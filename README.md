# Crossclimb Solver

A Chrome extension that automatically solves the [LinkedIn Crossclimb](https://www.linkedin.com/games/crossclimb/) word ladder puzzle.

Built as an educational exercise in browser automation, DOM interaction, and reverse-engineering React-based web application UIs. This project explores the technical challenges of programmatically interacting with modern single-page applications from within Chrome Extension sandboxes.

## How It Works

1. **Fetches answers** from [crossclimbanswer.io](https://crossclimbanswer.io) via the extension's background service worker (bypassing CORS restrictions)
2. **Parses the HTML** to extract the word ladder sequence and clue-answer mappings
3. **Reads clues** from the LinkedIn puzzle DOM
4. **Matches clues to answers** using fuzzy text matching
5. **Types answers** into each row using simulated keyboard events
6. **Reorders rows** via simulated drag-and-drop to form the correct word ladder
7. **Completes the puzzle** by filling in the unlocked top/bottom endpoint rows

## Attribution

Puzzle answer data is sourced from [crossclimbanswer.io](https://crossclimbanswer.io). This project is not affiliated with, endorsed by, or sponsored by crossclimbanswer.io. Their site provides publicly available Crossclimb puzzle solutions, and this extension fetches that data to automate gameplay. Full credit for answer curation goes to the crossclimbanswer.io team.

## Disclaimer

This project is an **unofficial, independent tool** created for educational and personal use. It is **not affiliated with, endorsed by, or sponsored by LinkedIn or Microsoft**.

- **LinkedIn Terms of Service**: Automating interactions with LinkedIn's games may violate their [User Agreement](https://www.linkedin.com/legal/user-agreement). Use this extension at your own risk. The authors are not responsible for any consequences to your LinkedIn account.
- **No warranty**: This software is provided "as is" without warranty of any kind. LinkedIn may change their DOM structure, class names, or game framework at any time, which could break this extension.
- **Personal use**: This tool is intended for personal, educational, and research purposes — specifically as a case study in browser extension development, DOM automation, and reverse-engineering web UIs.

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
CrossclimbSolver.solve()           // Trigger solve
CrossclimbSolver.inspect()         // Run DOM inspection
CrossclimbSolver.getPuzzleData()   // View loaded answers
CrossclimbSolver.testType('WAND')  // Test typing a word
CrossclimbSolver.testInteractive() // List all interactive elements
```

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
│   ├── page-bridge.js         # Page-context JS bridge (bypasses CSP)
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

- **Answer Parser** (`answer-parser.js`): Extracts the word ladder and clue-answer pairs from the answer site's HTML using multiple parsing strategies with automatic fallback.

- **DOM Helpers** (`dom-helpers.js`): Provides multiple strategies for interacting with React-controlled inputs — native value setter + synthetic events, individual keypress simulation, virtual keyboard clicking, and three drag-and-drop implementations.

- **Page Bridge** (`page-bridge.js`): Runs in the page's JavaScript context (not the content script's isolated world) to dispatch trusted events via `document.execCommand('insertText')`.

- **Solver** (`solver.js`): Orchestrates the full solving flow: board discovery, clue reading, answer matching, typing, reordering, and two-phase completion.

- **Overlay** (`overlay.js`): A draggable floating panel injected into the page showing solver status, puzzle info, answer preview, and an activity log.

## Technical Challenges

### Cross-Origin Answer Fetching
Content scripts run in the page's origin (`linkedin.com`) and cannot fetch from `crossclimbanswer.io` due to CORS. The background service worker handles all cross-origin requests.

### React Input Manipulation
LinkedIn uses React, which maintains its own state. Setting `input.value` directly doesn't update React's internal state. The extension uses `document.execCommand('insertText')` to generate trusted input events, with fallback to the native `HTMLInputElement` value setter + synthetic events.

### Drag-and-Drop Simulation
The extension implements pointer-event based drag with eased intermediate steps and human-like timing delays to trigger the game's drag recognition.

### Two-Phase Puzzle Completion
The top and bottom rows are locked until the middle 5 answers are correct AND properly ordered. The solver detects when these rows unlock and fills them in automatically.

### Content Security Policy
LinkedIn's CSP blocks inline scripts. The page bridge is loaded as a `web_accessible_resource` file to bypass this restriction.

## Limitations

- Depends on crossclimbanswer.io's HTML structure remaining consistent
- LinkedIn may change their DOM structure or class names at any time
- Drag-and-drop simulation may need tuning depending on LinkedIn's reordering implementation
- Extension needs to be reloaded if LinkedIn significantly changes their game framework

## Contributing

Contributions are welcome! If crossclimbanswer.io or LinkedIn changes their site structure and breaks the extension, PRs to fix parsing or DOM interaction are especially appreciated.

## License

Copyright 2025 mcarthey

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
