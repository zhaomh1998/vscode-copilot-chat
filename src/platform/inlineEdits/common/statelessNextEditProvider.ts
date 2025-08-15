/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { Result } from '../../../util/common/result';
import { assert, assertNever } from '../../../util/vs/base/common/assert';
import { DeferredPromise } from '../../../util/vs/base/common/async';
import { CancellationToken, CancellationTokenSource } from '../../../util/vs/base/common/cancellation';
import { URI } from '../../../util/vs/base/common/uri';
import { LineEdit, LineReplacement, SerializedLineEdit } from '../../../util/vs/editor/common/core/edits/lineEdit';
import { StringEdit } from '../../../util/vs/editor/common/core/edits/stringEdit';
import { OffsetRange } from '../../../util/vs/editor/common/core/ranges/offsetRange';
import { StringText } from '../../../util/vs/editor/common/core/text/abstractText';
import { ChatFetchResponseType, FetchResponse } from '../../chat/common/commonTypes';
import { ISerializedOffsetRange, LogEntry, serializeOffsetRange } from '../../workspaceRecorder/common/workspaceLog';
import { DocumentId } from './dataTypes/documentId';
import { Edits } from './dataTypes/edit';
import { SerializedEdit } from './dataTypes/editUtils';
import { LanguageId } from './dataTypes/languageId';
import { DebugRecorderBookmark } from './debugRecorderBookmark';
import { InlineEditRequestLogContext } from './inlineEditLogContext';
import { stringifyChatMessages } from './utils/stringifyChatMessages';
import { IXtabHistoryEntry } from './workspaceEditTracker/nesXtabHistoryTracker';

export const enum ShowNextEditPreference {
	Always = 'always',
	AroundEdit = 'aroundEdit',
}

export type PushEdit = (edit: Result<{ edit: LineReplacement; window?: OffsetRange; targetDocument?: DocumentId }, NoNextEditReason>) => void;

export interface IStatelessNextEditProvider {
	readonly ID: string;
	readonly dependsOnSelection?: boolean;
	readonly showNextEditPreference?: ShowNextEditPreference;
	provideNextEdit(request: StatelessNextEditRequest, pushEdit: PushEdit, logContext: InlineEditRequestLogContext, cancellationToken: CancellationToken): Promise<StatelessNextEditResult>;
	handleAcceptance?(): void;
	handleRejection?(): void;
}

export class StatelessNextEditRequest<TFirstEdit = any> {

	private static ID = 0;
	public readonly seqid = String(++StatelessNextEditRequest.ID);

	public readonly cancellationTokenSource = new CancellationTokenSource();
	public liveDependentants = 0; // number of invocations which haven't been canceled and depend on this request
	public fetchIssued = false;
	public intermediateUserEdit: StringEdit | undefined = StringEdit.empty;

	private readonly _result: DeferredPromise<StatelessNextEditResult> = new DeferredPromise<StatelessNextEditResult>();
	public get result(): Promise<StatelessNextEditResult> {
		return this._result.p;
	}

	constructor(
		public readonly id: string,
		public readonly documentBeforeEdits: StringText,
		public readonly documents: readonly StatelessNextEditDocument[],
		public readonly activeDocumentIdx: number,
		public readonly xtabEditHistory: IXtabHistoryEntry[],
		public readonly firstEdit: DeferredPromise<Result<TFirstEdit, NoNextEditReason>>,
		public readonly logContext: InlineEditRequestLogContext,
		public readonly recordingBookmark: DebugRecorderBookmark | undefined,
		public readonly recording: LogEntry[] | undefined,
		public readonly providerRequestStartDateTime: number | undefined,
	) {
		assert(documents.length > 0);
		assert(activeDocumentIdx >= 0 && activeDocumentIdx < documents.length);
	}

	public setResult(nextEditResult: StatelessNextEditResult) {
		this._result.complete(nextEditResult);
	}

	public setResultError(err: any) {
		this._result.error(err);
	}

	public hasDocument(docId: DocumentId): boolean {
		return this.documents.find(d => d.id === docId) !== undefined;
	}

	getActiveDocument(): StatelessNextEditDocument {
		return this.documents[this.activeDocumentIdx];
	}

	serialize(): ISerializedNextEditRequest {
		return {
			id: this.id,
			documents: this.documents.map(d => d.serialize()),
			activeDocumentIdx: this.activeDocumentIdx,
			recording: this.recording,
		};
	}

	toString(): string {
		return this.toMarkdown();
	}

	toMarkdown(): string {
		const docs = this.documents.map((d, idx) => ` * [${idx + 1}/${this.documents.length}] ${idx === this.activeDocumentIdx ? '(active document) ' : ''}` + d.toMarkdown()).join('\n\n');
		return `### StatelessNextEditRequest\n\n${docs}`;
	}
}

export interface ISerializedNextEditRequest {
	id: string;
	documents: ISerializedNextEditDocument[];
	activeDocumentIdx: number;
	recording: LogEntry[] | undefined;
}

export class StatelessNextEditDocument {
	public readonly documentAfterEdits = new StringText(this.recentEdits.apply(this.documentBeforeEdits.value));
	public readonly documentAfterEditsLines: string[] = this.documentAfterEdits.getLines();

	/**
	 * NOTE: if you add new public fields to this class, please also update {@link ISerializedNextEditDocument} and {@link serialize()} methods,
	 * which are used to send this to http-server-powered NES provider.
	 */
	constructor(
		public readonly id: DocumentId,
		public readonly workspaceRoot: URI | undefined,
		public readonly languageId: LanguageId,
		public readonly documentLinesBeforeEdit: string[],
		public readonly recentEdit: LineEdit,
		public readonly documentBeforeEdits: StringText,
		public readonly recentEdits: Edits,
		public readonly lastSelectionInAfterEdit: OffsetRange | undefined = undefined,
	) { }

	serialize(): ISerializedNextEditDocument {
		return {
			id: this.id.uri,
			workspaceRoot: this.workspaceRoot?.toString(),
			languageId: this.languageId,
			documentLinesBeforeEdit: this.documentLinesBeforeEdit,
			recentEdit: this.recentEdit.serialize(),
			documentBeforeEdits: this.documentBeforeEdits.value,
			recentEdits: this.recentEdits.serialize(),
			lastSelectionInAfterEdit: this.lastSelectionInAfterEdit === undefined ? undefined : serializeOffsetRange(this.lastSelectionInAfterEdit),
		};
	}

	toString(): string {
		return this.toMarkdown();
	}

	toMarkdown(): string {
		const lines: string[] = [];

		lines.push(`StatelessNextEditDocument: **${this.id.uri}**\n`);
		lines.push('```patch');
		lines.push(this.recentEdit.humanReadablePatch(this.documentLinesBeforeEdit));
		lines.push('```');
		lines.push('');

		return lines.join('\n');
	}
}

export interface ISerializedNextEditDocument {
	id: string;
	workspaceRoot: string | undefined;
	languageId: string;
	documentLinesBeforeEdit: string[];
	recentEdit: SerializedLineEdit;
	documentBeforeEdits: string;
	recentEdits: SerializedEdit[];
	lastSelectionInAfterEdit: ISerializedOffsetRange | undefined;
}

export enum FilteredOutReason {
	LowLogProbSuggestions = 'lowLogProbSuggestions',
	EnforcingNextEditOptions = 'enforcingNextEditOptions',
	PromptTooLarge = 'promptTooLarge',
	Uncategorized = 'uncategorized',
}

export namespace NoNextEditReason {
	export class ActiveDocumentHasNoEdits {
		public readonly kind = 'activeDocumentHasNoEdits';
	}
	export class NoSuggestions {
		public readonly kind = 'noSuggestions';
		constructor(
			public readonly documentBeforeEdits: StringText,
			public readonly window: OffsetRange | undefined
		) {
		}
	}
	export class GotCancelled {
		public readonly kind = 'gotCancelled';
		constructor(public readonly message: 'afterDebounce' | 'afterGettingEndpoint' | 'afterPromptConstruction' | 'afterFetchCall' | 'duringStreaming' | 'afterResponse' | 'afterFailedRebase' | 'beforeExecutingNewRequest') {
		}
	}
	export class FetchFailure {
		public readonly kind = 'fetchFailure';
		constructor(public readonly error: Error) {
		}
	}
	export class FilteredOut {
		public readonly kind = 'filteredOut';
		constructor(public readonly message: FilteredOutReason | string) {
		}
	}
	export class Uncategorized {
		public readonly kind = 'uncategorized';
		constructor(public readonly error: Error) {
		}
	}
	export class Unexpected {
		public readonly kind = 'unexpected';
		constructor(public readonly error: Error) {
		}
	}
}

export type NoNextEditReason =
	| NoNextEditReason.ActiveDocumentHasNoEdits
	| NoNextEditReason.NoSuggestions
	| NoNextEditReason.GotCancelled
	| NoNextEditReason.FetchFailure
	| NoNextEditReason.FilteredOut
	| NoNextEditReason.Uncategorized
	| NoNextEditReason.Unexpected
	;

export class StatelessNextEditResult {
	public static noEdit(reason: NoNextEditReason, telemetryBuilder: StatelessNextEditTelemetryBuilder): StatelessNextEditResult {
		const result = Result.error(reason);
		const telemetry = telemetryBuilder.build(result);
		return new StatelessNextEditResult(result, telemetry);
	}

	public static streaming(telemetryBuilder: StatelessNextEditTelemetryBuilder): StatelessNextEditResult {
		const result = Result.ok<void>(undefined);
		const telemetry = telemetryBuilder.build(result);
		return new StatelessNextEditResult(result, telemetry);
	}

	constructor(
		public readonly nextEdit: Result<void, NoNextEditReason>,
		public readonly telemetry: IStatelessNextEditTelemetry,
	) {
	}
}

export interface IStatelessNextEditTelemetry {

	readonly hadStatelessNextEditProviderCall: boolean;

	/* general info */
	readonly statelessNextEditProviderDuration: number;
	readonly isCursorAtEndOfLine: boolean | undefined;
	readonly nLinesOfCurrentFileInPrompt: number | undefined;
	readonly modelName: string | undefined;

	/* options info */
	readonly logProbThreshold: number | undefined;

	/* prompt info */

	readonly prompt: string | undefined;
	readonly promptLineCount: number | undefined;
	readonly promptCharCount: number | undefined;

	/* fetch request info */

	readonly debounceTime: number | undefined;
	/** This's only used to compute time from inline edit provider call to fetch init. Not included in telemetry. */
	readonly fetchStartedAt: number | undefined;

	/* response info */

	/** Artificial delay (aka backoff) on the response based on previous user acceptance/rejection in milliseconds */
	readonly artificialDelay: number | undefined;

	readonly hadLowLogProbSuggestion: boolean | undefined;
	readonly response: undefined | Promise<FetchResultWithStats>;

	/* suggestions info */

	readonly nEditsSuggested: number | undefined;
	readonly lineDistanceToMostRecentEdit: number | undefined;

	/* result info */
	readonly nextEditLogprob: number | undefined;
	readonly noNextEditReasonKind: string | undefined;
	readonly noNextEditReasonMessage: string | undefined;
	readonly summarizedEditWindow: any;
}

export type FetchResultWithStats = {
	readonly ttft: number | undefined;
	readonly response: FetchResponse<string>;
	readonly fetchTime: number;
	readonly fetchResult: ChatFetchResponseType;
}

export class StatelessNextEditTelemetryBuilder {

	public readonly startTime: number;
	public readonly requestUuid: string;

	/**
	 * It takes a request to automatically capture some properties from the request.
	 */
	constructor(request: StatelessNextEditRequest) {
		this.startTime = Date.now();
		this.requestUuid = request.id;
	}

	public build(result: Result<void, NoNextEditReason>): IStatelessNextEditTelemetry {
		const endTime = Date.now();
		const timeSpent = endTime - this.startTime;

		const prompt = this._prompt ? JSON.stringify(this._prompt.map(({ role, content }) => ({ role, content }))) : undefined;
		const promptText = this._prompt ? stringifyChatMessages(this._prompt) : undefined;
		const promptLineCount = promptText?.split('\n').length;
		const promptCharCount = promptText?.length;

		const noNextEditReasonKind = result.isOk() ? undefined : result.err.kind;

		let noNextEditReasonMessage: string | undefined;
		if (result.isError()) {
			if (result.err instanceof NoNextEditReason.ActiveDocumentHasNoEdits || result.err instanceof NoNextEditReason.NoSuggestions) {
				// ignore
			} else if (result.err instanceof NoNextEditReason.GotCancelled || result.err instanceof NoNextEditReason.FilteredOut) {
				noNextEditReasonMessage = result.err.message;
			} else if (result.err instanceof NoNextEditReason.FetchFailure || result.err instanceof NoNextEditReason.Uncategorized || result.err instanceof NoNextEditReason.Unexpected) {
				noNextEditReasonMessage = result.err.error.stack ? result.err.error.stack : result.err.error.message;
			} else {
				assertNever(result.err);
			}
		}

		return {
			hadStatelessNextEditProviderCall: true,

			noNextEditReasonKind,
			noNextEditReasonMessage,

			statelessNextEditProviderDuration: timeSpent,
			logProbThreshold: this._logProbThreshold,
			nLinesOfCurrentFileInPrompt: this._nLinesOfCurrentFileInPrompt,
			modelName: this._modelName,
			prompt,
			promptLineCount,
			promptCharCount,
			isCursorAtEndOfLine: this._isCursorAtLineEnd,
			debounceTime: this._debounceTime,
			artificialDelay: this._artificialDelay,
			fetchStartedAt: this._fetchStartedAt,
			hadLowLogProbSuggestion: this._hadLowLogProbSuggestion,
			response: this._response,
			nEditsSuggested: this._nEditsSuggested,
			nextEditLogprob: this._nextEditLogProb,
			lineDistanceToMostRecentEdit: this._lineDistanceToMostRecentEdit,
			summarizedEditWindow: this._summarizedEditWindow,
		};
	}

	private _logProbThreshold: number | undefined;
	public setLogProbThreshold(logProbThreshold: number): this {
		this._logProbThreshold = logProbThreshold;
		return this;
	}

	private _hadLowLogProbSuggestion: boolean | undefined;
	public setHadLowLogProbSuggestion(hadLowLogProbSuggestions: boolean): this {
		this._hadLowLogProbSuggestion = hadLowLogProbSuggestions;
		return this;
	}

	private _nLinesOfCurrentFileInPrompt: number | undefined;
	public setNLinesOfCurrentFileInPrompt(nLines: number): this {
		this._nLinesOfCurrentFileInPrompt = nLines;
		return this;
	}

	private _modelName: string | undefined;
	public setModelName(modelName: string): this {
		this._modelName = modelName;
		return this;
	}

	private _prompt: Raw.ChatMessage[] | undefined;
	public setPrompt(prompt: Raw.ChatMessage[]): this {
		this._prompt = prompt;
		return this;
	}

	private _isCursorAtLineEnd: boolean | undefined;
	public setIsCursorAtLineEnd(isCursorAtLineEnd: boolean): this {
		this._isCursorAtLineEnd = isCursorAtLineEnd;
		return this;
	}

	private _debounceTime: number | undefined;
	public setDebounceTime(debounceTime: number): this {
		this._debounceTime = debounceTime;
		return this;
	}

	private _artificialDelay: number | undefined;
	public setArtificialDelay(artificialDelay: number): this {
		this._artificialDelay = artificialDelay;
		return this;
	}

	private _fetchStartedAt: number | undefined;
	public setFetchStartedAt(): this {
		this._fetchStartedAt = Date.now();
		return this;
	}
	public get fetchStartedAt(): number | undefined {
		return this._fetchStartedAt;
	}

	private _response: Promise<FetchResultWithStats> | undefined;
	public setResponse(response: Promise<{ ttft: number | undefined; response: FetchResponse<string> }>): this {
		this._response = response.then(({ response, ttft }) => {

			const fetchTime = Date.now() - this._fetchStartedAt!;

			const fetchResult = response.type;

			return {
				ttft,
				response,
				fetchTime,
				fetchResult,
			};
		});

		return this;
	}

	private _nextEditLogProb: number | undefined;
	public setNextEditLogProb(logProb: number): this {
		this._nextEditLogProb = logProb;
		return this;
	}

	private _nEditsSuggested: number | undefined;
	public setNEditsSuggested(nEditsSuggested: number): this {
		this._nEditsSuggested = nEditsSuggested;
		return this;
	}

	private _lineDistanceToMostRecentEdit: number | undefined;
	public setLineDistanceToMostRecentEdit(distanceToMostRecentEdit: number): this {
		this._lineDistanceToMostRecentEdit = distanceToMostRecentEdit;
		return this;
	}

	private _summarizedEditWindow: any;
	public setSummarizedEditWindow(summarizedEditWindow: any): this {
		this._summarizedEditWindow = summarizedEditWindow;
		return this;
	}
}
