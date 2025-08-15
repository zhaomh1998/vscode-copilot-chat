/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { HARD_TOOL_LIMIT } from '../../../../platform/configuration/common/configurationService';

/** Point after which we'll start grouping tools */
export const START_GROUPING_AFTER_TOOL_COUNT = HARD_TOOL_LIMIT / 2; // 64, currently

/** Re-expand groups until we have at least this many tools. */
export const EXPAND_UNTIL_COUNT = START_GROUPING_AFTER_TOOL_COUNT;
/**
 * If we have an opportunity to re-collapse during summarization, do so if the
 * number of tools exceeds this threshold.
 */
export const TRIM_THRESHOLD = HARD_TOOL_LIMIT * 3 / 4; // 96, currently

/**
 * By default we group all MCP/extension tools together. If the number of tools
 * the toolset contains is above this limit, we'll instead categorize tools
 * within the toolset into groups.
 */
export const GROUP_WITHIN_TOOLSET = HARD_TOOL_LIMIT / 8; // 16, currently

/** Minimum number of tools in a toolset to group, vs always just including them individually. */
export const MIN_TOOLSET_SIZE_TO_GROUP = 2;

/** Max number of times to retrying categorization in the event of failures. */
export const MAX_CATEGORIZATION_RETRIES = 3;

/** Name for the group containing tools that could not be automatically categorized */
export const UNCATEGORIZED_TOOLS_GROUP_NAME = 'uncategorized_tools';

/** Summary for the group containing tools that could not be automatically categorized */
export const UNCATEGORIZED_TOOLS_GROUP_SUMMARY = 'Tools that could not be automatically categorized into existing groups.';
