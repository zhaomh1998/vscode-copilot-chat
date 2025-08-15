/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { BasePromptElementProps, PromptElement, PromptElementProps, PromptSizing } from '@vscode/prompt-tsx';
import { EOL } from 'os';
import type * as vscode from 'vscode';
import { TextDocumentSnapshot } from '../../../platform/editing/common/textDocumentSnapshot';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { IChatEndpoint } from '../../../platform/networking/common/networking';
import { IAlternativeNotebookContentService } from '../../../platform/notebook/common/alternativeContent';
import { BaseAlternativeNotebookContentProvider } from '../../../platform/notebook/common/alternativeContentProvider';
import { getCellId, getCellIdMap, getDefaultLanguage, normalizeCellId } from '../../../platform/notebook/common/helpers';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { createSha256Hash } from '../../../util/common/crypto';
import { findCell, findNotebook } from '../../../util/common/notebooks';
import { findLast } from '../../../util/vs/base/common/arraysFind';
import { raceCancellation, StatefulPromise } from '../../../util/vs/base/common/async';
import { isCancellationError } from '../../../util/vs/base/common/errors';
import { createSingleCallFunction } from '../../../util/vs/base/common/functional';
import { DisposableStore, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { isEqual } from '../../../util/vs/base/common/resources';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { EventEmitter, LanguageModelPromptTsxPart, LanguageModelTextPart, LanguageModelToolResult, NotebookCellData, NotebookCellKind, NotebookEdit, NotebookRange, Position, Range, TextEdit } from '../../../vscodeTypes';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { renderPromptElementJSON } from '../../prompts/node/base/promptRenderer';
import { Tag } from '../../prompts/node/base/tag';
import { CodeMapper, ICodeMapperRequestInput } from '../../prompts/node/codeMapper/codeMapper';
import { EXISTING_CODE_MARKER } from '../../prompts/node/panel/codeBlockFormattingRules';
import { CodeBlock } from '../../prompts/node/panel/safeElements';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

export interface IEditNotebookToolParams {
	filePath: string;
	explanation: string;
	cellId?: string;
	newCode?: string | string[];
	language?: string;
	editType: 'insert' | 'delete' | 'edit';
}

type ExistingCell = { cell: vscode.NotebookCell; index: number; type: 'existing' };
type InsertCell = { cell: NotebookCellData; index: number; type: 'insert'; originalIndex: number };
type DeleteCell = { cell: vscode.NotebookCell; index: number; type: 'delete' };
type ChangedCell = ExistingCell | InsertCell | DeleteCell;

class ErrorWithTelemetrySafeReason extends Error {
	constructor(message: string, public readonly reason: string) {
		super(message);
	}
}

export class EditNotebookTool implements ICopilotTool<IEditNotebookToolParams> {
	public static toolName = ToolName.EditNotebook;
	private promptContext?: IBuildPromptContext;

	constructor(
		@IPromptPathRepresentationService protected readonly promptPathRepresentationService: IPromptPathRepresentationService,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IWorkspaceService protected readonly workspaceService: IWorkspaceService,
		@IAlternativeNotebookContentService protected readonly alternativeNotebookContent: IAlternativeNotebookContentService,
		@ILogService protected readonly logger: ILogService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@IFileSystemService protected readonly fileSystemService: IFileSystemService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IEditNotebookToolParams>, token: vscode.CancellationToken) {
		let uri = this.promptPathRepresentationService.resolveFilePath(options.input.filePath);
		if (!uri) {
			sendEditNotebookToolOutcomeTelemetry(this.telemetryService, this.endpointProvider, options, 'invalid_file_path');
			throw new ErrorWithTelemetrySafeReason(`Invalid file path`, 'invalid_file_path');
		}
		// Sometimes we get the notebook cell Uri in the resource.
		// Resolve this to notebook.
		uri = findNotebook(uri, this.workspaceService.notebookDocuments)?.uri || uri;

		// Validate parameters
		const stream = this.promptContext?.stream;
		if (!stream) {
			sendEditNotebookToolOutcomeTelemetry(this.telemetryService, this.endpointProvider, options, 'invalid_input_no_stream');
			throw new ErrorWithTelemetrySafeReason(`Invalid input, no stream`, 'invalid_input_no_stream');
		}

		let notebook: vscode.NotebookDocument;
		try {
			notebook = await this.workspaceService.openNotebookDocument(uri);
		} catch (error) {
			if (await this.fileSystemService.stat(uri).catch(() => false)) {
				throw error;
			} else {
				// Possible the notebook does not exist and model is trying to create a new notebook.
				// Edit tool doesn't support creating a new notebook.
				const editFileToolExists = this.promptContext?.tools?.availableTools?.some(t => t.name === ToolName.EditFile);
				const toolToCreateFile = editFileToolExists ? ToolName.EditFile : ToolName.CreateFile;
				const message = error.message || error.toString();
				throw new Error(`${message}\nIf trying to create a Notebook, then first use the ${toolToCreateFile} tool to create an empty notebook.`);
			}
		}

		const notebookUri = notebook.uri;
		const provider = this.alternativeNotebookContent.create(this.alternativeNotebookContent.getFormat(this.promptContext?.request?.model));
		if (token.isCancellationRequested) {
			sendEditNotebookToolOutcomeTelemetry(this.telemetryService, this.endpointProvider, options, 'cancelled');
			return;
		}


		const codeMapperCompleted: Promise<any>[] = [];
		const cells: ChangedCell[] = notebook.getCells().map((cell, index) => ({ cell, index, type: 'existing' }));
		const expectedCellEdits: ChangedCell[] = [];
		const expectedCellTextEdits: [vscode.Uri, TextEdit][] = [];

		// We must wait for all of the cell edits to get applied.
		// This way we can return the final state of the notebook.
		// We do the same in edit file too as well. Not doing this could result in inconsistencies as model will have an invalid state of the notebook document.
		const done = new EventEmitter<void>();
		const disposables = new DisposableStore();
		disposables.add(toDisposable(() => { done.fire(); done.dispose(); }));
		const cellEditsApplied = this.waitForCellOperationComplete(notebook, done.event, expectedCellEdits, disposables, token);
		const textEditsApplied = this.waitForCellTextEditsToComplete(done.event, expectedCellTextEdits, disposables, token);
		const sendEndEdit = createSingleCallFunction(() => stream.notebookEdit(notebookUri, true));
		disposables.add(toDisposable(() => sendEndEdit()));
		const counters = { insert: 0, edit: 0, delete: 0 };
		let failureReason: string | undefined = undefined;
		try {
			// First validate all of the args begore applying any changes.
			this.fixInput(options.input, notebook, provider);
			this.validateInput(options.input, notebook);
			stream.notebookEdit(notebookUri, []);
			let previousCellIdUsedForInsertion = '';
			const explanation = options.input.explanation;
			const { editType, language, newCode } = options.input;
			const cellCode = Array.isArray(newCode) ? newCode.join(EOL) : newCode;
			let cellId = options.input.cellId || '';
			const cellMap = getCellIdMap(notebook);
			if (editType === 'insert') {
				counters.insert++;
				// Model can send two subsequent inserts, and only first insert might contain the cellid.
				previousCellIdUsedForInsertion = cellId = cellId || previousCellIdUsedForInsertion;
				let notebookCellIndex = -1; // Index in notebook where we are to insert this new cell.
				let cellsCellIndex = -1; // Index in cells array.
				let originalIndex = -1; // Original intended Notebook Cell Index.

				if (cellId === 'top') {
					originalIndex = 0;

					// Possible we have already inserted a cell at the top.
					// We need to find the last cell that was inserted at the top.
					const entry = findLast(cells, item => item.type === 'insert' && item.originalIndex === 0);
					if (entry) {
						cellsCellIndex = cells.indexOf(entry) + 1;
						notebookCellIndex = entry.index + 1;
					} else {
						cellsCellIndex = 0;
						notebookCellIndex = 0;
					}
				} else if (cellId === 'bottom') {
					// Possible we have already inserted a cell at the bottom.
					// We need to find the last cell that was inserted at the bottom.
					cellsCellIndex = cells.length;
					notebookCellIndex = cells.filter(item => item.type !== 'delete').length;
				} else {
					const cell = cellId ? cellMap.get(cellId) : undefined;
					if (cellId && !cell) {
						throw new ErrorWithTelemetrySafeReason(`Invalid cell id: ${cellId}, notebook may have been modified, try reading the file again`, 'invalid_cell_id_insert_after');
					}
					const entry = cells.find(item => item.cell === cell)!;
					cellsCellIndex = cells.indexOf(entry) + 1;
					originalIndex = notebookCellIndex = entry.index + 1;

					// Possible we have already inserted a cell at the top.
					// We need to find the last cell that was inserted at the top.
					const inserted = findLast(cells, item => item.type === 'insert' && item.originalIndex === originalIndex);
					if (inserted) {
						cellsCellIndex = cells.indexOf(inserted) + 1;
						notebookCellIndex = inserted.index + 1;
					}
				}


				previousCellIdUsedForInsertion = cellId ?? previousCellIdUsedForInsertion;
				const languageId = language || getDefaultLanguage(notebook) || 'python'; // Default to Python if no language is provided
				const cellKind = language === 'markdown' ? NotebookCellKind.Markup : NotebookCellKind.Code;
				const cell = new NotebookCellData(cellKind, cellCode || '', languageId);
				expectedCellEdits.push({ type: 'insert', index: notebookCellIndex, cell, originalIndex });

				// Shift other indexes by 1.
				cells.filter(({ type }) => type !== 'delete').filter(({ index }) => index >= notebookCellIndex).forEach(item => item.index = item.index + 1);
				cells.splice(cellsCellIndex, 0, { cell, index: notebookCellIndex, type: 'insert', originalIndex });
				stream.notebookEdit(notebookUri, NotebookEdit.insertCells(notebookCellIndex, [cell]));
			} else {
				previousCellIdUsedForInsertion = '';
				const cell = cellId ? cellMap.get(cellId) : undefined;
				if (!cell) {
					throw new ErrorWithTelemetrySafeReason(`Invalid cell id: ${cellId}, notebook may have been modified, try reading the file again`, 'invalid_cell_id_empty');
				}
				const cellIndex = cells.find(i => i.cell === cell)!.index;
				if (cellIndex === -1) {
					throw new ErrorWithTelemetrySafeReason(`Invalid cell id: ${cellId}, notebook may have been modified, try reading the file again`, 'invalid_cell_id_edit_or_delete');
				}

				if (editType === 'delete') {
					counters.delete++;
					const cellRange = new NotebookRange(cellIndex, cellIndex + 1);

					// Shift other indexes by 1.
					const cell = cells.find(({ index, type }) => index === cellIndex && type === 'existing')!;
					expectedCellEdits.push({ type: 'delete', cell: cell.cell as vscode.NotebookCell, index: cellIndex });
					cell.type = 'delete';
					cells.filter(({ type }) => type !== 'delete').filter(({ index }) => index > cellIndex).forEach(item => item.index = item.index - 1);
					stream.notebookEdit(notebookUri, NotebookEdit.deleteCells(cellRange));
				}
				else {
					if (cellCode === undefined) {
						throw new ErrorWithTelemetrySafeReason('Invalid input: newCode is required for edit operation', 'invalid_input_new_code_required');
					}
					counters.edit++;
					const existingCell = notebook.cellAt(cellIndex);
					expectedCellEdits.push({ type: 'existing', cell: existingCell, index: cellIndex });
					if (existingCell.document.getText().length && cellCode.includes(EXISTING_CODE_MARKER)) {
						sendEditNotebookCellTelemetry(this.telemetryService, true, existingCell.document.uri, options, this.endpointProvider);
						const codeMapper = this.instantiationService.createInstance(CodeMapper);
						const requestInput = createCodeMapperRequest(existingCell, notebookUri, cellCode, explanation ?? '');
						const cellEditOperation = codeMapper.mapCode(requestInput, {
							notebookEdit(target, edits) { stream.notebookEdit(target, edits); },
							textEdit(_target, edits) {
								stream.textEdit(existingCell.document.uri, edits);
								if (typeof edits !== 'boolean') {
									edits = Array.isArray(edits) ? edits : [edits];
									edits.forEach(e => expectedCellTextEdits.push([existingCell.document.uri, e]));
								}
							},
						}, undefined, token);
						codeMapperCompleted.push(cellEditOperation);
					} else {
						sendEditNotebookCellTelemetry(this.telemetryService, false, existingCell.document.uri, options, this.endpointProvider);
						const edit = new TextEdit(new Range(new Position(0, 0), existingCell.document.lineAt(existingCell.document.lineCount - 1).range.end), cellCode);
						stream.textEdit(existingCell.document.uri, edit);
						expectedCellTextEdits.push([existingCell.document.uri, edit]);
					}
				}
			}

			sendEndEdit();

			const summaryOfExpectedEdits = summarizeOriginalEdits(notebook, options.input, expectedCellEdits);
			this.logger.trace(`[Notebook] ${summaryOfExpectedEdits}`);
			await raceCancellation(Promise.all(codeMapperCompleted), token);
			if (token.isCancellationRequested) {
				return;
			}

			done.fire();

			// Possible this logic for waiting for edits is wrong.
			// Wait for a max of 10s, if not done, then log an error and return.
			// Worse case scenario, we report incorrect content in the response.
			const timeoutPromise = new StatefulPromise(new Promise<void>((resolve) => {
				const timeout = setTimeout(() => {
					if (expectedCellEdits.length) {
						const summaryOfPendingEdits = summarizeEdits(expectedCellEdits);
						this.logger.error(`[Notebook] Timed out waiting for cell operations to complete.`, `${summaryOfExpectedEdits}. Pending Cell Edits ${summaryOfPendingEdits}`);
					}
					if (expectedCellEdits.length) {
						const summaryOfPendingEdits = summarizeTextEdits(notebook, expectedCellTextEdits);
						this.logger.error(`[Notebook] Timed out waiting for cell text edit operations to complete.`, `${summaryOfExpectedEdits}. Pending Text Edits ${summaryOfPendingEdits}`);
					}
					resolve();
				}, 10_000);
				disposables.add(toDisposable(() => clearTimeout(timeout)));
			}));

			await raceCancellation(Promise.race([timeoutPromise.promise, Promise.all([cellEditsApplied, textEditsApplied])]), token);
			if (token.isCancellationRequested) {
				return;
			}

			// If we timedout waiting for edit operations to complete, we don't want to return the result.
			if (timeoutPromise.isResolved) {
				return new LanguageModelToolResult([
					new LanguageModelTextPart(
						`Notebook edited successfully. Use the ${ToolName.ReadFile} file tool to get the latest content of the notebook file`
					)
				]);
			}

			return new LanguageModelToolResult([
				new LanguageModelPromptTsxPart(
					await renderPromptElementJSON(
						this.instantiationService,
						EditFileResult,
						{ document: notebook, changes: cells, languageModel: this.promptContext?.request?.model },
						// If we are not called with tokenization options, have _some_ fake tokenizer
						// otherwise we end up returning the entire document
						options.tokenizationOptions ?? {
							tokenBudget: 1000,
							countTokens: (t) => Promise.resolve(t.length * 3 / 4)
						},
						token,
					),
				)
			]);
		} catch (error) {
			if (isCancellationError(error)) {
				failureReason = 'cancellation';
			} else {
				failureReason = error && error instanceof ErrorWithTelemetrySafeReason ? error.reason : 'unknown';
			}
			throw error;
		} finally {
			disposables.dispose();
			if (!failureReason) {
				sendEditNotebookCellOperationsTelemetry(this.telemetryService, this.endpointProvider, options, counters);
			}
			sendEditNotebookToolOutcomeTelemetry(this.telemetryService, this.endpointProvider, options, failureReason ?? 'success');
			sendEditNotebookTelemetry(this.telemetryService, this.endpointProvider, 'notebookEdit', notebookUri, this.promptContext?.requestId, options.model ?? this.promptContext?.request?.model);
		}

	}

	async resolveInput(input: IEditNotebookToolParams, promptContext: IBuildPromptContext): Promise<IEditNotebookToolParams> {
		this.promptContext = promptContext;
		return input;
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IEditNotebookToolParams>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: options.input.explanation || l10n.t('Editing notebook'),
			presentation: options.input.explanation && typeof options.input.explanation ? undefined : 'hidden'
		};
	}

	private validateInput(input: IEditNotebookToolParams, notebook: vscode.NotebookDocument) {
		const { editType, cellId, newCode } = input;
		// Possible we'll get cellId as a number such as -1 when inserting a cell at the top.
		const id = ((typeof (cellId as any) === 'number' ? `${cellId}` : cellId) || '').trim();
		const cellMap = getCellIdMap(notebook);
		const cell = (id && id !== 'top' && id !== 'bottom') ? cellMap.get(id) : undefined;
		if (id && id !== 'top' && id !== 'bottom' && !cell) {
			throw new ErrorWithTelemetrySafeReason(`None of the edits were applied as cell id: ${id} is invalid. Notebook may have been modified, try reading the file again`, 'invalidCellId');
		}
		switch (editType) {
			case 'insert':
				if (newCode === undefined) {
					throw new ErrorWithTelemetrySafeReason('None of the edits were applied as newCode is required for insert operation', 'missingNewCode');
				}
				break;
			case 'delete':
				if (id === undefined) {
					throw new ErrorWithTelemetrySafeReason('None of the edits were applied as cellId is required for delete operation', 'missingCellId');
				}
				break;
			case 'edit':
				if (!id) {
					throw new ErrorWithTelemetrySafeReason('None of the edits were applied as cellId is required for edit operation', 'missingCellId');
				}
				if (newCode === undefined) {
					throw new ErrorWithTelemetrySafeReason('None of the edits were applied as newCode is required for edit operation', 'missingNewCode');
				}
				break;
		}
	}

	private fixInput(input: IEditNotebookToolParams, notebook: vscode.NotebookDocument, provider: BaseAlternativeNotebookContentProvider) {
		input.cellId = (input.cellId || '').toString().trim();
		if (input.cellId.toLowerCase() === 'top') {
			input.cellId = 'top';
		}
		if (input.cellId.toLowerCase() === 'bottom') {
			input.cellId = 'bottom';
		}
		if (input.editType === 'insert' && input.newCode) {
			input.newCode = provider.stripCellMarkers(Array.isArray(input.newCode) ? input.newCode.join(EOL) : input.newCode);
		}
		if (input.newCode && Array.isArray(input.newCode)) {
			input.newCode = Array.isArray(input.newCode) ? input.newCode.join(EOL) : input.newCode;
		}

		// If the insertion has no cell id, then treat it as bottom.
		if (input.editType === 'insert' && !input.cellId) {
			input.cellId = 'bottom';
		}
		if (input.cellId && input.cellId !== 'top' && input.cellId !== 'bottom') {
			input.cellId = normalizeCellId(input.cellId);
		}
	}

	async waitForCellOperationComplete(notebook: vscode.NotebookDocument, done: vscode.Event<void>, expectedOutputs: ChangedCell[], disposables: DisposableStore, token: vscode.CancellationToken): Promise<void> {
		const store = disposables.add(new DisposableStore());
		return new Promise<void>((resolve) => {
			let completed = false;
			store.add(token.onCancellationRequested(() => resolve()));
			store.add(done(() => {
				completed = true;
				if (expectedOutputs.length === 0) {
					resolve();
				}
			}));
			store.add(this.workspaceService.onDidChangeNotebookDocument((e) => {
				if (e.notebook !== notebook) {
					return;
				}
				expectedOutputs
					.filter(expectedOutput => {
						if (expectedOutput.type === 'existing') {
							if (e.notebook === notebook && e.cellChanges.some(cell => cell.cell === expectedOutput.cell)) {
								return true;
							}

							return false;
						}
						for (const change of e.contentChanges) {
							if (change.removedCells.length && expectedOutput.type === 'delete' && change.removedCells.some(cell => cell === expectedOutput.cell)) {
								return true;
							}
							if (change.addedCells.length && expectedOutput.type === 'insert' && change.addedCells.some(cell => cell.index === expectedOutput.index)) {
								return true;
							}
						}
						return false;
					})
					.forEach(found => {
						const index = expectedOutputs.findIndex(i => i === found);
						if (index !== -1) {
							expectedOutputs.splice(index, 1);
						}
					});

				if (completed && expectedOutputs.length === 0) {
					resolve();
				}
			}));
		}).finally(() => store.dispose());
	}

	async waitForCellTextEditsToComplete(done: vscode.Event<void>, expectedTextEdits: [vscode.Uri, TextEdit][], disposables: DisposableStore, token: vscode.CancellationToken): Promise<any> {
		const store = disposables.add(new DisposableStore());
		return new Promise<void>((resolve) => {
			let completed = false;
			store.add(token.onCancellationRequested(() => resolve()));
			store.add(done(() => {
				completed = true;
				if (expectedTextEdits.length === 0) {
					resolve();
				}
			}));
			store.add(this.workspaceService.onDidChangeTextDocument((e) => {
				expectedTextEdits
					.filter(([uri, edit]) => {
						for (const change of e.contentChanges) {
							if (!isEqual(e.document.uri, uri)) {
								continue;
							}
							if (isEqual(e.document.uri, uri) && (change.range.contains(edit.range) || edit.range.contains(change.range) || edit.range.isEqual(change.range))) {
								return true;
							}
						}
						return false;
					})
					.forEach(found => {
						const index = expectedTextEdits.findIndex(i => i[0] === found[0] && i[1] === found[1]);
						if (index !== -1) {
							expectedTextEdits.splice(index, 1);
						}
					});

				if (completed && expectedTextEdits.length === 0) {
					resolve();
				}
			}));
		}).finally(() => store.dispose());
	}
}

function summarizeOriginalEdits(notebook: vscode.NotebookDocument, inputEdit: IEditNotebookToolParams, edits: ChangedCell[]): string {
	const summary: string[] = [];
	summary.push(`Notebook ${notebook.uri.toString()}. `);
	summary.push(`Original number of cells: ${notebook.cellCount}. `);
	summary.push(`Original cell Ids: ${notebook.getCells().map(cell => getCellId(cell)).join(', ')}. `);
	summary.push(`Requested Edits: =>`);
	switch (inputEdit.editType) {
		case 'edit':
			summary.push(`Edit cell id ${inputEdit.cellId}`);
			break;
		case 'insert':
			summary.push(`Insert cell after ${inputEdit.cellId}`);
			break;
		case 'delete':
			summary.push(`Delete cell id ${inputEdit.cellId}`);
			break;
	}
	summary.push(`Final generated edits: =>`);
	summary.push(summarizeEdits(edits));
	return summary.join('\n');
}

function summarizeEdits(edits: ChangedCell[]): string {
	const summary: string[] = [];
	for (const [index, edit] of edits.entries()) {
		switch (edit.type) {
			case 'existing':
				summary.push(`${index}. Edited cell at index ${edit.index}`);
				break;
			case 'insert':
				summary.push(`${index}. Inserted cell at index ${edit.index}`);
				break;
			case 'delete':
				summary.push(`${index}. Deleted cell at index ${edit.index}`);
				break;
		}
	}
	return summary.join('\n');
}

function summarizeTextEdits(notebook: vscode.NotebookDocument, edits: [vscode.Uri, TextEdit][]): string {
	const summary: string[] = [];
	for (const [index, edit] of edits.entries()) {
		const cell = findCell(edit[0], notebook);
		const range = `range (${edit[1].range.start.line + 1}-${edit[1].range.end.line + 1})`;
		if (cell) {
			summary.push(`${index}. Cell ${getCellId(cell)}, ${range} to Edit`);
		} else {
			summary.push(`[WARNING] ${index}. Cell Uri NOT found, ${range} to Edit (${edit[0].toString()})`);
		}

	}
	return summary.join('\n');
}

function createCodeMapperRequest(existingCell: vscode.NotebookCell, notebookUri: vscode.Uri, newCode: string, explanation: string) {
	// Create a TextDocumentSnapshot from the existing cell but with Notebook Uri.
	// This is because Cell Uris contain schemes and query strings/fragments that
	// do not work well with CodeMapper (i.e. Model doesn't handle such Uris well).
	const documentSnapshot = TextDocumentSnapshot.fromJSON(existingCell.document, {
		_text: existingCell.document.getText(),
		eol: existingCell.document.eol,
		languageId: existingCell.document.languageId,
		version: existingCell.document.version,
		uri: notebookUri
	});
	const requestInput: ICodeMapperRequestInput = {
		createNew: false,
		codeBlock: newCode,
		uri: notebookUri,
		markdownBeforeBlock: explanation || undefined,
		existingDocument: documentSnapshot
	};

	return requestInput;
}

export interface IEditFileResultProps extends BasePromptElementProps {
	document: vscode.NotebookDocument;
	changes: ChangedCell[];
	languageModel: vscode.LanguageModelChat | undefined;
}

export class EditFileResult extends PromptElement<IEditFileResultProps> {
	constructor(
		props: PromptElementProps<IEditFileResultProps>,
		@IAlternativeNotebookContentService protected readonly alternativeNotebookContent: IAlternativeNotebookContentService,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
	) {
		super(props);
	}

	/**
	 * When cells are inserted, the model doesn't have the details of the ids of the new cells.
	 * All it has is the cell ids of the cells after which the cells were inserted.
	 * Its been observed that the model uses the ids of the cells that were used as args in editTool as identifiers of the new cells.
	 * To try and avoid this hallucination, we need to show the cells that were inserted along with their ids.
	 */
	override async render(state: void, sizing: PromptSizing) {
		const document = this.props.document;
		const cellsToInlucdeInSummary: vscode.NotebookCell[] = [];

		if (this.props.changes.every(i => i.type !== 'insert')) {
			return <>The notebook file was successfully edited.</>;
		}

		let previousCell: vscode.NotebookCell | undefined;
		const existingCells = new Set(this.props.changes.filter(i => i.type === 'existing').map(i => i.cell));
		document.getCells().forEach((cell) => {
			if (existingCells.has(cell)) {
				previousCell = cell;
				return;
			}
			// This is a new cell, we need to include it in the summary.
			if (previousCell && !cellsToInlucdeInSummary.includes(cell)) {
				cellsToInlucdeInSummary.push(previousCell);
			}
			cellsToInlucdeInSummary.push(cell);
		});
		const format = this.alternativeNotebookContent.getFormat(this.props.languageModel);
		const summary = this.alternativeNotebookContent.create(format).getSummaryOfStructure(document, cellsToInlucdeInSummary, EXISTING_CODE_MARKER);
		return <Tag name='some_of_the_cells_after_edit' attrs={{ path: this.promptPathRepresentationService.getFilePath(document.uri) }}>
			Below is a summary of some of the inserted cells including some of the existing cells around the new cells.<br />
			NOTE: This is merely a summary and not the actual content of the cells nor the entire notebook.<br />
			<CodeBlock includeFilepath={false} languageId={format} uri={document.uri} code={summary} />
		</Tag>;
	}
}

ToolRegistry.registerTool(EditNotebookTool);

export async function sendEditNotebookTelemetry(telemetryService: ITelemetryService, endpointProvider: IEndpointProvider | undefined, toolUsedToEditNotebook: 'notebookEdit' | 'applyPatch' | 'stringReplace' | 'newNotebookIntent' | 'editCodeIntent' | 'insertEdit' | 'createFile', resource: vscode.Uri, requestId?: string, chatModel?: vscode.LanguageModelChat, endpoint?: IChatEndpoint) {
	const resourceHash = await createSha256Hash(resource.fsPath);
	const model = endpoint?.model ?? (chatModel && endpointProvider && (await endpointProvider.getChatEndpoint(chatModel)).model);

	/* __GDPR__
		"editNotebook.toolUsed" : {
			"owner": "donjayamanne",
			"comment": "Tracks the tool used to edit Notebook documents",
			"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The id of the current request turn." },
			"resourceHash": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The hash of the resource of the current request turn. (Notebook Uri)" },
			"editTool": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Tool used to edit the notebook, one of 'notebookEdit' | 'applyPatch' | 'stringReplace' | 'newNotebookIntent' | 'editCodeIntent' | 'insertEdit' | 'createFile'" },
			"isNotebook": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Whether the document is a notebook (this measure is used to identify notebook related telemetry)." },
			"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model used for the request." }
		}
	*/
	telemetryService.sendMSFTTelemetryEvent('editNotebook.toolUsed',
		{ requestId, editTool: toolUsedToEditNotebook, resourceHash, model }, { isNotebook: 1 }
	);
}

async function sendEditNotebookToolOutcomeTelemetry(telemetryService: ITelemetryService, endpointProvider: IEndpointProvider | undefined, options: vscode.LanguageModelToolInvocationOptions<IEditNotebookToolParams>, outcome: string) {
	const model = (options.model && endpointProvider && (await endpointProvider.getChatEndpoint(options.model)).model);

	/* __GDPR__
		"editNotebook.toolOutcome" : {
			"owner": "donjayamanne",
			"comment": "Tracks the tool used to edit Notebook documents",
			"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The id of the current request turn." },
			"isNotebook": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Whether the document is a notebook (this measure is used to identify notebook related telemetry)." },
			"outcome": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Outcome of the edit operation" },
			"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model used for the request." }
		}
	*/
	telemetryService.sendMSFTTelemetryEvent('editNotebook.toolOutcome',
		{ requestId: options.chatRequestId, outcome, model }, { isNotebook: 1 }
	);
}

async function sendEditNotebookCellOperationsTelemetry(telemetryService: ITelemetryService, endpointProvider: IEndpointProvider | undefined, options: vscode.LanguageModelToolInvocationOptions<IEditNotebookToolParams>, counters: { insert: number; edit: number; delete: number }) {
	const model = (options.model && endpointProvider && (await endpointProvider.getChatEndpoint(options.model)).model);

	/* __GDPR__
		"editNotebook.cellEditOps" : {
			"owner": "donjayamanne",
			"comment": "Tracks the tool used to edit Notebook documents",
			"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The id of the current request turn." },
			"isNotebook": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Whether the document is a notebook (this measure is used to identify notebook related telemetry)." },
			"insert": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of cell inserts" },
			"delete": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of cell deletes" },
			"edit": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of cell edits" },
			"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model used for the request." }
		}
	*/
	telemetryService.sendMSFTTelemetryEvent('editNotebook.cellEditOps',
		{ requestId: options.chatRequestId, model }, { isNotebook: 1, insert: counters.insert, edit: counters.edit, delete: counters.delete }
	);
}

async function sendEditNotebookCellTelemetry(telemetryService: ITelemetryService, hasCodeMarker: boolean, resource: vscode.Uri, options: vscode.LanguageModelToolInvocationOptions<IEditNotebookToolParams>, endpointProvider: IEndpointProvider) {
	const resourceHash = await createSha256Hash(resource.fsPath);
	const model = options.model && (await endpointProvider.getChatEndpoint(options.model)).model;

	/* __GDPR__
		"editNotebook.editCellWithCodeMarker" : {
			"owner": "donjayamanne",
			"comment": "Tracks the presence of code markers in code when editing Notebook cells",
			"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The id of the current request turn." },
			"resourceHash": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The hash of the resource of the current request turn. (Notebook Uri)" },
			"hasCodeMarker": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Whether there any code markers are present", "isMeasurement": true },
			"isNotebook": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Whether the document is a notebook (this measure is used to identify notebook related telemetry)." },
			"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model used for the request." }
		}
	*/
	telemetryService.sendMSFTTelemetryEvent('editNotebook.editCellWithCodeMarker',
		{ requestId: options.chatRequestId, resourceHash, model }, { hasCodeMarker: hasCodeMarker ? 1 : 0, isNotebook: 1 }
	);
}

// This is what we get, when using indexes, Model generates multiple tool call,
// Unfortunately this causes issues.
// Basically we can get multiple tool calls one after the other.
// However the tool has no idea whether the cell indexes relate to a previous state or latest state of notebook.
// E.g. if we have 10 cells (a,b,c,d,e,f,g,h,i,j,k), and we apply the edits based on the following individual tool calls.
// We want to delete indexes 2,3,4,6, hence expect cells c,d,e,g to be deleted.
// However after each tool call, the notebook gets updated hence indexes shift.
// As a result we end up deleting cells c,e,g,j.
// Given indexes are not stable, we need to use cell ids.
// This way if a cell is deleted and the id is incorrect, we can throw an error and model will request the latest state of the notebook.
// Where as using indexes we could end up deleting/updating the wrong cells.
/**
## Response
### Assistant
````md

🛠️ edit_notebook_file (call_j3TEKk5R0KHfMYhJo1x88QeS) {
	"filePath": "/Users/donjayamanne/demo/chat/sample.ipynb",
	"cellIndex": 2,
	"explanation": "Deleting empty cell",
	"editType": "delete"
}
🛠️ edit_notebook_file (call_Gv6WxrMzSIDMPE0lqqM3GbWo) {
	"filePath": "/Users/donjayamanne/demo/chat/sample.ipynb",
	"cellIndex": 3,
	"explanation": "Deleting empty cell",
	"editType": "delete"
}
🛠️ edit_notebook_file (call_iPokgpiaeYDV7JwnbAFgdgZD) {
	"filePath": "/Users/donjayamanne/demo/chat/sample.ipynb",
	"cellIndex": 4,
	"explanation": "Deleting empty cell",
	"editType": "delete"
}
🛠️ edit_notebook_file (call_8t3Ls4C3QLVDAeFXwU1dE7Hh) {
	"filePath": "/Users/donjayamanne/demo/chat/sample.ipynb",
	"cellIndex": 6,
	"explanation": "Deleting empty cell",
	"editType": "delete"
}
````
 */