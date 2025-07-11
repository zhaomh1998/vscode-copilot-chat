/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { Raw } from '@vscode/prompt-tsx';
import type { CancellationToken, ChatRequest, ChatResponseReferencePart, ChatResponseStream, ChatResult, LanguageModelToolInformation, Progress } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IAuthenticationChatUpgradeService } from '../../../platform/authentication/common/authenticationUpgrade';
import { CanceledResult, ChatFetchResponseType, ChatLocation, ChatResponse, getErrorDetailsFromChatFetchError } from '../../../platform/chat/common/commonTypes';
import { IConversationOptions } from '../../../platform/chat/common/conversationOptions';
import { IEditSurvivalTrackerService, IEditSurvivalTrackingSession, NullEditSurvivalTrackingSession } from '../../../platform/editSurvivalTracking/common/editSurvivalTrackerService';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { HAS_IGNORED_FILES_MESSAGE } from '../../../platform/ignore/common/ignoreService';
import { ILogService } from '../../../platform/log/common/logService';
import { FinishedCallback, OptionalChatRequestParams } from '../../../platform/networking/common/fetch';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { ISurveyService } from '../../../platform/survey/common/surveyService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { ChatResponseStreamImpl } from '../../../util/common/chatResponseStreamImpl';
import { isCancellationError } from '../../../util/vs/base/common/errors';
import { Event } from '../../../util/vs/base/common/event';
import { DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { mixin } from '../../../util/vs/base/common/objects';
import { assertType } from '../../../util/vs/base/common/types';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseMarkdownPart, ChatResponseProgressPart, ChatResponseTextEditPart, LanguageModelToolResult2 } from '../../../vscodeTypes';
import { CodeBlocksMetadata, CodeBlockTrackingChatResponseStream } from '../../codeBlocks/node/codeBlockProcessor';
import { CopilotInteractiveEditorResponse, InteractionOutcomeComputer } from '../../inlineChat/node/promptCraftingTypes';
import { PauseController } from '../../intents/node/pauseController';
import { EmptyPromptError, isToolCallLimitCancellation, IToolCallingBuiltPromptEvent, IToolCallingLoopOptions, IToolCallingResponseEvent, IToolCallLoopResult, ToolCallingLoop, ToolCallLimitBehavior } from '../../intents/node/toolCallingLoop';
import { UnknownIntent } from '../../intents/node/unknownIntent';
import { ResponseStreamWithLinkification } from '../../linkify/common/responseStreamWithLinkification';
import { SummarizedConversationHistoryMetadata } from '../../prompts/node/agent/summarizedConversationHistory';
import { normalizeToolSchema } from '../../tools/common/toolSchemaNormalizer';
import { ToolCallCancelledError } from '../../tools/common/toolsService';
import { WebSocketService } from '../../websocket/node/websocketService';
import { Conversation, getUniqueReferences, GlobalContextMessageMetadata, IResultMetadata, RenderedUserMessageMetadata, RequestDebugInformation, ResponseStreamParticipant, Turn, TurnStatus } from '../common/conversation';
import { IBuildPromptContext, IToolCallRound } from '../common/intents';
import { ChatTelemetry, ChatTelemetryBuilder } from './chatParticipantTelemetry';
import { IntentInvocationMetadata } from './conversation';
import { IDocumentContext } from './documentContext';
import { IBuildPromptResult, IIntent, IIntentInvocation, IResponseProcessor } from './intents';
import { ConversationalBaseTelemetryData, createTelemetryWithId, sendModelMessageTelemetry } from './telemetry';

export interface IDefaultIntentRequestHandlerOptions {
	maxToolCallIterations: number;
	/**
	 * Whether to ask the user if they want to continue when the tool call limit
	 * is exceeded. Defaults to true.
	 */
	confirmOnMaxToolIterations?: boolean;
	temperature?: number;
	overrideRequestLocation?: ChatLocation;
	hideRateLimitTimeEstimate?: boolean;
}

/*
* Handles a single chat-request via an intent-invocation.
*/
export class DefaultIntentRequestHandler {

	private readonly turn: Turn;

	private _editSurvivalTracker: IEditSurvivalTrackingSession = new NullEditSurvivalTrackingSession();
	private _loop!: DefaultToolCallingLoop;

	constructor(
		private readonly intent: IIntent,
		private readonly conversation: Conversation,
		protected readonly request: ChatRequest,
		protected readonly stream: ChatResponseStream,
		private readonly token: CancellationToken,
		protected readonly documentContext: IDocumentContext | undefined,
		private readonly location: ChatLocation,
		private readonly chatTelemetryBuilder: ChatTelemetryBuilder,
		private readonly handlerOptions: IDefaultIntentRequestHandlerOptions = { maxToolCallIterations: 15 },
		private readonly onPaused: Event<boolean>, // todo: use a PauseController instead
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IConversationOptions private readonly options: IConversationOptions,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@ILogService private readonly _logService: ILogService,
		@ISurveyService private readonly _surveyService: ISurveyService,
		@IRequestLogger private readonly _requestLogger: IRequestLogger,
		@IEditSurvivalTrackerService private readonly _editSurvivalTrackerService: IEditSurvivalTrackerService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
	) {
		// Initialize properties
		this.turn = conversation.getLatestTurn();
	}

	async getResult(): Promise<ChatResult> {
		if (isToolCallLimitCancellation(this.request)) {
			// Just some friendly text instead of an empty message on cancellation:
			this.stream.markdown(l10n.t("Let me know if there's anything else I can help with!"));
			return {};
		}

		try {
			if (this.token.isCancellationRequested) {
				return CanceledResult;
			}

			this._logService.logger.trace('Processing intent');
			const intentInvocation = await this.intent.invoke({ location: this.location, documentContext: this.documentContext, request: this.request });
			if (this.token.isCancellationRequested) {
				return CanceledResult;
			}
			this._logService.logger.trace('Processed intent');

			this.turn.setMetadata(new IntentInvocationMetadata(intentInvocation));

			const confirmationResult = await this.handleConfirmationsIfNeeded();
			if (confirmationResult) {
				return confirmationResult;
			}

			const resultDetails = await this._requestLogger.captureInvocation(this.request, () => this.runWithToolCalling(intentInvocation));

			let chatResult = resultDetails.chatResult || {};
			this._surveyService.signalUsage(`${this.location === ChatLocation.Editor ? 'inline' : 'panel'}.${this.intent.id}`, this.documentContext?.document.languageId);

			const responseMessage = resultDetails.toolCallRounds.at(-1)?.response ?? '';
			const metadataFragment: Partial<IResultMetadata> = {
				toolCallRounds: resultDetails.toolCallRounds,
				toolCallResults: this._collectRelevantToolCallResults(resultDetails.toolCallRounds, resultDetails.toolCallResults),
			};
			mixin(chatResult, { metadata: metadataFragment }, true);
			const baseModelTelemetry = createTelemetryWithId();
			chatResult = await this.processResult(resultDetails.response, responseMessage, chatResult, metadataFragment, baseModelTelemetry, resultDetails.toolCallRounds);
			if (chatResult.errorDetails && intentInvocation.modifyErrorDetails) {
				chatResult.errorDetails = intentInvocation.modifyErrorDetails(chatResult.errorDetails, resultDetails.response);
			}

			if (resultDetails.hadIgnoredFiles) {
				this.stream.markdown(HAS_IGNORED_FILES_MESSAGE);
			}

			return chatResult;
		} catch (err: any) {
			if (err instanceof ToolCallCancelledError) {
				this.turn.setResponse(TurnStatus.Cancelled, { message: err.message, type: 'meta' }, undefined, {});
				return {};
			} else if (isCancellationError(err)) {
				return CanceledResult;
			} else if (err instanceof EmptyPromptError) {
				return {};
			}

			this._logService.logger.error(err);
			this._telemetryService.sendGHTelemetryException(err, 'Error');
			const errorMessage = (<Error>err).message;
			const chatResult = { errorDetails: { message: errorMessage } };
			this.turn.setResponse(TurnStatus.Error, { message: errorMessage, type: 'meta' }, undefined, chatResult);
			return chatResult;
		}
	}

	private _collectRelevantToolCallResults(toolCallRounds: IToolCallRound[], toolCallResults: Record<string, LanguageModelToolResult2>): Record<string, LanguageModelToolResult2> | undefined {
		const resultsUsedInThisTurn: Record<string, LanguageModelToolResult2> = {};
		for (const round of toolCallRounds) {
			for (const toolCall of round.toolCalls) {
				resultsUsedInThisTurn[toolCall.id] = toolCallResults[toolCall.id];
			}
		}

		return Object.keys(resultsUsedInThisTurn).length ? resultsUsedInThisTurn : undefined;
	}

	private _sendInitialChatReferences({ result: buildPromptResult }: IToolCallingBuiltPromptEvent) {
		const [includedVariableReferences, ignoredVariableReferences] = [getUniqueReferences(buildPromptResult.references), getUniqueReferences(buildPromptResult.omittedReferences)].map((refs) => refs.reduce((acc, ref) => {
			if ('variableName' in ref.anchor) {
				acc.add(ref.anchor.variableName);
			}
			return acc;
		}, new Set<string>()));
		for (const reference of buildPromptResult.references) {
			// Report variables which were partially sent to the model
			const options = reference.options ?? ('variableName' in reference.anchor && ignoredVariableReferences.has(reference.anchor.variableName)
				? { status: { kind: 2, description: l10n.t('Part of this attachment was not sent to the model due to context window limitations.') } }
				: undefined);
			if (!reference.options?.isFromTool) {
				// References reported by a tool result will be shown in a separate list, don't need to be reported as references
				this.stream.reference2(reference.anchor, undefined, options);
			}
		}
		for (const omittedReference of buildPromptResult.omittedReferences) {
			if ('variableName' in omittedReference.anchor && !includedVariableReferences.has(omittedReference.anchor.variableName)) {
				this.stream.reference2(omittedReference.anchor, undefined, { status: { kind: 3, description: l10n.t('This attachment was not sent to the model due to context window limitations.') } });
			}
		}
	}

	private makeResponseStreamParticipants(intentInvocation: IIntentInvocation): ResponseStreamParticipant[] {
		const participants: ResponseStreamParticipant[] = [];

		// 1. Tracking of code blocks. Currently used in stests. todo@connor4312:
		// can we simplify this so it's not used otherwise?
		participants.push(stream => {
			const codeBlockTrackingResponseStream = this._instantiationService.createInstance(CodeBlockTrackingChatResponseStream, stream, intentInvocation.codeblocksRepresentEdits);
			return ChatResponseStreamImpl.spy(
				codeBlockTrackingResponseStream,
				v => v,
				() => {
					const codeBlocksMetaData = codeBlockTrackingResponseStream.finish();
					this.turn.setMetadata(codeBlocksMetaData);
				}
			);
		});

		// 2. Track the survival of edits made in the editor
		if (this.documentContext && this.location === ChatLocation.Editor) {
			participants.push(stream => {
				const firstTurnWithAIEditCollector = this.conversation.turns.find(turn => turn.getMetadata(CopilotInteractiveEditorResponse)?.editSurvivalTracker);
				this._editSurvivalTracker = firstTurnWithAIEditCollector?.getMetadata(CopilotInteractiveEditorResponse)?.editSurvivalTracker ?? this._editSurvivalTrackerService.initialize(this.documentContext!.document.document);
				return ChatResponseStreamImpl.spy(stream, value => {
					if (value instanceof ChatResponseTextEditPart) {
						this._editSurvivalTracker.collectAIEdits(value.edits);
					}
				});
			});
		}


		// 3. Track the survival of other(?) interactions
		// todo@connor4312: can these two streams be combined?
		const interactionOutcomeComputer = new InteractionOutcomeComputer(this.documentContext?.document.uri);
		participants.push(stream => interactionOutcomeComputer.spyOnStream(stream));

		// 4. Linkify the stream unless told otherwise
		if (!intentInvocation.linkification?.disable) {
			participants.push(stream => {
				const linkStream = this._instantiationService.createInstance(ResponseStreamWithLinkification, { requestId: this.turn.id, references: this.turn.references }, stream, intentInvocation.linkification?.additionaLinkifiers ?? [], this.token);
				return ChatResponseStreamImpl.spy(linkStream, p => p, () => {
					this._loop.telemetry.markAddedLinks(linkStream.totalAddedLinkCount);
				});
			});
		}

		// 5. General telemetry on emitted components
		participants.push(stream => ChatResponseStreamImpl.spy(stream, (part) => {
			if (part instanceof ChatResponseMarkdownPart) {
				this._loop.telemetry.markEmittedMarkdown(part.value);
			}
			if (part instanceof ChatResponseTextEditPart) {
				this._loop.telemetry.markEmittedEdits(part.uri, part.edits);
			}
		}));

		return participants;
	}

	private async _onDidReceiveResponse({ response, toolCalls, interactionOutcome }: IToolCallingResponseEvent) {
		const responseMessage = (response.type === ChatFetchResponseType.Success ? response.value : '');
		await this._loop.telemetry.sendTelemetry(response.requestId, response.type, responseMessage, interactionOutcome.interactionOutcome, toolCalls);

		if (this.documentContext) {
			this.turn.setMetadata(new CopilotInteractiveEditorResponse(
				'ok',
				interactionOutcome.store,
				{ ...this.documentContext, intent: this.intent, query: this.request.prompt },
				this.chatTelemetryBuilder.telemetryMessageId,
				this._loop.telemetry,
				this._editSurvivalTracker,
			));

			const documentText = this.documentContext?.document.getText();
			this.turn.setMetadata(new RequestDebugInformation(
				this.documentContext.document.uri,
				this.intent.id,
				this.documentContext.document.languageId,
				documentText!,
				this.request.prompt,
				this.documentContext.selection
			));
		}
	}

	private async runWithToolCalling(intentInvocation: IIntentInvocation): Promise<IInternalRequestResult> {
		const store = new DisposableStore();
		const loop = this._loop = store.add(this._instantiationService.createInstance(
			DefaultToolCallingLoop,
			{
				conversation: this.conversation,
				intent: this.intent,
				invocation: intentInvocation,
				toolCallLimit: this.handlerOptions.maxToolCallIterations,
				onHitToolCallLimit: this.handlerOptions.confirmOnMaxToolIterations !== false
					? ToolCallLimitBehavior.Confirm : ToolCallLimitBehavior.Stop,
				request: this.request,
				documentContext: this.documentContext,
				streamParticipants: this.makeResponseStreamParticipants(intentInvocation),
				temperature: this.handlerOptions.temperature ?? this.options.temperature,
				location: this.location,
				overrideRequestLocation: this.handlerOptions.overrideRequestLocation,
				interactionContext: this.documentContext?.document.uri,
				responseProcessor: typeof intentInvocation.processResponse === 'function' ? intentInvocation as IResponseProcessor : undefined,
			},
			this.chatTelemetryBuilder,
		));

		store.add(Event.once(loop.onDidBuildPrompt)(this._sendInitialChatReferences, this));

		// We need to wait for all response handlers to finish before
		// we can dispose the store. This is because the telemetry machine
		// still needs the tokenizers to count tokens. There was a case in vitests
		// in which the store, and the tokenizers, were disposed before the telemetry
		// machine could count the tokens, which resulted in an error.
		// src/extension/prompt/node/chatParticipantTelemetry.ts#L521-L522
		//
		// cc @lramos15
		const responseHandlers: Promise<any>[] = [];
		store.add(loop.onDidReceiveResponse(res => {
			const promise = this._onDidReceiveResponse(res);
			responseHandlers.push(promise);
			return promise;
		}, this));

		const pauseCtrl = store.add(new PauseController(this.onPaused, this.token));

		try {
			const result = await loop.run(this.stream, pauseCtrl);
			if (!result.round.toolCalls.length || result.response.type !== ChatFetchResponseType.Success) {
				loop.telemetry.sendToolCallingTelemetry(result.toolCallRounds, result.availableToolCount, this.token.isCancellationRequested ? 'cancelled' : result.response.type);
			}
			result.chatResult ??= {};
			if ((result.chatResult.metadata as IResultMetadata)?.maxToolCallsExceeded) {
				loop.telemetry.sendToolCallingTelemetry(result.toolCallRounds, result.availableToolCount, 'maxToolCalls');
			}

			// TODO need proper typing for all chat metadata and a better pattern to build it up from random places
			result.chatResult = this.resultWithMetadatas(result.chatResult);
			return { ...result, lastRequestTelemetry: loop.telemetry };
		} finally {
			await Promise.allSettled(responseHandlers);
			store.dispose();
		}
	}

	private resultWithMetadatas(chatResult: ChatResult | undefined): ChatResult | undefined {
		const codeBlocks = this.turn.getMetadata(CodeBlocksMetadata);
		const summarizedConversationHistory = this.turn.getMetadata(SummarizedConversationHistoryMetadata);
		const renderedUserMessageMetadata = this.turn.getMetadata(RenderedUserMessageMetadata);
		const globalContextMetadata = this.turn.getMetadata(GlobalContextMessageMetadata);
		return codeBlocks || summarizedConversationHistory || renderedUserMessageMetadata || globalContextMetadata ?
			{
				...chatResult,
				metadata: {
					...chatResult?.metadata,
					...codeBlocks,
					...summarizedConversationHistory && { summary: summarizedConversationHistory },
					...renderedUserMessageMetadata,
					...globalContextMetadata,
				} satisfies Partial<IResultMetadata>,
			} : chatResult;
	}

	private async handleConfirmationsIfNeeded(): Promise<ChatResult | undefined> {
		const intentInvocation = this.turn.getMetadata(IntentInvocationMetadata)?.value;
		assertType(intentInvocation);
		if ((this.request.acceptedConfirmationData?.length || this.request.rejectedConfirmationData?.length) && intentInvocation.confirmationHandler) {
			await intentInvocation.confirmationHandler(this.request.acceptedConfirmationData, this.request.rejectedConfirmationData, this.stream);
			return {};
		}
	}

	private async processSuccessfulFetchResult(appliedText: string, requestId: string, chatResult: ChatResult, baseModelTelemetry: ConversationalBaseTelemetryData, rounds: IToolCallRound[]): Promise<ChatResult> {
		if (appliedText.length === 0 && !rounds.some(r => r.toolCalls.length)) {
			const message = l10n.t('The model unexpectedly did not return a response, which may indicate a service issue. Please report a bug.');
			this.turn.setResponse(TurnStatus.Error, { type: 'meta', message }, baseModelTelemetry.properties.messageId, chatResult);
			return {
				errorDetails: {
					message
				},
			};
		}

		this.turn.setResponse(TurnStatus.Success, { type: 'model', message: appliedText }, baseModelTelemetry.properties.messageId, chatResult);
		baseModelTelemetry.markAsDisplayed();
		sendModelMessageTelemetry(
			this._telemetryService,
			this.conversation,
			this.location,
			appliedText,
			requestId,
			this.documentContext?.document,
			baseModelTelemetry
		);

		return chatResult;
	}

	private processOffTopicFetchResult(baseModelTelemetry: ConversationalBaseTelemetryData): ChatResult {
		// Create starting off topic telemetry and mark event as issued and displayed
		this.stream.markdown(this.options.rejectionMessage);
		this.turn.setResponse(TurnStatus.OffTopic, { message: this.options.rejectionMessage, type: 'offtopic-detection' }, baseModelTelemetry.properties.messageId, {});
		return {};
	}

	private async processResult(fetchResult: ChatResponse, responseMessage: string, chatResult: ChatResult | void, metadataFragment: Partial<IResultMetadata>, baseModelTelemetry: ConversationalBaseTelemetryData, rounds: IToolCallRound[]): Promise<ChatResult> {
		switch (fetchResult.type) {
			case ChatFetchResponseType.Success: {
				console.log(`[MESSAGE-Success] ${responseMessage}`);

				// Stream success message to WebSocket
				const wsService = WebSocketService.getInstance();
				if (wsService) {
					wsService.broadcast({
						type: 'message_success',
						timestamp: new Date().toISOString(),
						content: responseMessage
					});
				}

				return await this.processSuccessfulFetchResult(responseMessage, fetchResult.requestId, chatResult ?? {}, baseModelTelemetry, rounds);
			}
			case ChatFetchResponseType.OffTopic:
				console.log(`[MESSAGE-OffTopic] ${responseMessage}`);
				return this.processOffTopicFetchResult(baseModelTelemetry);
			case ChatFetchResponseType.Canceled: {
				console.log(`[MESSAGE-Canceled] ${responseMessage}`);
				const errorDetails = getErrorDetailsFromChatFetchError(fetchResult, (await this._authenticationService.getCopilotToken()).copilotPlan);
				const chatResult = { errorDetails, metadata: metadataFragment };
				this.turn.setResponse(TurnStatus.Cancelled, { message: errorDetails.message, type: 'user' }, baseModelTelemetry.properties.messageId, chatResult);
				return chatResult;
			}
			case ChatFetchResponseType.QuotaExceeded:
			case ChatFetchResponseType.RateLimited: {
				console.log(`[MESSAGE-Quota] ${responseMessage}`);
				const errorDetails = getErrorDetailsFromChatFetchError(fetchResult, (await this._authenticationService.getCopilotToken()).copilotPlan, this.handlerOptions.hideRateLimitTimeEstimate);
				const chatResult = { errorDetails, metadata: metadataFragment };
				this.turn.setResponse(TurnStatus.Error, undefined, baseModelTelemetry.properties.messageId, chatResult);
				return chatResult;
			}
			case ChatFetchResponseType.BadRequest:
			case ChatFetchResponseType.Failed: {
				console.log(`[MESSAGE-Failed] ${responseMessage}`);
				const errorDetails = getErrorDetailsFromChatFetchError(fetchResult, (await this._authenticationService.getCopilotToken()).copilotPlan);
				const chatResult = { errorDetails, metadata: metadataFragment };
				this.turn.setResponse(TurnStatus.Error, { message: errorDetails.message, type: 'server' }, baseModelTelemetry.properties.messageId, chatResult);
				return chatResult;
			}
			case ChatFetchResponseType.Filtered: {
				console.log(`[MESSAGE-Filtered] ${responseMessage}`);
				const errorDetails = getErrorDetailsFromChatFetchError(fetchResult, (await this._authenticationService.getCopilotToken()).copilotPlan);
				const chatResult = { errorDetails, metadata: metadataFragment };
				this.turn.setResponse(TurnStatus.Filtered, undefined, baseModelTelemetry.properties.messageId, chatResult);
				return chatResult;
			}
			case ChatFetchResponseType.AgentUnauthorized: {
				console.log(`[MESSAGE-AgentUnauthorized] ${responseMessage}`);
				const chatResult = {};
				this.turn.setResponse(TurnStatus.Error, undefined, baseModelTelemetry.properties.messageId, chatResult);
				return chatResult;
			}
			case ChatFetchResponseType.AgentFailedDependency: {
				console.log(`[MESSAGE-AgentFailedDependency] ${responseMessage}`);
				const errorDetails = getErrorDetailsFromChatFetchError(fetchResult, (await this._authenticationService.getCopilotToken()).copilotPlan);
				const chatResult = { errorDetails, metadata: metadataFragment };
				this.turn.setResponse(TurnStatus.Error, undefined, baseModelTelemetry.properties.messageId, chatResult);
				return chatResult;
			}
			case ChatFetchResponseType.Length: {
				console.log(`[MESSAGE-Length] ${responseMessage}`);
				const errorDetails = getErrorDetailsFromChatFetchError(fetchResult, (await this._authenticationService.getCopilotToken()).copilotPlan);
				const chatResult = { errorDetails, metadata: metadataFragment };
				this.turn.setResponse(TurnStatus.Error, undefined, baseModelTelemetry.properties.messageId, chatResult);
				return chatResult;
			}
			case ChatFetchResponseType.NotFound: // before we had `NotFound`, it would fall into Unknown, so behavior should be consistent
			case ChatFetchResponseType.Unknown: {
				console.log(`[MESSAGE-Unknown] ${responseMessage}`);
				const errorDetails = getErrorDetailsFromChatFetchError(fetchResult, (await this._authenticationService.getCopilotToken()).copilotPlan);
				const chatResult = { errorDetails, metadata: metadataFragment };
				this.turn.setResponse(TurnStatus.Error, undefined, baseModelTelemetry.properties.messageId, chatResult);
				return chatResult;
			}
			case ChatFetchResponseType.ExtensionBlocked: {
				console.log(`[MESSAGE-ExtensionBlocked] ${responseMessage}`);
				const errorDetails = getErrorDetailsFromChatFetchError(fetchResult, (await this._authenticationService.getCopilotToken()).copilotPlan);
				const chatResult = { errorDetails, metadata: metadataFragment };
				// This shouldn't happen, only 3rd party extensions should be blocked
				this.turn.setResponse(TurnStatus.Error, undefined, baseModelTelemetry.properties.messageId, chatResult);
				return chatResult;
			}
		}
	}
}

interface IInternalRequestResult {
	response: ChatResponse;
	round: IToolCallRound;
	chatResult?: ChatResult; // TODO should just be metadata
	hadIgnoredFiles: boolean;
	lastRequestMessages: Raw.ChatMessage[];
	lastRequestTelemetry: ChatTelemetry;
	availableToolCount: number;
}

interface IDefaultToolLoopOptions extends IToolCallingLoopOptions {
	invocation: IIntentInvocation;
	intent: IIntent;
	documentContext: IDocumentContext | undefined;
	location: ChatLocation;
	temperature: number;
	overrideRequestLocation?: ChatLocation;
}

class DefaultToolCallingLoop extends ToolCallingLoop<IDefaultToolLoopOptions> {
	public telemetry!: ChatTelemetry;
	constructor(
		options: IDefaultToolLoopOptions,
		telemetryBuilder: ChatTelemetryBuilder,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService logService: ILogService,
		@IRequestLogger requestLogger: IRequestLogger,
		@IEndpointProvider endpointProvider: IEndpointProvider,
		@IAuthenticationChatUpgradeService authenticationChatUpgradeService: IAuthenticationChatUpgradeService,
		@ITelemetryService telemetryService: ITelemetryService,
	) {
		super(options, instantiationService, endpointProvider, logService, requestLogger, authenticationChatUpgradeService, telemetryService);

		this._register(this.onDidBuildPrompt(({ result, tools, promptTokenLength }) => {
			this.telemetry = telemetryBuilder.makeRequest(
				options.intent!,
				options.location,
				options.conversation,
				result.messages,
				promptTokenLength,
				result.references,
				options.invocation.endpoint,
				result.telemetryData ?? [],
				tools.length
			);
		}));
	}

	protected override async buildPrompt(buildPromptContext: IBuildPromptContext, progress: Progress<ChatResponseReferencePart | ChatResponseProgressPart>, token: CancellationToken): Promise<IBuildPromptResult> {
		const buildPromptResult = await this.options.invocation.buildPrompt(buildPromptContext, progress, token);
		this.fixMessageNames(buildPromptResult.messages);
		return buildPromptResult;
	}

	protected override async fetch(messages: Raw.ChatMessage[], finishedCb: FinishedCallback, requestOptions: OptionalChatRequestParams, firstFetchCall: boolean, token: CancellationToken): Promise<ChatResponse> {
		const messageSourcePrefix = this.options.location === ChatLocation.Editor ? 'inline' : 'chat';
		return this.options.invocation.endpoint.makeChatRequest(
			`${ChatLocation.toStringShorter(this.options.location)}/${this.options.intent?.id}`,
			messages,
			(...args) => {
				this.telemetry.markReceivedToken();
				return finishedCb(...args);
			},
			token,
			this.options.overrideRequestLocation ?? this.options.location,
			undefined,
			{
				...requestOptions,
				tools: normalizeToolSchema(
					this.options.invocation.endpoint.family,
					requestOptions.tools,
					(tool, rule) => {
						this._logService.logger.warn(`Tool ${tool} failed validation: ${rule}`);
					},
				),
				temperature: this.calculateTemperature(),
			},
			firstFetchCall, // The first tool call is user initiated and then the rest are just considered part of the loop
			{
				messageId: this.telemetry.telemetryMessageId,
				conversationId: this.options.conversation.sessionId,
				messageSource: this.options.intent?.id && this.options.intent.id !== UnknownIntent.ID ? `${messageSourcePrefix}.${this.options.intent.id}` : `${messageSourcePrefix}.user`,
			},
			{ intent: true }
		);
	}

	protected override async getAvailableTools(): Promise<LanguageModelToolInformation[]> {
		return this.options.invocation.getAvailableTools?.() ?? [];
	}

	private fixMessageNames(messages: Raw.ChatMessage[]): void {
		messages.forEach(m => {
			if (m.role !== Raw.ChatRole.System && 'name' in m && m.name === this.options.intent?.id) {
				// Assistant messages from the current intent should not have 'name' set.
				// It's not well-documented how this works in OpenAI models but this seems to be the expectation
				m.name = undefined;
			}
		});
	}

	private calculateTemperature(): number {
		if (this.options.request.attempt > 0) {
			return Math.min(
				this.options.temperature * (this.options.request.attempt + 1),
				2 /* MAX temperature - https://platform.openai.com/docs/api-reference/chat/create#chat/create-temperature */
			);
		} else {
			return this.options.temperature;
		}
	}
}

interface IInternalRequestResult extends IToolCallLoopResult {
	lastRequestTelemetry: ChatTelemetry;
}
