/** move-analysis.js
 * Author: Piyush Soni
 * Moved-code ("Analyze moves") runtime for Better GitHub.
 *
 * This file is a standalone runtime module: it owns all data structures,
 * algorithms, styles, and DOM rendering for the "Analyze moves" feature on
 * the Files changed page. It is loaded before better-github.user.js in both
 * dual targets (see manifest.json content_scripts and the @require line in
 * better-github.user.js) and exposes a single namespaced API on
 * window.BetterGitHubMoveAnalysis.
 *
 * better-github.user.js resolves this module as an optional dependency and
 * wires it up through initialize()/runForCurrentPage(), passing in small
 * callbacks (getPullRequestInfo, getFilePathFromRegion, isFilesChangedView,
 * autoLoadLargeFileDiffs, isEnabled) rather than duplicating that general PR
 * parsing / settings logic here.
 */

(function () {
    'use strict';

    if (window.BetterGitHubMoveAnalysis) {
        return;
    }

    const MOVE_ANCHOR_LINE_COUNT = 3;
    const MOVE_MINIMUM_LINE_COUNT = 4;
    const MOVE_MINIMUM_ALPHANUMERIC_COUNT = 40;
    const MOVE_MAXIMUM_ANCHOR_OCCURRENCES = 8;
    const MOVE_MAXIMUM_SUBSTANTIVE_GAP_LINES = 12;
    const MOVE_MAXIMUM_CHANGED_GAP_LINES = 3;
    const MOVE_MAXIMUM_RAW_GAP_LINES = 50;
    const MOVE_MAXIMUM_LINE_COUNT_DRIFT = 2;
    const MOVE_MINIMUM_EXACT_RATIO = 0.8;
    const MOVE_REQUEST_TIMEOUT_MS = 60000;
    const MOVE_FORCE_LOAD_WINDOW_MS = 15000;
    const MOVE_NAVIGATION_WAIT_MS = 5000;
    const MOVE_NAVIGATION_POLL_MS = 100;

    let moveAnalysisState = null;
    let movesStylesInjected = false;

    // Callbacks supplied by better-github.user.js through initialize(). Kept
    // as narrow, explicit dependencies instead of reaching into the main
    // script's globals.
    let dependencies = {
        getPullRequestInfo: () => null,
        getFilePathFromRegion: () => null,
        isFilesChangedView: () => false,
        autoLoadLargeFileDiffs: () => {},
        isEnabled: () => false
    };

    function decodeGitQuotedPath(pathText) {
        const quotedPath = pathText.replace(/^"|"$/g, '');
        const bytes = [];
        const textEncoder = new TextEncoder();
        const escapedCharacters = {
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
            v: '\v',
            '"': '"',
            '\\': '\\'
        };

        for (let index = 0; index < quotedPath.length; index += 1) {
            const character = quotedPath[index];
            if (character !== '\\' || index + 1 >= quotedPath.length) {
                bytes.push(...textEncoder.encode(character));
                continue;
            }

            const escapedCharacter = quotedPath[index + 1];
            if (/[0-7]/.test(escapedCharacter)) {
                const octalMatch = quotedPath.slice(index + 1).match(/^[0-7]{1,3}/);
                bytes.push(parseInt(octalMatch[0], 8));
                index += octalMatch[0].length;
                continue;
            }

            const decodedCharacter = escapedCharacters[escapedCharacter] ?? escapedCharacter;
            bytes.push(...textEncoder.encode(decodedCharacter));
            index += 1;
        }

        return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
    }

    function parseUnifiedDiffPath(pathText) {
        let result = (pathText || '').trim();
        if (!result || result === '/dev/null') {
            return null;
        }

        if (result.startsWith('"')) {
            result = decodeGitQuotedPath(result);
        } else {
            result = result.split('\t')[0];
        }

        return result.replace(/^[ab]\//, '');
    }

    function normalizedMoveLine(lineText) {
        return (lineText || '').replace(/\s+$/, '').replace(/^[\t ]+/, '');
    }

    function moveLineStrength(lineText) {
        let strength = 0;
        for (const character of lineText || '') {
            if (/[A-Za-z0-9_$]/.test(character)) {
                strength += 1;
            }
        }
        return strength;
    }

    function isSubstantiveMoveLine(line) {
        return Boolean(line && line.normalizedText);
    }

    function countSubstantiveMoveLines(lines, startIndex = 0, endIndex = lines.length) {
        let count = 0;
        for (let index = startIndex; index < endIndex; index += 1) {
            if (isSubstantiveMoveLine(lines[index])) {
                count += 1;
            }
        }
        return count;
    }

    function parseUnifiedDiff(diffText) {
        const files = [];
        const deletedRuns = [];
        const addedRuns = [];
        const lines = (diffText || '').split('\n');
        let currentFile = null;
        let currentDeletedRun = null;
        let currentAddedRun = null;
        let oldLineNumber = 0;
        let newLineNumber = 0;
        let inHunk = false;
        let runId = 0;

        const finishRuns = () => {
            currentDeletedRun = null;
            currentAddedRun = null;
        };

        const finishFile = () => {
            finishRuns();
            if (currentFile) {
                files.push(currentFile);
                currentFile = null;
            }
        };

        const appendChangedLine = (type, text, lineNumber) => {
            const runCollection = type === 'deleted' ? deletedRuns : addedRuns;
            let currentRun = type === 'deleted' ? currentDeletedRun : currentAddedRun;
            if (!currentRun) {
                currentRun = {
                    id: `${type}-${runId++}`,
                    type,
                    file: currentFile,
                    lines: []
                };
                runCollection.push(currentRun);
                if (type === 'deleted') {
                    currentDeletedRun = currentRun;
                } else {
                    currentAddedRun = currentRun;
                }
            }

            const line = {
                text,
                normalizedText: normalizedMoveLine(text),
                strength: moveLineStrength(normalizedMoveLine(text)),
                lineNumber,
                run: currentRun,
                runIndex: currentRun.lines.length
            };
            currentRun.lines.push(line);
        };

        lines.forEach(line => {
            if (line.startsWith('diff --git ')) {
                finishFile();
                currentFile = {
                    oldPath: null,
                    newPath: null,
                    deletedRuns: [],
                    addedRuns: []
                };
                inHunk = false;
                return;
            }

            if (!currentFile) {
                return;
            }

            if (!inHunk && line.startsWith('--- ')) {
                currentFile.oldPath = parseUnifiedDiffPath(line.slice(4));
                return;
            }

            if (!inHunk && line.startsWith('+++ ')) {
                currentFile.newPath = parseUnifiedDiffPath(line.slice(4));
                return;
            }

            const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (hunkMatch) {
                finishRuns();
                oldLineNumber = Number(hunkMatch[1]);
                newLineNumber = Number(hunkMatch[2]);
                inHunk = true;
                return;
            }

            if (!inHunk || line.startsWith('\\ No newline at end of file')) {
                return;
            }

            if (line.startsWith('-')) {
                currentAddedRun = null;
                appendChangedLine('deleted', line.slice(1), oldLineNumber);
                oldLineNumber += 1;
                return;
            }

            if (line.startsWith('+')) {
                currentDeletedRun = null;
                appendChangedLine('added', line.slice(1), newLineNumber);
                newLineNumber += 1;
                return;
            }

            finishRuns();
            if (line.startsWith(' ')) {
                oldLineNumber += 1;
                newLineNumber += 1;
            }
        });

        finishFile();

        deletedRuns.forEach(run => {
            run.file.deletedRuns.push(run);
        });
        addedRuns.forEach(run => {
            run.file.addedRuns.push(run);
        });

        return {
            files,
            deletedRuns,
            addedRuns,
            diffLineCount: lines.length
        };
    }

    function moveAnchorKey(run, startIndex) {
        const anchorLines = run.lines.slice(startIndex, startIndex + MOVE_ANCHOR_LINE_COUNT);
        if (anchorLines.length !== MOVE_ANCHOR_LINE_COUNT) {
            return null;
        }

        return anchorLines.map(line => line.normalizedText).join('\u0000');
    }

    function expandMoveCandidate(deletedRun, deletedStart, addedRun, addedStart) {
        let sourceStart = deletedStart;
        let destinationStart = addedStart;
        let sourceEnd = deletedStart + MOVE_ANCHOR_LINE_COUNT - 1;
        let destinationEnd = addedStart + MOVE_ANCHOR_LINE_COUNT - 1;

        while (sourceStart > 0
            && destinationStart > 0
            && deletedRun.lines[sourceStart - 1].normalizedText === addedRun.lines[destinationStart - 1].normalizedText) {
            sourceStart -= 1;
            destinationStart -= 1;
        }

        while (sourceEnd + 1 < deletedRun.lines.length
            && destinationEnd + 1 < addedRun.lines.length
            && deletedRun.lines[sourceEnd + 1].normalizedText === addedRun.lines[destinationEnd + 1].normalizedText) {
            sourceEnd += 1;
            destinationEnd += 1;
        }

        while (sourceStart <= sourceEnd
            && !isSubstantiveMoveLine(deletedRun.lines[sourceStart])) {
            sourceStart += 1;
            destinationStart += 1;
        }

        const sourceLines = deletedRun.lines.slice(sourceStart, sourceEnd + 1);
        const substantiveLineCount = countSubstantiveMoveLines(sourceLines);
        const alphanumericCount = sourceLines.reduce(
            (total, line) => total + line.strength,
            0
        );

        if (substantiveLineCount < MOVE_MINIMUM_LINE_COUNT
            || alphanumericCount < MOVE_MINIMUM_ALPHANUMERIC_COUNT) {
            return null;
        }

        return {
            deletedRun,
            addedRun,
            sourceStart,
            sourceEnd,
            destinationStart,
            destinationEnd,
            lineCount: sourceLines.length,
            substantiveLineCount,
            alphanumericCount,
            blockKey: sourceLines.map(line => line.normalizedText).join('\u0000')
        };
    }

    function rangesOverlap(firstStart, firstEnd, secondStart, secondEnd) {
        return firstStart <= secondEnd && secondStart <= firstEnd;
    }

    function selectExactMoveMatches(parsedDiff) {
        const addedAnchorIndex = new Map();
        const coveredAnchorStartsByDiagonal = new Map();
        parsedDiff.addedRuns.forEach(run => {
            for (let index = 0; index <= run.lines.length - MOVE_ANCHOR_LINE_COUNT; index += 1) {
                const key = moveAnchorKey(run, index);
                if (!key) {
                    continue;
                }

                const occurrences = addedAnchorIndex.get(key) || [];
                if (occurrences.length <= MOVE_MAXIMUM_ANCHOR_OCCURRENCES) {
                    occurrences.push({ run, index });
                    addedAnchorIndex.set(key, occurrences);
                }
            }
        });

        const candidateMap = new Map();
        parsedDiff.deletedRuns.forEach(deletedRun => {
            for (let deletedIndex = 0; deletedIndex <= deletedRun.lines.length - MOVE_ANCHOR_LINE_COUNT; deletedIndex += 1) {
                const key = moveAnchorKey(deletedRun, deletedIndex);
                const addedOccurrences = key ? addedAnchorIndex.get(key) : null;
                if (!addedOccurrences || addedOccurrences.length > MOVE_MAXIMUM_ANCHOR_OCCURRENCES) {
                    continue;
                }

                addedOccurrences.forEach(occurrence => {
                    const diagonalKey = [
                        deletedRun.id,
                        occurrence.run.id,
                        deletedIndex - occurrence.index
                    ].join(':');
                    const coveredThrough = coveredAnchorStartsByDiagonal.get(diagonalKey);
                    if (coveredThrough !== undefined && deletedIndex <= coveredThrough) {
                        return;
                    }

                    const candidate = expandMoveCandidate(
                        deletedRun,
                        deletedIndex,
                        occurrence.run,
                        occurrence.index
                    );
                    if (!candidate) {
                        return;
                    }
                    coveredAnchorStartsByDiagonal.set(
                        diagonalKey,
                        candidate.sourceEnd - MOVE_ANCHOR_LINE_COUNT + 1
                    );

                    const candidateKey = [
                        candidate.deletedRun.id,
                        candidate.sourceStart,
                        candidate.sourceEnd,
                        candidate.addedRun.id,
                        candidate.destinationStart,
                        candidate.destinationEnd
                    ].join(':');
                    candidateMap.set(candidateKey, candidate);
                });
            }
        });

        const blockLocations = new Map();
        candidateMap.forEach(candidate => {
            const locations = blockLocations.get(candidate.blockKey) || {
                sources: new Set(),
                destinations: new Set()
            };
            locations.sources.add(`${candidate.deletedRun.id}:${candidate.sourceStart}:${candidate.sourceEnd}`);
            locations.destinations.add(`${candidate.addedRun.id}:${candidate.destinationStart}:${candidate.destinationEnd}`);
            blockLocations.set(candidate.blockKey, locations);
        });

        const candidates = Array.from(candidateMap.values())
            .filter(candidate => {
                const locations = blockLocations.get(candidate.blockKey);
                return locations.sources.size === 1 && locations.destinations.size === 1;
            })
            .sort((first, second) => {
                if (first.substantiveLineCount !== second.substantiveLineCount) {
                    return second.substantiveLineCount - first.substantiveLineCount;
                }
                if (first.lineCount !== second.lineCount) {
                    return second.lineCount - first.lineCount;
                }
                return second.alphanumericCount - first.alphanumericCount;
            });

        const selected = [];
        candidates.forEach(candidate => {
            const overlapsSelected = selected.some(existing => {
                const sourceOverlap = existing.deletedRun === candidate.deletedRun
                    && rangesOverlap(existing.sourceStart, existing.sourceEnd, candidate.sourceStart, candidate.sourceEnd);
                const destinationOverlap = existing.addedRun === candidate.addedRun
                    && rangesOverlap(
                        existing.destinationStart,
                        existing.destinationEnd,
                        candidate.destinationStart,
                        candidate.destinationEnd
                    );
                return sourceOverlap || destinationOverlap;
            });

            if (!overlapsSelected) {
                selected.push(candidate);
            }
        });

        return selected;
    }

    function shouldBridgeMoveMatches(currentRange, nextMatch) {
        if (currentRange.deletedRun !== nextMatch.deletedRun
            || currentRange.addedRun !== nextMatch.addedRun) {
            return false;
        }

        const sourceGap = nextMatch.sourceStart - currentRange.sourceEnd - 1;
        const destinationGap = nextMatch.destinationStart - currentRange.destinationEnd - 1;
        if (sourceGap < 0
            || destinationGap < 0
            || Math.max(sourceGap, destinationGap) > MOVE_MAXIMUM_RAW_GAP_LINES) {
            return false;
        }

        const sourceSubstantiveGap = countSubstantiveMoveLines(
            currentRange.deletedRun.lines,
            currentRange.sourceEnd + 1,
            nextMatch.sourceStart
        );
        const destinationSubstantiveGap = countSubstantiveMoveLines(
            currentRange.addedRun.lines,
            currentRange.destinationEnd + 1,
            nextMatch.destinationStart
        );
        if (Math.max(sourceSubstantiveGap, destinationSubstantiveGap) > MOVE_MAXIMUM_SUBSTANTIVE_GAP_LINES
            || Math.abs(sourceSubstantiveGap - destinationSubstantiveGap) > MOVE_MAXIMUM_LINE_COUNT_DRIFT) {
            return false;
        }

        if (Math.max(sourceSubstantiveGap, destinationSubstantiveGap) <= MOVE_MAXIMUM_CHANGED_GAP_LINES) {
            return true;
        }

        const exactSubstantiveLineCount =
            currentRange.exactSubstantiveLineCount + nextMatch.substantiveLineCount;
        const sourceSubstantiveSpan = countSubstantiveMoveLines(
            currentRange.deletedRun.lines,
            currentRange.sourceStart,
            nextMatch.sourceEnd + 1
        );
        const destinationSubstantiveSpan = countSubstantiveMoveLines(
            currentRange.addedRun.lines,
            currentRange.destinationStart,
            nextMatch.destinationEnd + 1
        );
        return exactSubstantiveLineCount
            / Math.max(sourceSubstantiveSpan, destinationSubstantiveSpan) >= MOVE_MINIMUM_EXACT_RATIO;
    }

    function createMovedRange(matches) {
        const firstMatch = matches[0];
        const lastMatch = matches[matches.length - 1];
        const sourceLines = firstMatch.deletedRun.lines.slice(firstMatch.sourceStart, lastMatch.sourceEnd + 1);
        const destinationLines = firstMatch.addedRun.lines.slice(
            firstMatch.destinationStart,
            lastMatch.destinationEnd + 1
        );
        const exactSourceLineNumbers = new Set();
        const exactDestinationLineNumbers = new Set();

        matches.forEach(match => {
            for (let offset = 0; offset < match.lineCount; offset += 1) {
                exactSourceLineNumbers.add(match.deletedRun.lines[match.sourceStart + offset].lineNumber);
                exactDestinationLineNumbers.add(match.addedRun.lines[match.destinationStart + offset].lineNumber);
            }
        });

        const exactLineCount = matches.reduce((total, match) => total + match.lineCount, 0);
        const exactSubstantiveLineCount = matches.reduce(
            (total, match) => total + match.substantiveLineCount,
            0
        );
        const sourceSubstantiveLineCount = countSubstantiveMoveLines(sourceLines);
        const destinationSubstantiveLineCount = countSubstantiveMoveLines(destinationLines);
        return {
            source: {
                path: firstMatch.deletedRun.file.oldPath || firstMatch.deletedRun.file.newPath,
                startLine: sourceLines[0].lineNumber,
                endLine: sourceLines[sourceLines.length - 1].lineNumber,
                exactLineNumbers: exactSourceLineNumbers
            },
            destination: {
                path: firstMatch.addedRun.file.newPath || firstMatch.addedRun.file.oldPath,
                startLine: destinationLines[0].lineNumber,
                endLine: destinationLines[destinationLines.length - 1].lineNumber,
                exactLineNumbers: exactDestinationLineNumbers
            },
            exactLineCount,
            exactSubstantiveLineCount,
            sourceLineCount: sourceLines.length,
            destinationLineCount: destinationLines.length,
            sourceSubstantiveLineCount,
            destinationSubstantiveLineCount,
            hasEdits: exactSubstantiveLineCount
                < Math.max(sourceSubstantiveLineCount, destinationSubstantiveLineCount)
        };
    }

    function analyzeMovedRanges(diffText) {
        const parsedDiff = parseUnifiedDiff(diffText);
        const exactMatches = selectExactMoveMatches(parsedDiff);
        const matchesByRunPair = new Map();

        exactMatches.forEach(match => {
            const key = `${match.deletedRun.id}|${match.addedRun.id}`;
            const matches = matchesByRunPair.get(key) || [];
            matches.push(match);
            matchesByRunPair.set(key, matches);
        });

        const movedRanges = [];
        matchesByRunPair.forEach(matches => {
            matches.sort((first, second) => first.sourceStart - second.sourceStart);
            let currentRange = null;

            matches.forEach(match => {
                if (!currentRange) {
                    currentRange = {
                        deletedRun: match.deletedRun,
                        addedRun: match.addedRun,
                        sourceStart: match.sourceStart,
                        sourceEnd: match.sourceEnd,
                        destinationStart: match.destinationStart,
                        destinationEnd: match.destinationEnd,
                        exactLineCount: match.lineCount,
                        exactSubstantiveLineCount: match.substantiveLineCount,
                        matches: [match]
                    };
                    return;
                }

                if (shouldBridgeMoveMatches(currentRange, match)) {
                    currentRange.sourceEnd = match.sourceEnd;
                    currentRange.destinationEnd = match.destinationEnd;
                    currentRange.exactLineCount += match.lineCount;
                    currentRange.exactSubstantiveLineCount += match.substantiveLineCount;
                    currentRange.matches.push(match);
                    return;
                }

                movedRanges.push(createMovedRange(currentRange.matches));
                currentRange = {
                    deletedRun: match.deletedRun,
                    addedRun: match.addedRun,
                    sourceStart: match.sourceStart,
                    sourceEnd: match.sourceEnd,
                    destinationStart: match.destinationStart,
                    destinationEnd: match.destinationEnd,
                    exactLineCount: match.lineCount,
                    exactSubstantiveLineCount: match.substantiveLineCount,
                    matches: [match]
                };
            });

            if (currentRange) {
                movedRanges.push(createMovedRange(currentRange.matches));
            }
        });

        movedRanges.sort((first, second) => {
            const pathComparison = (first.source.path || '').localeCompare(second.source.path || '');
            return pathComparison || first.source.startLine - second.source.startLine;
        });
        movedRanges.forEach((range, index) => {
            range.id = `move-${index + 1}`;
        });

        return {
            parsedDiff,
            movedRanges
        };
    }

    function addMoveAnalysisStyles() {
        if (movesStylesInjected || typeof GM_addStyle !== 'function') {
            return;
        }
        movesStylesInjected = true;

        GM_addStyle(`
            .better-github-move-controls {
                align-items: center;
                display: inline-flex;
                gap: 8px;
            }
            .better-github-move-status {
                color: var(--fgColor-muted, var(--color-fg-muted));
                font-size: 12px;
                max-width: 360px;
            }
            .better-github-move-status[data-state="error"],
            .better-github-move-status[data-state="partial"] {
                color: var(--fgColor-attention, var(--color-attention-fg, #9a6700));
            }
            .better-github-moved-source {
                background-color: rgba(163, 113, 247, 0.14) !important;
                box-shadow: inset 4px 0 0 #8250df;
            }
            .better-github-moved-destination {
                background-color: rgba(57, 197, 207, 0.14) !important;
                box-shadow: inset 4px 0 0 #1b7c83;
            }
            .better-github-moved-edited-source {
                box-shadow: inset 4px 0 0 rgba(130, 80, 223, 0.7);
            }
            .better-github-moved-edited-destination {
                box-shadow: inset 4px 0 0 rgba(27, 124, 131, 0.7);
            }
            .better-github-move-annotation {
                align-items: center;
                background: var(--bgColor-accent-muted, var(--color-accent-subtle, #ddf4ff));
                border: 1px solid var(--borderColor-accent-muted, var(--color-accent-muted, #54aeff66));
                border-radius: 4px;
                display: flex;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                font-size: 12px;
                font-weight: 600;
                gap: 6px;
                margin: 2px 6px;
                padding: 3px 6px;
                white-space: normal;
            }
            .better-github-move-annotation button {
                background: none;
                border: 0;
                color: var(--fgColor-accent, var(--color-accent-fg, #0969da));
                cursor: pointer;
                font: inherit;
                padding: 0;
                text-align: left;
                text-decoration: underline;
            }
            .better-github-move-focus {
                animation: better-github-move-focus 1.6s ease-out;
            }
            @keyframes better-github-move-focus {
                0%, 35% { outline: 2px solid var(--borderColor-accent-emphasis, #0969da); outline-offset: -2px; }
                100% { outline-color: transparent; }
            }
        `);
    }

    function getMoveAnalysisKey(pullRequestInfo) {
        return `${pullRequestInfo.owner}/${pullRequestInfo.repository}#${pullRequestInfo.pullRequestNumber}`;
    }

    function requestText(url) {
        return new Promise((resolve, reject) => {
            if (typeof GM === 'undefined' || typeof GM.xmlHttpRequest !== 'function') {
                reject(new Error('GM.xmlHttpRequest is unavailable'));
                return;
            }

            let settled = false;
            const timeoutId = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    reject(new Error('GitHub diff request timed out'));
                }
            }, MOVE_REQUEST_TIMEOUT_MS);
            const finish = callback => value => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeoutId);
                callback(value);
            };

            GM.xmlHttpRequest({
                method: 'GET',
                url,
                headers: {
                    Accept: 'text/plain'
                },
                onload: response => {
                    if (response.status < 200 || response.status >= 300) {
                        finish(reject)(new Error(`GitHub returned HTTP ${response.status}`));
                        return;
                    }
                    finish(resolve)(response.responseText || response.response || '');
                },
                onerror: response => {
                    finish(reject)(new Error(response.statusText || response.error || 'GitHub diff request failed'));
                }
            });
        });
    }

    function pageIndicatesLimitedDiff() {
        const warningElements = document.querySelectorAll([
            '[role="alert"]',
            '.flash',
            '[class*="DiffTooLarge"]',
            '[class*="diff-too-large"]',
            '[data-testid*="diff-error"]'
        ].join(','));
        return Array.from(warningElements).some(element => (
            /could not display the entire diff|diff is too large|some files were not shown|too many files/i.test(
                element.textContent || ''
            )
        ));
    }

    function detectPartialMoveAnalysis() {
        return pageIndicatesLimitedDiff();
    }

    function clearMoveAnnotations() {
        document.querySelectorAll('[data-better-github="move-annotation"]').forEach(annotation => annotation.remove());
        document.querySelectorAll([
            '.better-github-moved-source',
            '.better-github-moved-destination',
            '.better-github-moved-edited-source',
            '.better-github-moved-edited-destination',
            '.better-github-move-focus'
        ].join(',')).forEach(element => {
            element.classList.remove(
                'better-github-moved-source',
                'better-github-moved-destination',
                'better-github-moved-edited-source',
                'better-github-moved-edited-destination',
                'better-github-move-focus'
            );
        });
    }

    function getMoveAnalysisControls() {
        return document.querySelector('[data-better-github="move-analysis-controls"]');
    }

    function updateMoveAnalysisControls(pullRequestInfo) {
        const controls = getMoveAnalysisControls();
        if (!controls) {
            return;
        }

        const button = controls.querySelector('button');
        const status = controls.querySelector('.better-github-move-status');
        const state = moveAnalysisState && moveAnalysisState.key === getMoveAnalysisKey(pullRequestInfo)
            ? moveAnalysisState
            : null;
        let buttonText = 'Analyze moves';
        let statusText = '';
        let statusState = state ? state.phase : 'idle';
        const buttonDisabled = Boolean(state && ['loading', 'fetching', 'analyzing'].includes(state.phase));

        if (state) {
            if (state.phase === 'loading') {
                buttonText = 'Analyzing moves...';
                statusText = 'Loading available diffs...';
            } else if (state.phase === 'fetching') {
                buttonText = 'Analyzing moves...';
                statusText = 'Fetching the pull request diff...';
            } else if (state.phase === 'analyzing') {
                buttonText = 'Analyzing moves...';
                statusText = 'Matching moved ranges...';
            } else {
                buttonText = 'Re-analyze moves';
                if (state.phase === 'error') {
                    statusText = state.message;
                } else {
                    const movedRanges = state.result.movedRanges;
                    const editedCount = movedRanges.filter(range => range.hasEdits).length;
                    const unavailableCount = state.unavailableEndpointCount || 0;
                    const details = [`${movedRanges.length} moved range${movedRanges.length === 1 ? '' : 's'}`];
                    if (editedCount) {
                        details.push(`${editedCount} with edits`);
                    }
                    if (unavailableCount) {
                        const endpointState = state.partial ? 'unavailable' : 'pending rendering';
                        details.push(`${unavailableCount} endpoint${unavailableCount === 1 ? '' : 's'} ${endpointState}`);
                    }
                    if (state.partial) {
                        details.push('partial GitHub diff');
                        statusState = 'partial';
                    } else {
                        statusState = 'complete';
                    }
                    statusText = details.join(' - ');
                }
            }
        }

        if (button.disabled !== buttonDisabled) {
            button.disabled = buttonDisabled;
        }
        if (button.textContent !== buttonText) {
            button.textContent = buttonText;
        }
        if (status.textContent !== statusText) {
            status.textContent = statusText;
        }
        if (status.dataset.state !== statusState) {
            status.dataset.state = statusState;
        }
    }

    function findMoveDiffRegion(path, parsedDiff) {
        const fileRegions = Array.from(document.querySelectorAll('div[id^="diff-"][role="region"]'));
        const exactRegion = fileRegions.find(fileRegion => dependencies.getFilePathFromRegion(fileRegion) === path);
        if (exactRegion) {
            return exactRegion;
        }

        const parsedFile = parsedDiff.files.find(file => file.oldPath === path || file.newPath === path);
        if (!parsedFile) {
            return null;
        }

        const alternatePath = parsedFile.newPath === path ? parsedFile.oldPath : parsedFile.newPath;
        return fileRegions.find(fileRegion => {
            const regionPath = dependencies.getFilePathFromRegion(fileRegion);
            return regionPath === parsedFile.newPath
                || regionPath === parsedFile.oldPath
                || regionPath === alternatePath;
        }) || null;
    }

    function buildMoveDomIndex(parsedDiff) {
        const regionByPath = new Map();
        const rowsByRegion = new Map();
        const fileRegions = document.querySelectorAll('div[id^="diff-"][role="region"]');

        fileRegions.forEach(fileRegion => {
            const path = dependencies.getFilePathFromRegion(fileRegion);
            if (path) {
                regionByPath.set(path, fileRegion);
            }

            const rowMap = new Map();
            fileRegion.querySelectorAll('[data-diff-side][data-line-number]').forEach(lineCell => {
                const side = lineCell.getAttribute('data-diff-side');
                const lineNumber = lineCell.getAttribute('data-line-number');
                const row = lineCell.closest('tr.diff-line-row');
                if (side && lineNumber && row) {
                    rowMap.set(`${side}:${lineNumber}`, row);
                }
            });
            rowsByRegion.set(fileRegion, rowMap);
        });

        parsedDiff.files.forEach(file => {
            const existingRegion = regionByPath.get(file.newPath) || regionByPath.get(file.oldPath);
            if (!existingRegion) {
                return;
            }
            if (file.oldPath && !regionByPath.has(file.oldPath)) {
                regionByPath.set(file.oldPath, existingRegion);
            }
            if (file.newPath && !regionByPath.has(file.newPath)) {
                regionByPath.set(file.newPath, existingRegion);
            }
        });

        return { regionByPath, rowsByRegion };
    }

    function findMoveDiffRow(path, side, lineNumber, parsedDiff) {
        const fileRegion = findMoveDiffRegion(path, parsedDiff);
        if (!fileRegion) {
            return null;
        }

        return findMoveDiffRowInRegion(fileRegion, side, lineNumber);
    }

    function findMoveDiffRowInRegion(fileRegion, side, lineNumber) {
        const lineCell = fileRegion.querySelector(
            `[data-diff-side="${side}"][data-line-number="${lineNumber}"]`
        );
        return lineCell ? lineCell.closest('tr.diff-line-row') : null;
    }

    function getMoveSideCells(row, side) {
        const cells = Array.from(row.querySelectorAll(`[data-diff-side="${side}"]`));
        const contentCell = row.querySelector(side === 'left' ? '.left-side-diff-cell' : '.right-side-diff-cell');
        if (contentCell && !cells.includes(contentCell)) {
            cells.push(contentCell);
        }
        return cells.length ? cells : [row];
    }

    function formatMoveRangeLocation(moveSide) {
        const lineText = moveSide.startLine === moveSide.endLine
            ? `line ${moveSide.startLine}`
            : `lines ${moveSide.startLine}-${moveSide.endLine}`;
        return `${moveSide.path}, ${lineText}`;
    }

    async function waitForMoveDiffRow(moveSide, side, parsedDiff) {
        const startedAt = Date.now();
        let row = findMoveDiffRow(moveSide.path, side, moveSide.startLine, parsedDiff);
        while (!row && Date.now() - startedAt < MOVE_NAVIGATION_WAIT_MS) {
            await new Promise(resolve => setTimeout(resolve, MOVE_NAVIGATION_POLL_MS));
            row = findMoveDiffRow(moveSide.path, side, moveSide.startLine, parsedDiff);
        }
        return row;
    }

    async function navigateToMovedRange(rangeId, targetSideName, pullRequestInfo) {
        const analysisState = moveAnalysisState;
        if (!analysisState
            || analysisState.key !== getMoveAnalysisKey(pullRequestInfo)
            || !analysisState.result) {
            return;
        }

        const range = analysisState.result.movedRanges.find(candidate => candidate.id === rangeId);
        if (!range) {
            return;
        }

        dependencies.autoLoadLargeFileDiffs(true);
        const targetSide = range[targetSideName];
        const diffSide = targetSideName === 'source' ? 'left' : 'right';
        const targetRow = await waitForMoveDiffRow(
            targetSide,
            diffSide,
            analysisState.result.parsedDiff
        );
        if (moveAnalysisState !== analysisState) {
            return;
        }
        if (!targetRow) {
            const controls = getMoveAnalysisControls();
            const status = controls && controls.querySelector('.better-github-move-status');
            if (status) {
                status.dataset.state = 'partial';
                status.textContent = `GitHub did not render ${formatMoveRangeLocation(targetSide)}`;
            }
            return;
        }

        const targetRegion = findMoveDiffRegion(targetSide.path, analysisState.result.parsedDiff);
        const focusedCells = [];
        for (let lineNumber = targetSide.startLine; lineNumber <= targetSide.endLine; lineNumber += 1) {
            const row = targetRegion && findMoveDiffRowInRegion(targetRegion, diffSide, lineNumber);
            if (row) {
                getMoveSideCells(row, diffSide).forEach(cell => {
                    cell.classList.add('better-github-move-focus');
                    focusedCells.push(cell);
                });
            }
        }

        targetRow.scrollIntoView({ block: 'center' });
        setTimeout(() => {
            focusedCells.forEach(element => {
                element.classList.remove('better-github-move-focus');
            });
        }, 1700);
    }

    function addMoveAnnotation(row, range, sideName, pullRequestInfo) {
        const diffSide = sideName === 'source' ? 'left' : 'right';
        const annotationSelector = `[data-better-github-move-id="${range.id}"][data-better-github-move-side="${sideName}"]`;
        const targetSideName = sideName === 'source' ? 'destination' : 'source';
        const targetSide = range[targetSideName];
        const contentCell = row.querySelector(
            diffSide === 'left' ? '.left-side-diff-cell' : '.right-side-diff-cell'
        ) || row.querySelector(
            `.diff-text-cell[data-diff-side="${diffSide}"]`
        ) || Array.from(row.querySelectorAll(`[data-diff-side="${diffSide}"]`)).find(
            element => !element.hasAttribute('data-line-number')
        ) || row.lastElementChild;
        if (!contentCell) {
            return false;
        }

        let annotation = document.querySelector(annotationSelector);
        if (annotation) {
            if (annotation.parentElement !== contentCell) {
                contentCell.prepend(annotation);
            }
            return true;
        }

        annotation = document.createElement('div');
        annotation.className = 'better-github-move-annotation';
        annotation.dataset.betterGithub = 'move-annotation';
        annotation.dataset.betterGithubMoveId = range.id;
        annotation.dataset.betterGithubMoveSide = sideName;
        const button = document.createElement('button');
        button.type = 'button';
        const direction = sideName === 'source' ? 'to' : 'from';
        button.textContent = `Moved${range.hasEdits ? ' with edits' : ''} ${direction} ${formatMoveRangeLocation(targetSide)}`;
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            navigateToMovedRange(range.id, targetSideName, pullRequestInfo);
        });
        annotation.appendChild(button);
        contentCell.prepend(annotation);
        return true;
    }

    function renderMovedRangeSide(range, sideName, pullRequestInfo, domIndex) {
        const moveSide = range[sideName];
        const diffSide = sideName === 'source' ? 'left' : 'right';
        const exactClass = sideName === 'source'
            ? 'better-github-moved-source'
            : 'better-github-moved-destination';
        const editedClass = sideName === 'source'
            ? 'better-github-moved-edited-source'
            : 'better-github-moved-edited-destination';
        const fileRegion = domIndex.regionByPath.get(moveSide.path);
        if (!fileRegion) {
            return false;
        }
        const rowMap = domIndex.rowsByRegion.get(fileRegion);
        let firstRow = null;

        for (let lineNumber = moveSide.startLine; lineNumber <= moveSide.endLine; lineNumber += 1) {
            const row = rowMap && rowMap.get(`${diffSide}:${lineNumber}`);
            if (!row) {
                continue;
            }
            firstRow = firstRow || row;
            const lineClass = moveSide.exactLineNumbers.has(lineNumber) ? exactClass : editedClass;
            getMoveSideCells(row, diffSide).forEach(cell => cell.classList.add(lineClass));
        }

        return Boolean(firstRow && addMoveAnnotation(firstRow, range, sideName, pullRequestInfo));
    }

    function renderMoveAnalysisResults(pullRequestInfo) {
        if (!moveAnalysisState
            || moveAnalysisState.key !== getMoveAnalysisKey(pullRequestInfo)
            || !moveAnalysisState.result) {
            return;
        }

        const domIndex = buildMoveDomIndex(moveAnalysisState.result.parsedDiff);
        let unavailableEndpointCount = 0;
        moveAnalysisState.result.movedRanges.forEach(range => {
            if (!renderMovedRangeSide(
                range,
                'source',
                pullRequestInfo,
                domIndex
            )) {
                unavailableEndpointCount += 1;
            }
            if (!renderMovedRangeSide(
                range,
                'destination',
                pullRequestInfo,
                domIndex
            )) {
                unavailableEndpointCount += 1;
            }
        });
        moveAnalysisState.unavailableEndpointCount = unavailableEndpointCount;
        updateMoveAnalysisControls(pullRequestInfo);
    }

    async function runMoveAnalysis(pullRequestInfo) {
        const key = getMoveAnalysisKey(pullRequestInfo);
        if (moveAnalysisState
            && moveAnalysisState.key === key
            && ['loading', 'fetching', 'analyzing'].includes(moveAnalysisState.phase)) {
            return;
        }

        clearMoveAnnotations();
        const analysisState = {
            key,
            phase: 'loading',
            result: null,
            partial: false,
            forceLoadUntil: Date.now() + MOVE_FORCE_LOAD_WINDOW_MS,
            unavailableEndpointCount: 0
        };
        moveAnalysisState = analysisState;
        updateMoveAnalysisControls(pullRequestInfo);
        dependencies.autoLoadLargeFileDiffs(true);

        try {
            await new Promise(resolve => requestAnimationFrame(resolve));
            if (moveAnalysisState !== analysisState) {
                return;
            }
            analysisState.phase = 'fetching';
            updateMoveAnalysisControls(pullRequestInfo);
            const diffText = await requestText(`${pullRequestInfo.baseUrl}.diff`);
            if (!diffText || !diffText.includes('diff --git ')) {
                throw new Error('GitHub did not return a recognizable pull request diff');
            }

            if (moveAnalysisState !== analysisState) {
                return;
            }
            analysisState.phase = 'analyzing';
            updateMoveAnalysisControls(pullRequestInfo);
            await new Promise(resolve => setTimeout(resolve, 0));
            const result = analyzeMovedRanges(diffText);
            if (moveAnalysisState !== analysisState) {
                return;
            }
            analysisState.result = result;
            analysisState.partial = detectPartialMoveAnalysis();
            analysisState.forceLoadUntil = Date.now() + MOVE_FORCE_LOAD_WINDOW_MS;
            analysisState.phase = 'complete';
            renderMoveAnalysisResults(pullRequestInfo);
        } catch (error) {
            if (moveAnalysisState !== analysisState) {
                return;
            }
            console.error('Better GitHub move analysis failed:', error);
            analysisState.phase = 'error';
            analysisState.message = error.message || 'Move analysis failed';
            updateMoveAnalysisControls(pullRequestInfo);
        }
    }

    function addMoveAnalysisButton(pullRequestInfo) {
        if (!dependencies.isEnabled()) {
            const controls = getMoveAnalysisControls();
            if (controls) {
                controls.remove();
            }
            clearMoveAnnotations();
            return;
        }

        let controls = getMoveAnalysisControls();
        if (!controls) {
            controls = document.createElement('span');
            controls.className = 'better-github-move-controls';
            controls.dataset.betterGithub = 'move-analysis-controls';

            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'better-github-button';
            button.addEventListener('click', () => {
                const currentPullRequestInfo = dependencies.getPullRequestInfo();
                if (currentPullRequestInfo) {
                    runMoveAnalysis(currentPullRequestInfo);
                }
            });

            const status = document.createElement('span');
            status.className = 'better-github-move-status';
            status.setAttribute('aria-live', 'polite');

            controls.append(button, status);
            const headerActions = document.querySelector('div[data-component="PH_Actions"]');
            const navigationArea = document.querySelector('div[data-component="PH_Navigation"]');
            const insertionParent = headerActions || navigationArea;
            if (!insertionParent) {
                return;
            }
            insertionParent.appendChild(controls);
        }

        updateMoveAnalysisControls(pullRequestInfo);
    }

    function removeMoveAnalysisButton() {
        const controls = getMoveAnalysisControls();
        if (controls) {
            controls.remove();
        }
        clearMoveAnnotations();
    }

    function initialize(options) {
        dependencies = Object.assign({}, dependencies, options || {});
        addMoveAnalysisStyles();
    }

    // Called on every run of the main script's runFeaturesForCurrentPage, for
    // every pull request page (not only Files changed) so that state can be
    // reset on PR navigation. Controls/annotations are only shown on the
    // Files changed view, but a completed result for the same PR is kept so
    // returning to that view re-renders without another fetch.
    function runForCurrentPage(pullRequestInfo) {
        if (moveAnalysisState
            && (!pullRequestInfo || moveAnalysisState.key !== getMoveAnalysisKey(pullRequestInfo))) {
            clearMoveAnnotations();
            moveAnalysisState = null;
        }

        if (!pullRequestInfo || !dependencies.isFilesChangedView(pullRequestInfo)) {
            removeMoveAnalysisButton();
            return;
        }

        const forceLoadForMoveAnalysis = Boolean(
            moveAnalysisState
            && moveAnalysisState.key === getMoveAnalysisKey(pullRequestInfo)
            && Date.now() < moveAnalysisState.forceLoadUntil
        );
        addMoveAnalysisButton(pullRequestInfo);
        if (forceLoadForMoveAnalysis) {
            dependencies.autoLoadLargeFileDiffs(true);
        }
        renderMoveAnalysisResults(pullRequestInfo);
    }

    window.BetterGitHubMoveAnalysis = {
        initialize,
        runForCurrentPage,
        // Narrow, pure analysis API kept available for ad hoc testing against
        // saved diff fixtures. Takes a unified diff string and returns fresh
        // parsed/matched data; exposes no mutable internal state.
        analyzeMovedRanges
    };
})();
