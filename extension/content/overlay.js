// Copyright 2025 mcarthey
// SPDX-License-Identifier: Apache-2.0
//
// CrossclimbSolver - Floating Overlay UI
// Provides a visual control panel injected into the LinkedIn page

const Overlay = {
  _panel: null,
  _logContainer: null,
  _statusText: null,
  _solveBtn: null,
  _inspectBtn: null,
  _minimized: false,

  // Create and inject the overlay panel
  create() {
    if (this._panel) return;

    this._panel = document.createElement('div');
    this._panel.id = 'crossclimb-solver-overlay';
    this._panel.innerHTML = `
      <div class="ccs-header">
        <div class="ccs-title">
          <span class="ccs-icon">&#9881;</span>
          Crossclimb Solver
        </div>
        <div class="ccs-controls">
          <button class="ccs-btn ccs-btn-minimize" title="Minimize">&#8722;</button>
          <button class="ccs-btn ccs-btn-close" title="Close">&times;</button>
        </div>
      </div>
      <div class="ccs-body">
        <div class="ccs-status">
          <div class="ccs-status-indicator ccs-status-idle"></div>
          <span class="ccs-status-text">Ready</span>
        </div>
        <div class="ccs-puzzle-info">
          <span class="ccs-puzzle-number">-</span>
          <span class="ccs-puzzle-words">-</span>
        </div>
        <div class="ccs-actions">
          <button class="ccs-btn ccs-btn-primary ccs-solve-btn">Solve Puzzle</button>
          <button class="ccs-btn ccs-btn-secondary ccs-inspect-btn">Inspect DOM</button>
        </div>
        <div class="ccs-log-container">
          <div class="ccs-log-header">Activity Log</div>
          <div class="ccs-log"></div>
        </div>
        <div class="ccs-answer-preview">
          <div class="ccs-answer-header">Answers</div>
          <div class="ccs-answer-list"></div>
        </div>
      </div>
    `;

    document.body.appendChild(this._panel);

    // Cache references
    this._logContainer = this._panel.querySelector('.ccs-log');
    this._statusText = this._panel.querySelector('.ccs-status-text');
    this._statusIndicator = this._panel.querySelector('.ccs-status-indicator');
    this._solveBtn = this._panel.querySelector('.ccs-solve-btn');
    this._inspectBtn = this._panel.querySelector('.ccs-inspect-btn');
    this._puzzleNumber = this._panel.querySelector('.ccs-puzzle-number');
    this._puzzleWords = this._panel.querySelector('.ccs-puzzle-words');
    this._answerList = this._panel.querySelector('.ccs-answer-list');

    // Event listeners
    this._panel.querySelector('.ccs-btn-minimize').addEventListener('click', () => this.toggleMinimize());
    this._panel.querySelector('.ccs-btn-close').addEventListener('click', () => this.hide());
    this._solveBtn.addEventListener('click', () => this._onSolveClick());
    this._inspectBtn.addEventListener('click', () => this._onInspectClick());

    // Make draggable
    this._makeDraggable();
  },

  // Show/hide
  show() {
    this.create();
    this._panel.classList.add('ccs-visible');
  },

  hide() {
    if (this._panel) {
      this._panel.classList.remove('ccs-visible');
    }
  },

  toggleMinimize() {
    if (!this._panel) return;
    this._minimized = !this._minimized;
    this._panel.classList.toggle('ccs-minimized', this._minimized);
    this._panel.querySelector('.ccs-btn-minimize').innerHTML = this._minimized ? '&#43;' : '&#8722;';
  },

  // Status updates
  setStatus(phase, message) {
    if (!this._statusText) return;

    this._statusText.textContent = message;

    // Update indicator color
    const indicator = this._statusIndicator;
    indicator.className = 'ccs-status-indicator';

    const phaseColors = {
      idle: 'ccs-status-idle',
      inspecting: 'ccs-status-working',
      fetching: 'ccs-status-working',
      reading: 'ccs-status-working',
      matching: 'ccs-status-working',
      solving: 'ccs-status-working',
      reordering: 'ccs-status-working',
      finalizing: 'ccs-status-working',
      done: 'ccs-status-done',
      error: 'ccs-status-error'
    };

    indicator.classList.add(phaseColors[phase] || 'ccs-status-idle');

    // Disable/enable solve button
    if (this._solveBtn) {
      const isWorking = !['idle', 'done', 'error'].includes(phase);
      this._solveBtn.disabled = isWorking;
      this._solveBtn.textContent = isWorking ? 'Solving...' : (phase === 'done' ? 'Solved!' : 'Solve Puzzle');
    }
  },

  // Add a log entry
  log(message) {
    if (!this._logContainer) return;

    const entry = document.createElement('div');
    entry.className = 'ccs-log-entry';
    const time = new Date().toLocaleTimeString();
    entry.textContent = `[${time}] ${message}`;

    this._logContainer.appendChild(entry);
    this._logContainer.scrollTop = this._logContainer.scrollHeight;
  },

  // Display puzzle info
  setPuzzleInfo(puzzleData) {
    if (!puzzleData) return;

    if (this._puzzleNumber) {
      this._puzzleNumber.textContent = puzzleData.puzzleNumber
        ? `Puzzle #${puzzleData.puzzleNumber}`
        : 'Puzzle';
    }

    if (this._puzzleWords && puzzleData.wordLadder.length >= 2) {
      this._puzzleWords.textContent =
        `${puzzleData.wordLadder[0]} → ${puzzleData.wordLadder[puzzleData.wordLadder.length - 1]}`;
    }

    // Show answers
    if (this._answerList && puzzleData.wordLadder.length > 0) {
      this._answerList.innerHTML = '';
      puzzleData.wordLadder.forEach((word, i) => {
        const el = document.createElement('div');
        el.className = 'ccs-answer-item';
        if (i === 0 || i === puzzleData.wordLadder.length - 1) {
          el.classList.add('ccs-answer-locked');
        }
        el.innerHTML = `
          <span class="ccs-answer-pos">${i + 1}</span>
          <span class="ccs-answer-word">${word}</span>
          ${puzzleData.clueAnswerPairs.find(p => p.answer === word)
            ? `<span class="ccs-answer-clue">${puzzleData.clueAnswerPairs.find(p => p.answer === word).clue}</span>`
            : `<span class="ccs-answer-clue">${i === 0 ? '(start)' : '(end)'}</span>`
          }
        `;
        this._answerList.appendChild(el);
      });
    }
  },

  // Callbacks (set by main.js)
  _solveCallback: null,
  _inspectCallback: null,

  onSolve(callback) {
    this._solveCallback = callback;
  },

  onInspect(callback) {
    this._inspectCallback = callback;
  },

  _onSolveClick() {
    if (this._solveCallback) {
      this._solveCallback();
    }
  },

  _onInspectClick() {
    if (this._inspectCallback) {
      this._inspectCallback();
    }
  },

  // Make the panel draggable by its header
  _makeDraggable() {
    const header = this._panel.querySelector('.ccs-header');
    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('.ccs-btn')) return; // Don't drag when clicking buttons
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = this._panel.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      header.style.cursor = 'grabbing';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      this._panel.style.left = `${initialLeft + dx}px`;
      this._panel.style.top = `${initialTop + dy}px`;
      this._panel.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
      header.style.cursor = 'grab';
    });
  }
};
