// Copyright 2025 mcarthey
// SPDX-License-Identifier: Apache-2.0
//
// CrossclimbSolver - Core Solver Logic
// Targets LinkedIn Crossclimb's actual DOM structure:
//   .crossclimb__guess          — a puzzle row
//   .crossclimb__guess--lock    — locked row (start/end word)
//   .crossclimb__guess--middle  — fillable middle row
//   .crossclimb__guess--new-focus — currently focused row
//   .crossclimb__guess__inner   — inner content with letter boxes
//   .crossclimb__guess_box      — individual letter input box
//   .crossclimb__guess-dragger  — drag handle for reordering
//   .crossclimb__clue           — clue text for the active row
//   .crossclimb__grid           — the grid container

const Solver = {
  // State
  state: {
    puzzleData: null,
    currentPhase: 'idle',
    log: [],
  },

  // ----- MAIN SOLVE FLOW -----

  async solve(puzzleData, callbacks = {}) {
    const { onStatus, onLog, onError, onComplete } = callbacks;

    const log = (msg) => {
      this.state.log.push(msg);
      console.log(`[CrossclimbSolver] ${msg}`);
      onLog?.(msg);
    };

    const status = (phase, msg) => {
      this.state.currentPhase = phase;
      log(`[${phase}] ${msg}`);
      onStatus?.(phase, msg);
    };

    try {
      this.state.puzzleData = puzzleData;

      // Step 1: Find the game board
      status('inspecting', 'Looking for Crossclimb game board...');
      const board = this._findGameBoard();

      if (!board) {
        // Run legacy discovery as fallback + diagnostics
        const domInfo = await this._legacyDiscoverDOM(puzzleData);
        if (domInfo.rows.length >= 3 || domInfo.wordRows.length >= 3) {
          log('Found rows via legacy discovery, falling back to legacy solve');
          return await this._legacySolve(domInfo, puzzleData, callbacks);
        }
        // Show diagnostics
        if (domInfo.diagnostics) {
          log(`DIAGNOSTICS: ${domInfo.diagnostics.singleLetterCount} single-letter elements`);
          for (const f of domInfo.diagnostics.iframes || []) {
            log(`  iframe: ${f.src} accessible=${f.accessible}`);
          }
        }
        throw new Error('Could not find Crossclimb game board. Make sure the puzzle page is open.');
      }

      log(`Found game board: ${board.middleRows.length} middle rows, ${board.lockedRows.length} locked rows`);

      // Tag rows with data attributes so the page-context bridge can find them.
      // Sort middle rows by visual position (y-coordinate) to handle CSS-transformed ordering.
      board.middleRows.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      board.middleRows.forEach((row, i) => row.setAttribute('data-cs-row', String(i)));
      board.lockedRows.forEach((row, i) => row.setAttribute('data-cs-lock', String(i)));

      // Inject the page-context bridge for event dispatch (file-based, bypasses CSP)
      await CrossclimbDOM.injectBridge();
      // Verify bridge is alive
      const ping = await CrossclimbDOM._bridgeCmd('ping', {}, 2000);
      log(`Bridge status: ${ping.ok ? 'connected' : 'FAILED - ' + (ping.error || 'no response')}`);

      // Step 2: Build clue-answer map from our puzzle data
      status('matching', 'Preparing answers...');
      const middleAnswers = AnswerParser.getMiddleAnswersOrdered(puzzleData);
      const clueAnswerMap = new Map();
      for (const pair of puzzleData.clueAnswerPairs) {
        clueAnswerMap.set(pair.clue.toLowerCase().trim(), pair.answer);
      }
      log(`Have ${middleAnswers.length} middle answers: ${middleAnswers.join(', ')}`);
      log(`Have ${clueAnswerMap.size} clue-answer pairs`);

      // Step 3: Run diagnostics on the first row to understand input mechanism
      status('solving', 'Analyzing input mechanism...');
      const diagSel = '[data-cs-row="0"] .crossclimb__guess_box';
      const diag = await CrossclimbDOM._bridgeCmd('diagnose', { selector: diagSel }, 3000);
      if (diag.ok && diag.data) {
        const d = diag.data;
        log(`Diagnostics: activeElement=${d.activeElement?.tag}.${d.activeElement?.class?.substring(0, 30)}`);
        if (d.afterClick) log(`  After click: ${d.afterClick.tag}.${d.afterClick.class?.substring(0, 40)} editable=${d.afterClick.contentEditable}`);
        log(`  Game inputs: ${d.gameInputCount}`);
        for (const gi of (d.gameInputs || [])) {
          log(`    <${gi.tag}> type=${gi.type} class="${gi.class}" rect=${gi.rect} val="${gi.value}"`);
        }
        log(`  Box children: ${d.boxChildren?.length || 0}`);
        for (const bc of (d.boxChildren || [])) {
          log(`    <${bc.tag}> class="${bc.class}" text="${bc.text}" rect=${bc.rect} editable=${bc.contentEditable}`);
        }
        log(`  Hidden inputs: ${d.hiddenInputs?.length || 0}`);
        for (const hi of (d.hiddenInputs || [])) {
          log(`    <${hi.tag}> type=${hi.type} class="${hi.class}" rect=${hi.rect} parent="${hi.parentClass}"`);
        }
        log(`  Contenteditable elements: ${d.editableCount || 0}`);
      }

      // Step 4: Read all clues first (don't fill yet — prevents cascade failures)
      // Previously, we read a clue and immediately filled its row. If clue matching
      // failed (e.g. error message on row 1), the fallback "stole" a word that a
      // later row's clue would have matched. Two-pass approach fixes this.
      status('solving', 'Reading clues from all rows...');
      const rowClues = [];

      for (let i = 0; i < board.middleRows.length; i++) {
        const row = board.middleRows[i];
        status('solving', `Reading clue ${i + 1}/${board.middleRows.length}...`);
        await this._activateRow(row);
        await CrossclimbDOM.sleep(400);
        const clueText = this._readActiveClue(board.gridContainer);
        rowClues.push({ index: i, clue: clueText });
        log(`Row ${i + 1} clue: "${clueText || '(none)'}"`);
      }

      // Log source clue-answer pairs for debugging
      log('Source clue-answer pairs:');
      for (const pair of puzzleData.clueAnswerPairs) {
        log(`  "${pair.clue}" → ${pair.answer}`);
      }

      // Step 5: Global clue-to-answer matching (all clues at once)
      status('solving', 'Matching clues to answers...');
      const assignments = this._globalMatchClues(rowClues, puzzleData, middleAnswers, log);
      log(`Assignments: ${assignments.map(a => `Row ${a.index + 1}=${a.answer}`).join(', ')}`);

      // Step 6: Fill each row with its assigned answer (second pass)
      status('solving', 'Filling in answers...');
      const filledAnswers = [];

      for (const assignment of assignments) {
        const i = assignment.index;
        const row = board.middleRows[i];
        status('solving', `Filling row ${i + 1}/${board.middleRows.length} with ${assignment.answer}...`);

        await this._activateRow(row);
        await CrossclimbDOM.sleep(400);

        log(`Typing "${assignment.answer}" into row ${i + 1}`);
        await this._typeIntoRow(row, assignment.answer, board, log);
        filledAnswers.push({ answer: assignment.answer, rowElement: row, index: i });
        await CrossclimbDOM.sleep(500);
      }

      log(`Filled ${filledAnswers.length}/${board.middleRows.length} rows`);

      // Step 7: Reorder rows to form the correct word ladder
      if (filledAnswers.length >= 2) {
        status('reordering', 'Reordering rows...');
        await this._reorderMiddleRows(board, middleAnswers, filledAnswers, log);
      }

      // Step 8: Fill start/end words into the locked rows (which unlock after correct ordering)
      if (puzzleData.startWord && puzzleData.endWord) {
        status('solving', 'Checking for endpoint rows...');
        await CrossclimbDOM.sleep(2000); // Wait for game to process correct ordering

        // Re-detect all rows in the grid to find newly unlocked endpoint rows
        const allGuesses = board.gridContainer.querySelectorAll('.crossclimb__guess');
        const sortedRows = [...allGuesses]
          .map(r => ({ el: r, y: r.getBoundingClientRect().top, hasInputs: r.querySelectorAll('.crossclimb__guess_box input').length > 0 }))
          .sort((a, b) => a.y - b.y);

        const middleRowSet = new Set(board.middleRows);
        const topRow = sortedRows[0];
        const bottomRow = sortedRows[sortedRows.length - 1];

        log(`Endpoint rows: top hasInputs=${topRow?.hasInputs} bottom hasInputs=${bottomRow?.hasInputs}`);

        // Fill top row (start word) if it has inputs and isn't a middle row
        if (topRow?.hasInputs && !middleRowSet.has(topRow.el)) {
          topRow.el.setAttribute('data-cs-endpoint', 'top');
          log(`Filling top row with "${puzzleData.startWord}"`);
          const topResult = await CrossclimbDOM.pageFillRow('[data-cs-endpoint="top"]', puzzleData.startWord);
          log(`  Top: ok=${topResult.ok} inputs=${topResult.inputCount || '?'}${topResult.error ? ' err=' + topResult.error : ''}`);
          if (topResult.fillDetails) {
            log(`  Letters: ${topResult.fillDetails.map(d => `${d.letter}=${d.valueAfter || '?'}`).join(' ')}`);
          }
          await CrossclimbDOM.sleep(500);
        }

        // Fill bottom row (end word) if it has inputs and isn't a middle row
        if (bottomRow?.hasInputs && !middleRowSet.has(bottomRow.el)) {
          bottomRow.el.setAttribute('data-cs-endpoint', 'bottom');
          log(`Filling bottom row with "${puzzleData.endWord}"`);
          const bottomResult = await CrossclimbDOM.pageFillRow('[data-cs-endpoint="bottom"]', puzzleData.endWord);
          log(`  Bottom: ok=${bottomResult.ok} inputs=${bottomResult.inputCount || '?'}${bottomResult.error ? ' err=' + bottomResult.error : ''}`);
          if (bottomResult.fillDetails) {
            log(`  Letters: ${bottomResult.fillDetails.map(d => `${d.letter}=${d.valueAfter || '?'}`).join(' ')}`);
          }
        }
      }

      status('done', 'Puzzle solved!');
      onComplete?.();

    } catch (error) {
      status('error', error.message);
      onError?.(error);
      console.error('[CrossclimbSolver] Error:', error);
    }
  },

  // ----- GAME BOARD DISCOVERY -----

  _findGameBoard(root = document) {
    // Find the grid container
    const gridContainer = root.querySelector('.crossclimb__grid') ||
                          root.querySelector('[class*="crossclimb__grid"]');
    if (!gridContainer) {
      console.log('[CrossclimbSolver] No .crossclimb__grid found');

      // Try in accessible iframes
      const iframes = root.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
          if (!iframeDoc) continue;
          const result = this._findGameBoard(iframeDoc);
          if (result) return result;
        } catch { /* cross-origin */ }
      }
      return null;
    }

    // Find all guess rows
    const allGuesses = gridContainer.querySelectorAll('.crossclimb__guess, [class*="crossclimb__guess"]');
    const lockedRows = [];
    const middleRows = [];

    for (const guess of allGuesses) {
      const className = guess.className || '';
      if (className.includes('crossclimb__guess--lock')) {
        lockedRows.push(guess);
      } else if (className.includes('crossclimb__guess--middle')) {
        middleRows.push(guess);
      }
    }

    // Also check inside the ordered list container
    if (middleRows.length === 0) {
      const container = gridContainer.querySelector('.crossclimb__guess__container, ol');
      if (container) {
        for (const child of container.children) {
          const className = child.className || '';
          if (className.includes('crossclimb__guess')) {
            if (className.includes('--lock')) {
              lockedRows.push(child);
            } else {
              middleRows.push(child);
            }
          }
        }
      }
    }

    if (middleRows.length === 0) {
      console.log('[CrossclimbSolver] Found grid but no middle rows');
      return null;
    }

    // Find the clue section
    const clueSection = root.querySelector('.crossclimb__clue-section') ||
                        root.querySelector('[class*="crossclimb__clue"]');

    // Find the wrapper
    const wrapper = root.querySelector('.crossclimb__wrapper') ||
                    gridContainer.parentElement;

    return {
      gridContainer,
      wrapper,
      clueSection,
      lockedRows,
      middleRows,
      allGuesses: [...allGuesses],
      doc: root,
    };
  },

  // ----- ROW ACTIVATION -----

  async _activateRow(rowElement) {
    const idx = rowElement.getAttribute('data-cs-row');
    const baseSel = `[data-cs-row="${idx}"]`;

    // Click the first guess box via the page-context bridge
    const boxSel = `${baseSel} .crossclimb__guess_box`;
    let result = await CrossclimbDOM.pageClick(boxSel);
    await CrossclimbDOM.sleep(150);

    // Also click the inner container
    const innerSel = `${baseSel} .crossclimb__guess__inner`;
    await CrossclimbDOM.pageClick(innerSel);
    await CrossclimbDOM.sleep(150);

    // If still not focused, click the row itself
    const isActive = rowElement.className.includes('new-focus') ||
                     rowElement.className.includes('active');
    if (!isActive) {
      await CrossclimbDOM.pageClick(baseSel);
      await CrossclimbDOM.sleep(150);
    }
  },

  // ----- CLUE READING -----

  _readActiveClue(gridContainer) {
    // The game shows one clue at a time in .crossclimb__clue
    // Search upward from grid to find the clue section
    const searchRoots = [
      gridContainer,
      gridContainer.parentElement,
      gridContainer.closest('.crossclimb__wrapper'),
      gridContainer.closest('.crossclimb__container'),
      gridContainer.closest('[class*="crossclimb"]'),
      document,
    ].filter(Boolean);

    for (const root of searchRoots) {
      const clueEl = root.querySelector('.crossclimb__clue');
      if (clueEl) {
        const text = clueEl.textContent.trim();
        if (text.length > 0) return text;
      }

      // Also try broader selectors
      const clueSections = root.querySelectorAll('[class*="crossclimb__clue"]');
      for (const section of clueSections) {
        const text = section.textContent.trim();
        // Skip very short or very long text (not a clue)
        if (text.length > 5 && text.length < 200) return text;
      }
    }

    return null;
  },

  // ----- CLUE-ANSWER MATCHING -----

  _matchClueToAnswer(clueFromDOM, puzzleData, usedAnswers) {
    const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const clueNorm = normalize(clueFromDOM);

    let bestMatch = null;
    let bestScore = 0;

    for (const pair of puzzleData.clueAnswerPairs) {
      if (usedAnswers.includes(pair.answer)) continue;

      const pairNorm = normalize(pair.clue);

      // Exact match
      if (clueNorm === pairNorm) return pair.answer;

      // One contains the other
      if (clueNorm.includes(pairNorm) || pairNorm.includes(clueNorm)) {
        if (0.9 > bestScore) { bestScore = 0.9; bestMatch = pair.answer; }
        continue;
      }

      // Word overlap (Jaccard similarity)
      const wordsA = new Set(clueNorm.split(' '));
      const wordsB = new Set(pairNorm.split(' '));
      const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
      const union = new Set([...wordsA, ...wordsB]);
      const jaccard = intersection.size / union.size;

      if (jaccard > bestScore) {
        bestScore = jaccard;
        bestMatch = pair.answer;
      }
    }

    return bestScore > 0.3 ? bestMatch : null;
  },

  // ----- GLOBAL CLUE MATCHING -----

  _globalMatchClues(rowClues, puzzleData, middleAnswers, log) {
    const pairs = puzzleData.clueAnswerPairs;
    const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

    // Detect error messages (not real clues)
    const isErrorClue = (clue) => {
      if (!clue) return true;
      const lower = clue.toLowerCase();
      return lower.includes('wrong') || lower.includes('incorrect') ||
             lower.includes('try again') || lower.includes('not quite') ||
             lower.length > 150;
    };

    const assignments = new Array(rowClues.length).fill(null);
    const usedAnswers = new Set();

    // Pass 1: Exact matches (normalized)
    for (let i = 0; i < rowClues.length; i++) {
      const { clue } = rowClues[i];
      if (isErrorClue(clue)) continue;
      const clueNorm = normalize(clue);

      for (const pair of pairs) {
        if (usedAnswers.has(pair.answer)) continue;
        if (clueNorm === normalize(pair.clue)) {
          assignments[i] = pair.answer;
          usedAnswers.add(pair.answer);
          log(`  Exact match: Row ${i + 1} → ${pair.answer}`);
          break;
        }
      }
    }

    // Pass 2: Substring matches
    for (let i = 0; i < rowClues.length; i++) {
      if (assignments[i]) continue;
      const { clue } = rowClues[i];
      if (isErrorClue(clue)) continue;
      const clueNorm = normalize(clue);

      for (const pair of pairs) {
        if (usedAnswers.has(pair.answer)) continue;
        const pairNorm = normalize(pair.clue);
        if (clueNorm.includes(pairNorm) || pairNorm.includes(clueNorm)) {
          assignments[i] = pair.answer;
          usedAnswers.add(pair.answer);
          log(`  Substring match: Row ${i + 1} → ${pair.answer}`);
          break;
        }
      }
    }

    // Pass 3: Jaccard similarity (best match above threshold)
    for (let i = 0; i < rowClues.length; i++) {
      if (assignments[i]) continue;
      const { clue } = rowClues[i];
      if (isErrorClue(clue)) continue;
      const clueNorm = normalize(clue);
      const wordsA = new Set(clueNorm.split(' '));

      let bestMatch = null;
      let bestScore = 0;

      for (const pair of pairs) {
        if (usedAnswers.has(pair.answer)) continue;
        const pairNorm = normalize(pair.clue);
        const wordsB = new Set(pairNorm.split(' '));
        const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
        const union = new Set([...wordsA, ...wordsB]);
        const jaccard = intersection.size / union.size;
        if (jaccard > bestScore) { bestScore = jaccard; bestMatch = pair.answer; }
      }

      if (bestScore > 0.3 && bestMatch) {
        assignments[i] = bestMatch;
        usedAnswers.add(bestMatch);
        log(`  Fuzzy match (${bestScore.toFixed(2)}): Row ${i + 1} → ${bestMatch}`);
      }
    }

    // Pass 4: Assign remaining answers to remaining rows (position-based fallback)
    const remainingAnswers = middleAnswers.filter(a => !usedAnswers.has(a));
    let remainIdx = 0;
    for (let i = 0; i < rowClues.length; i++) {
      if (assignments[i]) continue;
      if (remainIdx < remainingAnswers.length) {
        assignments[i] = remainingAnswers[remainIdx++];
        log(`  Fallback: Row ${i + 1} → ${assignments[i]}`);
      }
    }

    return assignments
      .map((answer, i) => ({ index: i, answer }))
      .filter(a => a.answer);
  },

  // ----- TYPING -----

  async _typeIntoRow(rowElement, answer, board, log) {
    const idx = rowElement.getAttribute('data-cs-row');
    const rowSel = `[data-cs-row="${idx}"]`;

    // Primary: Use fill-row to target each input individually via execCommand
    const result = await CrossclimbDOM.pageFillRow(rowSel, answer);
    if (log) {
      log(`  Fill row: ok=${result.ok} inputs=${result.inputCount || '?'}${result.error ? ' err=' + result.error : ''}`);
      // Log per-letter details
      if (result.fillDetails) {
        const summary = result.fillDetails.map(d =>
          `${d.letter}${d.execOk ? '' : '!exec'}${d.fallback ? '(fb)' : ''}=${d.valueAfter || '?'}`
        ).join(' ');
        log(`  Letters: ${summary}`);
      }
    }

    if (!result.ok) {
      // Fallback: click first box + type word via execCommand-only
      if (log) log(`  Falling back to type-word`);
      const boxSel = `${rowSel} .crossclimb__guess_box`;
      await CrossclimbDOM.pageClick(boxSel);
      await CrossclimbDOM.sleep(200);
      const typeResult = await CrossclimbDOM.pageTypeWord(answer);
      if (log) log(`  Type word fallback: ok=${typeResult.ok}`);
    }
  },

  // ----- ROW REORDERING -----

  async _reorderMiddleRows(board, correctMiddleOrder, filledAnswers, log) {
    // correctMiddleOrder is [word2, word3, word4, word5, word6] in correct ladder order

    // Read actual board state via bridge (sorted by visual y-coordinate)
    const readOrder = async () => {
      const result = await CrossclimbDOM.pageReadOrder();
      if (!result.ok || !result.data?.rows) return null;
      return result.data.rows; // [{word, csRow, y}, ...]
    };

    const isCorrect = (rows) => {
      if (!rows) return false;
      return JSON.stringify(rows.map(r => r.word)) === JSON.stringify(correctMiddleOrder);
    };

    let current = await readOrder();
    if (!current || current.length === 0) {
      log('Could not read board order');
      return;
    }

    const currentWords = current.map(r => r.word);
    log(`Current order: ${currentWords.join(' → ')}`);
    log(`Target order:  ${correctMiddleOrder.join(' → ')}`);

    if (isCorrect(current)) {
      log('Rows already in correct order!');
      return;
    }

    // Helper: find first wrong position and build selectors
    const findSwap = (rows) => {
      const words = rows.map(r => r.word);
      const wrongIdx = words.findIndex((w, i) => w !== correctMiddleOrder[i]);
      if (wrongIdx < 0) return null;
      const targetWord = correctMiddleOrder[wrongIdx];
      const sourceIdx = words.indexOf(targetWord);
      if (sourceIdx < 0) return null;
      // Use [data-sortable-handle="true"] for the actual sortable handle element
      const srcRow = rows[sourceIdx].csRow;
      const tgtRow = rows[wrongIdx].csRow;
      return {
        word: targetWord, sourceIdx, wrongIdx, srcRow, tgtRow,
        srcHandle: `[data-cs-row="${srcRow}"] [data-sortable-handle="true"]`,
        tgtHandle: `[data-cs-row="${tgtRow}"] [data-sortable-handle="true"]`,
        srcDragger: `[data-cs-row="${srcRow}"] .crossclimb__guess-dragger`,
        tgtDragger: `[data-cs-row="${tgtRow}"] .crossclimb__guess-dragger`,
        srcRow: `[data-cs-row="${srcRow}"]`,
        tgtRow: `[data-cs-row="${tgtRow}"]`
      };
    };

    // Helper: try a single drag with a given method, return true if it changed the order
    const tryOneDrag = async (method, label, srcSel, tgtSel, beforeWords) => {
      log(`  Moving via ${label}...`);
      let dragResult;
      switch (method) {
        case 'pointer':
          dragResult = await CrossclimbDOM.pageDrag(srcSel, tgtSel);
          break;
        case 'capture-bypass':
          dragResult = await CrossclimbDOM.pageDragCaptureBypass(srcSel, tgtSel);
          break;
        case 'touch':
          dragResult = await CrossclimbDOM.pageDragTouch(srcSel, tgtSel);
          break;
        case 'html5':
          dragResult = await CrossclimbDOM.pageDragHtml5(srcSel, tgtSel);
          break;
        default:
          return false;
      }
      log(`  ${label}: ok=${dragResult.ok}${dragResult.captureAttempted ? ' captureBypass=yes' : ''}${dragResult.html5Completed ? ' html5=complete' : ''}${dragResult.error ? ' err=' + dragResult.error : ''}`);
      await CrossclimbDOM.sleep(800);

      const after = await readOrder();
      if (isCorrect(after)) {
        log(`  ${label} succeeded — all rows correct!`);
        return 'complete';
      }
      if (after) {
        const afterWords = after.map(r => r.word);
        if (JSON.stringify(afterWords) === JSON.stringify(beforeWords)) {
          log(`  ${label} had no effect`);
          return 'no-effect';
        }
        log(`  ${label} partial: ${afterWords.join(' → ')}`);
        return 'partial';
      }
      return 'error';
    };

    // Helper: try multiple drags with a given method until correct
    const tryFullReorder = async (method, label) => {
      for (let pass = 0; pass < 6; pass++) {
        current = await readOrder();
        if (!current || isCorrect(current)) return isCorrect(current);
        const swap = findSwap(current);
        if (!swap) return true; // already correct
        const beforeWords = current.map(r => r.word);
        log(`  [${label} pass ${pass + 1}] "${swap.word}" pos ${swap.sourceIdx}→${swap.wrongIdx}`);
        const result = await tryOneDrag(method, label, swap.srcHandle, swap.tgtHandle, beforeWords);
        if (result === 'complete') return true;
        if (result === 'no-effect') return false;
        // partial — continue
      }
      current = await readOrder();
      return current && isCorrect(current);
    };

    let reordered = false;

    // ──── Phase 1: Pointer drag with setPointerCapture bypass ────
    // The game's sortable library calls element.setPointerCapture() during drag start.
    // This API silently fails for synthetic events (requires isTrusted:true).
    // We temporarily override setPointerCapture/releasePointerCapture/hasPointerCapture
    // so our synthetic pointer events can trigger the drag operation.
    // We also dispatch gotpointercapture/lostpointercapture events that the browser
    // normally sends after a successful capture.
    log('Phase 1: Pointer drag with setPointerCapture bypass...');
    {
      const swap = findSwap(current);
      if (swap) {
        const beforeWords = current.map(r => r.word);
        const result = await tryOneDrag('capture-bypass', 'capture-bypass', swap.srcHandle, swap.tgtHandle, beforeWords);
        if (result === 'complete') {
          reordered = true;
        } else if (result === 'partial') {
          reordered = await tryFullReorder('capture-bypass', 'capture-bypass');
        } else if (result === 'no-effect') {
          // Also try targeting the dragger class (in case data-sortable-handle selector fails)
          log('  Retrying on .crossclimb__guess-dragger...');
          current = await readOrder();
          if (current && !isCorrect(current)) {
            const swap2 = findSwap(current);
            if (swap2) {
              const bw2 = current.map(r => r.word);
              const result2 = await tryOneDrag('capture-bypass', 'capture-bypass-dragger', swap2.srcDragger, swap2.tgtDragger, bw2);
              if (result2 === 'complete') reordered = true;
              else if (result2 === 'partial') reordered = await tryFullReorder('capture-bypass', 'capture-bypass-dragger');
            }
          }
        }
      }
    }

    // ──── Phase 2: HTML5 Drag and Drop ────
    // The game has ember-drag-drop addon which uses the HTML5 DnD API
    // (dragstart, dragenter, dragover, drop, dragend events with DataTransfer).
    if (!reordered) {
      log('Phase 2: HTML5 Drag and Drop...');
      current = await readOrder();
      if (current && !isCorrect(current)) {
        const swap = findSwap(current);
        if (swap) {
          const beforeWords = current.map(r => r.word);
          // Try on handle first, then on row
          let result = await tryOneDrag('html5', 'html5-handle', swap.srcHandle, swap.tgtHandle, beforeWords);
          if (result === 'complete') {
            reordered = true;
          } else if (result === 'partial') {
            reordered = await tryFullReorder('html5', 'html5');
          } else if (result === 'no-effect') {
            current = await readOrder();
            if (current && !isCorrect(current)) {
              const swap2 = findSwap(current);
              if (swap2) {
                const bw2 = current.map(r => r.word);
                const result2 = await tryOneDrag('html5', 'html5-row', swap2.srcRow, swap2.tgtRow, bw2);
                if (result2 === 'complete') reordered = true;
                else if (result2 === 'partial') reordered = await tryFullReorder('html5', 'html5-row');
              }
            }
          }
        }
      }
    }

    // ──── Phase 3: Deep Ember reorder ────
    // Comprehensive approach: loads Ember via requirejs to access internal registries
    // (NAMESPACES, _viewRegistry), searches ALL DOM elements globally for __ember*
    // metadata, loads game-state/crossclimb modules, and attempts to find the Ember
    // owner to look up services and reorder the model. Falls back to DOM reorder.
    if (!reordered) {
      log('Phase 3: Deep Ember reorder...');
      current = await readOrder();
      if (current && !isCorrect(current)) {
        const deepResult = await CrossclimbDOM.pageEmberDeepReorder(correctMiddleOrder);
        const reorderMethod = deepResult.reorderMethod || (deepResult.reordered ? 'unknown' : 'none');
        log(`  Deep reorder: ok=${deepResult.ok} ownerFound=${deepResult.ownerFound || false} reordered=${deepResult.reordered || false} method=${reorderMethod}`);

        // Log strategies tried
        if (deepResult.strategies?.length > 0) {
          for (const s of deepResult.strategies) {
            log(`  Strategy: ${s}`);
          }
        }

        // Log diagnostics
        const diag = deepResult.diag || {};
        if (diag.emberVersion) log(`  Ember version: ${diag.emberVersion}`);
        if (diag.namespaceCount !== undefined) log(`  Namespaces: ${diag.namespaceCount}`);
        if (diag.viewRegistryCount !== undefined) log(`  View registry entries: ${diag.viewRegistryCount}`);
        if (diag.globalEmberViews !== undefined) log(`  Global .ember-view elements: ${diag.globalEmberViews}`);
        if (diag.viewsWithMeta !== undefined) log(`  Views with __ember metadata: ${diag.viewsWithMeta}`);
        if (diag.candidateElements !== undefined) log(`  Candidate elements searched: ${diag.candidateElements} (with meta: ${diag.candidatesWithMeta || 0})`);
        if (diag.appClassKeys?.length > 0) log(`  App class keys: ${diag.appClassKeys.join(', ')}`);

        // Log lookups
        if (deepResult.lookups) {
          for (const [name, info] of Object.entries(deepResult.lookups)) {
            if (info.found) {
              log(`  Lookup ${name}: FOUND [${info.keys?.slice(0, 15).join(', ')}]`);
              if (info.sortCompKeys) log(`    sortComponent: [${info.sortCompKeys.slice(0, 15).join(', ')}]`);
              if (info.groupEntryCount !== undefined) log(`    groupEntries: ${info.groupEntryCount}`);
            } else if (info.error) {
              log(`  Lookup ${name}: error=${info.error}`);
            }
          }
        }

        // Log game-state module info
        if (diag.gameState) {
          const gs = diag.gameState;
          log(`  game-state module: defaultType=${gs.defaultType} keys=[${gs.keys?.join(', ')}]`);
          if (gs.protoKeys?.length > 0) log(`    proto: [${gs.protoKeys.join(', ')}]`);
          if (gs.objectKeys?.length > 0) log(`    object: [${gs.objectKeys.join(', ')}]`);
          if (gs.namedExports) log(`    exports: ${JSON.stringify(gs.namedExports)}`);
        }
        if (diag.gameStateError) log(`  game-state error: ${diag.gameStateError}`);

        // Log crossclimb component info
        if (diag.crossclimbComp) {
          log(`  crossclimb component: defaultType=${diag.crossclimbComp.defaultType}`);
          if (diag.crossclimbComp.protoKeys?.length > 0) log(`    proto: [${diag.crossclimbComp.protoKeys.join(', ')}]`);
        }
        if (diag.guessComp) {
          log(`  guess component: defaultType=${diag.guessComp.defaultType}`);
          if (diag.guessComp.protoKeys?.length > 0) log(`    proto: [${diag.guessComp.protoKeys.join(', ')}]`);
        }
        if (diag.sortableGroup) {
          log(`  sortable-group modifier: defaultType=${diag.sortableGroup.defaultType}`);
          if (diag.sortableGroup.protoKeys?.length > 0) log(`    proto: [${diag.sortableGroup.protoKeys.join(', ')}]`);
        }

        if (deepResult.reordered) {
          await CrossclimbDOM.sleep(1000);
          current = await readOrder();
          if (isCorrect(current)) {
            if (reorderMethod === 'ember-model') {
              log('  Ember model reorder succeeded!');
              reordered = true;
            } else if (reorderMethod === 'dom') {
              log('  DOM reorder succeeded visually but Ember model NOT updated');
              log('  WARNING: Game may not recognize the reorder. Endpoint rows may not unlock.');
              // Still mark as "reordered" so we don't retry, but the model may be stale
              reordered = true;
            } else {
              log('  Reorder succeeded (method: ' + reorderMethod + ')');
              reordered = true;
            }
          } else {
            log('  Reorder applied but visual order still wrong');
          }
        }
      }
    }

    // Final verification
    const final = await readOrder();
    if (final) {
      const finalWords = final.map(r => r.word);
      log(`Final order: ${finalWords.join(' → ')}`);
      if (JSON.stringify(finalWords) === JSON.stringify(correctMiddleOrder)) {
        log('Reordering successful!');
        if (!reordered) {
          log('NOTE: Visual order is correct but the game may not recognize it.');
          log('The game\'s Ember data model may need updating. Check Ember exploration logs above for clues.');
        }
      } else {
        log('WARNING: Final order does not match target. Manual reorder may be needed.');
        log(`Expected: ${correctMiddleOrder.join(' → ')}`);
      }
    }
  },

  // ----- LEGACY SUPPORT -----
  // Keep old discovery methods for diagnostics and fallback

  async _legacyDiscoverDOM(puzzleDataOverride = null) {
    const pd = puzzleDataOverride || this.state.puzzleData;
    const wordLadder = pd?.wordLadder;

    const info = {
      container: null,
      rows: [],
      wordRows: [],
      keyboard: null,
      isInIframe: false,
      isInShadow: false,
      doc: document,
      gameFrame: null,
      gameRoot: null,
    };

    // Check regular DOM
    const localRows = this._findLegacyRows(document, document.body);
    if (localRows.length >= 5) {
      info.rows = localRows;
      return info;
    }

    // Check for word-rows
    if (wordLadder?.length >= 7) {
      const wordRows = this._findWordRows(document, document.body, wordLadder);
      if (wordRows.length >= 3) {
        info.wordRows = wordRows;
        return info;
      }
    }

    // Check iframes
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!iframeDoc || !iframeDoc.body) continue;
        const iframeRows = this._findLegacyRows(iframeDoc, iframeDoc.body);
        if (iframeRows.length >= 5) {
          info.isInIframe = true;
          info.doc = iframeDoc;
          info.rows = iframeRows;
          return info;
        }
      } catch { /* cross-origin */ }
    }

    // No rows found — return diagnostics
    info.diagnostics = this._collectDiagnostics(document);
    return info;
  },

  _findLegacyRows(doc, container) {
    const root = container || doc.body;
    if (!root) return [];

    const rows = [];
    const allElements = root.querySelectorAll('*');

    for (const el of allElements) {
      const text = el.textContent.trim();
      if (text.length > 5000 || text.length === 0) continue;
      if (el.children.length < 2) continue;
      if (rows.find(r => r.element === el)) continue;

      // Class-name based cell lookup
      const letterEls = el.querySelectorAll(
        '[class*="cell"], [class*="Cell"], [class*="tile"], [class*="Tile"], ' +
        '[class*="letter"], [class*="Letter"]'
      );
      if (letterEls.length >= 3 && letterEls.length <= 8) {
        rows.push(this._makeRow(el, [...letterEls]));
        continue;
      }

      // Direct children whose textContent is a single letter
      const charChildren = [...el.children].filter(c => /^[A-Z]$/i.test(c.textContent.trim()));
      if (charChildren.length >= 3 && charChildren.length <= 8) {
        rows.push(this._makeRow(el, charChildren));
      }
    }

    return this._deduplicateRows(rows);
  },

  _findWordRows(doc, root, wordLadder) {
    if (!root || !wordLadder || wordLadder.length < 7) return [];
    const wordSet = new Set(wordLadder.map(w => w.toUpperCase()));
    const wordRows = [];
    const overlayEl = document.getElementById('crossclimb-solver-overlay');

    const allEls = root.querySelectorAll('*');
    for (const el of allEls) {
      if (overlayEl && (el === overlayEl || overlayEl.contains(el))) continue;
      const text = el.textContent.trim().toUpperCase();
      if (text.length > 20) continue;
      const collapsed = text.replace(/\s+/g, '');
      if (wordSet.has(collapsed) && collapsed.length >= 3) {
        let draggableAncestor = el;
        while (draggableAncestor && !draggableAncestor.draggable && draggableAncestor !== root) {
          draggableAncestor = draggableAncestor.parentElement;
        }
        wordRows.push({
          element: el,
          word: collapsed,
          draggableElement: draggableAncestor?.draggable ? draggableAncestor : null,
          rect: el.getBoundingClientRect(),
        });
      }
    }

    const seen = new Set();
    return wordRows.filter(wr => {
      if (seen.has(wr.word)) return false;
      seen.add(wr.word);
      return true;
    });
  },

  _makeRow(element, letterElements) {
    return {
      element,
      letterElements,
      currentLetters: letterElements.map(le => le.textContent.trim()).join(''),
      isLocked: (element.className?.toString() || '').toLowerCase().includes('lock'),
      draggable: element.draggable || element.getAttribute('draggable') === 'true',
    };
  },

  _deduplicateRows(rows) {
    return rows.filter((row, i) => {
      return !rows.some((other, j) => {
        if (i === j) return false;
        return row.element.contains(other.element) && row.element !== other.element;
      });
    });
  },

  _collectDiagnostics(doc) {
    const report = { singleLetterCount: 0, iframes: [] };

    const allEls = doc.querySelectorAll('*');
    let count = 0;
    for (const el of allEls) {
      if (/^[A-Z]$/i.test(el.textContent.trim())) count++;
    }
    report.singleLetterCount = count;

    const iframes = doc.querySelectorAll('iframe');
    for (const iframe of iframes) {
      let accessible = false;
      try {
        accessible = !!(iframe.contentDocument || iframe.contentWindow?.document);
      } catch { /* cross-origin */ }
      report.iframes.push({ src: (iframe.src || '').substring(0, 100), accessible });
    }

    return report;
  },

  async _legacySolve(domInfo, puzzleData, callbacks) {
    // Minimal fallback for non-crossclimb DOMs
    callbacks.onLog?.('Legacy solver not implemented in v1.5 — use Inspect DOM for diagnostics');
    callbacks.onError?.(new Error('Legacy solve path not available'));
  },

  // Public method for inspector compatibility
  _findRows(doc, container) {
    return this._findLegacyRows(doc, container);
  },

  _findKeyboard(doc) {
    const selectors = ['[class*="keyboard" i]', '[data-testid*="keyboard"]'];
    for (const sel of selectors) {
      try {
        const el = doc.querySelector(sel);
        if (el) return el;
      } catch { /* skip */ }
    }
    return null;
  },
};
