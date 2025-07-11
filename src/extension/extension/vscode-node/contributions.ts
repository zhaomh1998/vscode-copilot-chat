/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AuthenticationContrib } from '../../authentication/vscode-node/authentication.contribution';
import { BYOKContrib } from '../../byok/vscode-node/byokContribution';
import { ChatQuotaContribution } from '../../chat/vscode-node/chatQuota.contribution';
import * as chatBlockLanguageContribution from '../../codeBlocks/vscode-node/chatBlockLanguageFeatures.contribution';
import { IExtensionContributionFactory, asContributionFactory } from '../../common/contributions';
import { ConfigurationMigrationContribution } from '../../configuration/vscode-node/configurationMigration';
import { ContextKeysContribution } from '../../contextKeys/vscode-node/contextKeys.contribution';
import { AiMappedEditsContrib } from '../../conversation/vscode-node/aiMappedEditsContrib';
import { ConversationFeature } from '../../conversation/vscode-node/conversationFeature';
import { FeedbackCommandContribution } from '../../conversation/vscode-node/feedbackContribution';
import { LanguageModelAccess } from '../../conversation/vscode-node/languageModelAccess';
import { LogWorkspaceStateContribution } from '../../conversation/vscode-node/logWorkspaceState';
import { RemoteAgentContribution } from '../../conversation/vscode-node/remoteAgents';
import { WalkthroughCommandContribution } from '../../getting-started/vscode-node/commands';
import * as newWorkspaceContribution from '../../getting-started/vscode-node/newWorkspace.contribution';
import { IgnoredFileProviderContribution } from '../../ignore/vscode-node/ignoreProvider';
import { InlineChatHintFeature } from '../../inlineChat/vscode-node/inlineChatHint';
import { InlineEditProviderFeature } from '../../inlineEdits/vscode-node/inlineEditProviderFeature';
import { FixTestFailureContribution } from '../../intents/vscode-node/fixTestFailureContributions';
import { TestGenLensContribution } from '../../intents/vscode-node/testGenLens';
import { LoggingActionsContrib } from '../../log/vscode-node/loggingActions';
import { RequestLogTree } from '../../log/vscode-node/requestLogTree';
import { McpSetupCommands } from '../../mcp/vscode-node/commands';
import { NotebookFollowCommands } from '../../notebook/vscode-node/followActions';
import { CopilotDebugCommandContribution } from '../../onboardDebug/vscode-node/copilotDebugCommandContribution';
import { OnboardTerminalTestsContribution } from '../../onboardDebug/vscode-node/onboardTerminalTestsContribution';
import { DebugCommandsContribution } from '../../prompt/vscode-node/debugCommands';
import { RenameSuggestionsContrib } from '../../prompt/vscode-node/renameSuggestions';
import { RelatedFilesProviderContribution } from '../../relatedFiles/vscode-node/relatedFiles.contribution';
import { SearchPanelCommands } from '../../search/vscode-node/commands';
import { SettingsSchemaFeature } from '../../settingsSchema/vscode-node/settingsSchemaFeature';
import { SurveyCommandContribution } from '../../survey/vscode-node/surveyCommands';
import { SetupTestsContribution } from '../../testing/vscode/setupTestContributions';
import { ToolsContribution } from '../../tools/vscode-node/tools';
import { InlineCompletionContribution } from '../../typescriptContext/vscode-node/languageContextService';
import * as workspaceChunkSearchContribution from '../../workspaceChunkSearch/node/workspaceChunkSearch.contribution';
import * as workspaceIndexingContribution from '../../workspaceChunkSearch/vscode-node/workspaceChunkSearch.contribution';
import { WorkspaceRecorderFeature } from '../../workspaceRecorder/vscode-node/workspaceRecorderFeature';
import { WebSocketContribution } from '../../websocket/vscode-node/websocket.contribution';
import vscodeContributions from '../vscode/contributions';

// ###################################################################################################
// ###                                                                                             ###
// ###                   Node contributions run ONLY in node.js extension host.                    ###
// ###                                                                                             ###
// ### !!! Prefer to list contributions in ../vscode/contributions.ts to support them anywhere !!! ###
// ###                                                                                             ###
// ###################################################################################################

export const vscodeNodeContributions: IExtensionContributionFactory[] = [
	...vscodeContributions,
	asContributionFactory(ConversationFeature),
	workspaceChunkSearchContribution,
	asContributionFactory(AuthenticationContrib),
	chatBlockLanguageContribution,
	asContributionFactory(LoggingActionsContrib),
	asContributionFactory(ContextKeysContribution),
	asContributionFactory(CopilotDebugCommandContribution),
	asContributionFactory(DebugCommandsContribution),
	asContributionFactory(LanguageModelAccess),
	asContributionFactory(WalkthroughCommandContribution),
	asContributionFactory(InlineEditProviderFeature),
	asContributionFactory(SettingsSchemaFeature),
	asContributionFactory(WorkspaceRecorderFeature),
	asContributionFactory(SurveyCommandContribution),
	asContributionFactory(FeedbackCommandContribution),
	asContributionFactory(InlineCompletionContribution),
	asContributionFactory(SearchPanelCommands),
	asContributionFactory(ChatQuotaContribution),
	asContributionFactory(NotebookFollowCommands),
	asContributionFactory(WebSocketContribution),
	workspaceIndexingContribution,
];

/**
 * These contributions are special in that they are only instantiated
 * when the user is logged in and chat is enabled.
 * Anything that contributes a copilot chat feature that doesn't need
 * to run when chat is not enabled should be added here.
*/
export const vscodeNodeChatContributions: IExtensionContributionFactory[] = [
	asContributionFactory(ConfigurationMigrationContribution),
	asContributionFactory(TestGenLensContribution),
	asContributionFactory(RequestLogTree),
	asContributionFactory(InlineChatHintFeature),
	asContributionFactory(OnboardTerminalTestsContribution),
	asContributionFactory(ToolsContribution),
	asContributionFactory(RemoteAgentContribution),
	asContributionFactory(AiMappedEditsContrib),
	asContributionFactory(RenameSuggestionsContrib),
	asContributionFactory(LogWorkspaceStateContribution),
	asContributionFactory(SetupTestsContribution),
	asContributionFactory(FixTestFailureContribution),
	asContributionFactory(IgnoredFileProviderContribution),
	asContributionFactory(RelatedFilesProviderContribution),
	asContributionFactory(BYOKContrib),
	asContributionFactory(McpSetupCommands),
	newWorkspaceContribution,
];
