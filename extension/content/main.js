// CrossclimbSolver - Main Content Script
// Entry point that orchestrates the solving flow
// Loaded last in the content script chain (after dom-helpers, answer-parser, dom-inspector, solver, overlay)

(function() {
  'use strict';

  const LOG_PREFIX = '[CrossclimbSolver]';

  // State
  let puzzleData = null;
  let isInitialized = false;

  // ----- INITIALIZATION -----

  async function init() {
    if (isInitialized) return;
    isInitialized = true;

    console.log(`${LOG_PREFIX} Initializing on ${window.location.href}`);

    // Create and show the overlay
    Overlay.create();
    Overlay.show();
    Overlay.log('Extension loaded. Ready to solve.');

    // Wire up overlay callbacks
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

    await Solver.solve(puzzleData, {
      onStatus: (phase, msg) => Overlay.setStatus(phase, msg),
      onLog: (msg) => Overlay.log(msg),
      onError: (error) => {
        Overlay.log(`Error: ${error.message}`);
        console.error(`${LOG_PREFIX} Solver error:`, error);
      },
      onComplete: () => {
        Overlay.log('Puzzle solved successfully!');
      }
    });
  }

  // ----- INSPECT HANDLER -----

  async function handleInspect() {
    Overlay.log('Running DOM inspection...');
    Overlay.setStatus('inspecting', 'Inspecting DOM structure...');

    const report = DOMInspector.inspect();

    // Log summary to overlay
    Overlay.log(`Found ${report.iframes.length} iframe(s)`);
    Overlay.log(`Found ${report.gameContainer.length} game container candidate(s)`);
    Overlay.log(`Found ${report.rows.length} potential puzzle row(s)`);
    Overlay.log(`Found ${report.inputs.length} input element(s)`);
    Overlay.log(`Found ${report.keyboard.length} keyboard(s)`);
    Overlay.log(`Found ${report.draggables.length} draggable element(s)`);
    Overlay.log(`Found ${report.buttons.length} game button(s)`);

    Overlay.setStatus('idle', 'Inspection complete. Check browser console for full report.');
    Overlay.log('Full report logged to browser console (F12 → Console)');

    // Also make the report accessible from the console
    window.__crossclimbInspection = report;
    console.log(`${LOG_PREFIX} Inspection report available as window.__crossclimbInspection`);
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

  // Listen for messages from the popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_STATUS') {
      sendResponse({ puzzleData });
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
  });

  // ----- CONSOLE API -----

  // Expose utility functions for manual debugging/testing
  window.CrossclimbSolver = {
    // Re-run initialization
    init,

    // Get the loaded puzzle data
    getPuzzleData: () => puzzleData,

    // Manually trigger solve
    solve: handleSolve,

    // Run DOM inspection
    inspect: handleInspect,

    // Show/hide the overlay
    showOverlay: () => Overlay.show(),
    hideOverlay: () => Overlay.hide(),

    // Manually set puzzle data (for testing)
    setPuzzleData: (data) => {
      puzzleData = data;
      Overlay.setPuzzleInfo(data);
    },

    // Access sub-modules
    DOM: CrossclimbDOM,
    Parser: AnswerParser,
    Inspector: DOMInspector,
    Solver: Solver,
    Overlay: Overlay,

    // Quick test: type a word using different strategies
    async testType(word) {
      console.log(`${LOG_PREFIX} Test typing: "${word}"`);

      // Strategy 1: Keyboard events to document
      console.log('Strategy 1: Keyboard events to document');
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

    // Quick test: find and log all interactive elements
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

  // Wait for the page to be ready, then initialize
  if (document.readyState === 'complete') {
    // Small delay to let React render
    setTimeout(init, 1500);
  } else {
    window.addEventListener('load', () => setTimeout(init, 1500));
  }

  console.log(`${LOG_PREFIX} Content script loaded. API available at window.CrossclimbSolver`);
})();
