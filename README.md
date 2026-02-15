# CrossclimbSolver

A Chrome extension that automatically solves the [LinkedIn Crossclimb](https://www.linkedin.com/games/crossclimb/) puzzle by fetching today's answers and interacting with the game UI.

Built as an educational exercise in browser automation, DOM interaction, and reverse-engineering web application UIs. This project explores the technical challenges of programmatically interacting with React-based web applications, simulating drag-and-drop, and working within browser extension sandboxes.

## How It Works

1. **Fetches answers** from [crossclimbanswer.io](https://crossclimbanswer.io) via the extension's background service worker (bypassing CORS)
2. **Parses the HTML** to extract the word ladder sequence and clue-answer mappings
3. **Reads clues** from the LinkedIn puzzle DOM
4. **Matches clues to answers** using fuzzy text matching
5. **Types answers** into each row using simulated keyboard events
6. **Reorders rows** via simulated drag-and-drop to form the correct word ladder
7. **Completes the puzzle** by filling in the unlocked top/bottom rows

## Architecture

```
extension/
├── manifest.json              # Chrome Extension Manifest V3
├── background.js              # Service worker: cross-origin fetching
├── content/
│   ├── main.js                # Entry point & orchestration
│   ├── dom-helpers.js         # DOM interaction utilities (typing, dragging)
│   ├── dom-inspector.js       # DOM discovery & structure analysis
│   ├── answer-parser.js       # Parses crossclimbanswer.io HTML
│   ├── solver.js              # Core solving logic
│   ├── overlay.js             # Floating UI panel
│   └── overlay.css            # Overlay styles
├── popup/
│   ├── popup.html             # Extension toolbar popup
│   └── popup.js               # Popup logic
└── icons/
    ├── icon48.png
    └── icon128.png
```

### Key Components

- **Background Service Worker** (`background.js`): Handles cross-origin HTTP requests to crossclimbanswer.io, since content scripts are subject to CORS restrictions.

- **Answer Parser** (`answer-parser.js`): Extracts the word ladder and clue-answer pairs from the answer site's HTML using multiple parsing strategies (arrow patterns, tables, text patterns).

- **DOM Helpers** (`dom-helpers.js`): Provides multiple strategies for interacting with React-controlled inputs:
  - Native value setter + synthetic events (for standard React inputs)
  - Individual keypress simulation (for keystroke-validated inputs)
  - Virtual keyboard button clicking (for on-screen keyboards)
  - Pointer-event drag, HTML5 drag-and-drop, and touch-event drag

- **DOM Inspector** (`dom-inspector.js`): Discovers and maps the puzzle's DOM structure. Since LinkedIn's DOM may change, this tool helps identify the correct selectors.

- **Solver** (`solver.js`): Orchestrates the full solving flow: DOM discovery, clue reading, answer matching, typing, reordering, and two-phase completion.

- **Overlay** (`overlay.js`): A draggable floating panel injected into the page showing solver status, puzzle info, answer preview, and an activity log.

## Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/mcarthey/CrossclimbSolver.git
   ```

2. Open Chrome and navigate to `chrome://extensions/`

3. Enable **Developer mode** (toggle in the top-right corner)

4. Click **Load unpacked** and select the `extension/` directory

5. Navigate to [LinkedIn Crossclimb](https://www.linkedin.com/games/crossclimb/)

6. The solver overlay will appear in the top-right corner of the page

## Usage

### Automatic Mode
When you open the Crossclimb page, the extension automatically:
- Fetches today's answers
- Displays them in the overlay panel
- Waits for you to click **"Solve Puzzle"**

### Manual Controls
- **Solve Puzzle**: Starts the automated solving process
- **Inspect DOM**: Runs a diagnostic scan of the page structure (results in browser console)

### Console API
Open the browser console (F12) for advanced control:

```javascript
// Access the solver API
CrossclimbSolver.solve()           // Trigger solve
CrossclimbSolver.inspect()         // Run DOM inspection
CrossclimbSolver.getPuzzleData()   // View loaded answers
CrossclimbSolver.testType('WAND')  // Test typing a word
CrossclimbSolver.testInteractive() // List all interactive elements

// Access sub-modules directly
CrossclimbSolver.DOM               // DOM interaction helpers
CrossclimbSolver.Parser            // Answer parser
CrossclimbSolver.Inspector         // DOM inspector
CrossclimbSolver.Solver            // Core solver
```

## Technical Challenges

### 1. Cross-Origin Answer Fetching
Content scripts run in the page's origin (`linkedin.com`) and cannot fetch from `crossclimbanswer.io` due to CORS. The background service worker handles all cross-origin requests.

### 2. React Input Manipulation
LinkedIn uses React, which maintains its own state. Setting `input.value` directly doesn't update React's internal state. The extension uses the native HTMLInputElement value setter and dispatches synthetic `input`/`change` events that React's event delegation recognizes.

### 3. Drag-and-Drop Simulation
The extension implements three drag strategies:
- **Pointer events**: `pointerdown` → `pointermove` (with eased intermediate steps) → `pointerup`
- **HTML5 Drag API**: `dragstart` → `dragover` → `drop` → `dragend`
- **Touch events**: `touchstart` → `touchmove` → `touchend`

Each strategy includes timing delays and eased movement curves to match how libraries detect drag gestures.

### 4. Two-Phase Puzzle Completion
The top and bottom rows are locked until the middle 5 answers are correct AND properly ordered. The solver uses a `MutationObserver`-based polling approach to detect when these rows unlock.

### 5. DOM Discovery
LinkedIn's class names may be hashed/obfuscated. The DOM Inspector uses a combination of:
- Semantic selectors (`[role]`, `[aria-label]`)
- Pattern-based class matching (`[class*="keyboard"]`)
- Structural analysis (finding containers with single-letter child elements)
- React fiber tree traversal

## Iterating on DOM Selectors

Since LinkedIn may update their DOM structure, you may need to update the solver's selectors:

1. Click **"Inspect DOM"** in the overlay
2. Open the browser console (F12) to see the full report
3. Access the report: `window.__crossclimbInspection`
4. Update selectors in `solver.js` → `Solver.selectors`

## Limitations

- Requires manual observation of LinkedIn's DOM structure (use the Inspector)
- Drag-and-drop simulation may need tuning depending on how LinkedIn implements reordering
- The answer parser depends on crossclimbanswer.io's HTML structure remaining consistent
- Extension needs to be reloaded if LinkedIn significantly changes their game framework

## License

MIT
