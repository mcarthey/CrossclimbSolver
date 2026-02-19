# Claude Instructions

## Project Context
Chrome extension that solves the LinkedIn Crossclimb puzzle.
All source code lives in `extension/`. Do not scan outside this directory.

## Read On Demand Only
Do not eagerly read all files at session start. Read files only when 
relevant to the specific task asked.

## Key Files
- `main.js` — entry point, start here for orientation
- `solver.js` — core orchestration (verbose, contains diagnostic output)
- `dom-inspector.js` — DOM discovery only; generates large runtime output
  listing LinkedIn's internal React module paths — these are NOT part of
  this codebase and should not be analyzed or traced

## Do Not
- Run or simulate any CrossclimbSolver console API methods
- Treat runtime console/diagnostic output as source code
- Attempt to follow or map LinkedIn's internal module paths
  (voyager-web/, feed-shared/, games-web/, etc.)
