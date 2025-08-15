/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement, PromptElementProps, PromptPiece, PromptReference, PromptSizing, TextChunk, UserMessage } from '@vscode/prompt-tsx';
import type { Diagnostic, DiagnosticSeverity, LanguageModelToolInformation } from 'vscode';
import { ChatFetchResponseType, ChatLocation } from '../../../../platform/chat/common/commonTypes';
import { IEndpointProvider } from '../../../../platform/endpoint/common/endpointProvider';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../../platform/filesystem/common/fileTypes';
import { ILogService } from '../../../../platform/log/common/logService';
import { ICopilotToolCall } from '../../../../platform/networking/common/fetch';
import { IChatEndpoint } from '../../../../platform/networking/common/networking';
import { IAlternativeNotebookContentService } from '../../../../platform/notebook/common/alternativeContent';
import { IPromptPathRepresentationService } from '../../../../platform/prompts/common/promptPathRepresentationService';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { createFencedCodeBlock } from '../../../../util/common/markdown';
import { getNotebookAndCellFromUri } from '../../../../util/common/notebooks';
import { isLocation } from '../../../../util/common/types';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Schemas } from '../../../../util/vs/base/common/network';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatReferenceBinaryData, ChatReferenceDiagnostic, LanguageModelToolResult2, Range, Uri } from '../../../../vscodeTypes';
import { GenericBasePromptElementProps } from '../../../context/node/resolvers/genericPanelIntentInvocation';
import { ChatVariablesCollection, isPromptInstruction } from '../../../prompt/common/chatVariablesCollection';
import { InternalToolReference } from '../../../prompt/common/intents';
import { ToolName } from '../../../tools/common/toolNames';
import { normalizeToolSchema } from '../../../tools/common/toolSchemaNormalizer';
import { IToolsService } from '../../../tools/common/toolsService';
import { EmbeddedInsideUserMessage, embeddedInsideUserMessageDefault } from '../base/promptElement';
import { IPromptEndpoint, PromptRenderer } from '../base/promptRenderer';
import { Tag } from '../base/tag';
import { FilePathMode, FileVariable } from './fileVariable';
import { Image } from './image';
import { NotebookCellOutputVariable } from './notebookVariables';
import { PanelChatBasePrompt } from './panelChatBasePrompt';
import { sendInvokedToolTelemetry, toolCallErrorToResult, ToolResult, ToolResultMetadata } from './toolCalling';
import { IFileTreeData, workspaceVisualFileTree } from './workspace/visualFileTree';

export interface ChatVariablesProps extends BasePromptElementProps, EmbeddedInsideUserMessage {
	readonly chatVariables: ChatVariablesCollection;
	readonly includeFilepath?: boolean;
	readonly omitReferences?: boolean;
	readonly isAgent?: boolean;
}

export class ChatVariables extends PromptElement<ChatVariablesProps, void> {
	constructor(
		props: ChatVariablesProps,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
	) {
		super(props);
	}

	override async render(state: void, sizing: PromptSizing): Promise<PromptPiece<any, any> | undefined> {
		const elements = await renderChatVariables(this.props.chatVariables, this.fileSystemService, this.props.includeFilepath, this.props.omitReferences, this.props.isAgent);
		if (elements.length === 0) {
			return undefined;
		}

		if (this.props.embeddedInsideUserMessage ?? embeddedInsideUserMessageDefault) {
			return (
				<>
					{Boolean(elements.length) && <Tag name='attachments' priority={this.props.priority}>
						{...elements}
					</Tag>}
				</>
			);
		}
		return (<>{...elements.map(element => asUserMessage(element, this.props.priority))}</>);
	}
}

export interface QueryProps extends BasePromptElementProps {
	readonly chatVariables: ChatVariablesCollection;
	readonly query: string;
}

export class UserQuery extends PromptElement<QueryProps, void> {
	override render(state: void, sizing: PromptSizing): PromptPiece<any, any> | undefined {
		const rewrittenMessage = this.props.chatVariables.substituteVariablesWithReferences(this.props.query);
		return (<>{rewrittenMessage}</>);
	}
}

export interface ChatVariablesAndQueryProps extends BasePromptElementProps, EmbeddedInsideUserMessage {
	readonly query: string;
	readonly chatVariables: ChatVariablesCollection;
	/**
	 * By default, the chat variables are reversed. Set this to true to maintain the variable order.
	 */
	readonly maintainOrder?: boolean;
	readonly includeFilepath?: boolean;
	readonly omitReferences?: boolean;
}

export class ChatVariablesAndQuery extends PromptElement<ChatVariablesAndQueryProps, void> {
	constructor(
		props: ChatVariablesAndQueryProps,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
	) {
		super(props);
	}

	override async render(state: void, sizing: PromptSizing): Promise<PromptPiece<any, any> | undefined> {
		const chatVariables = this.props.maintainOrder ? this.props.chatVariables : this.props.chatVariables.reverse();
		const elements = await renderChatVariables(chatVariables, this.fileSystemService, this.props.includeFilepath, this.props.omitReferences, undefined);

		if (this.props.embeddedInsideUserMessage ?? embeddedInsideUserMessageDefault) {
			if (!elements.length) {
				return (
					<Tag name='prompt'>
						<UserQuery chatVariables={chatVariables} query={this.props.query} priority={this.props.priority} />
					</Tag>
				);
			}
			return (<>
				{Boolean(elements.length) && <Tag name='attachments' flexGrow={1} priority={this.props.priority}>
					{elements}
				</Tag>}
				<Tag name='prompt'>
					<UserQuery chatVariables={chatVariables} query={this.props.query} priority={this.props.priority} />
				</Tag>
			</>);
		}

		return (<>
			{...elements.map(element => asUserMessage(element, this.props.priority && this.props.priority - 1))}
			{asUserMessage(<UserQuery chatVariables={chatVariables} query={this.props.query} />, this.props.priority)}
		</>);
	}
}

function asUserMessage(element: PromptElement, priority: number | undefined): UserMessage {
	return (<UserMessage priority={priority}>{element}</UserMessage>);
}


export async function renderChatVariables(chatVariables: ChatVariablesCollection, fileSystemService: IFileSystemService, includeFilepathInCodeBlocks = true, omitReferences?: boolean, isAgent?: boolean): Promise<PromptElement[]> {
	const elements = [];
	for (const variable of chatVariables) {
		const { uniqueName: variableName, value: variableValue, reference } = variable;
		if (isPromptInstruction(variable)) { // prompt instructions are handled in the `CustomInstructions` element
			continue;
		}

		if (URI.isUri(variableValue) || isLocation(variableValue)) {
			const uri = 'uri' in variableValue ? variableValue.uri : variableValue;

			// Check if the variable is a directory
			let isDirectory = false;
			try {
				const stat = await fileSystemService.stat(uri);
				isDirectory = stat.type === FileType.Directory;
			} catch { }

			if (isDirectory) {
				elements.push(<FolderVariable variableName={variableName} folderUri={uri} omitReferences={omitReferences} description={reference.modelDescription} />);
			} else {
				const filePathMode = (isAgent && includeFilepathInCodeBlocks)
					? FilePathMode.AsAttribute
					: includeFilepathInCodeBlocks
						? FilePathMode.AsComment
						: FilePathMode.None;
				const file = <FileVariable alwaysIncludeSummary={true} filePathMode={filePathMode} variableName={variableName} variableValue={variableValue} omitReferences={omitReferences} description={reference.modelDescription} />;

				if (!isAgent || (!URI.isUri(variableValue) || variableValue.scheme !== Schemas.vscodeNotebookCellOutput)) {
					// When attaching outupts, there's no need to add the entire notebook file again, as model can request the notebook file.
					// In non agent mode, we need to add the file for context.
					elements.push(file);
				}
				if (URI.isUri(variableValue) && variableValue.scheme === Schemas.vscodeNotebookCellOutput) {
					elements.push(<NotebookCellOutputVariable outputUri={variableValue} />);
				}
			}
		} else if (typeof variableValue === 'string') {
			elements.push(
				<Tag name='attachment' attrs={variableName ? { id: variableName } : undefined} >
					<TextChunk>
						{!omitReferences && <references value={[new PromptReference({ variableName })]} />}
						{reference.modelDescription ? reference.modelDescription + ':\n' : ''}
						{variableValue}
					</TextChunk>
				</Tag>
			);
		} else if (variableValue instanceof ChatReferenceBinaryData) {
			elements.push(<Image variableName={variableName} variableValue={await variableValue.data()} reference={variableValue.reference} omitReferences={omitReferences}></Image>);
		} else if (typeof ChatReferenceDiagnostic !== 'undefined' && variableValue instanceof ChatReferenceDiagnostic) { // check undefined to avoid breaking old Insiders versions
			elements.push(<DiagnosticVariable diagnostics={variableValue.diagnostics} />);
		}
	}
	return elements;
}

interface IDiagnosticVariableProps extends BasePromptElementProps {
	diagnostics: [uri: Uri, diagnostics: Diagnostic[]][];
}

const diangosticSeverityMap: { [K in DiagnosticSeverity]: string } = {
	[0]: 'error',
	[1]: 'warning',
	[2]: 'info',
	[3]: 'hint'
};

class DiagnosticVariable extends PromptElement<IDiagnosticVariableProps> {
	constructor(
		props: PromptElementProps<IDiagnosticVariableProps>,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IAlternativeNotebookContentService private readonly alternativeNotebookContent: IAlternativeNotebookContentService,
		@IPromptEndpoint private readonly endpoint: IPromptEndpoint,
	) {
		super(props);
	}

	render() {
		return <>
			{this.props.diagnostics.flatMap(([uri, diagnostics]) =>
				diagnostics.map(d => {
					let range = d.range;
					([uri, range] = this.translateNotebookUri(uri, range));
					return <Tag name="error" attrs={{ path: this.promptPathRepresentationService.getFilePath(uri), line: range.start.line + 1, code: getDiagnosticCode(d), severity: diangosticSeverityMap[d.severity] }}>
						{d.message}
					</Tag>;
				}
				)
			)}
		</>;
	}
	private translateNotebookUri(uri: Uri, range: Range): [Uri, Range] {
		if (uri.scheme !== Schemas.vscodeNotebookCell) {
			return [uri, range];
		}
		const [notebook, cell] = getNotebookAndCellFromUri(uri, this.workspaceService.notebookDocuments);
		if (!notebook || !cell) {
			return [uri, range];
		}
		if (range.start.line > cell.document.lineCount || range.end.line > cell.document.lineCount) {
			return [uri, range];
		}

		const altDocument = this.alternativeNotebookContent.create(this.alternativeNotebookContent.getFormat(this.endpoint)).getAlternativeDocument(notebook);
		const start = altDocument.fromCellPosition(cell, range.start);
		const end = altDocument.fromCellPosition(cell, range.end);
		const newRange = new Range(start, end);
		return [notebook.uri, newRange];
	}
}

function getDiagnosticCode(diagnostic: Diagnostic): string {
	const code = (typeof diagnostic.code === 'object' && !!diagnostic.code) ? diagnostic.code.value : diagnostic.code;
	return String(code);
}

interface IFolderVariableProps extends BasePromptElementProps {
	variableName: string;
	folderUri: Uri;
	omitReferences?: boolean;
	description?: string;
}

class FolderVariable extends PromptElement<IFolderVariableProps, IFileTreeData | undefined> {
	constructor(
		props: PromptElementProps<IFolderVariableProps>,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
	) {
		super(props);
	}

	override async prepare(sizing: PromptSizing): Promise<IFileTreeData | undefined> {
		try {
			return this.instantiationService.invokeFunction(accessor =>
				workspaceVisualFileTree(accessor, this.props.folderUri, { maxLength: 2000, excludeDotFiles: false }, CancellationToken.None)
			);
		} catch {
			// Directory doesn't exist or is not accessible
			return undefined;
		}
	}

	render(state: IFileTreeData | undefined) {
		const folderPath = this.promptPathRepresentationService.getFilePath(this.props.folderUri);
		return (
			<Tag name='attachment' attrs={this.props.variableName ? { id: this.props.variableName, folderPath } : undefined}>
				<TextChunk>
					{!this.props.omitReferences && <references value={[new PromptReference({ variableName: this.props.variableName })]} />}
					{this.props.description ? this.props.description + ':\n' : ''}
					The user attached the folder `{folderPath}`{state ? ' which has the following structure: ' + createFencedCodeBlock('', state.tree) : ''}
				</TextChunk>
			</Tag>
		);
	}
}

export interface ChatToolCallProps extends GenericBasePromptElementProps, EmbeddedInsideUserMessage {
}

interface IToolCallResult {
	readonly name: string | undefined;
	readonly value: LanguageModelToolResult2;
}

/**
 * Render toolReferences set on the request.
 */
export class ChatToolReferences extends PromptElement<ChatToolCallProps, void> {
	constructor(
		props: ChatToolCallProps,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IToolsService private readonly toolsService: IToolsService,
		@ILogService private readonly logService: ILogService,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@IPromptEndpoint private readonly promptEndpoint: IPromptEndpoint,
		@ITelemetryService private readonly telemetryService: ITelemetryService
	) {
		super(props);
	}

	override async render(state: void, sizing: PromptSizing): Promise<PromptPiece<any, any> | undefined> {
		const { tools, toolCallResults } = this.props.promptContext;
		if (!tools || !tools.toolReferences.length) {
			return;
		}

		const results: IToolCallResult[] = [];
		for (const toolReference of tools.toolReferences) {
			const tool = this.toolsService.getTool(toolReference.name);
			if (!tool) {
				throw new Error(`Unknown tool: "${toolReference.name}"`);
			}

			if (toolCallResults?.[toolReference.id]) {
				results.push({ name: toolReference.name, value: toolCallResults[toolReference.id] });
				continue;
			}

			const toolArgsEndpoint = await this.endpointProvider.getChatEndpoint('gpt-4o-mini');
			const internalToolArgs = toolReference.input ?? {};
			const toolArgs = await this.fetchToolArgs(tool, toolArgsEndpoint);

			const name = toolReference.range ? this.props.promptContext.query.slice(toolReference.range[0], toolReference.range[1]) : undefined;
			try {
				const result = await this.toolsService.invokeTool(tool.name, { input: { ...toolArgs, ...internalToolArgs }, toolInvocationToken: tools.toolInvocationToken }, CancellationToken.None);
				sendInvokedToolTelemetry(this.promptEndpoint.acquireTokenizer(), this.telemetryService, tool.name, result);
				results.push({ name, value: result });
			} catch (err) {
				const errResult = toolCallErrorToResult(err);
				results.push({ name, value: errResult.result });
			}
		}

		if (this.props.embeddedInsideUserMessage ?? embeddedInsideUserMessageDefault) {
			return this._renderChatToolResults(tools.toolReferences, results, this.props.priority);
		}

		return (
			<UserMessage priority={this.props.priority}>
				{this._renderChatToolResults(tools.toolReferences, results)}
			</UserMessage>
		);
	}

	private _renderChatToolResults(tools: readonly InternalToolReference[], results: readonly IToolCallResult[], priority?: number) {
		return (
			<>
				These attachments may have useful context for the user's query. The user may refer to these attachments directly using a term that starts with #.<br />
				{...results.map((toolResult, i) => this.renderChatToolResult(tools[i].id, toolResult, priority))}
			</>
		);
	}

	private renderChatToolResult(id: string, toolResult: IToolCallResult, priority?: number): PromptElement {
		return <Tag name='attachment' attrs={toolResult.name ? { tool: toolResult.name } : undefined} priority={priority}>
			<meta value={new ToolResultMetadata(id, toolResult.value)}></meta>
			<ToolResult content={toolResult.value.content} />
		</Tag>;
	}

	private async fetchToolArgs(tool: LanguageModelToolInformation, endpoint: IChatEndpoint): Promise<any> {
		const ownTool = this.toolsService.getCopilotTool(tool.name as ToolName);
		if (typeof ownTool?.provideInput === 'function') {
			const input = await ownTool.provideInput(this.props.promptContext);
			if (input) {
				return input;
			}
		}

		if (!tool.inputSchema || Object.keys(tool.inputSchema).length === 0) {
			return {};
		}

		const argFetchProps: GenericBasePromptElementProps = {
			...this.props,
			promptContext: {
				...this.props.promptContext,
				tools: undefined
			}
		};
		const toolTokens = await endpoint.acquireTokenizer().countToolTokens([tool]);
		const { messages } = await PromptRenderer.create(this.instantiationService, { ...endpoint, modelMaxPromptTokens: endpoint.modelMaxPromptTokens - toolTokens }, PanelChatBasePrompt, argFetchProps).render();
		let fnCall: ICopilotToolCall | undefined;
		const fetchResult = await endpoint.makeChatRequest(
			'fetchToolArgs',
			messages,
			async (text, _, delta) => {
				if (delta.copilotToolCalls) {
					fnCall = delta.copilotToolCalls[0];
				}
				return undefined;
			},
			CancellationToken.None,
			ChatLocation.Panel,
			undefined,
			{
				tools: normalizeToolSchema(
					endpoint.family,
					[
						{
							type: 'function',
							function: {
								name: tool.name,
								description: tool.description,
								parameters: tool.inputSchema
							}
						}
					],
					(tool, rule) => this.logService.warn(`Tool ${tool} failed validation: ${rule}`)
				),
				tool_choice: {
					type: 'function',
					function: {
						name: tool.name,
					}
				},
			},
			false
		);
		if (!fnCall) {
			throw new Error(`Failed to compute args for tool: "${tool.name}"`);
		}

		if (fetchResult.type !== ChatFetchResponseType.Success) {
			throw new Error(`Fetching tool args failed: ${fetchResult.type} ${fetchResult.reason}`);
		}

		try {
			const args = JSON.parse(fnCall.arguments);
			return args;
		} catch (e) {
			throw new Error('Invalid tool arguments: ' + e.message);
		}
	}
}
