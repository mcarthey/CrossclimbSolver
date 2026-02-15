// CrossclimbSolver - DOM Interaction Helpers
// Low-level utilities for typing into React inputs and simulating drag-and-drop

const CrossclimbDOM = {
  // ----- WAITING / OBSERVATION -----

  // Wait for an element matching a selector (or predicate function) to appear
  waitForElement(selectorOrFn, { timeout = 10000, root = document } = {}) {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (typeof selectorOrFn === 'function') return selectorOrFn();
        return root.querySelector(selectorOrFn);
      };

      const existing = check();
      if (existing) {
        resolve(existing);
        return;
      }

      const observer = new MutationObserver(() => {
        const el = check();
        if (el) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(el);
        }
      });

      observer.observe(root.body || root, { childList: true, subtree: true });

      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timeout waiting for element: ${selectorOrFn}`));
      }, timeout);
    });
  },

  // Wait for a condition to become true
  waitForCondition(conditionFn, { timeout = 10000, pollInterval = 200 } = {}) {
    return new Promise((resolve, reject) => {
      if (conditionFn()) {
        resolve();
        return;
      }

      const interval = setInterval(() => {
        if (conditionFn()) {
          clearInterval(interval);
          clearTimeout(timer);
          resolve();
        }
      }, pollInterval);

      const timer = setTimeout(() => {
        clearInterval(interval);
        reject(new Error('Timeout waiting for condition'));
      }, timeout);
    });
  },

  // ----- INPUT / TYPING -----

  // Strategy 1: Set React input value directly (works for standard React inputs)
  setReactInputValue(element, value) {
    // Use the native setter to bypass React's synthetic event system
    const descriptor = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ) || Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    );

    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }

    // Dispatch events React listens for
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  },

  // Strategy 2: Simulate individual key presses (for keystroke-validated inputs)
  async simulateKeyPresses(targetElement, text, { delay = 60 } = {}) {
    // Focus the element first
    targetElement.focus();
    targetElement.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    targetElement.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    await this.sleep(50);

    for (const char of text) {
      await this._pressKey(targetElement, char);
      await this.sleep(delay);
    }
  },

  // Simulate a single key press with full event sequence
  async _pressKey(target, char) {
    const key = char;
    const code = `Key${char.toUpperCase()}`;
    const keyCode = char.toUpperCase().charCodeAt(0);

    const commonProps = {
      key,
      code,
      keyCode,
      which: keyCode,
      charCode: keyCode,
      bubbles: true,
      cancelable: true,
      composed: true
    };

    target.dispatchEvent(new KeyboardEvent('keydown', commonProps));
    target.dispatchEvent(new KeyboardEvent('keypress', { ...commonProps, charCode: char.charCodeAt(0) }));

    // If it's an input/textarea, update the value
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(target, (target.value || '') + char);
      }
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }

    target.dispatchEvent(new KeyboardEvent('keyup', commonProps));
  },

  // Strategy 3: Click virtual keyboard buttons (for on-screen keyboards)
  async clickVirtualKeyboard(text, { keyboardSelector, delay = 80 } = {}) {
    const keyboard = keyboardSelector
      ? document.querySelector(keyboardSelector)
      : this._findVirtualKeyboard();

    if (!keyboard) {
      throw new Error('Virtual keyboard not found');
    }

    for (const char of text) {
      const keyButton = this._findKeyButton(keyboard, char);
      if (!keyButton) {
        console.warn(`[CrossclimbSolver] Key button for "${char}" not found`);
        continue;
      }

      // Simulate a full click sequence
      keyButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      keyButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await this.sleep(30);
      keyButton.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      keyButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      keyButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      await this.sleep(delay);
    }
  },

  _findVirtualKeyboard() {
    // Common selectors for virtual keyboards in web games
    const selectors = [
      '[class*="keyboard"]',
      '[class*="Keyboard"]',
      '[data-testid*="keyboard"]',
      '[role="group"]',
      '[class*="key-row"]'
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }

    // Fallback: look for a container with many single-letter buttons
    const allButtons = document.querySelectorAll('button, [role="button"]');
    const singleLetterButtons = [...allButtons].filter(b => /^[A-Z]$/i.test(b.textContent.trim()));
    if (singleLetterButtons.length >= 20) {
      return singleLetterButtons[0].parentElement?.parentElement;
    }

    return null;
  },

  _findKeyButton(keyboard, char) {
    const upper = char.toUpperCase();
    const lower = char.toLowerCase();

    // Try aria-label
    let btn = keyboard.querySelector(`[aria-label="${upper}"], [aria-label="${lower}"]`);
    if (btn) return btn;

    // Try data attributes
    btn = keyboard.querySelector(`[data-key="${upper}"], [data-key="${lower}"]`);
    if (btn) return btn;

    // Try text content match
    const buttons = keyboard.querySelectorAll('button, [role="button"], [class*="key"]');
    for (const b of buttons) {
      const text = b.textContent.trim();
      if (text === upper || text === lower) return b;
    }

    return null;
  },

  // ----- CLICKING / SELECTION -----

  // Click an element with full event simulation
  async clickElement(element) {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    const eventProps = { clientX: x, clientY: y, bubbles: true, cancelable: true };

    element.dispatchEvent(new PointerEvent('pointerdown', { ...eventProps, pointerId: 1 }));
    element.dispatchEvent(new MouseEvent('mousedown', eventProps));
    await this.sleep(50);
    element.dispatchEvent(new PointerEvent('pointerup', { ...eventProps, pointerId: 1 }));
    element.dispatchEvent(new MouseEvent('mouseup', eventProps));
    element.dispatchEvent(new MouseEvent('click', eventProps));
  },

  // ----- DRAG AND DROP -----

  // Strategy 1: Pointer-event based drag (most common in modern touch-friendly UIs)
  async pointerDrag(sourceEl, targetEl, { steps = 20, stepDelay = 16, pauseAtStart = 150 } = {}) {
    const sourceRect = sourceEl.getBoundingClientRect();
    const targetRect = targetEl.getBoundingClientRect();

    const startX = sourceRect.left + sourceRect.width / 2;
    const startY = sourceRect.top + sourceRect.height / 2;
    const endX = targetRect.left + targetRect.width / 2;
    const endY = targetRect.top + targetRect.height / 2;

    const commonPointerProps = { pointerId: 1, pointerType: 'mouse', isPrimary: true };

    // Press down on source
    sourceEl.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: startX, clientY: startY,
      bubbles: true, cancelable: true, ...commonPointerProps
    }));
    sourceEl.dispatchEvent(new MouseEvent('mousedown', {
      clientX: startX, clientY: startY,
      bubbles: true, cancelable: true
    }));

    // Brief pause to trigger drag recognition (many libraries need this)
    await this.sleep(pauseAtStart);

    // Move in incremental steps with easing
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      // Ease in-out for more natural movement
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const currentX = startX + (endX - startX) * eased;
      const currentY = startY + (endY - startY) * eased;

      const moveProps = {
        clientX: currentX, clientY: currentY,
        bubbles: true, cancelable: true
      };

      sourceEl.dispatchEvent(new PointerEvent('pointermove', { ...moveProps, ...commonPointerProps }));
      document.dispatchEvent(new PointerEvent('pointermove', { ...moveProps, ...commonPointerProps }));
      sourceEl.dispatchEvent(new MouseEvent('mousemove', moveProps));
      document.dispatchEvent(new MouseEvent('mousemove', moveProps));

      await this.sleep(stepDelay);
    }

    // Release at target
    const releaseProps = {
      clientX: endX, clientY: endY,
      bubbles: true, cancelable: true
    };

    sourceEl.dispatchEvent(new PointerEvent('pointerup', { ...releaseProps, ...commonPointerProps }));
    document.dispatchEvent(new PointerEvent('pointerup', { ...releaseProps, ...commonPointerProps }));
    sourceEl.dispatchEvent(new MouseEvent('mouseup', releaseProps));
    document.dispatchEvent(new MouseEvent('mouseup', releaseProps));
  },

  // Strategy 2: HTML5 Drag and Drop API
  async html5DragDrop(sourceEl, targetEl) {
    const dataTransfer = new DataTransfer();

    const sourceRect = sourceEl.getBoundingClientRect();
    const targetRect = targetEl.getBoundingClientRect();

    sourceEl.dispatchEvent(new DragEvent('dragstart', {
      dataTransfer, bubbles: true, cancelable: true,
      clientX: sourceRect.left + sourceRect.width / 2,
      clientY: sourceRect.top + sourceRect.height / 2
    }));

    await this.sleep(100);

    targetEl.dispatchEvent(new DragEvent('dragenter', {
      dataTransfer, bubbles: true, cancelable: true
    }));
    targetEl.dispatchEvent(new DragEvent('dragover', {
      dataTransfer, bubbles: true, cancelable: true
    }));

    await this.sleep(50);

    targetEl.dispatchEvent(new DragEvent('drop', {
      dataTransfer, bubbles: true, cancelable: true,
      clientX: targetRect.left + targetRect.width / 2,
      clientY: targetRect.top + targetRect.height / 2
    }));
    sourceEl.dispatchEvent(new DragEvent('dragend', {
      dataTransfer, bubbles: true, cancelable: true
    }));
  },

  // Strategy 3: Touch-event based drag (for mobile-oriented UIs)
  async touchDrag(sourceEl, targetEl, { steps = 20, stepDelay = 16 } = {}) {
    const sourceRect = sourceEl.getBoundingClientRect();
    const targetRect = targetEl.getBoundingClientRect();

    const startX = sourceRect.left + sourceRect.width / 2;
    const startY = sourceRect.top + sourceRect.height / 2;
    const endX = targetRect.left + targetRect.width / 2;
    const endY = targetRect.top + targetRect.height / 2;

    const createTouch = (x, y) => new Touch({
      identifier: 0, target: sourceEl,
      clientX: x, clientY: y,
      pageX: x + window.scrollX, pageY: y + window.scrollY
    });

    sourceEl.dispatchEvent(new TouchEvent('touchstart', {
      touches: [createTouch(startX, startY)],
      targetTouches: [createTouch(startX, startY)],
      changedTouches: [createTouch(startX, startY)],
      bubbles: true, cancelable: true
    }));

    await this.sleep(100);

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const currentX = startX + (endX - startX) * eased;
      const currentY = startY + (endY - startY) * eased;

      document.dispatchEvent(new TouchEvent('touchmove', {
        touches: [createTouch(currentX, currentY)],
        targetTouches: [createTouch(currentX, currentY)],
        changedTouches: [createTouch(currentX, currentY)],
        bubbles: true, cancelable: true
      }));

      await this.sleep(stepDelay);
    }

    document.dispatchEvent(new TouchEvent('touchend', {
      touches: [],
      targetTouches: [],
      changedTouches: [createTouch(endX, endY)],
      bubbles: true, cancelable: true
    }));
  },

  // ----- REACT INTERNALS -----

  // Access React component instance from a DOM element
  getReactInstance(element) {
    const keys = Object.keys(element);
    const fiberKey = keys.find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    return fiberKey ? element[fiberKey] : null;
  },

  // Walk up the React fiber tree to find a component with specific props
  findReactComponent(element, predicate) {
    let fiber = this.getReactInstance(element);
    while (fiber) {
      if (fiber.memoizedProps && predicate(fiber.memoizedProps, fiber)) {
        return fiber;
      }
      fiber = fiber.return;
    }
    return null;
  },

  // ----- PAGE-CONTEXT BRIDGE -----
  // Content scripts run in an isolated JS world. Events dispatched from here
  // are invisible to the page's JS (Ember). The bridge injects a <script> into
  // the page context and communicates via window.postMessage.

  _bridgeReady: false,
  _bridgeLoadPromise: null,

  injectBridge() {
    if (this._bridgeReady) return Promise.resolve();
    if (this._bridgeLoadPromise) return this._bridgeLoadPromise;

    this._bridgeLoadPromise = new Promise((resolve) => {
      // Load the bridge as an external file to bypass CSP restrictions on inline scripts.
      // The file is declared in manifest.json under web_accessible_resources.
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('content/page-bridge.js');
      script.onload = () => {
        console.log('[CrossclimbSolver] Bridge script loaded');
        script.remove();
        this._bridgeReady = true;
        resolve();
      };
      script.onerror = (e) => {
        console.error('[CrossclimbSolver] Bridge script failed to load:', e);
        this._bridgeLoadPromise = null;
        resolve(); // resolve anyway so we don't hang
      };
      (document.head || document.documentElement).appendChild(script);
    });

    return this._bridgeLoadPromise;
  },

  // Send a command to the page bridge and wait for acknowledgment
  async _bridgeCmd(action, payload = {}, timeout = 5000) {
    await this.injectBridge();
    return new Promise((resolve) => {
      const id = Date.now() + '_' + Math.random().toString(36).slice(2);
      const handler = (event) => {
        if (event.data?.src === 'cs-ack' && event.data.id === id) {
          window.removeEventListener('message', handler);
          clearTimeout(timer);
          resolve(event.data);
        }
      };
      window.addEventListener('message', handler);
      const timer = setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve({ ok: false, error: 'bridge timeout' });
      }, timeout);
      window.postMessage({ src: 'cs-cmd', action, id, ...payload }, '*');
    });
  },

  // Type a single key in the page's JS context
  async pageTypeKey(key) {
    return this._bridgeCmd('type-key', { key });
  },

  // Type a full word in the page's JS context (with 80ms delay between keys)
  async pageTypeWord(word) {
    return this._bridgeCmd('type-word', { word }, 10000);
  },

  // Click an element by CSS selector in the page's JS context
  async pageClick(selector) {
    return this._bridgeCmd('click', { selector });
  },

  // Focus an element by CSS selector in the page's JS context
  async pageFocus(selector) {
    return this._bridgeCmd('focus', { selector });
  },

  // Drag from source to target (by CSS selectors) in the page's JS context
  async pageDrag(srcSel, tgtSel) {
    return this._bridgeCmd('drag', { srcSel, tgtSel }, 8000);
  },

  // ----- UTILITIES -----

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },

  // Get all text content from an element, excluding hidden children
  getVisibleText(element) {
    if (!element) return '';
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return '';
    return (element.textContent || '').trim();
  }
};
