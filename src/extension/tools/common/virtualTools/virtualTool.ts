/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LanguageModelToolInformation } from 'vscode';
import { ISummarizedToolCategory } from './virtualToolTypes';

export const VIRTUAL_TOOL_NAME_PREFIX = 'activate_';

export interface IVirtualToolMetadata {
	toolsetKey: string;
	possiblePrefix?: string;
	groups: ISummarizedToolCategory[];
	preExpanded?: boolean;
}

export class VirtualTool {
	public isExpanded = false;

	constructor(
		public readonly name: string,
		public readonly description: string,
		public lastUsedOnTurn: number,
		public readonly metadata: IVirtualToolMetadata,
		public contents: (LanguageModelToolInformation | VirtualTool)[] = [],
	) {
		if (!name.startsWith(VIRTUAL_TOOL_NAME_PREFIX)) {
			throw new Error(`Virtual tool name must start with '${VIRTUAL_TOOL_NAME_PREFIX}'`);
		}
	}

	public cloneWithPrefix(prefix: string) {
		return new VirtualTool(VIRTUAL_TOOL_NAME_PREFIX + prefix + this.name.slice(VIRTUAL_TOOL_NAME_PREFIX.length), this.description, this.lastUsedOnTurn, { ...this.metadata, possiblePrefix: undefined }, this.contents);
	}

	/**
	 * Looks up a tool. Update the {@link lastUsedOnTurn} of all virtual tools
	 * it touches.
	 */
	public find(name: string): undefined | {
		tool: VirtualTool | LanguageModelToolInformation;
		path: VirtualTool[];
	} {
		if (this.name === name) {
			return { tool: this, path: [] };
		}

		for (const content of this.contents) {
			if (content instanceof VirtualTool) {
				const found = content.find(name);
				if (found) {
					found.path.unshift(this);
					return found;
				}
			} else {
				if (content.name === name) {
					return { tool: content, path: [this] };
				}
			}
		}

		return undefined;
	}

	/**
	 * Gets the tool with the lowest {@link lastUsedOnTurn} that is expanded.
	 */
	public getLowestExpandedTool(): VirtualTool | undefined {
		let lowest: VirtualTool | undefined;

		for (const tool of this.all()) {
			if (tool instanceof VirtualTool && tool.isExpanded) {
				if (!lowest || tool.lastUsedOnTurn < lowest.lastUsedOnTurn) {
					lowest = tool;
				}
			}
		}

		return lowest;
	}

	public *all(): Iterable<LanguageModelToolInformation | VirtualTool> {
		yield this;
		for (const content of this.contents) {
			if (content instanceof VirtualTool) {
				yield* content.all();
			} else {
				yield content;
			}
		}
	}

	public *tools(): Iterable<LanguageModelToolInformation> {
		if (!this.isExpanded) {
			yield {
				name: this.name,
				description: this.description,
				inputSchema: undefined,
				source: undefined,
				tags: [],
			};
			return;
		}

		for (const content of this.contents) {
			if (content instanceof VirtualTool) {
				yield* content.tools();
			} else {
				yield content;
			}
		}
	}
}
