/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type * as vscode from 'vscode';


export namespace Copilot {

	export type DocumentUri = string;

	export type Position = {
		line: number;
		character: number;
	}

	export type Range = {
		start: Position;
		end: Position;
	}

	/**
	* The ContextProvider API allows extensions to provide additional context items that
	* Copilot can use in its prompt. This file contains type definitions for the methods
	* and the data structures used by the API.
	*
	* Note: providing context is not enough to ensure that the context will be used in the prompt.
	*
	* The API is exposed as an export of the Copilot extension. To use it, you can cast the
	* exported object to the ContextProviderApiV1 interface.
	*
	* Example:
	* ```
	* const copilot = vscode.extensions.getExtension("github.copilot");
	* const contextProviderAPI = copilot.exports.getContextProviderAPI("v1") as ContextProviderApiV1;
	* ```
	*/
	export interface ContextProviderApiV1 {
		registerContextProvider<T extends SupportedContextItem>(provider: ContextProvider<T>): vscode.Disposable;
	}

	/**
	* Each extension can register a number of context providers, uniquely identified by their ID.
	* In addition, each provider has to provide:
	* - a DocumentSelector, to specify the file types for which the provider is active
	* - a ContextResolver, a function that returns the context items for a given request
	*
	* Example:
	* ```
	* contextProviderAPI.registerContextProvider<Trait>({
	*  id: "pythonProvider",
	*  selector: [{ language: "python" }],
	*  resolver: {
	*      resolve: async (request, token) => {
	*        return [{name: 'traitName', value: 'traitValue'}];
	*      }
	*  }
	* });
	* ```
	*/
	export interface ContextProvider<T extends SupportedContextItem> {
		id: string;
		selector: vscode.DocumentSelector;
		resolver: ContextResolver<T>;
	}

	export interface ContextResolver<T extends SupportedContextItem> {
		resolve(request: ResolveRequest, token: vscode.CancellationToken): Promise<T> | Promise<T[]> | AsyncIterable<T>;
		// Optional method to be invoked if the request timed out. This requests additional context items.
		resolveOnTimeout?(request: ResolveRequest): T | readonly T[] | undefined;
	}

	/**
	 * The first argument of the resolve method is a ResolveRequest object, which informs
	 * the provider about:
	 * - the completionId, a unique identifier for the completion request
	 * - the documentContext, which contains information about the document for which the context is requested
	 * - the activeExperiments, a map of active experiments and their values
	 * - the timeBudget the provider has to provide context items
	 * - the previousUsageStatistics, which contains information about the last request to the provider
	 */
	export type Status = 'full' | 'partial' | 'none';

	export type ContextUsageStatistics = {
		usage: Status;
		resolution: Status;
	};

	interface TextEdit {
		/**
		* The range of the text document to be manipulated. To insert
		* text into a document create a range where start === end.
		*/
		range: Range;
		/**
		* The string to be inserted. For delete operations use an
		* empty string.
		*/
		newText: string;
	}

	export type ProposedTextEdit = TextEdit & {
		positionAfterEdit: Position;
		// Indicates whether the edit is suggested by the IDE. Otherwise it's assumed to be speculative
		source?: 'selectedCompletionInfo';
	};

	export interface DocumentContext {
		uri: DocumentUri;
		languageId: string;
		version: number;
		// Position and offset are relative to the provided version of the document.
		// The position after an edit is applied is found in ProposedTextEdit.positionAfterEdit.
		/**
		 * @deprecated Use `position` instead.
		 */
		offset: number;
		position?: Position;
		proposedEdits?: ProposedTextEdit[];
	}
	export interface ResolveRequest {
		// A unique ID to correlate the request with the completion request.
		completionId: string;
		// Optional the opportunity ID provided by VS Code core.
		opportunityId?: string;

		documentContext: DocumentContext;

		activeExperiments: Map<string, string | number | boolean | string[]>;

		/**
		 * The number of milliseconds for the context provider to provide context items.
		 * After the time budget runs out, the request will be cancelled via the CancellationToken.
		 * Providers can use this value as a hint when computing context. Providers should expect the
		 * request to be cancelled once the time budget runs out.
		 *
		 * @deprecated Use `timeoutEnd` instead.
		 */
		timeBudget: number;

		/**
		 * Unix timestamp representing the exact time the request will be cancelled via the CancellationToken.
		 */
		timeoutEnd: number;

		/**
		 * Various statistics about the last completion request. This can be used by the context provider
		 * to make decisions about what context to provide for the current call.
		 */
		previousUsageStatistics?: ContextUsageStatistics;

		/**
		 * Data from completionItem
		 *
		 * See https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#completionItem
		 */
		data?: unknown;

		/**
		 * Allows specifying the source of the context item, e.g., 'nes'.
		 *
		 * @experimental
		 */
		source: string;
	}

	/**
	 * These are the data types that can be provided by a context provider. Any non-conforming
	 * context items will be filtered out.
	 */
	interface ContextItem {
		/**
		 * Specifies the relative importance with respect to items of the same type.
		 * Cross-type comparisons is currently handled by the wishlist.
		 * Accepted values are integers in the range [0, 100], where 100 is the highest importance.
		 * Items with non-conforming importance values will be filtered out.
		 * Default value is 0.
		 */
		importance?: number;
	}

	// A key-value pair used for short string snippets.
	export interface Trait extends ContextItem {
		name: string;
		value: string;
	}

	// Code snippet extracted from a file. The URI is used for content exclusion.
	export interface CodeSnippet extends ContextItem {
		uri: string;
		value: string;
		// Additional URIs that contribute the same code snippet.
		additionalUris?: string[];
	}

	export type SupportedContextItem = Trait | CodeSnippet;

}
