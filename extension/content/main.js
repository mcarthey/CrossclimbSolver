// CrossclimbSolver - Main Content Script
// Entry point that orchestrates the solving flow
// Loaded last in the content script chain (after dom-helpers, answer-parser, dom-inspector, solver, overlay)

(function() {
  'use strict';

  const LOG_PREFIX = '[CrossclimbSolver]';
  const VERSION = '1.5.5';

  // State
  let puzzleData = null;
  let isInitialized = false;
  let isTopFrame = false;
  let gameRowsFoundInThisFrame = false;

  // ----- INITIALIZATION -----

  async function init() {
    if (isInitialized) return;
    isInitialized = true;

    isTopFrame = (window === window.top);
    console.log(`${LOG_PREFIX} v${VERSION} Initializing on ${window.location.href} (${isTopFrame ? 'top frame' : 'iframe'})`);

    if (isTopFrame) {
      // --- TOP FRAME: overlay, answer fetching, orchestration ---
      Overlay.create();
      Overlay.show();
      Overlay.log(`Extension v${VERSION} loaded. Ready to solve.`);

      Overlay.onSolve(handleSolve);
      Overlay.onInspect(handleInspect);

      // Automatically fetch today's answers
      try {
        Overlay.setStatus('fetching', 'Fetching answers...');
        Overlay.log('Fetching latest puzzle from crossclimbanswer.io...');

        puzzleData = await fetchAndParseAnswers();

        if (puzzleData) {
          Overlay.setPuzzleInfo(puzzleData);
          Overlay.setStatus('idle', 'Answers loaded. Click "Solve Puzzle" to start.');
          Overlay.log(`Loaded puzzle #${puzzleData.puzzleNumber}: ${puzzleData.wordLadder.join(' → ')}`);
        } else {
          Overlay.setStatus('error', 'Could not parse answers');
          Overlay.log('Error: Failed to parse answer data');
        }
      } catch (error) {
        console.error(`${LOG_PREFIX} Init error:`, error);
        Overlay.setStatus('error', 'Failed to fetch answers');
        Overlay.log(`Error: ${error.message}`);
      }
    } else {
      // --- IFRAME: check for game content, register as game frame ---
      console.log(`${LOG_PREFIX} Iframe instance - scanning for puzzle rows...`);

      // Give React a moment to render in the iframe
      await new Promise(r => setTimeout(r, 2000));

      const localRows = Solver._findRows(document, document.body);
      console.log(`${LOG_PREFIX} Iframe found ${localRows.length} puzzle rows`);

      if (localRows.length >= 3) {
        gameRowsFoundInThisFrame = true;
        console.log(`${LOG_PREFIX} Game found in this iframe! Registering as game frame.`);

        // Notify the top frame that we have the game
        try {
          chrome.runtime.sendMessage({
            type: 'GAME_FRAME_READY',
            rowCount: localRows.length,
            url: window.location.href
          });
        } catch (e) {
          console.log(`${LOG_PREFIX} Could not send GAME_FRAME_READY:`, e.message);
        }
      }
    }
  }

  // ----- ANSWER FETCHING -----

  async function fetchAndParseAnswers() {
    // Step 1: Get the latest puzzle number
    const latestResponse = await sendMessage({ type: 'FETCH_LATEST' });
    if (!latestResponse.success) {
      throw new Error(`Failed to fetch homepage: ${latestResponse.error}`);
    }

    const puzzleNumber = latestResponse.data.puzzleNumber;
    console.log(`${LOG_PREFIX} Latest puzzle number: ${puzzleNumber}`);
    Overlay.log(`Latest puzzle: #${puzzleNumber}`);

    // Step 2: Fetch the answer page
    const answerResponse = await sendMessage({
      type: 'FETCH_ANSWERS',
      puzzleNumber: puzzleNumber
    });

    if (!answerResponse.success) {
      throw new Error(`Failed to fetch puzzle ${puzzleNumber}: ${answerResponse.error}`);
    }

    // Step 3: Parse the HTML
    const parsed = AnswerParser.parse(answerResponse.data.html);
    parsed.puzzleNumber = parsed.puzzleNumber || puzzleNumber;

    console.log(`${LOG_PREFIX} Parsed puzzle data:`, parsed);
    return parsed;
  }

  // ----- SOLVE HANDLER -----

  async function handleSolve() {
    if (!puzzleData) {
      Overlay.log('No puzzle data loaded. Trying to fetch...');
      try {
        puzzleData = await fetchAndParseAnswers();
        Overlay.setPuzzleInfo(puzzleData);
      } catch (error) {
        Overlay.setStatus('error', 'Cannot solve: no answers available');
        Overlay.log(`Error: ${error.message}`);
        return;
      }
    }

    Overlay.log('Starting solver...');

    const solverCallbacks = {
      onStatus: (phase, msg) => Overlay.setStatus(phase, msg),
      onLog: (msg) => Overlay.log(msg),
      onError: (error) => {
        Overlay.log(`Error: ${error.message}`);
        console.error(`${LOG_PREFIX} Solver error:`, error);
      },
      onComplete: () => {
        Overlay.log('Puzzle solved successfully!');
      }
    };

    // v1.5: Solver.solve() now uses crossclimb__* selectors directly,
    // with legacy fallback built in
    await Solver.solve(puzzleData, solverCallbacks);
  }

  // ----- INSPECT HANDLER -----

  async function handleInspect() {
    Overlay.log('Running DOM inspection...');
    Overlay.setStatus('inspecting', 'Inspecting DOM structure...');

    // Inspect the main page
    Overlay.log('--- Main page ---');
    const report = DOMInspector.inspect();

    Overlay.log(`Found ${report.iframes.length} iframe(s)`);
    Overlay.log(`Found ${report.gameContainer.length} game container candidate(s)`);
    Overlay.log(`Found ${report.rows.length} potential puzzle row(s)`);
    Overlay.log(`Found ${report.inputs.length} input element(s)`);
    Overlay.log(`Found ${report.keyboard.length} keyboard(s)`);
    Overlay.log(`Found ${report.draggables.length} draggable element(s)`);
    Overlay.log(`Found ${report.buttons.length} game button(s)`);

    // Show details of found rows
    for (const row of report.rows) {
      Overlay.log(`  Row: letters="${row.letters || ''}" class="${(row.className || '').substring(0, 60)}" ${row.matchedSelector || ''}`);
    }

    // Also inspect accessible iframes
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!iframeDoc || !iframeDoc.body) continue;

        const src = iframe.src?.substring(0, 60) || '(no src)';
        Overlay.log(`--- iframe: ${src} ---`);

        const iframeRows = Solver._findRows(iframeDoc, iframeDoc.body);
        Overlay.log(`  Puzzle rows: ${iframeRows.length}`);
        for (const row of iframeRows) {
          Overlay.log(`    Row: "${row.currentLetters}" locked=${row.isLocked} draggable=${row.draggable}`);
        }

        const iframeKeyboard = Solver._findKeyboard(iframeDoc);
        Overlay.log(`  Keyboard: ${iframeKeyboard ? 'found' : 'not found'}`);

      } catch (e) {
        const src = iframe.src?.substring(0, 60) || '(no src)';
        Overlay.log(`--- iframe: ${src} (cross-origin) ---`);
      }
    }

    // Ask iframe instances for their row counts
    Overlay.log('--- Asking iframe instances ---');
    try {
      const iframeReports = await sendMessageToAllFrames({ type: 'DISCOVER_ROWS' });
      if (iframeReports) {
        Overlay.log(`Iframe response: ${JSON.stringify(iframeReports).substring(0, 200)}`);
      } else {
        Overlay.log('No iframe responses received');
      }
    } catch (e) {
      Overlay.log(`Iframe query failed: ${e.message}`);
    }

    // v1.5: Check new crossclimb board detection
    Overlay.log('--- Board detection (v1.5) ---');
    const board = Solver._findGameBoard();
    if (board) {
      Overlay.log(`Game board FOUND: ${board.middleRows.length} middle rows, ${board.lockedRows.length} locked rows`);
      for (let i = 0; i < board.middleRows.length; i++) {
        const row = board.middleRows[i];
        const boxes = row.querySelectorAll('.crossclimb__guess_box');
        const cls = (row.className || '').substring(0, 80);
        Overlay.log(`  Middle row ${i + 1}: ${boxes.length} boxes, class="${cls}"`);
      }
      for (let i = 0; i < board.lockedRows.length; i++) {
        const row = board.lockedRows[i];
        const text = row.textContent.trim().substring(0, 60);
        Overlay.log(`  Locked row ${i + 1}: text="${text}"`);
      }
      const clue = Solver._readActiveClue(board.gridContainer);
      Overlay.log(`  Active clue: "${clue || '(none)'}"`);
    } else {
      Overlay.log('Game board NOT found via crossclimb__* selectors');
    }

    // Legacy solver diagnostics
    Overlay.log('--- Legacy solver diagnostics ---');
    const domInfo = await Solver._legacyDiscoverDOM(puzzleData);
    Overlay.log(`Legacy found ${domInfo.rows.length} puzzle rows (isInIframe=${domInfo.isInIframe})`);

    // Show diagnostics if no rows found
    if (domInfo.diagnostics) {
      Overlay.log(`  Single-letter elements: ${domInfo.diagnostics.singleLetterCount}`);
      for (const f of (domInfo.diagnostics.iframes || [])) {
        Overlay.log(`  iframe: ${f.src} accessible=${f.accessible}`);
      }
    }

    // Deep scan: Shadow DOM, canvas, answer words, custom elements
    Overlay.log('--- Deep scan ---');
    const answerWords = puzzleData?.wordLadder || [];
    const deepReport = DOMInspector.deepScan(answerWords);

    Overlay.log(`Total elements: ${deepReport.totalElements} (regular) + ${deepReport.shadowDOMElements} (shadow DOM)`);
    Overlay.log(`Shadow roots: ${deepReport.shadowRoots.length}`);
    for (const sr of deepReport.shadowRoots) {
      Overlay.log(`  <${sr.tag}> id="${sr.id}" shadow elements=${sr.shadowElementCount} text="${sr.shadowTextPreview.substring(0, 80)}"`);
    }

    Overlay.log(`Canvas elements: ${deepReport.canvasElements.length}`);
    for (const c of deepReport.canvasElements) {
      Overlay.log(`  <canvas> ${c.dimensions} css=${c.cssSize}`);
    }

    Overlay.log(`Custom elements: ${deepReport.customElements.length}`);
    for (const ce of deepReport.customElements.slice(0, 10)) {
      Overlay.log(`  <${ce.tag}> children=${ce.childCount} shadow=${ce.hasShadowRoot} text="${ce.textPreview.substring(0, 50)}"`);
    }

    if (answerWords.length > 0) {
      Overlay.log(`Answer word matches: ${deepReport.answerWordMatches.length}`);
      for (const m of deepReport.answerWordMatches.slice(0, 15)) {
        Overlay.log(`  "${m.word}" in <${m.tag}> exact=${m.exactMatch} draggable=${m.draggable} text="${m.fullText.substring(0, 50)}" path=${m.path.substring(0, 60)}`);
      }
    }

    Overlay.log(`Draggable details (${deepReport.draggableDetails.length}):`);
    for (const d of deepReport.draggableDetails.slice(0, 10)) {
      Overlay.log(`  <${d.tag}> "${d.text.substring(0, 60)}" children=${d.childCount} aria="${d.ariaLabel || ''}" ${JSON.stringify(d.dataset).substring(0, 60)}`);
    }

    Overlay.log(`Button details (${deepReport.buttonDetails.length}):`);
    for (const b of deepReport.buttonDetails.slice(0, 15)) {
      Overlay.log(`  "${b.text.substring(0, 40)}" disabled=${b.disabled} aria="${b.ariaLabel || ''}"`);
    }

    if (deepReport.gameElements) {
      Overlay.log(`Game elements (outside overlay): ${deepReport.gameElements.length}`);
      for (const ge of deepReport.gameElements.slice(0, 20)) {
        if (ge.type === 'word-candidate') {
          Overlay.log(`  WORD: "${ge.text}" in <${ge.tag}> parent=<${ge.parentTag}> class="${ge.parentClass?.substring(0, 50) || ''}"`);
        } else {
          Overlay.log(`  <${ge.tag}> "${ge.text.substring(0, 60)}" class="${(ge.className || '').substring(0, 50)}" role=${ge.role || ''} drag=${ge.draggable}`);
        }
      }
    }

    if (deepReport.crossclimbElements) {
      Overlay.log(`--- Crossclimb game elements: ${deepReport.crossclimbElements.length} ---`);
      for (const el of deepReport.crossclimbElements.slice(0, 25)) {
        Overlay.log(`  <${el.tag}> class="${(el.className || '').substring(0, 80)}" children=${el.childCount} text="${el.text.substring(0, 50)}" ${el.rect.width}x${el.rect.height}`);
      }
    }

    if (deepReport.gameTree?.length > 0) {
      Overlay.log(`--- Game DOM tree (${deepReport.gameTree.length} nodes) ---`);
      for (const node of deepReport.gameTree.slice(0, 40)) {
        const indent = '  '.repeat(node.depth);
        const cls = (node.className || '').split(' ').filter(c => c.match(/game|crossclimb|board|row|cell|clue|rung|ladder/i)).join(' ') || (node.className || '').substring(0, 40);
        Overlay.log(`${indent}<${node.tag}> ${cls} ch=${node.childCount} ${node.rect.width}x${node.rect.height} vis=${node.visible} txt=${node.textLen}`);
      }
    }

    Overlay.setStatus('idle', 'Inspection complete. Check browser console for full report.');
    Overlay.log('Full report logged to browser console (F12 → Console)');

    exposeToPageConsole('__crossclimbInspection', { ...report, deep: deepReport });
    console.log(`${LOG_PREFIX} Inspection report available as window.__crossclimbInspection`);
  }

  // Expose a value to the page's console (bypasses content script isolated world)
  function exposeToPageConsole(name, value) {
    try {
      const script = document.createElement('script');
      script.textContent = `window.${name} = ${JSON.stringify(value)};`;
      document.documentElement.appendChild(script);
      script.remove();
    } catch (e) {
      console.warn(`${LOG_PREFIX} Could not expose ${name} to page console:`, e);
    }
  }

  // ----- MESSAGING -----

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  // Send a message to all frames via background and get the first positive response
  function sendMessageToAllFrames(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'BROADCAST_TO_FRAMES', payload: message }, (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
          } else {
            resolve(response);
          }
        });
      } catch {
        resolve(null);
      }
    });
  }

  // Listen for messages from the popup AND from other frames
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // --- Messages from popup ---
    if (message.type === 'GET_STATUS') {
      sendResponse({ puzzleData, version: VERSION });
      return;
    }
    if (message.type === 'SOLVE') {
      handleSolve();
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'INSPECT') {
      handleInspect();
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'TOGGLE_OVERLAY') {
      const panel = document.getElementById('crossclimb-solver-overlay');
      if (panel?.classList.contains('ccs-visible')) {
        Overlay.hide();
      } else {
        Overlay.show();
      }
      sendResponse({ ok: true });
      return;
    }

    // --- Messages for iframe game frames ---
    if (message.type === 'DISCOVER_ROWS') {
      // Only respond from iframe instances
      if (!isTopFrame) {
        const rows = Solver._findRows(document, document.body);
        sendResponse({
          frameUrl: window.location.href,
          rowCount: rows.length,
          rows: rows.map(r => ({ letters: r.currentLetters, locked: r.isLocked, draggable: r.draggable }))
        });
      }
      return;
    }

    if (message.type === 'SOLVE_IN_FRAME') {
      // Only handle in iframe instances that have game rows
      if (!isTopFrame && gameRowsFoundInThisFrame) {
        console.log(`${LOG_PREFIX} Solving in iframe...`);
        const pd = message.puzzleData;
        Solver.solve(pd, {
          onStatus: (phase, msg) => console.log(`${LOG_PREFIX} [${phase}] ${msg}`),
          onLog: (msg) => console.log(`${LOG_PREFIX} ${msg}`),
          onError: (error) => console.error(`${LOG_PREFIX} Error:`, error),
          onComplete: () => console.log(`${LOG_PREFIX} Solve complete in iframe`)
        }).then(() => {
          sendResponse({ success: true });
        }).catch(e => {
          sendResponse({ success: false, error: e.message });
        });
        return true; // Keep channel open for async response
      }
      return;
    }
  });

  // ----- CONSOLE API -----

  window.CrossclimbSolver = {
    version: VERSION,
    init,
    getPuzzleData: () => puzzleData,
    solve: handleSolve,
    inspect: handleInspect,
    showOverlay: () => Overlay.show(),
    hideOverlay: () => Overlay.hide(),
    setPuzzleData: (data) => {
      puzzleData = data;
      if (isTopFrame) Overlay.setPuzzleInfo(data);
    },
    DOM: CrossclimbDOM,
    Parser: AnswerParser,
    Inspector: DOMInspector,
    Solver: Solver,
    Overlay: Overlay,

    async testType(word) {
      console.log(`${LOG_PREFIX} Test typing: "${word}"`);
      for (const char of word) {
        const key = char.toUpperCase();
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key, code: `Key${key}`, keyCode: key.charCodeAt(0),
          bubbles: true, cancelable: true
        }));
        document.dispatchEvent(new KeyboardEvent('keyup', {
          key, code: `Key${key}`, keyCode: key.charCodeAt(0),
          bubbles: true, cancelable: true
        }));
        await CrossclimbDOM.sleep(100);
      }
    },

    testInteractive() {
      const elements = document.querySelectorAll(
        'button, [role="button"], input, [tabindex], [contenteditable], [draggable]'
      );
      console.table([...elements].map(el => ({
        tag: el.tagName,
        text: el.textContent.trim().substring(0, 50),
        class: el.className.toString().substring(0, 80),
        role: el.getAttribute('role'),
        tabIndex: el.tabIndex,
        draggable: el.draggable,
        rect: `${Math.round(el.getBoundingClientRect().top)},${Math.round(el.getBoundingClientRect().left)}`
      })));
    }
  };

  // ----- START -----

  if (document.readyState === 'complete') {
    setTimeout(init, 1500);
  } else {
    window.addEventListener('load', () => setTimeout(init, 1500));
  }

  console.log(`${LOG_PREFIX} v${VERSION} Content script loaded (${window === window.top ? 'top' : 'iframe'}). API: window.CrossclimbSolver`);
})();
