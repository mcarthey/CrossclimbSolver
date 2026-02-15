// CrossclimbSolver - Core Solver Logic v1.5.0
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

      // Tag rows with data attributes so the page-context bridge can find them
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

      // Step 4: Fill in each middle row
      status('solving', 'Filling in answers...');
      const filledAnswers = []; // track what we put where

      for (let i = 0; i < board.middleRows.length; i++) {
        const row = board.middleRows[i];
        status('solving', `Working on row ${i + 1}/${board.middleRows.length}...`);

        // Click the row to activate it
        await this._activateRow(row);
        await CrossclimbDOM.sleep(400);

        // Read the clue that appears for this row
        const clueText = this._readActiveClue(board.gridContainer);
        log(`Row ${i + 1} clue: "${clueText || '(none)'}"`);

        // Match clue to an answer
        let answer = null;
        if (clueText) {
          answer = this._matchClueToAnswer(clueText, puzzleData, filledAnswers.map(f => f.answer));
        }

        // If clue matching failed, use position-based assignment
        if (!answer) {
          const remaining = middleAnswers.filter(a => !filledAnswers.some(f => f.answer === a));
          if (remaining.length > 0) {
            answer = remaining[0];
            log(`  No clue match, using fallback: ${answer}`);
          }
        }

        if (!answer) {
          log(`  WARNING: No answer available for row ${i + 1}`);
          continue;
        }

        log(`  Typing "${answer}" into row ${i + 1}`);
        await this._typeIntoRow(row, answer, board, log);
        filledAnswers.push({ answer, rowElement: row, index: i });
        await CrossclimbDOM.sleep(300);
      }

      log(`Filled ${filledAnswers.length}/${board.middleRows.length} rows`);

      // Step 4: Reorder rows to form the correct word ladder
      if (filledAnswers.length >= 2) {
        status('reordering', 'Reordering rows...');
        await this._reorderMiddleRows(board, middleAnswers, filledAnswers, log);
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

  // ----- TYPING -----

  async _typeIntoRow(rowElement, answer, board, log) {
    const idx = rowElement.getAttribute('data-cs-row');
    const boxSel = `[data-cs-row="${idx}"] .crossclimb__guess_box`;

    // Click the first box via page-context bridge
    const clickResult = await CrossclimbDOM.pageClick(boxSel);
    if (log) log(`  Click box: ok=${clickResult.ok}${clickResult.error ? ' err=' + clickResult.error : ''}`);
    await CrossclimbDOM.sleep(200);

    // Type the whole word via the page-context bridge
    const result = await CrossclimbDOM.pageTypeWord(answer);
    if (log) {
      log(`  Type word: ok=${result.ok}${result.error ? ' err=' + result.error : ''}`);
      // Log details from first key to understand what strategies were tried
      if (result.keyDetails && result.keyDetails[0]) {
        const kd = result.keyDetails[0];
        log(`  First key: active=${kd.activeTag}.${kd.activeClass} strategies=[${kd.strategies?.join(', ')}]`);
      }
    }

    if (!result.ok) {
      // Fallback: try key-by-key from page context
      if (log) log(`  Falling back to key-by-key typing`);
      for (const char of answer) {
        await CrossclimbDOM.pageTypeKey(char);
        await CrossclimbDOM.sleep(80);
      }
    }
  },

  // ----- ROW REORDERING -----

  async _reorderMiddleRows(board, correctMiddleOrder, filledAnswers, log) {
    // correctMiddleOrder is [word2, word3, word4, word5, word6] in correct ladder order
    // filledAnswers tracks which answer is in which row

    // Get current visual order (by Y position)
    const getCurrentOrder = () => {
      return filledAnswers
        .map(f => ({
          answer: f.answer,
          element: f.rowElement,
          y: f.rowElement.getBoundingClientRect().top,
        }))
        .sort((a, b) => a.y - b.y)
        .map(f => f.answer);
    };

    const currentOrder = getCurrentOrder();
    log(`Current order: ${currentOrder.join(' → ')}`);
    log(`Target order:  ${correctMiddleOrder.join(' → ')}`);

    // Check if already correct
    if (JSON.stringify(currentOrder) === JSON.stringify(correctMiddleOrder)) {
      log('Rows already in correct order!');
      return;
    }

    // Calculate moves needed (selection sort approach)
    for (let targetIdx = 0; targetIdx < correctMiddleOrder.length; targetIdx++) {
      const freshOrder = getCurrentOrder();
      const targetWord = correctMiddleOrder[targetIdx];
      const currentIdx = freshOrder.indexOf(targetWord);

      if (currentIdx === targetIdx) continue; // Already in place
      if (currentIdx === -1) {
        log(`  WARNING: "${targetWord}" not found in current rows`);
        continue;
      }

      log(`  Moving "${targetWord}" from position ${currentIdx} to ${targetIdx}`);

      // Find the source and target row elements by position
      const sortedElements = filledAnswers
        .map(f => ({ answer: f.answer, element: f.rowElement, y: f.rowElement.getBoundingClientRect().top }))
        .sort((a, b) => a.y - b.y);

      const sourceEntry = sortedElements.find(e => e.answer === targetWord);
      const targetEntry = sortedElements[targetIdx];

      if (!sourceEntry || !targetEntry || sourceEntry.element === targetEntry.element) continue;

      // Get data-cs-row indices for CSS selectors
      const srcIdx = sourceEntry.element.getAttribute('data-cs-row');
      const tgtIdx = targetEntry.element.getAttribute('data-cs-row');

      // Try drag via page-context bridge (dragger handle first, then row itself)
      const strategies = [
        { name: 'bridge-dragger', srcSel: `[data-cs-row="${srcIdx}"] .crossclimb__guess-dragger`, tgtSel: `[data-cs-row="${tgtIdx}"] .crossclimb__guess-dragger` },
        { name: 'bridge-row', srcSel: `[data-cs-row="${srcIdx}"]`, tgtSel: `[data-cs-row="${tgtIdx}"]` },
      ];

      let success = false;
      for (const s of strategies) {
        const result = await CrossclimbDOM.pageDrag(s.srcSel, s.tgtSel);
        log(`    Drag via ${s.name}: ok=${result.ok}${result.error ? ' err=' + result.error : ''}`);
        if (result.ok) { success = true; break; }
      }

      if (!success) {
        log(`  WARNING: All drag strategies failed for "${targetWord}"`);
      }

      await CrossclimbDOM.sleep(600); // Wait for animation
    }

    // Verify final order
    const finalOrder = getCurrentOrder();
    log(`Final order: ${finalOrder.join(' → ')}`);
    if (JSON.stringify(finalOrder) === JSON.stringify(correctMiddleOrder)) {
      log('Reordering successful!');
    } else {
      log('WARNING: Final order does not match target');
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
