// CrossclimbSolver - Core Solver Logic
// Orchestrates reading clues, matching answers, typing, and reordering

const Solver = {
  // Configurable selectors — updated after DOM inspection
  selectors: {
    // Game container
    gameContainer: null,
    // Individual puzzle rows (should match 7 elements)
    puzzleRow: null,
    // Clue text within a row
    clueText: null,
    // Letter cells within a row (individual letter boxes)
    letterCell: null,
    // Lock indicator on a row
    lockIndicator: null,
    // Drag handle or draggable element within a row
    dragHandle: null,
    // Virtual keyboard container
    keyboard: null,
    // Individual keyboard key buttons
    keyButton: null,
  },

  // State
  state: {
    puzzleData: null,       // Parsed answer data from crossclimbanswer.io
    gameRows: [],           // DOM elements for each row
    clueMap: new Map(),     // Clue text -> row element
    currentPhase: 'idle',   // idle | inspecting | fetching | solving | reordering | finalizing | done
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

      // Step 1: Discover the DOM structure
      status('inspecting', 'Inspecting puzzle DOM...');
      const domInfo = await this._discoverDOM();
      log(`Found ${domInfo.rows.length} puzzle rows`);

      if (domInfo.rows.length === 0) {
        throw new Error('Could not find puzzle rows in the DOM. Run DOMInspector.inspect() in the console for details.');
      }

      // Step 2: Read clues from the DOM
      status('reading', 'Reading clues from puzzle...');
      const clues = this._readClues(domInfo);
      log(`Read ${clues.length} clues: ${clues.map(c => c.text.substring(0, 30) + '...').join(', ')}`);

      // Step 3: Match clues to answers
      status('matching', 'Matching clues to answers...');
      const matches = this._matchCluesToAnswers(clues, puzzleData);
      log(`Matched ${matches.length} clue-answer pairs`);

      for (const match of matches) {
        log(`  "${match.clue.substring(0, 40)}..." → ${match.answer}`);
      }

      // Step 4: Type answers into each row
      status('solving', 'Typing answers...');
      for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        status('solving', `Typing "${match.answer}" (${i + 1}/${matches.length})...`);
        await this._typeAnswer(match.rowElement, match.answer, domInfo);
        await CrossclimbDOM.sleep(300);
      }

      // Step 5: Reorder rows to form the correct word ladder
      status('reordering', 'Reordering rows...');
      const middleAnswers = AnswerParser.getMiddleAnswersOrdered(puzzleData);
      await this._reorderRows(domInfo, middleAnswers, matches);

      // Step 6: Wait for top/bottom to unlock and fill them
      status('finalizing', 'Waiting for top/bottom rows to unlock...');
      await this._handleTopBottom(domInfo, puzzleData);

      status('done', 'Puzzle solved!');
      onComplete?.();

    } catch (error) {
      status('error', error.message);
      onError?.(error);
      console.error('[CrossclimbSolver] Error:', error);
    }
  },

  // ----- DOM DISCOVERY -----

  async _discoverDOM() {
    const info = {
      container: null,
      rows: [],
      keyboard: null,
      isInIframe: false,
      doc: document,
      gameFrame: null,
    };

    // First: check if we ARE inside the game frame already
    // (content script runs in all_frames, so we might be inside the game iframe)
    const localRows = this._findRows(document, document.body);
    if (localRows.length >= 5) {
      console.log('[CrossclimbSolver] Game found in current frame');
      info.doc = document;
      info.rows = localRows;
      info.container = this._findGameContainer(document);
      info.keyboard = this._findKeyboard(document);
      return info;
    }

    // Check accessible iframes for the game
    const iframes = document.querySelectorAll('iframe');
    console.log(`[CrossclimbSolver] Checking ${iframes.length} iframes for game content...`);

    for (const iframe of iframes) {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!iframeDoc || !iframeDoc.body) continue;

        const iframeRows = this._findRows(iframeDoc, iframeDoc.body);
        console.log(`[CrossclimbSolver] iframe "${iframe.src?.substring(0, 60) || '(no src)'}" → ${iframeRows.length} rows found`);

        if (iframeRows.length >= 5) {
          info.isInIframe = true;
          info.doc = iframeDoc;
          info.gameFrame = iframe;
          info.rows = iframeRows;
          info.container = this._findGameContainer(iframeDoc);
          info.keyboard = this._findKeyboard(iframeDoc);
          console.log('[CrossclimbSolver] Game found in iframe:', iframe.src);
          return info;
        }
      } catch (e) {
        console.log(`[CrossclimbSolver] Cannot access iframe (cross-origin): ${iframe.src?.substring(0, 60) || '(no src)'}`);
      }
    }

    // Fallback: use whatever we found in the main document
    info.rows = localRows;
    info.container = this._findGameContainer(document);
    info.keyboard = this._findKeyboard(document);

    // If still no rows, log diagnostic info
    if (info.rows.length === 0) {
      console.warn('[CrossclimbSolver] No puzzle rows found in any frame!');
      this._logDiagnostics(document);
    }

    return info;
  },

  // Log diagnostics when we can't find the game
  _logDiagnostics(doc) {
    console.log('[CrossclimbSolver] === DIAGNOSTICS ===');

    // Count elements with single-letter text content at various depths
    const singleLetterEls = doc.querySelectorAll('*');
    let singleLetterCount = 0;
    const sampleParents = new Set();
    for (const el of singleLetterEls) {
      if (el.children.length === 0 && /^[A-Z]$/i.test(el.textContent.trim())) {
        singleLetterCount++;
        if (sampleParents.size < 10 && el.parentElement) {
          sampleParents.add(el.parentElement);
        }
      }
    }
    console.log(`[CrossclimbSolver] Found ${singleLetterCount} single-letter leaf elements`);

    // Show sample parents of single-letter elements
    for (const parent of sampleParents) {
      const letters = [...parent.children]
        .filter(c => c.children.length === 0 && /^[A-Z]$/i.test(c.textContent.trim()))
        .map(c => c.textContent.trim());
      console.log(`[CrossclimbSolver]   Parent: <${parent.tagName}> class="${(parent.className?.toString() || '').substring(0, 80)}" children-letters: ${letters.join('')} (${letters.length} letters)`);

      // Also check grandparent
      const gp = parent.parentElement;
      if (gp) {
        console.log(`[CrossclimbSolver]     Grandparent: <${gp.tagName}> class="${(gp.className?.toString() || '').substring(0, 80)}" children: ${gp.children.length}`);
      }
    }

    // Check draggable elements
    const draggables = doc.querySelectorAll('[draggable="true"]');
    console.log(`[CrossclimbSolver] Draggable elements: ${draggables.length}`);
    for (const d of [...draggables].slice(0, 5)) {
      console.log(`[CrossclimbSolver]   <${d.tagName}> class="${(d.className?.toString() || '').substring(0, 80)}" text="${d.textContent.trim().substring(0, 60)}"`);
    }

    // List all iframes with access status
    const iframes = doc.querySelectorAll('iframe');
    for (const iframe of iframes) {
      let accessible = false;
      let bodyChildCount = 0;
      try {
        const idoc = iframe.contentDocument || iframe.contentWindow?.document;
        accessible = !!idoc;
        bodyChildCount = idoc?.body?.children?.length || 0;
      } catch { /* cross-origin */ }
      console.log(`[CrossclimbSolver]   iframe src="${(iframe.src || '').substring(0, 80)}" accessible=${accessible} bodyChildren=${bodyChildCount}`);
    }

    console.log('[CrossclimbSolver] === END DIAGNOSTICS ===');
  },

  _findGameContainer(doc) {
    // Try specific selectors first, then broader ones
    const selectors = [
      '[class*="crossclimb" i]',
      '[class*="game-board" i]', '[class*="gameboard" i]',
      '[class*="puzzle-board" i]', '[class*="puzzleboard" i]',
      '[class*="word-ladder" i]', '[class*="wordladder" i]',
      '[data-testid*="game"]', '[data-testid*="board"]',
      '[role="application"]',
      'main'
    ];

    for (const sel of selectors) {
      try {
        const el = doc.querySelector(sel);
        if (el) return el;
      } catch {
        // Invalid selector, skip
      }
    }

    return doc.body;
  },

  _findRows(doc, container) {
    const root = container || doc.body;
    if (!root) return [];

    const rows = [];
    const allElements = root.querySelectorAll('*');

    for (const el of allElements) {
      const text = el.textContent.trim();
      if (text.length > 500 || text.length === 0) continue;

      const children = el.children;
      if (children.length < 2) continue;

      // --- Strategy 1: class-name based cell lookup ---
      const letterEls = el.querySelectorAll(
        '[class*="cell"], [class*="Cell"], [class*="tile"], [class*="Tile"], ' +
        '[class*="letter"], [class*="Letter"], [class*="char"], [class*="Char"], ' +
        '[class*="square"], [class*="Square"]'
      );
      if (letterEls.length >= 3 && letterEls.length <= 8) {
        rows.push(this._makeRow(el, [...letterEls]));
        continue;
      }

      // --- Strategy 2: direct children are single uppercase letters ---
      const charChildren = [...children].filter(c =>
        /^[A-Z]$/i.test(c.textContent.trim()) && c.children.length === 0
      );
      if (charChildren.length >= 3) {
        rows.push(this._makeRow(el, charChildren));
        continue;
      }

      // --- Strategy 3: grandchildren are single letters ---
      // e.g. <row><wrapper><span>M</span><span>E</span>...</wrapper></row>
      for (const child of children) {
        const grandcharChildren = [...child.children].filter(gc =>
          /^[A-Z]$/i.test(gc.textContent.trim()) && gc.children.length === 0
        );
        if (grandcharChildren.length >= 3) {
          rows.push(this._makeRow(el, grandcharChildren));
          break; // Don't double-count this row
        }
      }

      // --- Strategy 4: leaf descendants are single letters (any depth) ---
      // Find all leaf text nodes that are single uppercase letters
      if (!rows.find(r => r.element === el)) {
        const leafLetters = [];
        const walk = (node) => {
          if (node.children.length === 0) {
            const t = node.textContent.trim();
            if (/^[A-Z]$/i.test(t)) leafLetters.push(node);
          } else {
            for (const c of node.children) walk(c);
          }
        };
        walk(el);

        // Only count if we have 3-8 leaf letter elements AND the element isn't too big
        // (to avoid matching the entire page body)
        if (leafLetters.length >= 3 && leafLetters.length <= 8 && text.length < 200) {
          rows.push(this._makeRow(el, leafLetters));
        }
      }
    }

    // Also try: find draggable elements that contain letter sequences
    const draggables = root.querySelectorAll('[draggable="true"]');
    for (const el of draggables) {
      if (rows.find(r => r.element === el || r.element.contains(el) || el.contains(r.element))) continue;

      const text = el.textContent.trim();
      if (text.length > 200 || text.length === 0) continue;

      const leafLetters = [];
      const walk = (node) => {
        if (node.children.length === 0) {
          const t = node.textContent.trim();
          if (/^[A-Z]$/i.test(t)) leafLetters.push(node);
        } else {
          for (const c of node.children) walk(c);
        }
      };
      walk(el);

      if (leafLetters.length >= 3 && leafLetters.length <= 8) {
        rows.push(this._makeRow(el, leafLetters));
      }
    }

    // Deduplicate: prefer innermost matching elements
    return this._deduplicateRows(rows);
  },

  _makeRow(element, letterElements) {
    return {
      element,
      letterElements,
      text: element.textContent.trim(),
      isLocked: this._isRowLocked(element),
      currentLetters: letterElements.map(le => le.textContent.trim()).join(''),
      draggable: element.draggable || element.getAttribute('draggable') === 'true',
      dragHandle: element.querySelector('[class*="drag"], [class*="Drag"], [class*="grip"], [class*="Grip"], [class*="handle"], [class*="Handle"]')
    };
  },

  _isRowLocked(element) {
    const className = element.className?.toString().toLowerCase() || '';
    const hasLockClass = className.includes('lock');

    const hasLockChild = element.querySelector(
      '[class*="lock"], [class*="Lock"], [aria-label*="lock"], [aria-label*="Lock"]'
    );

    // Check for lock emoji or icon
    const hasLockText = element.textContent.includes('🔒') || element.textContent.includes('🔐');

    // Check aria attributes
    const isDisabled = element.getAttribute('aria-disabled') === 'true';

    // Check for SVG lock icons
    const hasSvgLock = element.querySelector('svg[class*="lock"], svg[aria-label*="lock"]');

    // Check if the element or a parent has a "locked" state class
    const hasLockedState = className.includes('locked') || className.includes('disabled');

    return hasLockClass || !!hasLockChild || hasLockText || isDisabled || !!hasSvgLock || hasLockedState;
  },

  _deduplicateRows(rows) {
    // Remove rows that are ancestors of other rows (keep the most specific)
    return rows.filter((row, i) => {
      return !rows.some((other, j) => {
        if (i === j) return false;
        return row.element.contains(other.element) && row.element !== other.element;
      });
    });
  },

  _findKeyboard(doc) {
    const selectors = [
      '[class*="keyboard" i]',
      '[data-testid*="keyboard"]',
      '[aria-label*="keyboard" i]'
    ];

    for (const sel of selectors) {
      try {
        const el = doc.querySelector(sel);
        if (el) return el;
      } catch {
        // Skip invalid selectors
      }
    }

    // Fallback: look for a container with many single-letter buttons
    const buttons = doc.querySelectorAll('button, [role="button"]');
    const letterBtns = [...buttons].filter(b => /^[A-Z]$/i.test(b.textContent.trim()));
    if (letterBtns.length >= 20 && letterBtns[0].parentElement) {
      // Walk up to find the keyboard container
      let container = letterBtns[0].parentElement;
      while (container.parentElement && container.querySelectorAll('button, [role="button"]').length < letterBtns.length) {
        container = container.parentElement;
      }
      return container;
    }

    return null;
  },

  // ----- CLUE READING -----

  _readClues(domInfo) {
    const clues = [];

    for (const row of domInfo.rows) {
      if (row.isLocked) continue;

      // Try to find clue text associated with this row
      const clueText = this._extractClueFromRow(row.element, domInfo.doc);
      if (clueText) {
        clues.push({
          text: clueText,
          rowElement: row.element,
          letterElements: row.letterElements,
          currentLetters: row.currentLetters
        });
      }
    }

    return clues;
  },

  _extractClueFromRow(rowElement, doc) {
    // Strategy 1: Look for aria-label or data attributes
    const ariaLabel = rowElement.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.length > 10) return ariaLabel;

    // Strategy 2: Look for a sibling or child with clue-like content
    const textNodes = [];
    const walker = doc.createTreeWalker(rowElement, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      // Clues are typically sentences/phrases, not single words or letters
      if (text.length > 10 && !/^[A-Z]{1,2}$/.test(text)) {
        textNodes.push(text);
      }
    }
    if (textNodes.length > 0) {
      // Return the longest text node (most likely to be the clue)
      return textNodes.reduce((a, b) => a.length > b.length ? a : b);
    }

    // Strategy 3: Check adjacent siblings
    const parent = rowElement.parentElement;
    if (parent) {
      const siblings = [...parent.children];
      const idx = siblings.indexOf(rowElement);

      // Check next sibling (clue might be below the row)
      if (idx + 1 < siblings.length) {
        const nextText = siblings[idx + 1].textContent.trim();
        if (nextText.length > 10 && nextText.length < 200) return nextText;
      }

      // Check previous sibling
      if (idx - 1 >= 0) {
        const prevText = siblings[idx - 1].textContent.trim();
        if (prevText.length > 10 && prevText.length < 200) return prevText;
      }
    }

    return null;
  },

  // ----- CLUE-ANSWER MATCHING -----

  _matchCluesToAnswers(clues, puzzleData) {
    const matches = [];
    const usedAnswers = new Set();

    for (const clue of clues) {
      let bestMatch = null;
      let bestScore = 0;

      for (const pair of puzzleData.clueAnswerPairs) {
        if (usedAnswers.has(pair.answer)) continue;

        const score = this._clueMatchScore(clue.text, pair.clue);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = pair;
        }
      }

      if (bestMatch && bestScore > 0.3) {
        matches.push({
          clue: clue.text,
          answer: bestMatch.answer,
          rowElement: clue.rowElement,
          letterElements: clue.letterElements,
          confidence: bestScore
        });
        usedAnswers.add(bestMatch.answer);
      } else {
        console.warn(`[CrossclimbSolver] No match for clue: "${clue.text.substring(0, 50)}..."`);
      }
    }

    // If we couldn't match all 5, try word-length based matching as fallback
    if (matches.length < 5 && puzzleData.wordLadder.length >= 7) {
      console.log('[CrossclimbSolver] Falling back to word-length matching');
      const middleWords = puzzleData.wordLadder.slice(1, 6);

      for (const clue of clues) {
        const existingMatch = matches.find(m => m.rowElement === clue.rowElement);
        if (existingMatch) continue;

        // Match by letter count
        const wordLength = clue.letterElements.length;
        const candidate = middleWords.find(w => w.length === wordLength && !usedAnswers.has(w));
        if (candidate) {
          matches.push({
            clue: clue.text,
            answer: candidate,
            rowElement: clue.rowElement,
            letterElements: clue.letterElements,
            confidence: 0.2
          });
          usedAnswers.add(candidate);
        }
      }
    }

    return matches;
  },

  // Score how well two clue texts match (0-1)
  _clueMatchScore(clueFromDOM, clueFromSite) {
    const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

    const a = normalize(clueFromDOM);
    const b = normalize(clueFromSite);

    // Exact match
    if (a === b) return 1.0;

    // One contains the other
    if (a.includes(b) || b.includes(a)) return 0.9;

    // Word overlap (Jaccard similarity)
    const wordsA = new Set(a.split(' '));
    const wordsB = new Set(b.split(' '));
    const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);
    const jaccard = intersection.size / union.size;

    return jaccard;
  },

  // ----- ANSWER TYPING -----

  async _typeAnswer(rowElement, answer, domInfo) {
    // First, click/select the row
    await CrossclimbDOM.clickElement(rowElement);
    await CrossclimbDOM.sleep(200);

    // Try multiple typing strategies
    const strategies = [
      () => this._typeViaKeyboard(answer, domInfo),
      () => this._typeViaKeyEvents(rowElement, answer),
      () => this._typeViaVirtualKeyboard(answer, domInfo),
    ];

    for (const strategy of strategies) {
      try {
        await strategy();
        return;
      } catch (error) {
        console.log(`[CrossclimbSolver] Typing strategy failed: ${error.message}, trying next...`);
      }
    }

    throw new Error(`Failed to type answer "${answer}" into row`);
  },

  // Type using keyboard events on the focused element
  async _typeViaKeyEvents(rowElement, answer) {
    // The active element after clicking the row
    const target = document.activeElement || rowElement;
    await CrossclimbDOM.simulateKeyPresses(target, answer, { delay: 80 });
  },

  // Type using the virtual keyboard buttons
  async _typeViaVirtualKeyboard(answer, domInfo) {
    if (!domInfo.keyboard) {
      throw new Error('No virtual keyboard found');
    }
    await CrossclimbDOM.clickVirtualKeyboard(answer, {
      keyboardSelector: null // We already have the keyboard element
    });
  },

  // Type by dispatching keyboard events to the document
  async _typeViaKeyboard(answer, domInfo) {
    for (const char of answer) {
      const key = char.toUpperCase();
      const code = `Key${key}`;
      const keyCode = key.charCodeAt(0);

      const props = {
        key, code, keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true,
        composed: true
      };

      // Dispatch to both the document and any focused element
      const targets = [document, document.activeElement].filter(Boolean);
      for (const target of targets) {
        target.dispatchEvent(new KeyboardEvent('keydown', props));
        target.dispatchEvent(new KeyboardEvent('keypress', props));
        target.dispatchEvent(new KeyboardEvent('keyup', props));
      }

      await CrossclimbDOM.sleep(80);
    }
  },

  // ----- ROW REORDERING -----

  async _reorderRows(domInfo, correctOrder, matches) {
    // correctOrder is an array of words in the correct top-to-bottom sequence
    // matches tells us which answer is in which row element

    // Build a map of answer -> current DOM position
    const answerToElement = new Map();
    for (const match of matches) {
      answerToElement.set(match.answer, match.rowElement);
    }

    // Get current visual order of rows (sorted by Y position)
    const rowPositions = matches.map(match => ({
      answer: match.answer,
      element: match.rowElement,
      y: match.rowElement.getBoundingClientRect().top
    }));
    rowPositions.sort((a, b) => a.y - b.y);
    const currentOrder = rowPositions.map(r => r.answer);

    console.log('[CrossclimbSolver] Current order:', currentOrder);
    console.log('[CrossclimbSolver] Target order:', correctOrder);

    // Calculate the moves needed (bubble sort approach — swap adjacent elements)
    const moves = this._calculateMoves(currentOrder, correctOrder);
    console.log(`[CrossclimbSolver] Need ${moves.length} swap(s) to reorder`);

    // Execute each move with drag simulation
    for (let i = 0; i < moves.length; i++) {
      const move = moves[i];
      console.log(`[CrossclimbSolver] Move ${i + 1}: Swap "${move.word}" from position ${move.from} to ${move.to}`);

      // Re-read current positions (they may have changed after previous drags)
      const freshPositions = matches
        .map(m => ({ answer: m.answer, element: m.rowElement, y: m.rowElement.getBoundingClientRect().top }))
        .sort((a, b) => a.y - b.y);

      const sourceIdx = freshPositions.findIndex(p => p.answer === move.word);
      const targetIdx = move.to;

      if (sourceIdx === -1 || sourceIdx === targetIdx) continue;

      const sourceEl = freshPositions[sourceIdx].element;
      const targetEl = freshPositions[targetIdx].element;

      // Try pointer drag first, then HTML5 drag, then touch
      const dragStrategies = [
        () => CrossclimbDOM.pointerDrag(sourceEl, targetEl),
        () => CrossclimbDOM.html5DragDrop(sourceEl, targetEl),
        () => CrossclimbDOM.touchDrag(sourceEl, targetEl),
      ];

      let dragSuccess = false;
      for (const strategy of dragStrategies) {
        try {
          await strategy();
          dragSuccess = true;
          break;
        } catch (error) {
          console.log(`[CrossclimbSolver] Drag strategy failed: ${error.message}`);
        }
      }

      if (!dragSuccess) {
        console.warn('[CrossclimbSolver] All drag strategies failed for this move');
      }

      await CrossclimbDOM.sleep(500); // Wait for animation
    }
  },

  // Calculate minimum swaps to transform currentOrder into targetOrder
  _calculateMoves(current, target) {
    const moves = [];
    const arr = [...current];

    for (let i = 0; i < target.length; i++) {
      if (arr[i] !== target[i]) {
        const fromIdx = arr.indexOf(target[i]);
        if (fromIdx === -1) continue;

        moves.push({
          word: target[i],
          from: fromIdx,
          to: i
        });

        // Perform the swap in our tracking array
        [arr[i], arr[fromIdx]] = [arr[fromIdx], arr[i]];
      }
    }

    return moves;
  },

  // ----- TOP/BOTTOM HANDLING -----

  async _handleTopBottom(domInfo, puzzleData) {
    if (!puzzleData.startWord || !puzzleData.endWord) {
      console.log('[CrossclimbSolver] No start/end words to fill');
      return;
    }

    // Wait for top/bottom rows to become unlocked
    try {
      await CrossclimbDOM.waitForCondition(() => {
        // Re-find rows and check if locked status changed
        const rows = this._findRows(domInfo.doc, domInfo.container);
        const lockedRows = rows.filter(r => r.isLocked);
        return lockedRows.length === 0;
      }, { timeout: 10000, pollInterval: 500 });
    } catch {
      console.log('[CrossclimbSolver] Top/bottom rows did not unlock within timeout');
      console.log('[CrossclimbSolver] They may need manual intervention or may already be filled');
      return;
    }

    console.log('[CrossclimbSolver] Top/bottom rows unlocked!');

    // Re-discover rows
    const freshDomInfo = await this._discoverDOM();

    // Find the top and bottom rows (by position)
    const sortedRows = freshDomInfo.rows
      .map(r => ({ ...r, y: r.element.getBoundingClientRect().top }))
      .sort((a, b) => a.y - b.y);

    if (sortedRows.length >= 2) {
      const topRow = sortedRows[0];
      const bottomRow = sortedRows[sortedRows.length - 1];

      // Type the start word in the top row
      if (!topRow.isLocked) {
        console.log(`[CrossclimbSolver] Typing "${puzzleData.startWord}" in top row`);
        await this._typeAnswer(topRow.element, puzzleData.startWord, freshDomInfo);
        await CrossclimbDOM.sleep(300);
      }

      // Type the end word in the bottom row
      if (!bottomRow.isLocked) {
        console.log(`[CrossclimbSolver] Typing "${puzzleData.endWord}" in bottom row`);
        await this._typeAnswer(bottomRow.element, puzzleData.endWord, freshDomInfo);
      }
    }
  }
};
