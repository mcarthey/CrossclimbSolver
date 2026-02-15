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

      // Check if we found word-rows (drag-to-reorder mode)
      if (domInfo.rows.length === 0 && domInfo.wordRows.length >= 3) {
        log(`Found ${domInfo.wordRows.length} word-rows (drag-to-reorder mode)`);
        for (const wr of domInfo.wordRows) {
          log(`  "${wr.word}" draggable=${!!wr.draggableElement} rect=${Math.round(wr.rect.top)},${Math.round(wr.rect.left)}`);
        }

        // Solve via drag-to-reorder
        status('reordering', 'Reordering word rows...');
        await this._solveByReordering(domInfo.wordRows, puzzleData, log);
        status('done', 'Puzzle solved!');
        onComplete?.();
        return;
      }

      if (domInfo.rows.length === 0) {
        // Surface diagnostics in the overlay
        if (domInfo.diagnostics) {
          const d = domInfo.diagnostics;
          log(`DIAGNOSTICS: ${d.singleLetterCount} single-letter elements found`);
          for (const p of d.parentSamples) {
            log(`  Parent: <${p.tag}> letters="${p.letters}" (${p.count}) textLen=${p.textLength}`);
          }
          for (const dr of d.draggables.slice(0, 5)) {
            log(`  Draggable: "${dr.text}" childLetters="${dr.childLetters}"`);
          }
          for (const iframe of d.iframes) {
            log(`  iframe: ${iframe.src} accessible=${iframe.accessible}`);
          }
        }
        throw new Error('Could not find puzzle rows in the DOM. Check diagnostics above.');
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
      wordRows: [],  // Word-row mode: rows containing whole words (for drag-to-reorder)
      keyboard: null,
      isInIframe: false,
      isInShadow: false,
      doc: document,
      gameFrame: null,
      gameRoot: null,  // Could be a shadow root
    };

    // First: check regular DOM in current frame
    const localRows = this._findRows(document, document.body);
    if (localRows.length >= 5) {
      console.log('[CrossclimbSolver] Game found in current frame (letter-cell mode)');
      info.doc = document;
      info.rows = localRows;
      info.container = this._findGameContainer(document);
      info.keyboard = this._findKeyboard(document);
      return info;
    }

    // Check for word-rows in current frame (drag-to-reorder mode)
    if (this.state.puzzleData?.wordLadder?.length >= 7) {
      const wordRows = this._findWordRows(document, document.body, this.state.puzzleData.wordLadder);
      if (wordRows.length >= 3) {
        console.log('[CrossclimbSolver] Game found in current frame (word-row mode)');
        info.doc = document;
        info.wordRows = wordRows;
        info.container = this._findGameContainer(document);
        return info;
      }
    }

    // Walk Shadow DOM trees looking for game content
    console.log('[CrossclimbSolver] Checking Shadow DOM...');
    const shadowRoots = this._findAllShadowRoots(document);
    console.log(`[CrossclimbSolver] Found ${shadowRoots.length} shadow root(s)`);

    for (const { root, host } of shadowRoots) {
      const shadowRows = this._findRows(root, root);
      if (shadowRows.length >= 5) {
        console.log('[CrossclimbSolver] Game found in Shadow DOM!');
        info.isInShadow = true;
        info.gameRoot = root;
        info.rows = shadowRows;
        info.container = host;
        info.keyboard = this._findKeyboard(root);
        return info;
      }

      // Also check for word-rows in shadow DOM
      if (this.state.puzzleData?.wordLadder?.length >= 7) {
        const shadowWordRows = this._findWordRows(root, root, this.state.puzzleData.wordLadder);
        if (shadowWordRows.length >= 3) {
          console.log('[CrossclimbSolver] Game found in Shadow DOM (word-row mode)!');
          info.isInShadow = true;
          info.gameRoot = root;
          info.wordRows = shadowWordRows;
          info.container = host;
          return info;
        }
      }
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

        // Check iframe shadow DOMs too
        const iframeShadowRoots = this._findAllShadowRoots(iframeDoc);
        for (const { root, host } of iframeShadowRoots) {
          const sr = this._findRows(root, root);
          if (sr.length >= 5) {
            console.log('[CrossclimbSolver] Game found in iframe Shadow DOM!');
            info.isInIframe = true;
            info.isInShadow = true;
            info.gameRoot = root;
            info.rows = sr;
            info.container = host;
            return info;
          }
        }

        // Word-rows in iframe
        if (this.state.puzzleData?.wordLadder?.length >= 7) {
          const iframeWordRows = this._findWordRows(iframeDoc, iframeDoc.body, this.state.puzzleData.wordLadder);
          if (iframeWordRows.length >= 3) {
            console.log('[CrossclimbSolver] Game found in iframe (word-row mode)');
            info.isInIframe = true;
            info.doc = iframeDoc;
            info.gameFrame = iframe;
            info.wordRows = iframeWordRows;
            return info;
          }
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
    if (info.rows.length === 0 && info.wordRows.length === 0) {
      console.warn('[CrossclimbSolver] No puzzle rows found in any frame or shadow root!');
      info.diagnostics = this._logDiagnostics(document);
    }

    return info;
  },

  // Find all shadow roots in a document, recursively
  _findAllShadowRoots(doc) {
    const results = [];
    const walk = (root) => {
      const els = root.querySelectorAll('*');
      for (const el of els) {
        if (el.shadowRoot) {
          results.push({ root: el.shadowRoot, host: el });
          walk(el.shadowRoot);
        }
      }
    };
    walk(doc);
    return results;
  },

  // Find elements containing whole words from our answer ladder
  // For Crossclimb's drag-to-reorder game mode
  _findWordRows(doc, root, wordLadder) {
    if (!root || !wordLadder || wordLadder.length < 7) return [];

    const wordSet = new Set(wordLadder.map(w => w.toUpperCase()));
    const wordRows = [];

    // Walk all elements looking for those whose text matches an answer word
    const allEls = root.querySelectorAll('*');
    for (const el of allEls) {
      const text = el.textContent.trim().toUpperCase();
      // Skip very large elements (they contain multiple words)
      if (text.length > 20) continue;

      // Check if this element's text matches an answer word
      // Account for spaced-out letters like "H O R N S"
      const collapsed = text.replace(/\s+/g, '');
      if (wordSet.has(collapsed) && collapsed.length >= 3) {
        // Find the draggable ancestor (if any)
        let draggableAncestor = el;
        while (draggableAncestor && !draggableAncestor.draggable && draggableAncestor !== root) {
          draggableAncestor = draggableAncestor.parentElement;
        }

        wordRows.push({
          element: el,
          word: collapsed,
          draggableElement: draggableAncestor?.draggable ? draggableAncestor : null,
          text: el.textContent.trim(),
          rect: el.getBoundingClientRect(),
          isLeaf: el.children.length === 0,
          parentTag: el.parentElement?.tagName,
          parentClass: (el.parentElement?.className?.toString() || '').substring(0, 100),
        });
      }
    }

    // Deduplicate: prefer innermost exact matches
    const seen = new Set();
    return wordRows.filter(wr => {
      if (seen.has(wr.word)) return false;
      seen.add(wr.word);
      return true;
    });
  },

  // Log diagnostics when we can't find the game
  // Returns a report object so the overlay can display it
  _logDiagnostics(doc) {
    const report = { singleLetterCount: 0, parentSamples: [], draggables: [], iframes: [] };
    console.log('[CrossclimbSolver] === DIAGNOSTICS ===');

    // Count elements with single-letter text content (both leaf and non-leaf)
    const allEls = doc.querySelectorAll('*');
    let leafLetterCount = 0;
    let textContentLetterCount = 0;
    const leafParents = new Set();
    const textParents = new Set();

    for (const el of allEls) {
      const trimmed = el.textContent.trim();
      if (/^[A-Z]$/i.test(trimmed)) {
        textContentLetterCount++;
        if (textParents.size < 10 && el.parentElement) textParents.add(el.parentElement);
        if (el.children.length === 0) {
          leafLetterCount++;
          if (leafParents.size < 10 && el.parentElement) leafParents.add(el.parentElement);
        }
      }
    }

    console.log(`[CrossclimbSolver] Single-letter elements: ${textContentLetterCount} total, ${leafLetterCount} leaf nodes`);
    report.singleLetterCount = textContentLetterCount;

    // Show parents that have 3+ single-letter children (textContent-based)
    console.log('[CrossclimbSolver] Parents with 3+ single-letter children (textContent):');
    for (const parent of textParents) {
      const letters = [...parent.children]
        .filter(c => /^[A-Z]$/i.test(c.textContent.trim()))
        .map(c => c.textContent.trim());
      if (letters.length >= 3) {
        const info = `<${parent.tagName}> class="${(parent.className?.toString() || '').substring(0, 100)}" letters="${letters.join('')}" (${letters.length})`;
        console.log(`[CrossclimbSolver]   ${info}`);
        report.parentSamples.push({ tag: parent.tagName, className: (parent.className?.toString() || '').substring(0, 100), letters: letters.join(''), count: letters.length, textLength: parent.textContent.trim().length });
      }
    }

    // Also show leaf-node parents
    console.log('[CrossclimbSolver] Parents with 3+ single-letter LEAF children:');
    for (const parent of leafParents) {
      const letters = [...parent.children]
        .filter(c => c.children.length === 0 && /^[A-Z]$/i.test(c.textContent.trim()))
        .map(c => c.textContent.trim());
      if (letters.length >= 3) {
        console.log(`[CrossclimbSolver]   <${parent.tagName}> class="${(parent.className?.toString() || '').substring(0, 100)}" letters="${letters.join('')}" (${letters.length})`);
      }
    }

    // Check draggable elements
    const draggables = doc.querySelectorAll('[draggable="true"]');
    console.log(`[CrossclimbSolver] Draggable elements: ${draggables.length}`);
    for (const d of [...draggables].slice(0, 10)) {
      const childLetters = [...d.children].filter(c => /^[A-Z]$/i.test(c.textContent.trim())).map(c => c.textContent.trim());
      const info = `<${d.tagName}> class="${(d.className?.toString() || '').substring(0, 80)}" text="${d.textContent.trim().substring(0, 60)}" childLetters="${childLetters.join('')}"`;
      console.log(`[CrossclimbSolver]   ${info}`);
      report.draggables.push({ tag: d.tagName, text: d.textContent.trim().substring(0, 60), childLetters: childLetters.join('') });
    }

    // List all iframes with access status
    const iframes = doc.querySelectorAll('iframe');
    console.log(`[CrossclimbSolver] Iframes: ${iframes.length}`);
    for (const iframe of iframes) {
      let accessible = false;
      let bodyChildCount = 0;
      try {
        const idoc = iframe.contentDocument || iframe.contentWindow?.document;
        accessible = !!idoc;
        bodyChildCount = idoc?.body?.children?.length || 0;
      } catch { /* cross-origin */ }
      const info = `src="${(iframe.src || '').substring(0, 100)}" accessible=${accessible} bodyChildren=${bodyChildCount}`;
      console.log(`[CrossclimbSolver]   ${info}`);
      report.iframes.push({ src: (iframe.src || '').substring(0, 100), accessible, bodyChildCount });
    }

    console.log('[CrossclimbSolver] === END DIAGNOSTICS ===');
    return report;
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
      // Generous guard: skip only very large or empty elements
      if (text.length > 5000 || text.length === 0) continue;

      const children = el.children;
      if (children.length < 2) continue;

      // Skip if we already found this element as a row
      if (rows.find(r => r.element === el)) continue;

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

      // --- Strategy 2: direct children whose textContent is a single letter ---
      // (does NOT require children to be leaf nodes — matches DOMInspector approach)
      const charChildren = [...children].filter(c =>
        /^[A-Z]$/i.test(c.textContent.trim())
      );
      if (charChildren.length >= 3 && charChildren.length <= 8) {
        rows.push(this._makeRow(el, charChildren));
        continue;
      }

      // --- Strategy 3: grandchildren whose textContent is a single letter ---
      for (const child of children) {
        if (child.children.length < 2) continue;
        const grandcharChildren = [...child.children].filter(gc =>
          /^[A-Z]$/i.test(gc.textContent.trim())
        );
        if (grandcharChildren.length >= 3 && grandcharChildren.length <= 8) {
          rows.push(this._makeRow(el, grandcharChildren));
          break;
        }
      }
      if (rows.find(r => r.element === el)) continue;

      // --- Strategy 4: leaf descendants are single letters (any depth) ---
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
      if (leafLetters.length >= 3 && leafLetters.length <= 8 && text.length < 2000) {
        rows.push(this._makeRow(el, leafLetters));
        continue;
      }

      // --- Strategy 5: aria-label or data attributes suggest a game row ---
      const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
      const role = el.getAttribute('role') || '';
      if ((ariaLabel.includes('row') || ariaLabel.includes('word') || ariaLabel.includes('clue') ||
           role === 'row' || role === 'listitem') && children.length >= 2) {
        // This element looks like a game row — check if it contains letters
        const allTextChildren = [...el.querySelectorAll('*')].filter(c =>
          c.children.length === 0 && /^[A-Z]$/i.test(c.textContent.trim())
        );
        if (allTextChildren.length >= 3 && allTextChildren.length <= 8) {
          rows.push(this._makeRow(el, allTextChildren));
        }
      }
    }

    // Also try: find draggable elements that contain letter sequences
    const draggables = root.querySelectorAll('[draggable="true"]');
    for (const el of draggables) {
      if (rows.find(r => r.element === el || r.element.contains(el) || el.contains(r.element))) continue;

      const text = el.textContent.trim();
      if (text.length > 2000 || text.length === 0) continue;

      // Check direct children textContent first (non-leaf approach)
      const charChildren = [...el.children].filter(c =>
        /^[A-Z]$/i.test(c.textContent.trim())
      );
      if (charChildren.length >= 3 && charChildren.length <= 8) {
        rows.push(this._makeRow(el, charChildren));
        continue;
      }

      // Leaf node approach
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

  // ----- WORD-ROW REORDERING (drag-to-reorder mode) -----

  async _solveByReordering(wordRows, puzzleData, log) {
    const correctOrder = puzzleData.wordLadder;
    if (!correctOrder || correctOrder.length < 7) {
      throw new Error('No valid word ladder to use for reordering');
    }

    // Get current visual order (sorted by Y position)
    const currentRows = wordRows
      .map(wr => ({
        ...wr,
        rect: wr.element.getBoundingClientRect(),
        y: wr.element.getBoundingClientRect().top
      }))
      .sort((a, b) => a.y - b.y);

    const currentOrder = currentRows.map(r => r.word);
    log(`Current order: ${currentOrder.join(' → ')}`);
    log(`Target order:  ${correctOrder.join(' → ')}`);

    // Find which words need to move
    // Only middle 5 words are movable (top and bottom are fixed)
    const fixedTop = correctOrder[0];
    const fixedBottom = correctOrder[6];

    // Check if top and bottom are already correct
    if (currentOrder[0] === fixedTop && currentOrder[currentOrder.length - 1] === fixedBottom) {
      log('Top and bottom rows are correctly placed');
    }

    // Calculate moves needed
    const moves = this._calculateMoves(currentOrder, correctOrder);
    log(`Need ${moves.length} move(s) to reorder`);

    for (let i = 0; i < moves.length; i++) {
      const move = moves[i];
      log(`Move ${i + 1}: "${move.word}" from position ${move.from} to ${move.to}`);

      // Re-read positions after each move (they may have changed)
      const freshRows = wordRows
        .map(wr => ({
          ...wr,
          rect: wr.element.getBoundingClientRect(),
          y: wr.element.getBoundingClientRect().top
        }))
        .sort((a, b) => a.y - b.y);

      const sourceRow = freshRows.find(r => r.word === move.word);
      const targetRow = freshRows[move.to];

      if (!sourceRow || !targetRow) {
        log(`Could not find source or target for move ${i + 1}`);
        continue;
      }

      // Use the draggable ancestor if available, otherwise the word element itself
      const sourceEl = sourceRow.draggableElement || sourceRow.element;
      const targetEl = targetRow.draggableElement || targetRow.element;

      // Try multiple drag strategies
      const strategies = [
        { name: 'pointer', fn: () => CrossclimbDOM.pointerDrag(sourceEl, targetEl) },
        { name: 'html5', fn: () => CrossclimbDOM.html5DragDrop(sourceEl, targetEl) },
        { name: 'touch', fn: () => CrossclimbDOM.touchDrag(sourceEl, targetEl) },
      ];

      let success = false;
      for (const strategy of strategies) {
        try {
          await strategy.fn();
          log(`  Drag via ${strategy.name} succeeded`);
          success = true;
          break;
        } catch (e) {
          log(`  Drag via ${strategy.name} failed: ${e.message}`);
        }
      }

      if (!success) {
        log(`  WARNING: All drag strategies failed for "${move.word}"`);
      }

      await CrossclimbDOM.sleep(500); // Wait for animation
    }

    log('Reordering complete');
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
