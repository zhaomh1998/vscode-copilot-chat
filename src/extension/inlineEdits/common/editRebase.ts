/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SingleEdits } from '../../../platform/inlineEdits/common/dataTypes/edit';
import * as errors from '../../../util/common/errors';
import { ITracer } from '../../../util/common/tracing';
import { AnnotatedStringEdit, AnnotatedStringReplacement, IEditData, StringEdit, StringReplacement, VoidEditData } from '../../../util/vs/editor/common/core/edits/stringEdit';
import { OffsetRange } from '../../../util/vs/editor/common/core/ranges/offsetRange';
import { StringText } from '../../../util/vs/editor/common/core/text/abstractText';
import { DefaultLinesDiffComputer } from '../../../util/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer';
import { ILinesDiffComputerOptions } from '../../../util/vs/editor/common/diff/linesDiffComputer';

const TROUBLESHOOT_EDIT_CONSISTENCY = false;

export interface NesRebaseConfigs {
}

export class EditDataWithIndex implements IEditData<EditDataWithIndex> {
	constructor(
		public readonly index: number
	) { }

	join(data: EditDataWithIndex): EditDataWithIndex | undefined {
		if (this.index !== data.index) {
			return undefined;
		}
		return this;
	}
}

export function tryRebase(originalDocument: string, editWindow: OffsetRange | undefined, originalEdits: readonly StringReplacement[], detailedEdits: AnnotatedStringReplacement<EditDataWithIndex>[][], userEditSince: StringEdit, currentDocumentContent: string, currentSelection: readonly OffsetRange[], resolution: 'strict' | 'lenient', tracer: ITracer, nesConfigs: NesRebaseConfigs = {}): { rebasedEdit: StringReplacement; rebasedEditIndex: number }[] | 'outsideEditWindow' | 'rebaseFailed' | 'error' | 'inconsistentEdits' {
	const start = Date.now();
	try {
		return _tryRebase(originalDocument, editWindow, originalEdits, detailedEdits, userEditSince, currentDocumentContent, currentSelection, resolution, tracer, nesConfigs);
	} catch (err) {
		tracer.trace(`Rebase error: ${errors.toString(err)}`);
		return 'error';
	} finally {
		tracer.trace(`Rebase duration: ${Date.now() - start}ms`);
	}
}

function _tryRebase(originalDocument: string, editWindow: OffsetRange | undefined, originalEdits: readonly StringReplacement[], detailedEdits: AnnotatedStringReplacement<EditDataWithIndex>[][], userEditSinceOrig: StringEdit, currentDocumentContent: string, currentSelection: readonly OffsetRange[], resolution: 'strict' | 'lenient', tracer: ITracer, nesConfigs: NesRebaseConfigs) {
	if (!checkEditConsistency(originalDocument, userEditSinceOrig, currentDocumentContent, tracer, true)) {
		return 'inconsistentEdits';
	}
	const userEditSince = userEditSinceOrig.removeCommonSuffixAndPrefix(originalDocument);
	const cursorRange = currentSelection[0];
	if (editWindow && cursorRange) {
		const updatedEditWindow = userEditSince.applyToOffsetRangeOrUndefined(editWindow);
		if (!updatedEditWindow?.containsRange(cursorRange)) {
			return 'outsideEditWindow';
		}
	}
	if (detailedEdits.length < originalEdits.length) {
		let intermediateDocument = originalDocument;
		for (let index = 0; index < detailedEdits.length; index++) {
			const edit = originalEdits[index];
			intermediateDocument = StringEdit.single(edit).apply(intermediateDocument);
		}
		for (let index = detailedEdits.length; index < originalEdits.length; index++) {
			const edit = originalEdits[index];
			const editData = new EditDataWithIndex(index);
			detailedEdits[index] = computeDiff(edit.replaceRange.substring(intermediateDocument), edit.newText, edit.replaceRange.start, editData, {
				ignoreTrimWhitespace: false,
				computeMoves: false,
				extendToSubwords: true,
				maxComputationTimeMs: 500,
			}) || [new AnnotatedStringReplacement(edit.replaceRange, edit.newText, editData)];
			intermediateDocument = StringEdit.single(edit).apply(intermediateDocument);
		}
	}
	const diffedEdit = AnnotatedStringEdit.compose(detailedEdits.map(edits => AnnotatedStringEdit.create(edits)));
	const rebasedEdit = tryRebaseEdits(originalDocument, diffedEdit, userEditSince, resolution, nesConfigs);
	if (!rebasedEdit) {
		return 'rebaseFailed';
	}
	const grouped = rebasedEdit.replacements.reduce((acc, item) => {
		(acc[item.data.index] ||= []).push(item);
		return acc;
	}, [] as (AnnotatedStringReplacement<EditDataWithIndex>[] | undefined)[]);
	const resultEdits: { rebasedEdit: StringReplacement; rebasedEditIndex: number }[] = [];
	for (let index = 0; index < grouped.length; index++) {
		const group = grouped[index];
		if (!group) {
			continue;
		}
		const range = OffsetRange.fromTo(group[0].replaceRange.start, group[group.length - 1].replaceRange.endExclusive);
		const newText = group.map((edit, i, a) => {
			if (i > 0) {
				return currentDocumentContent.substring(a[i - 1].replaceRange.endExclusive, edit.replaceRange.start) + edit.newText;
			} else {
				return edit.newText;
			}
		}).join('');
		const resultEdit = StringReplacement.replace(range, newText);
		if (!resultEdit.removeCommonSuffixAndPrefix(currentDocumentContent).isEmpty) {
			resultEdits.push({ rebasedEdit: resultEdit, rebasedEditIndex: index });
		}
	}
	if (resolution === 'strict' && resultEdits.length > 0 && new SingleEdits(originalEdits).apply(originalDocument) !== StringEdit.create(resultEdits.map(r => r.rebasedEdit)).apply(currentDocumentContent)) {
		tracer.trace('Result consistency check failed.');
		return 'inconsistentEdits';
	}
	return resultEdits;
}

export function checkEditConsistency(original: string, edit: StringEdit, current: string, tracer: ITracer, enabled = TROUBLESHOOT_EDIT_CONSISTENCY) {
	if (!enabled) {
		return true;
	}
	const consistent = edit.apply(original) === current;
	if (!consistent) {
		tracer.trace('Edit consistency check failed.');
	}
	return consistent;
}

export function tryRebaseStringEdits<T extends IEditData<T>>(content: string, ours: StringEdit, base: StringEdit, resolution: 'strict' | 'lenient', nesConfigs: NesRebaseConfigs = {}): StringEdit | undefined {
	return tryRebaseEdits(content, ours.mapData(r => new VoidEditData()), base, resolution, nesConfigs)?.toStringEdit();
}

function tryRebaseEdits<T extends IEditData<T>>(content: string, ours: AnnotatedStringEdit<T>, baseOrig: StringEdit, resolution: 'strict' | 'lenient', nesConfigs: NesRebaseConfigs): AnnotatedStringEdit<T> | undefined {
	const base = baseOrig.removeCommonSuffixAndPrefix(content);

	const newEdits: AnnotatedStringReplacement<T>[] = [];

	let baseIdx = 0;
	let ourIdx = 0;
	let offset = 0;

	while (ourIdx < ours.replacements.length || baseIdx < base.replacements.length) {
		// take the edit that starts first
		const baseEdit = base.replacements[baseIdx];
		const ourEdit = ours.replacements[ourIdx];

		if (!ourEdit) {
			if (resolution === 'strict') {
				// baseEdit does not match but interleaves
				return undefined;
			}
			// We processed all our edits
			break;
		} else if (!baseEdit) {
			// no more edits from base
			newEdits.push(ourEdit.delta(offset));
			ourIdx++;
		} else {
			let ourE = ourEdit;
			if (!ourE.replaceRange.containsRange(baseEdit.replaceRange)) {
				// Try to shift our edit to include the base edit.
				if (ourE.replaceRange.start > baseEdit.replaceRange.start) {
					// Expand our edit to the left to include the base edit.
					const added = content.substring(baseEdit.replaceRange.start, ourE.replaceRange.start);
					const updated = added + ourE.newText;
					// Remove the same text from the right.
					if (updated.endsWith(added)) {
						ourE = new AnnotatedStringReplacement(
							OffsetRange.fromTo(baseEdit.replaceRange.start, ourE.replaceRange.endExclusive - added.length),
							updated.substring(0, updated.length - added.length),
							ourE.data,
						);
					}
				}
				// Skipping the case where there is another edit for now because we might have to merge with it first.
				else if (ourIdx === ours.replacements.length - 1 && ourE.replaceRange.endExclusive < baseEdit.replaceRange.endExclusive) {
					// Expand our edit to the right to include the base edit.
					const added = content.substring(ourE.replaceRange.endExclusive, baseEdit.replaceRange.endExclusive);
					const updated = ourE.newText + added;
					// Remove the same text from the left.
					if (updated.startsWith(added)) {
						ourE = new AnnotatedStringReplacement(
							OffsetRange.fromTo(ourE.replaceRange.start + added.length, baseEdit.replaceRange.endExclusive),
							updated.substring(added.length),
							ourE.data,
						);
					}
				}
			}
			if (ourE.replaceRange.intersectsOrTouches(baseEdit.replaceRange)) {
				if (ourE.replaceRange.containsRange(baseEdit.replaceRange) && ourE.newText.length >= baseEdit.newText.length) {
					let delta = 0;
					let ourNewTextOffset = 0;
					let baseE = baseEdit;
					let previousBaseE: StringReplacement | undefined;
					while (baseE && ourE.replaceRange.containsRange(baseE.replaceRange)) {
						ourNewTextOffset = agreementIndexOf(content, ourE, baseE, previousBaseE, ourNewTextOffset, resolution, nesConfigs);
						if (ourNewTextOffset === -1) {
							// Conflicting
							return undefined;
						}
						delta += baseE.newText.length - baseE.replaceRange.length;
						previousBaseE = baseE;
						baseE = base.replacements[++baseIdx];
					}
					newEdits.push(new AnnotatedStringReplacement(
						new OffsetRange(ourE.replaceRange.start + offset, ourE.replaceRange.endExclusive + offset + delta),
						ourE.newText,
						ourE.data,
					));
					ourIdx++;
					offset += delta;
				} else {
					// Conflicting
					return undefined;
				}
			} else if (ourEdit.replaceRange.start < baseEdit.replaceRange.start) {
				// Our edit starts first
				newEdits.push(new AnnotatedStringReplacement(
					ourEdit.replaceRange.delta(offset),
					ourEdit.newText,
					ourEdit.data,
				));
				ourIdx++;
			} else {
				if (resolution === 'strict') {
					// baseEdit does not match but interleaves
					return undefined;
				}
				baseIdx++;
				offset += baseEdit.newText.length - baseEdit.replaceRange.length;
			}
		}
	}

	return AnnotatedStringEdit.create(newEdits);
}

export const maxAgreementOffset = 10; // If the user's typing is more than this into the suggestion we consider it a miss.
export const maxImperfectAgreementLength = 5; // If the user's typing is longer than this and the suggestion is not a perfect match we consider it a miss.

function agreementIndexOf<T extends IEditData<T>>(content: string, ourE: AnnotatedStringReplacement<T>, baseE: StringReplacement, previousBaseE: StringReplacement | undefined, ourNewTextOffset: number, resolution: 'strict' | 'lenient', nesConfigs: NesRebaseConfigs) {
	const minStart = previousBaseE ? previousBaseE.replaceRange.endExclusive : ourE.replaceRange.start;
	if (minStart < baseE.replaceRange.start) {
		baseE = new StringReplacement(
			OffsetRange.fromTo(minStart, baseE.replaceRange.endExclusive),
			content.substring(minStart, baseE.replaceRange.start) + baseE.newText
		);
	}
	const j = ourE.newText.indexOf(baseE.newText, ourNewTextOffset);
	if (resolution === 'strict' && j > maxAgreementOffset) {
		return -1;
	}
	if (resolution === 'strict' && j > 0 && baseE.newText.length > maxImperfectAgreementLength) {
		return -1;
	}
	return j !== -1 ? j + baseE.newText.length : -1;
}

function computeDiff(original: string, modified: string, offset: number, editData: EditDataWithIndex, options: ILinesDiffComputerOptions): AnnotatedStringReplacement<EditDataWithIndex>[] | undefined {
	const originalLines = original.split(/\r\n|\r|\n/);
	const modifiedLines = modified.split(/\r\n|\r|\n/);
	const diffComputer = new DefaultLinesDiffComputer();
	const result = diffComputer.computeDiff(originalLines, modifiedLines, options);
	if (result.hitTimeout) {
		return undefined;
	}

	const originalText = new StringText(original);
	const modifiedText = new StringText(modified);
	return result.changes.map(change => (change.innerChanges || []).map(innerChange => {
		const range = originalText.getTransformer().getOffsetRange(innerChange.originalRange);
		const newText = modifiedText.getValueOfRange(innerChange.modifiedRange);
		return new AnnotatedStringReplacement(range.delta(offset), newText, editData);
	})).flat();
}
