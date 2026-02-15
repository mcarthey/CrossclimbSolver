# CrossclimbSolver - Implementation Plan

## Overview

A browser-based tool that automatically solves the LinkedIn Crossclimb puzzle by:
1. Fetching today's answers from crossclimbanswer.io
2. Reading the clues from the LinkedIn puzzle DOM
3. Typing the correct answers into each row
4. Reordering rows via drag-and-drop to form the correct word ladder
5. Filling in the unlocked top/bottom rows after the middle 5 are correct

---

## Architecture Options

### Option A: Chrome Extension (Recommended)

**How it works:** A Chrome extension with a content script that injects into the LinkedIn Crossclimb page and a background service worker that handles cross-origin fetching.

**Pros:**
- Full cross-origin request capability via background service worker (bypasses CORS)
- Content script has direct DOM access to the LinkedIn page
- Can add a UI overlay (popup or injected panel) for status/controls
- Persistent — runs automatically when you visit the page
- Can be published or shared easily
- Professional structure suitable for a write-up

**Cons:**
- Slightly more boilerplate (manifest.json, service worker, content script)
- Needs to be loaded as an unpacked extension during development

**Structure:**
```
crossclimb-solver/
├── manifest.json          # Extension manifest (Manifest V3)
├── background.js          # Service worker - fetches answers from crossclimbanswer.io
├── content.js             # Injected into LinkedIn - reads DOM, types answers, reorders
├── popup.html             # Optional popup UI for manual trigger/status
├── popup.js               # Popup logic
├── solver.js              # Core solving logic (answer matching, ordering)
└── styles.css             # Overlay styling
```

### Option B: Tampermonkey Userscript

**How it works:** A single JavaScript file that runs via the Tampermonkey browser extension when LinkedIn Crossclimb is loaded.

**Pros:**
- Single file — simpler to develop and share
- `GM_xmlhttpRequest` bypasses CORS natively
- Easy to install (paste into Tampermonkey)
- Good for a write-up (self-contained)

**Cons:**
- Requires Tampermonkey to be installed first
- Slightly less control over lifecycle
- Harder to modularize if code grows

### Option C: Bookmarklet

**How it works:** A JavaScript snippet saved as a bookmark, clicked manually to activate.

**Pros:**
- Zero installation — just a bookmark
- Simple to share

**Cons:**
- **CORS is a blocker** — cannot fetch crossclimbanswer.io from linkedin.com domain
- Would need a CORS proxy or pre-embedded answers
- Limited code size
- No persistence

**Verdict:** Option C is impractical due to CORS. Options A and B are both viable.

---

## Technical Challenges & Solutions

### Challenge 1: Cross-Origin Answer Fetching

**Problem:** The content script runs on `linkedin.com` but needs data from `crossclimbanswer.io`. Browsers block this due to CORS.

**Solution (Chrome Extension):** The background service worker has unrestricted fetch access. The content script sends a message to the background worker, which fetches the answer page and returns parsed data.

**Solution (Userscript):** `GM_xmlhttpRequest` in Tampermonkey bypasses CORS by design.

### Challenge 2: Parsing Answer Data

**Problem:** crossclimbanswer.io returns HTML, not structured API data. We need to extract:
- The word ladder sequence (e.g., RANT → WANT → WAND → SAND → SANE → SAVE → RAVE)
- The clue-to-answer mapping

**Solution:** Parse the HTML response with DOMParser, extract the word ladder and clue/answer pairs using CSS selectors or text pattern matching. The site has a consistent structure per puzzle page at `/linkedin-crossclimb-answer/crossclimb-{number}/`.

**Determining puzzle number:** We can either:
- Scrape the homepage for the latest puzzle number
- Calculate from a known date/number baseline (puzzles increment daily)
- Read date from the LinkedIn page and match

### Challenge 3: Reading the LinkedIn Puzzle DOM

**Problem:** LinkedIn uses React with dynamically rendered components. The DOM structure may include:
- Shadow DOM or iframes
- Dynamically generated class names (CSS modules/hashed classes)
- React fiber internals

**Solution:**
- Inspect the live DOM to identify stable selectors (data attributes, aria labels, semantic structure)
- The puzzle likely lives in an iframe or a specific container — we need to traverse into it
- Use `MutationObserver` to wait for the puzzle to fully render before interacting
- Look for `aria-label`, `role`, `data-testid`, or structural patterns rather than class names

### Challenge 4: Typing Answers into Input Fields

**Problem:** React intercepts native DOM events. Simply setting `input.value = "WAND"` won't trigger React's state update.

**Solution:** Dispatch synthetic events that React's event system recognizes:
```javascript
function typeIntoReactInput(element, text) {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
    ).set;
    nativeInputValueSetter.call(element, text);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
}
```

Alternatively, simulate individual keypress events for each character if the puzzle validates keystroke-by-keystroke.

### Challenge 5: Drag-and-Drop Reordering (Hardest)

**Problem:** The puzzle requires dragging answer bars to reorder them. This involves simulating a full drag gesture sequence.

**Solution approach depends on the drag implementation used by LinkedIn:**

**If HTML5 Drag and Drop API:**
```javascript
function simulateDragDrop(sourceEl, targetEl) {
    const dataTransfer = new DataTransfer();
    sourceEl.dispatchEvent(new DragEvent('dragstart', { dataTransfer, bubbles: true }));
    targetEl.dispatchEvent(new DragEvent('dragover', { dataTransfer, bubbles: true }));
    targetEl.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true }));
    sourceEl.dispatchEvent(new DragEvent('dragend', { dataTransfer, bubbles: true }));
}
```

**If pointer/mouse-based drag (more likely for mobile compatibility):**
```javascript
async function simulateMouseDrag(sourceEl, targetEl) {
    const sourceRect = sourceEl.getBoundingClientRect();
    const targetRect = targetEl.getBoundingClientRect();

    const startX = sourceRect.left + sourceRect.width / 2;
    const startY = sourceRect.top + sourceRect.height / 2;
    const endX = targetRect.left + targetRect.width / 2;
    const endY = targetRect.top + targetRect.height / 2;

    sourceEl.dispatchEvent(new PointerEvent('pointerdown', { clientX: startX, clientY: startY, bubbles: true }));

    // Animate intermediate moves for realism
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
        const progress = i / steps;
        const currentX = startX + (endX - startX) * progress;
        const currentY = startY + (endY - startY) * progress;
        document.dispatchEvent(new PointerEvent('pointermove', { clientX: currentX, clientY: currentY, bubbles: true }));
        await sleep(30);
    }

    document.dispatchEvent(new PointerEvent('pointerup', { clientX: endX, clientY: endY, bubbles: true }));
}
```

**Key insight:** We'll need to inspect the actual LinkedIn puzzle to determine which drag mechanism they use. The implementation will need to match exactly — this will require some trial-and-error during development.

**Alternative approach:** If drag simulation proves too brittle, we could:
- Directly manipulate the React component state via React DevTools fiber tree
- Find and call the reorder handler function directly from the React internals
- Use `__reactFiber$` or `__reactInternalInstance$` properties on DOM nodes to access component methods

### Challenge 6: Two-Phase Solving

**Problem:** The top and bottom slots (RANT/RAVE) are locked until the middle 5 answers are correctly filled AND ordered.

**Solution:** Implement a two-phase approach:
1. **Phase 1:** Fill in the 5 middle answers and reorder them correctly. Wait for the UI to indicate the top/bottom have unlocked (watch for DOM changes via MutationObserver).
2. **Phase 2:** Fill in the top (RANT) and bottom (RAVE) words.

### Challenge 7: Clue-to-Answer Matching

**Problem:** The clues on LinkedIn need to be matched to the answers from crossclimbanswer.io. The clues on LinkedIn may be in a scrambled order.

**Solution:**
- Read clue text from each row in the LinkedIn DOM
- Match against the clue/answer pairs from crossclimbanswer.io using fuzzy string matching or exact match
- Once matched, we know which answer goes in which row AND the correct ordering

---

## Recommended Implementation: Chrome Extension (Manifest V3)

### Component Breakdown

1. **manifest.json** — Declares permissions, content script injection, service worker
2. **background.js (Service Worker)**
   - Listens for messages from content script
   - Fetches and parses crossclimbanswer.io puzzle page
   - Returns structured answer data
3. **content.js (Content Script)**
   - Waits for puzzle DOM to be ready
   - Reads clue text from each row
   - Sends message to background for answers
   - Matches clues to answers
   - Types answers into input fields
   - Reorders rows via drag simulation
   - Handles Phase 2 (top/bottom unlock)
4. **parser.js (Answer Parser)**
   - Parses HTML from crossclimbanswer.io
   - Extracts word ladder, clues, and answers
   - Returns structured data
5. **ui.js (Overlay UI)**
   - Injects a small floating panel on the LinkedIn page
   - Shows solver status, manual trigger button, and progress
6. **popup.html/js (Extension Popup)**
   - Quick status view and manual trigger from toolbar icon

### Execution Flow

```
User opens LinkedIn Crossclimb
    → content.js detects puzzle page
    → Sends message to background.js requesting answers
    → background.js fetches crossclimbanswer.io, parses HTML
    → Returns { wordLadder: [...], clueAnswerMap: {...} }
    → content.js reads clues from DOM
    → Matches clues to answers
    → Types answers into each row
    → Calculates correct row order from word ladder
    → Performs drag-and-drop reordering
    → Waits for top/bottom unlock
    → Types top/bottom answers
    → Puzzle solved!
```

---

## Development Phases

### Phase 1: Foundation
- Set up Chrome extension structure (manifest, scripts)
- Implement answer fetching and parsing from crossclimbanswer.io
- Write unit tests for the parser

### Phase 2: DOM Exploration
- Inspect LinkedIn Crossclimb DOM structure (manually and programmatically)
- Identify stable selectors for clue text, input fields, and row containers
- Document the drag mechanism used
- Build DOM interaction helpers

### Phase 3: Answer Entry
- Implement clue reading from LinkedIn DOM
- Implement clue-to-answer matching
- Implement answer typing (handling React's event system)

### Phase 4: Reordering
- Implement drag-and-drop simulation
- Test and refine the drag mechanism
- Handle edge cases (animation delays, re-renders)

### Phase 5: Two-Phase Completion
- Detect top/bottom unlock
- Fill in remaining answers
- Add completion detection

### Phase 6: Polish
- Add overlay UI with status indicators
- Add error handling and retry logic
- Add manual trigger option
- Write documentation for the LinkedIn post

---

## Key Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| LinkedIn DOM changes frequently | Selectors break | Use semantic/aria selectors; add resilience layer |
| Drag simulation doesn't work | Can't reorder | Try multiple approaches; fall back to React internals |
| Puzzle is in an iframe | Cross-origin blocked | Extension can inject into all frames via manifest |
| React eats synthetic events | Can't type answers | Use native value setter + multiple event types |
| crossclimbanswer.io changes format | Parser breaks | Modular parser with fallback strategies |
| LinkedIn detects automation | Account risk | Add human-like delays between actions |
