/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptReference, Raw } from '@vscode/prompt-tsx';
import type * as vscode from 'vscode';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { roleToString } from '../../../platform/chat/common/globalStringUtils';
import { ILanguageDiagnosticsService } from '../../../platform/languages/common/languageDiagnosticsService';
import { IChatEndpoint } from '../../../platform/networking/common/networking';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { isNotebookCellOrNotebookChatInput } from '../../../util/common/notebooks';
import { DiagnosticsTelemetryData, findDiagnosticsTelemetry } from '../../inlineChat/node/diagnosticsTelemetry';
import { InteractionOutcome } from '../../inlineChat/node/promptCraftingTypes';
import { AgentIntent } from '../../intents/node/agentIntent';
import { EditCodeIntent } from '../../intents/node/editCodeIntent';
import { EditCode2Intent } from '../../intents/node/editCodeIntent2';
import { TemporalContextStats } from '../../prompts/node/inline/temporalContext';
import { getCustomInstructionTelemetry } from '../../prompts/node/panel/customInstructions';
import { PATCH_PREFIX } from '../../tools/node/applyPatch/parseApplyPatch';
import { Conversation } from '../common/conversation';
import { IToolCall, IToolCallRound } from '../common/intents';
import { IDocumentContext } from './documentContext';
import { IIntent, TelemetryData } from './intents';
import { ConversationalBaseTelemetryData, createTelemetryWithId, extendUserMessageTelemetryData, getCodeBlocks, sendModelMessageTelemetry, sendOffTopicMessageTelemetry, sendUserActionTelemetry, sendUserMessageTelemetry } from './telemetry';

// #region: internal telemetry for responses

type ResponseInternalTelemetryProperties = {
	chatLocation: 'inline' | 'panel';
	intent: string;
	request: string;
	response: string;
	baseModel: string;
};

// EVENT: interactiveSessionResponse
export type ResponseInternalPanelTelemetryProperties = ResponseInternalTelemetryProperties & {
	chatLocation: 'panel';
	requestId: string;

	// shareable but NOT
	isParticipantDetected: string;
	sessionId: string;
};

// EVENT: interactiveSessionResponse
export type ResponseInternalPanelTelemetryMeasurements = {
	turnNumber: number;
};

// EVENT: interactiveSessionResponse
export type ResponseInternalInlineTelemetryProperties = ResponseInternalTelemetryProperties & {
	chatLocation: 'inline';

	// shareable but NOT
	conversationId: string;
	requestId: string;
	responseType: ChatFetchResponseType;

	// editor-specific
	problems: string;
	selectionProblems: string;
	diagnosticCodes: string;
	selectionDiagnosticCodes: string;
	diagnosticsProvider: string;
	language: string;
};

// EVENT: interactiveSessionResponse
export type ResponseInternalInlineTelemetryMeasurements = {
	isNotebook: number;
	turnNumber: number;
};

// #endregion

// #region: internal telemetry for requests

// EVENT: interactiveSessionMessage

export type RequestInternalPanelTelemetryProperties = {
	chatLocation: 'panel';
	sessionId: string;
	requestId: string;
	baseModel: string;
	intent: string;
	isParticipantDetected: string;
	detectedIntent: string;
	contextTypes: string;
	query: string;
};

// EVENT: interactiveSessionRequest

export type RequestInternalInlineTelemetryProperties = {
	chatLocation: 'inline';
	conversationId: string;
	requestId: string;
	intent: string;
	language: string;
	prompt: string;
	model: string;
};

export type RequestInternalInlineTelemetryMeasurements = {
	isNotebook: number;
	turnNumber: number;
};

// #endregion


//#region public telemetry for requests

// EVENT: panel.request

type RequestTelemetryProperties = {
	command: string;
	contextTypes: string;
	promptTypes: string;
	conversationId: string;
	requestId: string;

	responseType: string;
	languageId: string | undefined;
	model: string;
};

export type RequestPanelTelemetryProperties = RequestTelemetryProperties & {
	responseId: string;
	codeBlocks: string;
	isParticipantDetected: string;
	toolCounts: string;
};

export type RequestTelemetryMeasurements = {
	promptTokenCount: number;
	timeToRequest: number;
	timeToFirstToken: number;
	timeToComplete: number;
	responseTokenCount: number;
	messageTokenCount: number;
};

export type RequestPanelTelemetryMeasurements = RequestTelemetryMeasurements & {
	turn: number;
	round: number;
	textBlocks: number;
	links: number;
	maybeOffTopic: number;
	userPromptCount: number;
	numToolCalls: number;
	availableToolCount: number;
	temporalCtxFileCount: number;
	temporalCtxTotalCharCount: number;
};

// EVENT: inline.request

export type RequestInlineTelemetryProperties = RequestTelemetryProperties & {
	languageId: string;
	replyType: string;
	diagnosticsProvider: string;
	diagnosticCodes: string;
	selectionDiagnosticCodes: string;
	outcomeAnnotations: string;
};

export type RequestInlineTelemetryMeasurements = RequestTelemetryMeasurements & {
	firstTurn: number;
	isNotebook: number;
	withIntentDetection: number;
	implicitCommand: number;
	attemptCount: number;
	selectionLineCount: number;
	wholeRangeLineCount: number;
	editCount: number;
	editLineCount: number;
	markdownCharCount: number;
	problemsCount: number;
	selectionProblemsCount: number;
	diagnosticsCount: number;
	selectionDiagnosticsCount: number;
	temporalCtxFileCount: number;
	temporalCtxTotalCharCount: number;
};

//#endregion

export class ChatTelemetryBuilder {

	public readonly baseUserTelemetry: ConversationalBaseTelemetryData = createTelemetryWithId();

	public get telemetryMessageId() {
		return this.baseUserTelemetry.properties.messageId;
	}

	constructor(
		private readonly _startTime: number,
		private readonly _sessionId: string,
		private readonly _documentContext: IDocumentContext | undefined,
		private readonly _firstTurn: boolean,
		private readonly _request: vscode.ChatRequest,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@ILanguageDiagnosticsService private readonly _languageDiagnosticsService: ILanguageDiagnosticsService,
	) { }

	public makeRequest(intent: IIntent, location: ChatLocation, conversation: Conversation, messages: Raw.ChatMessage[], promptTokenLength: number, references: readonly PromptReference[], endpoint: IChatEndpoint, telemetryData: readonly TelemetryData[], availableToolCount: number): InlineChatTelemetry | PanelChatTelemetry {

		const Ctor = location === ChatLocation.Editor
			? InlineChatTelemetry
			: PanelChatTelemetry;

		return new Ctor(
			this._sessionId,
			this._documentContext!,
			this._firstTurn,
			this._request,
			this._startTime,
			this.baseUserTelemetry,
			conversation,
			intent,
			messages,
			references,
			endpoint,
			promptTokenLength,
			telemetryData,
			availableToolCount,
			this._telemetryService,
			this._languageDiagnosticsService,
		);
	}
}

export abstract class ChatTelemetry<C extends IDocumentContext | undefined = IDocumentContext | undefined> {

	protected readonly _userTelemetry: ConversationalBaseTelemetryData;

	protected readonly _requestStartTime: number = Date.now();
	protected _firstTokenTime: number = 0;

	protected _addedLinkCount = 0;
	protected _markdownCharCount: number = 0;
	protected _editCount: number = 0;
	protected _editLineCount: number = 0;

	// todo@connor4312: temporary event to track occurences of patches in response
	// text, ref https://github.com/microsoft/vscode-copilot/issues/16608
	private _didSeePatchInResponse = false;
	private _lastMarkdownLine = '';

	public get telemetryMessageId(): string {
		return this._userTelemetry.properties.messageId;
	}

	public get editCount(): number {
		return this._editCount;
	}

	public get editLineCount(): number {
		return this._editLineCount;
	}

	constructor(
		protected readonly _location: ChatLocation,
		protected readonly _sessionId: string,
		protected readonly _documentContext: C,
		protected readonly _firstTurn: boolean,
		protected readonly _request: vscode.ChatRequest,
		protected readonly _startTime: number,
		baseUserTelemetry: ConversationalBaseTelemetryData,
		protected readonly _conversation: Conversation,
		protected readonly _intent: IIntent,
		protected readonly _messages: Raw.ChatMessage[],
		protected readonly _references: readonly PromptReference[],
		protected readonly _endpoint: IChatEndpoint,
		promptTokenLength: number,
		protected readonly _genericTelemetryData: readonly TelemetryData[],
		protected readonly _availableToolCount: number,
		@ITelemetryService protected readonly _telemetryService: ITelemetryService,
	) {
		// Extend the base user telemetry with message and prompt information.
		// We don't send this telemetry yet, but we will need it later to include the off topic scores.
		this._userTelemetry = extendUserMessageTelemetryData(
			this._conversation,
			this._sessionId,
			this._location,
			this._request.prompt,
			promptTokenLength,
			// this._tokenizer.countMessagesTokens(this._messages),
			this._intent.id,
			baseUserTelemetry
		);

		// we are in a super-ctor and use a microtask to give sub-classes a change to initialize properties
		// that might be used in their _sendInternalRequestTelemetryEvent-method
		queueMicrotask(() => this._sendInternalRequestTelemetryEvent());
	}

	public markReceivedToken(): void {
		if (this._firstTokenTime === 0) {
			this._firstTokenTime = Date.now();
		}
	}

	public markAddedLinks(n: number): void {
		this._addedLinkCount += n;
	}

	public markEmittedMarkdown(str: vscode.MarkdownString) {
		this._markdownCharCount += str.value.length;
		this._lastMarkdownLine += str.value;
		if (this._lastMarkdownLine.includes(PATCH_PREFIX.trim())) {
			this._didSeePatchInResponse = true;
		}

		const i = this._lastMarkdownLine.lastIndexOf('\n');
		this._lastMarkdownLine = this._lastMarkdownLine.slice(i + 1);
	}

	public markEmittedEdits(uri: vscode.Uri, edits: vscode.TextEdit[]) {
		this._editCount += edits.length;
		this._editLineCount += edits.reduce((acc, edit) => acc + edit.newText.split('\n').length, 0);
	}

	public async sendTelemetry(requestId: string, responseType: ChatFetchResponseType, response: string, interactionOutcome: InteractionOutcome, toolCalls: IToolCall[]): Promise<void> {
		// We can send the user message telemetry event now that the response is returned, including off-topic prediction.
		sendUserMessageTelemetry(
			this._telemetryService,
			this._location,
			requestId,
			this._request.prompt,
			responseType === ChatFetchResponseType.OffTopic ? true : false,
			this._documentContext?.document,
			this._userTelemetry,
			this._getModeName(),
		);

		if (responseType === ChatFetchResponseType.OffTopic) {
			sendOffTopicMessageTelemetry(
				this._telemetryService,
				this._conversation,
				this._location,
				this._request.prompt,
				this.telemetryMessageId, // That's the message id of the user message
				this._documentContext?.document,
				this._userTelemetry
			);
		}

		if (responseType === ChatFetchResponseType.Success) {
			sendModelMessageTelemetry(
				this._telemetryService,
				this._conversation,
				this._location,
				response,
				this.telemetryMessageId, // That's the message id of the user message
				this._documentContext?.document,
				this._userTelemetry.extendedBy({ replyType: interactionOutcome.kind })
			);
		}

		await this._sendResponseTelemetryEvent(responseType, response, interactionOutcome, toolCalls);
		this._sendResponseInternalTelemetryEvent(responseType, response);


		// todo@connor4312: temporary event to track occurences of patches in response
		// text, ref https://github.com/microsoft/vscode-copilot/issues/16608
		if (this._didSeePatchInResponse) {
			/* __GDPR__
				"applyPatch.inResponse" : {
					"owner": "digitarald",
					"comment": "Metadata about an inline response from the model",
					"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model that is used in the endpoint." }
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('applyPatch.inResponse', {
				model: this._endpoint.model
			});
		}
	}

	protected _getModeName(): string {
		return this._request.modeInstructions ? 'custom' :
			this._intent.id === AgentIntent.ID ? 'agent' :
				(this._intent.id === EditCodeIntent.ID || this._intent.id === EditCode2Intent.ID) ? 'edit' :
					'ask';
	}

	public sendToolCallingTelemetry(toolCallRounds: IToolCallRound[], availableTools: readonly vscode.LanguageModelToolInformation[], responseType: ChatFetchResponseType | 'cancelled' | 'maxToolCalls'): void {
		if (availableTools.length === 0) {
			return;
		}

		const toolCounts = toolCallRounds.reduce((acc, round) => {
			round.toolCalls.forEach(call => {
				acc[call.name] = (acc[call.name] || 0) + 1;
			});
			return acc;
		}, {} as Record<string, number>);

		const invalidToolCallCount = toolCallRounds.reduce((acc, round) => {
			if (round.toolInputRetry > 0) {
				acc++;
			}
			return acc;
		}, 0);

		const toolCallProperties = {
			intentId: this._intent.id,
			conversationId: this._conversation.sessionId,
			responseType,
			toolCounts: JSON.stringify(toolCounts),
			model: this._endpoint.model
		};

		const toolCallMeasurements = {
			numRequests: toolCallRounds.length, // This doesn't include cancelled requests
			turnIndex: this._conversation.turns.length,
			sessionDuration: Date.now() - this._conversation.turns[0].startTime,
			turnDuration: Date.now() - this._conversation.getLatestTurn().startTime,
			promptTokenCount: this._userTelemetry.measurements.promptTokenLen,
			messageCharLen: this._userTelemetry.measurements.messageCharLen,
			availableToolCount: availableTools.length,
			invalidToolCallCount
		};

		/* __GDPR__
			"toolCallDetails" : {
				"owner": "roblourens",
				"comment": "Records information about tool calls during a request.",
				"intentId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Id for the invoked intent." },
				"conversationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Id for the current chat conversation." },
				"outcome": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request succeeded or failed." },
				"numRequests": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The total number of requests made" },
				"turnIndex": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The conversation turn index" },
				"toolCounts": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": false, "comment": "The number of times each tool was used" },
				"sessionDuration": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The time since the session started" },
				"turnDuration": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The time since the turn started" },
				"promptTokenCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many tokens were in the last generated prompt." },
				"messageCharLen": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many characters were in the user message." },
				"availableToolCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How number of tools that were available." },
				"responseType": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "If the final response was successful or how it failed." },
				"invalidToolCallCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The number of tool call rounds that had an invalid tool call." },
				"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model used for the request." }
			}
		*/
		this._telemetryService.sendMSFTTelemetryEvent('toolCallDetails', toolCallProperties, toolCallMeasurements);

		this._telemetryService.sendInternalMSFTTelemetryEvent('toolCallDetailsInternal', {
			...toolCallProperties,
			availableTools: JSON.stringify(availableTools.map(tool => tool.name)),
		}, toolCallMeasurements);
	}

	protected abstract _sendInternalRequestTelemetryEvent(): void;

	protected abstract _sendResponseTelemetryEvent(responseType: ChatFetchResponseType, response: string, interactionOutcome: InteractionOutcome, toolCalls?: IToolCall[]): Promise<void>;

	protected abstract _sendResponseInternalTelemetryEvent(responseType: ChatFetchResponseType, response: string): void;

	protected _getTelemetryData<T extends TelemetryData>(ctor: new (...args: any[]) => T): T | undefined {
		return <T>this._genericTelemetryData.find(d => d instanceof ctor);
	}
}

export class PanelChatTelemetry extends ChatTelemetry<IDocumentContext | undefined> {

	constructor(
		sessionId: string,
		documentContext: IDocumentContext | undefined,
		firstTurn: boolean,
		request: vscode.ChatRequest,
		startTime: number,
		baseUserTelemetry: ConversationalBaseTelemetryData,
		conversation: Conversation,
		intent: IIntent,
		messages: Raw.ChatMessage[],
		references: readonly PromptReference[],
		endpoint: IChatEndpoint,
		promptTokenLength: number,
		genericTelemetryData: readonly TelemetryData[],
		availableToolCount: number,
		@ITelemetryService telemetryService: ITelemetryService,
	) {
		super(ChatLocation.Panel,
			sessionId,
			documentContext,
			firstTurn,
			request,
			startTime,
			baseUserTelemetry,
			conversation,
			intent,
			messages,
			references,
			endpoint,
			promptTokenLength,
			genericTelemetryData,
			availableToolCount,
			telemetryService
		);
	}

	protected override _sendInternalRequestTelemetryEvent(): void {


		// Capture the created prompt in internal telemetry
		this._telemetryService.sendInternalMSFTTelemetryEvent('interactiveSessionMessage', {
			chatLocation: 'panel',
			sessionId: this._sessionId,
			requestId: this.telemetryMessageId,
			baseModel: this._endpoint.model,
			intent: this._intent.id,
			isParticipantDetected: String(this._request.isParticipantDetected),
			detectedIntent: this._request.enableCommandDetection ? this._intent?.id : 'none',
			contextTypes: 'none', // TODO this is defunct
			query: this._request.prompt
		} satisfies RequestInternalPanelTelemetryProperties, {
			turnNumber: this._conversation.turns.length,
		} satisfies ResponseInternalPanelTelemetryMeasurements);
	}

	protected override async _sendResponseTelemetryEvent(responseType: ChatFetchResponseType, response: string, interactionOutcome: InteractionOutcome, toolCalls: IToolCall[] = []): Promise<void> {

		const temporalContexData = this._getTelemetryData(TemporalContextStats);

		const turn = this._conversation.getLatestTurn();
		const roundIndex = turn.rounds.length - 1;

		const codeBlocks = response ? getCodeBlocks(response) : [];
		const codeBlockLanguages = codeBlocks.map(block => block.languageId);

		// TBD@digitarald: This is a first cheap way to detect off-topic LLM responses.
		const offTopicHints = ['programming-related tasks', 'programming related questions', 'software development topics', 'related to programming', 'expertise is limited', 'sorry, i can\'t assist with that'];
		let maybeOffTopic = 0;
		if (responseType === ChatFetchResponseType.Success && !response.trim().includes('\n')) {
			// Check responseMessage
			if (offTopicHints.some(flag => response.toLowerCase().includes(flag))) {
				maybeOffTopic = 1;
			}
		}

		const toolCounts = toolCalls.reduce((acc, call) => {
			acc[call.name] = (acc[call.name] || 0) + 1;
			return acc;
		}, {} as Record<string, number>);

		const messageTokenCount = await this._endpoint.acquireTokenizer().tokenLength(turn.request.message);
		const promptTokenCount = await this._endpoint.acquireTokenizer().countMessagesTokens(this._messages);
		const responseTokenCount = await this._endpoint.acquireTokenizer().tokenLength(response) ?? 0;

		/* __GDPR__
			"panel.request" : {
				"owner": "digitarald",
				"comment": "Metadata about one message turn in a chat conversation.",
				"command": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The command which was used in providing the response." },
				"contextTypes": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The context parts which were used in providing the response." },
				"promptTypes": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The prompt types and their length which were used in providing the response." },
				"conversationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Id for the current chat conversation." },
				"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Id for this message request." },
				"responseId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Id for this message response." },
				"responseType": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "If the response was successful or how it failed." },
				"languageId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The language of the active editor." },
				"codeBlocks": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Code block languages in the response." },
				"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model that is used in the endpoint." },
				"turn": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many turns have been made in the conversation." },
				"round": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The current round index of the turn." },
				"textBlocks": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "For text-only responses (no code), how many paragraphs were in the response." },
				"links": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Symbol and file links in the response.", "isMeasurement": true },
				"maybeOffTopic": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "If the response sounds like it got rejected due to the request being off-topic." },
				"messageTokenCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many characters were in the user message." },
				"promptTokenCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many characters were in the generated prompt." },
				"userPromptCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many user messages were in the generated prompt." },
				"responseTokenCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many characters were in the response." },
				"timeToRequest": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "How long it took to start the final request." },
				"timeToFirstToken": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "How long it took to get the first token." },
				"timeToComplete": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "How long it took to complete the request." },
				"codeGenInstructionsCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many code generation instructions are in the request." },
				"codeGenInstructionsLength": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Whats the length of the code generation instructions that were added to request." },
				"codeGenInstructionsFilteredCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many code generation instructions were filtered." },
				"codeGenInstructionFileCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many code generation instruction files were read." },
				"codeGenInstructionSettingsCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many code generation instructions originated from settings." },
				"toolCounts": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": false, "comment": "The number of times each tool was used" },
				"numToolCalls": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The total number of tool calls" },
				"availableToolCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How number of tools that were available." },
				"temporalCtxFileCount" : { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "How many temporal document-parts where included" },
				"temporalCtxTotalCharCount" : { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "How many characters all temporal document-parts where included" }
			}
		*/
		this._telemetryService.sendMSFTTelemetryEvent('panel.request', {
			command: this._intent.id,
			contextTypes: 'none', // TODO this is defunct
			promptTypes: this._messages.map(msg => `${msg.role}${'name' in msg && msg.name ? `-${msg.name}` : ''}:${msg.content?.length}`).join(','),
			conversationId: this._sessionId,
			requestId: turn.id,
			responseId: turn.id, // SAME as fetchResult.requestId ,
			responseType,
			languageId: this._documentContext?.document.languageId,
			codeBlocks: codeBlockLanguages.join(','),
			model: this._endpoint.model,
			isParticipantDetected: String(this._request.isParticipantDetected),
			toolCounts: JSON.stringify(toolCounts),
		} satisfies RequestPanelTelemetryProperties, {
			turn: this._conversation.turns.length,
			round: roundIndex,
			textBlocks: codeBlocks.length ? -1 : response.split(/\n{2,}/).length ?? 0,
			links: this._addedLinkCount,
			maybeOffTopic: maybeOffTopic,
			messageTokenCount,
			promptTokenCount,
			userPromptCount: this._messages.filter(msg => msg.role === Raw.ChatRole.User).length,
			responseTokenCount,
			timeToRequest: this._requestStartTime - this._startTime,
			timeToFirstToken: this._firstTokenTime ? this._firstTokenTime - this._startTime : -1,
			timeToComplete: Date.now() - this._startTime,
			...getCustomInstructionTelemetry(turn.references),
			numToolCalls: toolCalls.length,
			availableToolCount: this._availableToolCount,
			temporalCtxFileCount: temporalContexData?.documentCount ?? -1,
			temporalCtxTotalCharCount: temporalContexData?.totalCharLength ?? -1
		} satisfies RequestPanelTelemetryMeasurements);

		const modeName = this._getModeName();
		sendUserActionTelemetry(
			this._telemetryService,
			undefined,
			{
				command: this._intent.id,
				conversationId: this._sessionId,
				requestId: turn.id,
				responseType,
				languageId: this._documentContext?.document.languageId ?? '',
				model: this._endpoint.model,
				isParticipantDetected: String(this._request.isParticipantDetected),
				toolCounts: JSON.stringify(toolCounts),
				mode: modeName,
				codeBlocks: JSON.stringify(codeBlocks),
			},
			{
				isAgent: this._intent.id === AgentIntent.ID ? 1 : 0,
				turn: this._conversation.turns.length,
				round: roundIndex,
				textBlocks: codeBlocks.length ? -1 : response.split(/\n{2,}/).length ?? 0,
				links: this._addedLinkCount,
				maybeOffTopic,
				messageTokenCount,
				promptTokenCount,
				userPromptCount: this._messages.filter(msg => msg.role === Raw.ChatRole.User).length,
				responseTokenCount,
				timeToRequest: this._requestStartTime - this._startTime,
				timeToFirstToken: this._firstTokenTime ? this._firstTokenTime - this._startTime : -1,
				timeToComplete: Date.now() - this._startTime,
				numToolCalls: toolCalls.length,
				availableToolCount: this._availableToolCount,
				temporalCtxFileCount: temporalContexData?.documentCount ?? -1,
				temporalCtxTotalCharCount: temporalContexData?.totalCharLength ?? -1
			},
			'panel_request'
		);
	}

	protected override _sendResponseInternalTelemetryEvent(_responseType: ChatFetchResponseType, response: string): void {

		this._telemetryService.sendInternalMSFTTelemetryEvent('interactiveSessionResponse', {
			// shared
			chatLocation: 'panel',
			requestId: this.telemetryMessageId,
			intent: this._intent.id,
			request: this._request.prompt,
			response: response ?? '',
			baseModel: this._endpoint.model,

			// shareable but NOT
			isParticipantDetected: String(this._request.isParticipantDetected),
			sessionId: this._sessionId,
		} satisfies ResponseInternalPanelTelemetryProperties, {
			turnNumber: this._conversation.turns.length,
		} satisfies ResponseInternalPanelTelemetryMeasurements);
	}
}

export class InlineChatTelemetry extends ChatTelemetry<IDocumentContext> {

	private readonly _diagnosticsTelemetryData: {
		fileDiagnosticsTelemetry: DiagnosticsTelemetryData;
		selectionDiagnosticsTelemetry: DiagnosticsTelemetryData;
		diagnosticsProvider: string;
	};

	private get _isNotebookDocument(): number {
		return isNotebookCellOrNotebookChatInput(this._documentContext.document.uri) ? 1 : 0;
	}

	constructor(
		sessionId: string,
		documentContext: IDocumentContext,
		firstTurn: boolean,
		request: vscode.ChatRequest,
		startTime: number,
		baseUserTelemetry: ConversationalBaseTelemetryData,
		conversation: Conversation,
		intent: IIntent,
		messages: Raw.ChatMessage[],
		references: readonly PromptReference[],
		endpoint: IChatEndpoint,
		promptTokenLength: number,
		genericTelemetryData: readonly TelemetryData[],
		availableToolCount: number,
		@ITelemetryService telemetryService: ITelemetryService,
		@ILanguageDiagnosticsService private readonly _languageDiagnosticsService: ILanguageDiagnosticsService,
	) {
		super(ChatLocation.Editor,
			sessionId,
			documentContext,
			firstTurn,
			request,
			startTime,
			baseUserTelemetry,
			conversation,
			intent,
			messages,
			references,
			endpoint,
			promptTokenLength,
			genericTelemetryData,
			availableToolCount,
			telemetryService
		);

		this._diagnosticsTelemetryData = findDiagnosticsTelemetry(this._documentContext.selection, this._languageDiagnosticsService.getDiagnostics(this._documentContext.document.uri));
	}

	protected override _sendInternalRequestTelemetryEvent(): void {
		// Capture the created prompt in internal telemetry
		this._telemetryService.sendInternalMSFTTelemetryEvent('interactiveSessionRequest', {
			conversationId: this._sessionId,
			requestId: this.telemetryMessageId,
			chatLocation: 'inline',
			intent: this._intent.id,
			language: this._documentContext.document.languageId,
			prompt: this._messages.map(m => `${roleToString(m.role).toUpperCase()}:\n${m.content}`).join('\n---\n'),
			model: this._endpoint.model
		} satisfies RequestInternalInlineTelemetryProperties, {
			isNotebook: this._isNotebookDocument,
			turnNumber: this._conversation.turns.length,
		} satisfies RequestInternalInlineTelemetryMeasurements);
	}

	protected override async _sendResponseTelemetryEvent(responseType: ChatFetchResponseType, response: string, interactionOutcome: InteractionOutcome): Promise<void> {

		const temporalContexData = this._getTelemetryData(TemporalContextStats);

		/* __GDPR__
			"inline.request" : {
				"owner": "digitarald",
				"comment": "Metadata about an inline response from the model",
				"command": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The command which was used in providing the response." },
				"contextTypes": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The context parts which were used in providing the response." },
				"promptTypes": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The prompt types and their length which were used in providing the response." },
				"conversationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The id of the conversation." },
				"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Id for this message request." },
				"languageId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The language of the current document." },
				"responseType": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The result type of the response." },
				"replyType": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "How response is shown in the interface." },
				"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model that is used in the endpoint." },
				"diagnosticsProvider": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The diagnostics provider." },
				"diagnosticCodes": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The diagnostics codes in the file." },
				"selectionDiagnosticCodes": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The selected diagnostics codes." },
				"firstTurn": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Whether this is the first turn in the conversation." },
				"isNotebook": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Whether this is a notebook document." },
				"messageTokenCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many tokens are in the rest of the query, without the command." },
				"promptTokenCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many tokens are in the overall prompt." },
				"responseTokenCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many tokens were in the response." },
				"implicitCommand": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Whether the command was implictly detected or provided by the user." },
				"attemptCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many times the user has retried." },
				"selectionLineCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many lines are in the current selection." },
				"wholeRangeLineCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many lines are in the expanded whole range." },
				"editCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many edits are suggested." },
				"editLineCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many lines are in all suggested edits." },
				"markdownCharCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many characters were emitted as markdown to vscode in the response stream." },
				"problemsCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many problems are in the current document." },
				"selectionProblemsCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many problems are in the current selected code." },
				"diagnosticsCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many diagnostic codes are in the current ." },
				"selectionDiagnosticsCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many diagnostic codes are in the code at the selection." },
				"outcomeAnnotations": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Annotations about the outcome of the request." },
				"timeToRequest": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "How long it took to start the final request." },
				"timeToFirstToken": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "How long it took to get the first token." },
				"timeToComplete": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "How long it took to complete the request." },
				"temporalCtxFileCount" : { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "How many temporal document-parts where included" },
				"temporalCtxTotalCharCount" : { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "How many characters all temporal document-parts where included" },
				"codeGenInstructionsCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many code generation instructions are in the request." },
				"codeGenInstructionsLength": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The length of the code generation instructions that were added to request." },
				"codeGenInstructionsFilteredCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many code generation instructions were filtered." },
				"codeGenInstructionFileCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many code generation instruction files were read." },
				"codeGenInstructionSettingsCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "How many code generation instructions originated from settings." }
			}
		*/
		this._telemetryService.sendMSFTTelemetryEvent('inline.request', {
			command: this._intent.id,
			contextTypes: 'none',// TODO@jrieken intentResult.contexts.map(part => part.kind).join(',') ?? 'none',
			promptTypes: this._messages.map(msg => `${msg.role}${'name' in msg && msg.name ? `-${msg.name}` : ''}:${msg.content.length}`).join(','),
			conversationId: this._sessionId,
			requestId: this.telemetryMessageId,
			languageId: this._documentContext.document.languageId,
			responseType: responseType,
			replyType: interactionOutcome.kind,
			model: this._endpoint.model,
			diagnosticsProvider: this._diagnosticsTelemetryData.diagnosticsProvider,
			diagnosticCodes: this._diagnosticsTelemetryData.fileDiagnosticsTelemetry.diagnosticCodes,
			selectionDiagnosticCodes: this._diagnosticsTelemetryData.selectionDiagnosticsTelemetry.diagnosticCodes,
			outcomeAnnotations: interactionOutcome.annotations?.map(a => a.label).join(','),
		} satisfies RequestInlineTelemetryProperties, {
			firstTurn: this._firstTurn ? 1 : 0,
			isNotebook: this._isNotebookDocument,
			withIntentDetection: this._request.enableCommandDetection ? 1 : 0,
			messageTokenCount: await this._endpoint.acquireTokenizer().tokenLength(this._request.prompt),
			promptTokenCount: await this._endpoint.acquireTokenizer().countMessagesTokens(this._messages),
			responseTokenCount: responseType === ChatFetchResponseType.Success ? await this._endpoint.acquireTokenizer().tokenLength(response) : -1,
			implicitCommand: (!this._request.prompt.trim().startsWith(`/${this._intent.id}`) ? 1 : 0),
			attemptCount: this._request.attempt || 0,
			selectionLineCount: Math.abs(this._documentContext.selection.end.line - this._documentContext.selection.start.line) + 1,
			wholeRangeLineCount: Math.abs(this._documentContext.wholeRange.end.line - this._documentContext.wholeRange.start.line) + 1,
			editCount: this._editCount > 0 ? this._editCount : -1,
			editLineCount: this._editLineCount > 0 ? this._editLineCount : -1,
			markdownCharCount: this._markdownCharCount,
			problemsCount: this._diagnosticsTelemetryData.fileDiagnosticsTelemetry.problemsCount,
			selectionProblemsCount: this._diagnosticsTelemetryData.selectionDiagnosticsTelemetry.problemsCount,
			diagnosticsCount: this._diagnosticsTelemetryData.fileDiagnosticsTelemetry.diagnosticsCount,
			selectionDiagnosticsCount: this._diagnosticsTelemetryData.selectionDiagnosticsTelemetry.diagnosticsCount,
			timeToRequest: this._requestStartTime - this._startTime,
			timeToFirstToken: this._firstTokenTime ? this._firstTokenTime - this._startTime : -1,
			timeToComplete: Date.now() - this._startTime,
			...getCustomInstructionTelemetry(this._references),
			temporalCtxFileCount: temporalContexData?.documentCount ?? -1,
			temporalCtxTotalCharCount: temporalContexData?.totalCharLength ?? -1
		} satisfies RequestInlineTelemetryMeasurements);
	}

	protected override  _sendResponseInternalTelemetryEvent(responseType: ChatFetchResponseType, response: string): void {
		this._telemetryService.sendInternalMSFTTelemetryEvent('interactiveSessionResponse', {
			chatLocation: 'inline',
			intent: this._intent.id,
			request: this._request.prompt,
			response,
			conversationId: this._sessionId,
			requestId: this.telemetryMessageId,
			baseModel: this._endpoint.model,
			responseType,
			problems: this._diagnosticsTelemetryData.fileDiagnosticsTelemetry.problems,
			selectionProblems: this._diagnosticsTelemetryData.selectionDiagnosticsTelemetry.problems,
			diagnosticCodes: this._diagnosticsTelemetryData.fileDiagnosticsTelemetry.diagnosticCodes,
			selectionDiagnosticCodes: this._diagnosticsTelemetryData.selectionDiagnosticsTelemetry.diagnosticCodes,
			diagnosticsProvider: this._diagnosticsTelemetryData.diagnosticsProvider,
			language: this._documentContext.document.languageId,
		} satisfies ResponseInternalInlineTelemetryProperties, {
			isNotebook: this._isNotebookDocument,
			turnNumber: this._conversation.turns.length,
		} satisfies ResponseInternalInlineTelemetryMeasurements);
	}
}
