/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type tt from 'typescript/lib/tsserverlibrary';

export type DocumentUri = string;
export type FilePath = string;

export enum CacheScopeKind {
	/**
	 * The cache entry is still valid for the file.
	 */
	File = 'file',
	/**
	 * The cache entry is valid as long as changes to the file happen
	 * inside of the specific range.
	 */
	WithinRange = 'withinRange',
	/**
	 * The change entry is valid as long as changes to the file happen
	 * outside of the specific range.
	 */
	OutsideRange = 'outsideRange',
	/**
	 * The cache entry is valid as long as the neighbor files don't change.
	 */
	NeighborFiles = 'neighborFiles'
}

export type FileCacheScope = {
	kind: CacheScopeKind.File;
}
export type NeighborFilesCacheScope = {
	kind: CacheScopeKind.NeighborFiles;
}

export type Position = {
	line: number;
	character: number;
}

export type Range = {
	start: Position;
	end: Position;
}

export type WithinRangeCacheScope = {
	kind: CacheScopeKind.WithinRange;
	range: Range;
}

export type OutsideRangeCacheScope = {
	kind: CacheScopeKind.OutsideRange;
	ranges: Range[];
}

export type CacheScope = FileCacheScope | NeighborFilesCacheScope | WithinRangeCacheScope | OutsideRangeCacheScope;

export type ContextItemKey = string;
export enum EmitMode {
	ClientBased = 'clientBased',
	ClientBasedOnTimeout = 'clientBasedOnTimeout'
	// ServerBased = 'serverBased'
}
export type CacheInfo = {
	emitMode: EmitMode;
	scope: CacheScope;
}
export namespace CacheInfo {
	export type has = { cache: CacheInfo };
	export function has(item: any): item is has {
		return item.cache !== undefined;
	}
}
export type CachedContextItem = {
	key: ContextItemKey;
	sizeInChars?: number;
}
export namespace CachedContextItem {
	export function create(key: ContextItemKey, sizeInChars?: number): CachedContextItem {
		return { key, sizeInChars };
	}
}

/**
 * Different supported context item kinds.
 */
export enum ContextKind {
	Reference = 'reference',
	RelatedFile = 'relatedFile',
	Snippet = 'snippet',
	Trait = 'trait',
}

export type ContextItemReference = {
	kind: ContextKind.Reference;
	key: ContextItemKey;
};
export namespace ContextItemReference {
	export function create(key: ContextItemKey): ContextItemReference {
		return { kind: ContextKind.Reference, key };
	}
}

export enum Priorities {
	Locals = 1,
	Inherited = 0.9,
	Properties = 0.8,
	Blueprints = 0.7,
	Imports = 0.6,
	NeighborFiles = 0.55,
	Globals = 0.5,
	Traits = 0.4,
}

export enum SpeculativeKind {
	emit = 'emit',
	ignore = 'ignore'
}

/**
 * A related file context.
 */
export type RelatedFile = {
	kind: ContextKind.RelatedFile;
	key?: string;
	fileName: FilePath;
	range?: Range;
};

export enum TraitKind {
	Unknown = 'unknown',
	Module = 'module',
	ModuleResolution = 'moduleResolution',
	Lib = 'lib',
	Target = 'target',
	Version = 'version'
}

/**
 * A trait context.
 */
export type Trait = {
	kind: ContextKind.Trait;

	/**
	 * An optional key for the trait, used for caching purposes.
	 */
	key: string;

	/**
	 * The trait name.
	 */
	name: string;

	/**
	 * The trait value.
	 */
	value: string;
};
export namespace Trait {
	export function create(traitKind: TraitKind, name: string, value: string): Trait {
		return { kind: ContextKind.Trait, key: createContextItemKey(traitKind), name, value };
	}
	export function sizeInChars(trait: Trait): number {
		return trait.name.length + trait.value.length;
	}
	export function createContextItemKey(traitKind: TraitKind): string {
		return JSON.stringify({ k: ContextKind.Trait, tk: traitKind }, undefined, 0);
	}
}

/**
 * A snippet context.
 */
export type CodeSnippet = {
	kind: ContextKind.Snippet;

	/**
	 * An optional key for the snippet, used for caching purposes.
	 */
	key?: string;

	/**
	 * The primary file name.
	 */
	fileName: FilePath;

	/**
	 * Additional URIs
	 */
	additionalFileNames?: FilePath[];

	/**
	 * The snippet value.
	 */
	value: string;
};
export namespace CodeSnippet {
	export function create(key: string | undefined, fileName: FilePath, additionalFileNames: FilePath[] | undefined, value: string): CodeSnippet {
		return { kind: ContextKind.Snippet, key, fileName, additionalFileNames, value };
	}
	export function sizeInChars(snippet: CodeSnippet): number {
		let result: number = snippet.value.length;
		// +3 for "// " at the beginning of the line.
		result += snippet.fileName.length + 3;
		if (snippet.additionalFileNames !== undefined) {
			for (const fileName of snippet.additionalFileNames) {
				result += fileName.length + 3;
			}
		}
		return result;
	}
}

export type FullContextItem = RelatedFile | Trait | CodeSnippet;
export type ContextItem = FullContextItem | ContextItemReference;
export namespace ContextItem {
	export type keyed = { key: ContextItemKey } & ContextItem;
	export function hasKey(item: ContextItem): item is { key: ContextItemKey } & ContextItem {
		return (item as { key: ContextItemKey }).key !== undefined;
	}
	export function sizeInChars(item: ContextItem): number {
		switch (item.kind) {
			case ContextKind.Trait:
				return Trait.sizeInChars(item);
			case ContextKind.Snippet:
				return CodeSnippet.sizeInChars(item);
			default:
				return 0;
		}
	}
}

export type PriorityTag = {
	priority: number;
}

export enum ContextRunnableState {
	Created = 'created',
	InProgress = 'inProgress',
	IsFull = 'isFull',
	Finished = 'finished'
}

export type ContextRunnableResultId = string;
export enum ContextRunnableResultKind {
	ComputedResult = 'computedResult',
	CacheEntry = 'cacheEntry',
	Reference = 'reference'
}
export type ContextRunnableResult = {

	kind: ContextRunnableResultKind.ComputedResult;

	/**
	 * The id of the context compute runnable that computed
	 * this state.
	 */
	id: ContextRunnableResultId;

	/**
	 * The state of the computation.
	 */
	state: ContextRunnableState;

	/**
	 * Priorities of the items.
	 */
	priority: number;

	/**
	 * The items.
	 */
	items: ContextItem[];

	/**
	 * Information about how items can be cached.
	 */
	cache?: CacheInfo;

	/**
	 * Whether the runnable result can be used in a speculative request with the same
	 * document and position.
	 */
	speculativeKind: SpeculativeKind;
}

export type CachedContextRunnableResult = {

	kind: ContextRunnableResultKind.CacheEntry;

	/**
	 * The id of the context compute runnable that computed
	 * this state.
	 */
	id: ContextRunnableResultId;

	/**
	 * The state of the computation.
	 */
	state: ContextRunnableState;

	/**
	 * The items.
	 */
	items: CachedContextItem[];

	/**
	 * The cache information of the runnable.
	 */
	cache?: CacheInfo;
}

export type ContextRunnableResultReference = {

	kind: ContextRunnableResultKind.Reference;

	/**
	 * The id of the context compute runnable that computed
	 * this state.
	 */
	id: ContextRunnableResultId;
}

export type ContextRunnableResultTypes = ContextRunnableResult | ContextRunnableResultReference;

export type ErrorData = {
	code: number;
	message: string;
};
export namespace ErrorData {
	export function create(code: number, message: string): ErrorData {
		return { code, message };
	}
}

export type Timings = {
	totalTime: number;
	computeTime: number;
}
export namespace Timings {
	export function create(totalTime: number, computeTime: number): Timings {
		return { totalTime, computeTime };
	}
}

export enum ContextRequestResultState {
	Created = 'created',
	InProgress = 'inProgress',
	Cancelled = 'cancelled',
	Finished = 'finished'
}

export type ContextRequestResult = {

	state: ContextRequestResultState;

	/**
	 * The AST node path to the cursor location in the source file.
	 */
	path?: number[];

	/**
	 * The errors that occurred during the computation.
	 */
	errors?: ErrorData[];

	/**
	 * The timing if captured during the computation.
	 */
	timings?: Timings;

	/**
	 * Whether the requested got auto canceled due to a timeout.
	 */
	timedOut: boolean;

	/**
	 * Whether the token budget was exhausted.
	 */
	exhausted: boolean;

	/**
	 * The runnable results if any.
	 */
	runnableResults?: ContextRunnableResultTypes[];

	/**
	 * New server side context items that were computed.
	 */
	contextItems?: ContextItem[];
}

export interface ComputeContextRequestArgs extends tt.server.protocol.FileLocationRequestArgs {
	startTime: number;
	timeBudget?: number;
	tokenBudget?: number;
	neighborFiles?: FilePath[];
	clientSideRunnableResults?: CachedContextRunnableResult[];
}

export interface ComputeContextRequest extends tt.server.protocol.Request {
	arguments?: ComputeContextRequestArgs;
}

export enum ErrorCode {
	noArguments = 'noArguments',
	noProject = 'noProject',
	noProgram = 'noProgram',
	invalidArguments = 'invalidArguments',
	invalidPosition = 'invalidPosition',
	exception = 'exception',
}

export type ComputeContextResponse = (tt.server.protocol.Response & {
	body: ComputeContextResponse.OK | ComputeContextResponse.Failed;
}) | { type: 'cancelled' };

export namespace ComputeContextResponse {

	export type OK = ContextRequestResult;

	export type Failed = {
		error: ErrorCode;
		message: string;
		stack?: string;
	};

	export function isCancelled(response: ComputeContextResponse): boolean {
		return (response.type === 'cancelled');
	}

	export function isOk(response: ComputeContextResponse): response is tt.server.protocol.Response & { body: OK } {
		return response.type === 'response' && (response.body as any).state !== undefined;
	}
	export function isError(response: ComputeContextResponse): response is tt.server.protocol.Response & { body: Failed } {
		return response.type === 'response' && (response.body as any).error !== undefined;
	}
}

export interface PingResponse extends tt.server.protocol.Response {
	body: PingResponse.OK | PingResponse.Error;
}

export namespace PingResponse {
	export type OK = {
		kind: 'ok';
		session: boolean;
		supported: boolean;
		version?: string;
	};
	export type Error = {
		kind: 'error';
		message: string;
		stack?: string;
	};
}