/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken, Disposable, TextDocument } from 'vscode';
import { Copilot } from '../../../platform/inlineCompletions/common/api';
import { createServiceIdentifier } from '../../../util/common/services';
import { ContextItem } from '../../languageServer/common/languageContextService';

export const ILanguageContextProviderService = createServiceIdentifier<ILanguageContextProviderService>('ILanguageContextProviderService');

export interface ILanguageContextProviderService {
	readonly _serviceBrand: undefined;

	registerContextProvider<T extends Copilot.SupportedContextItem>(provider: Copilot.ContextProvider<T>): Disposable;

	getContextProviders(doc: TextDocument): Copilot.ContextProvider<Copilot.SupportedContextItem>[];

	getContextItems(doc: TextDocument, request: Copilot.ResolveRequest, cancellationToken: CancellationToken): AsyncIterable<ContextItem>;

	getContextItemsOnTimeout(doc: TextDocument, request: Copilot.ResolveRequest): ContextItem[];
}
