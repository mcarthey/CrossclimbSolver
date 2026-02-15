// CrossclimbSolver - DOM Inspector
// Discovers and maps the LinkedIn Crossclimb puzzle DOM structure
// Run this first to understand the page structure before solving

const DOMInspector = {
  // Run a comprehensive inspection and return a report
  inspect() {
    const report = {
      timestamp: new Date().toISOString(),
      url: window.location.href,
      iframes: this._findIframes(),
      gameContainer: this._findGameContainer(),
      rows: this._findPuzzleRows(),
      inputs: this._findInputElements(),
      keyboard: this._findKeyboard(),
      draggables: this._findDraggables(),
      buttons: this._findGameButtons(),
      lockIndicators: this._findLockIndicators(),
      ariaStructure: this._mapAriaStructure(),
      reactRoots: this._findReactRoots()
    };

    console.log('[CrossclimbSolver] DOM Inspection Report:', report);
    return report;
  },

  _findIframes() {
    return [...document.querySelectorAll('iframe')].map(iframe => ({
      src: iframe.src,
      id: iframe.id,
      name: iframe.name,
      className: iframe.className,
      sandbox: iframe.sandbox?.value,
      dimensions: `${iframe.offsetWidth}x${iframe.offsetHeight}`,
      accessible: this._canAccessIframe(iframe)
    }));
  },

  _canAccessIframe(iframe) {
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      return !!doc;
    } catch {
      return false;
    }
  },

  _findGameContainer() {
    const selectors = [
      '[class*="crossclimb"]', '[class*="Crossclimb"]',
      '[class*="game-board"]', '[class*="gameBoard"]', '[class*="GameBoard"]',
      '[class*="puzzle"]', '[class*="Puzzle"]',
      '[class*="game-container"]', '[class*="gameContainer"]',
      '[class*="ladder"]', '[class*="Ladder"]',
      '[class*="board"]', '[class*="Board"]',
      '[data-testid*="game"]', '[data-testid*="puzzle"]', '[data-testid*="board"]',
      '[id*="game"]', '[id*="puzzle"]',
      'main', '[role="main"]', '[role="application"]'
    ];

    const found = [];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el => {
        found.push({
          selector: sel,
          tag: el.tagName,
          id: el.id,
          className: this._truncate(el.className, 150),
          childCount: el.children.length,
          textPreview: this._truncate(el.textContent, 100),
          rect: this._getRect(el),
          dataset: { ...el.dataset }
        });
      });
    }
    return found;
  },

  _findPuzzleRows() {
    // Look for row-like structures that could be puzzle rows
    // A Crossclimb board has 7 rows, each containing letter cells
    const candidates = [];

    // Strategy 1: Find elements that look like rows with letter cells
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      const children = el.children;
      // A row might contain 3-6 child elements that are letter cells
      if (children.length >= 3 && children.length <= 8) {
        const childTexts = [...children].map(c => c.textContent.trim());
        const singleLetterChildren = childTexts.filter(t => /^[A-Z]$/i.test(t));

        // If most children are single letters, this could be a puzzle row
        if (singleLetterChildren.length >= 3) {
          candidates.push({
            tag: el.tagName,
            className: this._truncate(el.className, 150),
            childCount: children.length,
            letters: singleLetterChildren.join(''),
            fullText: this._truncate(el.textContent, 100),
            rect: this._getRect(el),
            parentClass: this._truncate(el.parentElement?.className, 100),
            draggable: el.draggable,
            role: el.getAttribute('role'),
            ariaLabel: el.getAttribute('aria-label'),
            dataset: { ...el.dataset }
          });
        }
      }
    }

    // Strategy 2: Look for common row selectors
    const rowSelectors = [
      '[class*="row"]', '[class*="Row"]',
      '[class*="line"]', '[class*="Line"]',
      '[class*="step"]', '[class*="Step"]',
      '[class*="rung"]', '[class*="Rung"]',
      '[role="listitem"]', '[role="row"]'
    ];

    for (const sel of rowSelectors) {
      document.querySelectorAll(sel).forEach(el => {
        // Avoid duplicates and only include elements that seem relevant to the game
        const text = el.textContent.trim();
        if (text.length < 500 && text.length > 0) {
          candidates.push({
            matchedSelector: sel,
            tag: el.tagName,
            className: this._truncate(el.className, 150),
            childCount: el.children.length,
            textPreview: this._truncate(text, 100),
            rect: this._getRect(el),
            draggable: el.draggable,
            role: el.getAttribute('role'),
            ariaLabel: el.getAttribute('aria-label')
          });
        }
      });
    }

    return candidates;
  },

  _findInputElements() {
    const inputs = [];

    // Standard inputs
    document.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]')
      .forEach(el => {
        inputs.push({
          tag: el.tagName,
          type: el.type,
          id: el.id,
          className: this._truncate(el.className, 100),
          ariaLabel: el.getAttribute('aria-label'),
          placeholder: el.placeholder,
          value: el.value,
          contentEditable: el.contentEditable,
          rect: this._getRect(el)
        });
      });

    // Letter cell elements (divs/spans that act as single-letter inputs)
    document.querySelectorAll('[class*="cell"], [class*="Cell"], [class*="tile"], [class*="Tile"], [class*="letter"], [class*="Letter"]')
      .forEach(el => {
        inputs.push({
          tag: el.tagName,
          className: this._truncate(el.className, 100),
          textContent: el.textContent.trim(),
          ariaLabel: el.getAttribute('aria-label'),
          role: el.getAttribute('role'),
          tabIndex: el.tabIndex,
          rect: this._getRect(el),
          dataset: { ...el.dataset }
        });
      });

    return inputs;
  },

  _findKeyboard() {
    const keyboards = [];

    const selectors = [
      '[class*="keyboard"]', '[class*="Keyboard"]',
      '[data-testid*="keyboard"]',
      '[aria-label*="keyboard"]', '[aria-label*="Keyboard"]'
    ];

    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el => {
        const buttons = el.querySelectorAll('button, [role="button"]');
        const keyTexts = [...buttons]
          .map(b => b.textContent.trim())
          .filter(t => t.length <= 3);

        keyboards.push({
          selector: sel,
          tag: el.tagName,
          className: this._truncate(el.className, 150),
          buttonCount: buttons.length,
          keyTexts: keyTexts.slice(0, 30),
          rect: this._getRect(el)
        });
      });
    }

    // Also look for a group of single-letter buttons
    const allButtons = document.querySelectorAll('button, [role="button"]');
    const letterButtons = [...allButtons].filter(b => /^[A-Z]$/i.test(b.textContent.trim()));
    if (letterButtons.length >= 20) {
      keyboards.push({
        detectedBy: 'letter-button-count',
        count: letterButtons.length,
        sample: letterButtons.slice(0, 5).map(b => ({
          text: b.textContent.trim(),
          className: this._truncate(b.className, 80),
          ariaLabel: b.getAttribute('aria-label'),
          parentClass: this._truncate(b.parentElement?.className, 80)
        }))
      });
    }

    return keyboards;
  },

  _findDraggables() {
    const draggables = [];

    // HTML5 draggable elements
    document.querySelectorAll('[draggable="true"]').forEach(el => {
      draggables.push({
        detectedBy: 'draggable-attr',
        tag: el.tagName,
        className: this._truncate(el.className, 100),
        textPreview: this._truncate(el.textContent, 80),
        rect: this._getRect(el)
      });
    });

    // Elements with drag-related classes
    const dragSelectors = [
      '[class*="drag"]', '[class*="Drag"]',
      '[class*="sortable"]', '[class*="Sortable"]',
      '[class*="grip"]', '[class*="Grip"]',
      '[class*="handle"]', '[class*="Handle"]',
      '[class*="reorder"]', '[class*="Reorder"]',
      '[class*="movable"]', '[class*="Movable"]'
    ];

    for (const sel of dragSelectors) {
      document.querySelectorAll(sel).forEach(el => {
        draggables.push({
          detectedBy: sel,
          tag: el.tagName,
          className: this._truncate(el.className, 100),
          textPreview: this._truncate(el.textContent, 80),
          cursor: window.getComputedStyle(el).cursor,
          rect: this._getRect(el)
        });
      });
    }

    return draggables;
  },

  _findGameButtons() {
    const buttons = [];
    document.querySelectorAll('button, [role="button"]').forEach(el => {
      const text = el.textContent.trim();
      // Filter to game-relevant buttons (not keyboard keys)
      if (text.length > 1 && text.length < 50) {
        buttons.push({
          text,
          tag: el.tagName,
          className: this._truncate(el.className, 100),
          ariaLabel: el.getAttribute('aria-label'),
          disabled: el.disabled,
          rect: this._getRect(el)
        });
      }
    });
    return buttons;
  },

  _findLockIndicators() {
    const locks = [];
    const selectors = [
      '[class*="lock"]', '[class*="Lock"]',
      '[aria-label*="lock"]', '[aria-label*="Lock"]',
      'svg[class*="lock"]', '[data-testid*="lock"]'
    ];

    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el => {
        locks.push({
          selector: sel,
          tag: el.tagName,
          className: this._truncate(el.className, 100),
          parentText: this._truncate(el.parentElement?.textContent, 80),
          rect: this._getRect(el)
        });
      });
    }
    return locks;
  },

  _mapAriaStructure() {
    const elements = [];
    document.querySelectorAll('[role], [aria-label], [aria-describedby], [aria-live]').forEach(el => {
      const role = el.getAttribute('role');
      const label = el.getAttribute('aria-label');
      // Filter to potentially game-related elements
      if (role || label) {
        elements.push({
          tag: el.tagName,
          role,
          ariaLabel: label,
          ariaDescribedBy: el.getAttribute('aria-describedby'),
          className: this._truncate(el.className, 80),
          childCount: el.children.length,
          textPreview: this._truncate(el.textContent, 60)
        });
      }
    });
    return elements;
  },

  _findReactRoots() {
    const roots = [];
    // Look for React root containers
    document.querySelectorAll('[id="root"], [id="app"], [id="__next"], [data-reactroot]').forEach(el => {
      roots.push({
        id: el.id,
        tag: el.tagName,
        className: this._truncate(el.className, 100),
        hasReactFiber: Object.keys(el).some(k => k.startsWith('__reactFiber') || k.startsWith('__reactContainer'))
      });
    });

    // Check if any element has React fiber keys
    const body = document.body;
    const bodyKeys = Object.keys(body);
    const reactKeys = bodyKeys.filter(k => k.includes('react') || k.includes('React'));
    if (reactKeys.length > 0) {
      roots.push({ note: 'React keys found on body', keys: reactKeys });
    }

    return roots;
  },

  // Deep scan: look for Shadow DOM, canvas, answer words, custom elements
  deepScan(answerWords = []) {
    const report = {
      shadowRoots: [],
      canvasElements: [],
      svgElements: [],
      customElements: [],
      answerWordMatches: [],
      draggableDetails: [],
      buttonDetails: [],
      webComponents: [],
      totalElements: 0,
      shadowDOMElements: 0,
    };

    const answerWordsUpper = answerWords.map(w => w.toUpperCase());

    // Walk entire DOM tree including shadow roots
    const walkDOM = (root, path = 'document') => {
      const allEls = root.querySelectorAll('*');
      report.totalElements += allEls.length;

      for (const el of allEls) {
        // Check for shadow root
        if (el.shadowRoot) {
          const childCount = el.shadowRoot.childNodes.length;
          const elCount = el.shadowRoot.querySelectorAll('*').length;
          report.shadowRoots.push({
            tag: el.tagName.toLowerCase(),
            className: this._truncate(el.className?.toString(), 100),
            id: el.id,
            path,
            shadowChildNodes: childCount,
            shadowElementCount: elCount,
            shadowTextPreview: this._truncate(el.shadowRoot.textContent, 200)
          });
          report.shadowDOMElements += elCount;
          // Recurse into shadow root
          walkDOM(el.shadowRoot, `${path} > ${el.tagName.toLowerCase()}#${el.id || '?'}.shadowRoot`);
        }

        // Check for custom elements (hyphenated tag names)
        if (el.tagName.includes('-')) {
          if (report.customElements.length < 30) {
            report.customElements.push({
              tag: el.tagName.toLowerCase(),
              className: this._truncate(el.className?.toString(), 80),
              childCount: el.children.length,
              textPreview: this._truncate(el.textContent, 80),
              hasShadowRoot: !!el.shadowRoot,
              path
            });
          }
        }

        // Check for canvas
        if (el.tagName === 'CANVAS') {
          report.canvasElements.push({
            id: el.id,
            className: this._truncate(el.className?.toString(), 80),
            dimensions: `${el.width}x${el.height}`,
            cssSize: `${el.offsetWidth}x${el.offsetHeight}`,
            path
          });
        }

        // Check for SVG with text content
        if (el.tagName === 'svg' || el.tagName === 'SVG') {
          const svgText = el.textContent.trim();
          if (svgText.length > 0) {
            report.svgElements.push({
              id: el.id,
              textPreview: this._truncate(svgText, 100),
              childCount: el.children.length,
              path
            });
          }
        }

        // Search for answer words in text content
        if (answerWordsUpper.length > 0) {
          const text = el.textContent.trim().toUpperCase();
          for (const word of answerWordsUpper) {
            if (text === word || (text.includes(word) && text.length < 200 && el.children.length <= 5)) {
              if (report.answerWordMatches.length < 50) {
                report.answerWordMatches.push({
                  word,
                  tag: el.tagName.toLowerCase(),
                  className: this._truncate(el.className?.toString(), 80),
                  exactMatch: text === word,
                  fullText: this._truncate(el.textContent.trim(), 100),
                  childCount: el.children.length,
                  isLeaf: el.children.length === 0,
                  draggable: el.draggable || el.getAttribute('draggable') === 'true',
                  path,
                  rect: this._getRect(el)
                });
              }
            }
          }
        }
      }
    };

    walkDOM(document);

    // Detailed draggable scan
    document.querySelectorAll('[draggable="true"]').forEach(el => {
      if (report.draggableDetails.length < 20) {
        const children = [...el.children].map(c => ({
          tag: c.tagName,
          text: this._truncate(c.textContent.trim(), 40),
          className: this._truncate(c.className?.toString(), 60)
        }));
        report.draggableDetails.push({
          tag: el.tagName,
          className: this._truncate(el.className?.toString(), 100),
          text: this._truncate(el.textContent.trim(), 100),
          childCount: el.children.length,
          children: children.slice(0, 5),
          rect: this._getRect(el),
          ariaLabel: el.getAttribute('aria-label'),
          role: el.getAttribute('role'),
          dataset: { ...el.dataset }
        });
      }
    });

    // Detailed button scan
    document.querySelectorAll('button, [role="button"]').forEach(el => {
      const text = el.textContent.trim();
      if (text.length > 0 && text.length < 100 && report.buttonDetails.length < 30) {
        report.buttonDetails.push({
          text,
          tag: el.tagName,
          className: this._truncate(el.className?.toString(), 80),
          ariaLabel: el.getAttribute('aria-label'),
          disabled: el.disabled,
          rect: this._getRect(el)
        });
      }
    });

    console.log('[CrossclimbSolver] Deep Scan Report:', report);
    return report;
  },

  // Helper utilities
  _truncate(str, maxLen) {
    if (!str) return '';
    const s = typeof str === 'string' ? str : String(str);
    return s.length > maxLen ? s.substring(0, maxLen) + '...' : s;
  },

  _getRect(el) {
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) };
  }
};
