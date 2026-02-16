// Copyright 2025 mcarthey
// SPDX-License-Identifier: Apache-2.0
//
// CrossclimbSolver - Page-Context Bridge
// Runs in the PAGE's JavaScript context (not the content script's isolated world).
// Communicates via window.postMessage. Loaded as web_accessible_resource to bypass CSP.

(function() {
  'use strict';

  if (window.__csBridge) return;
  window.__csBridge = true;

  window.addEventListener('message', function(evt) {
    if (evt.source !== window || !evt.data || evt.data.src !== 'cs-cmd') return;

    var d = evt.data;
    var result = { src: 'cs-ack', id: d.id, ok: true };

    try {
      switch (d.action) {
        case 'ping':
          result.pong = true;
          break;

        case 'diagnose':
          result.data = runDiagnostics(d.selector);
          break;

        case 'click':
          doClick(d.selector, result);
          break;

        case 'focus':
          var fel = document.querySelector(d.selector);
          if (fel) { fel.focus(); } else { result.ok = false; result.error = 'not found'; }
          break;

        case 'fill-row':
          fillRowAsync(d.rowSelector, d.word, result);
          return; // ack sent async

        case 'type-key':
          result.details = typeOneKey(d.key);
          break;

        case 'type-word':
          typeWordAsync(d.word, result);
          return; // ack sent async

        case 'drag':
          doDragAsync(d.srcSel, d.tgtSel, result);
          return; // ack sent async

        case 'read-order':
          result.data = readBoardOrder();
          break;

        case 'reorder-dom':
          reorderDOM(d.targetWords, result);
          break;

        case 'drag-touch':
          doTouchDragAsync(d.srcSel, d.tgtSel, result);
          return; // ack sent async

        case 'ember-explore':
          emberExplore(result);
          break;

        case 'ember-reorder':
          emberReorder(d.targetWords, result);
          break;

        case 'drag-capture-bypass':
          doDragCaptureBypassAsync(d.srcSel, d.tgtSel, result);
          return; // ack sent async

        case 'drag-html5':
          doDragHtml5Async(d.srcSel, d.tgtSel, result);
          return; // ack sent async

        case 'ember-explore-v2':
          emberExploreV2(result);
          break;

        default:
          result.ok = false;
          result.error = 'unknown action: ' + d.action;
      }
    } catch (err) {
      result.ok = false;
      result.error = err.message;
    }

    window.postMessage(result, '*');
  });

  // ---- DIAGNOSTICS ----

  function runDiagnostics(clickSelector) {
    var diag = {};

    // What is currently focused?
    var ae = document.activeElement;
    diag.activeElement = ae ? {
      tag: ae.tagName,
      class: (ae.className || '').substring(0, 80),
      id: ae.id || '',
      type: ae.type || '',
      contentEditable: ae.contentEditable,
      tabIndex: ae.tabIndex,
      rect: rectStr(ae)
    } : null;

    // If a selector was provided, click it and report what becomes active
    if (clickSelector) {
      var clickEl = document.querySelector(clickSelector);
      if (clickEl) {
        clickEl.click();
        clickEl.focus();
        var ae2 = document.activeElement;
        diag.afterClick = {
          tag: ae2.tagName,
          class: (ae2.className || '').substring(0, 80),
          id: ae2.id || '',
          type: ae2.type || '',
          contentEditable: ae2.contentEditable
        };
      }
    }

    // Find ALL input/textarea elements in the game board
    var gameInputs = document.querySelectorAll(
      '.crossclimb__grid input, .crossclimb__grid textarea, ' +
      '.crossclimb__guess input, .crossclimb__guess textarea, ' +
      '.crossclimb__wrapper input, .crossclimb__wrapper textarea, ' +
      '[class*="crossclimb"] input, [class*="crossclimb"] textarea'
    );
    diag.gameInputCount = gameInputs.length;
    diag.gameInputs = [];
    for (var i = 0; i < Math.min(gameInputs.length, 10); i++) {
      var inp = gameInputs[i];
      diag.gameInputs.push({
        tag: inp.tagName, type: inp.type || '',
        class: (inp.className || '').substring(0, 60),
        rect: rectStr(inp),
        parentClass: (inp.parentElement && inp.parentElement.className || '').substring(0, 60),
        value: (inp.value || '').substring(0, 20)
      });
    }

    // Inspect children of the first guess box
    var box = document.querySelector('.crossclimb__guess--new-focus .crossclimb__guess_box') ||
              document.querySelector('.crossclimb__guess_box');
    diag.boxChildren = [];
    if (box) {
      for (var c = 0; c < box.children.length; c++) {
        var child = box.children[c];
        diag.boxChildren.push({
          tag: child.tagName,
          class: (child.className || '').substring(0, 60),
          text: child.textContent.substring(0, 20),
          rect: rectStr(child),
          contentEditable: child.contentEditable,
          childCount: child.children.length
        });
      }
    }

    // Look for hidden/tiny inputs anywhere that might be game-related
    var allInputs = document.querySelectorAll('input, textarea');
    diag.hiddenInputs = [];
    for (var j = 0; j < allInputs.length; j++) {
      var el = allInputs[j];
      var r = el.getBoundingClientRect();
      // Small, off-screen, or zero-sized inputs
      if (r.width <= 2 || r.height <= 2 || r.top < -50 || r.left < -50) {
        var pClass = el.parentElement ? (el.parentElement.className || '') : '';
        // Only report game-adjacent ones
        if (pClass.match(/crossclimb|game|board|guess|grid/i) ||
            el.className.match(/crossclimb|game|board|guess|grid/i) ||
            diag.hiddenInputs.length < 5) {
          diag.hiddenInputs.push({
            tag: el.tagName, type: el.type || '',
            class: (el.className || '').substring(0, 60),
            rect: r.width + 'x' + r.height + '@' + Math.round(r.left) + ',' + Math.round(r.top),
            parentClass: pClass.substring(0, 60),
            value: (el.value || '').substring(0, 20)
          });
        }
      }
    }

    // Check for contenteditable elements in the game
    var editables = document.querySelectorAll('.crossclimb__grid [contenteditable], .crossclimb__wrapper [contenteditable]');
    diag.editableCount = editables.length;

    return diag;
  }

  // ---- CLICKING ----

  function doClick(selector, result) {
    var el = document.querySelector(selector);
    if (!el) { result.ok = false; result.error = 'not found: ' + selector; return; }

    var rect = el.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var ptrOpts = { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    var mouseOpts = { clientX: cx, clientY: cy, bubbles: true, cancelable: true };

    el.dispatchEvent(new PointerEvent('pointerdown', ptrOpts));
    el.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
    el.dispatchEvent(new PointerEvent('pointerup', ptrOpts));
    el.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
    el.dispatchEvent(new MouseEvent('click', mouseOpts));
    el.focus();
  }

  // ---- FILL ROW (primary typing strategy) ----
  // Targets each <input> in a row individually using execCommand('insertText')

  function fillRowAsync(rowSelector, word, result) {
    var row = document.querySelector(rowSelector);
    if (!row) {
      result.ok = false;
      result.error = 'row not found: ' + rowSelector;
      window.postMessage(result, '*');
      return;
    }

    // Find all inputs within the guess boxes
    var inputs = row.querySelectorAll('.crossclimb__guess_box input.ember-text-field');
    if (inputs.length === 0) {
      inputs = row.querySelectorAll('.crossclimb__guess_box input');
    }
    if (inputs.length === 0) {
      inputs = row.querySelectorAll('input');
    }

    result.inputCount = inputs.length;
    result.wordLength = word.length;

    if (inputs.length < word.length) {
      result.ok = false;
      result.error = 'inputs=' + inputs.length + ' need=' + word.length;
      window.postMessage(result, '*');
      return;
    }

    // First, click the first input to activate the row
    var firstInput = inputs[0];
    var rect = firstInput.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    firstInput.dispatchEvent(new PointerEvent('pointerdown', { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    firstInput.dispatchEvent(new MouseEvent('mousedown', { clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
    firstInput.dispatchEvent(new PointerEvent('pointerup', { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    firstInput.dispatchEvent(new MouseEvent('mouseup', { clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
    firstInput.dispatchEvent(new MouseEvent('click', { clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
    firstInput.focus();

    var idx = 0;
    var details = [];

    function fillNext() {
      if (idx >= word.length) {
        result.fillDetails = details;
        window.postMessage(result, '*');
        return;
      }

      var input = inputs[idx];
      var letter = word[idx].toLowerCase();
      var detail = { idx: idx, letter: letter };

      // Focus this specific input
      input.focus();

      // Select any existing content so execCommand replaces it
      input.select();

      // Use execCommand to insert — this creates TRUSTED input events
      var ok = document.execCommand('insertText', false, letter);
      detail.execOk = ok;
      detail.valueAfter = input.value;

      // If execCommand didn't work, fall back to direct value setting + events
      if (!ok || input.value !== letter) {
        // Use native setter to bypass Ember's value tracking
        var nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        if (nativeSetter && nativeSetter.set) {
          nativeSetter.set.call(input, letter);
        } else {
          input.value = letter;
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        detail.fallback = true;
        detail.valueAfter = input.value;
      }

      details.push(detail);
      idx++;
      setTimeout(fillNext, 120);
    }

    // Start after a brief delay for row activation
    setTimeout(fillNext, 200);
  }

  // ---- TYPING (legacy fallback, now only uses execCommand) ----

  function typeOneKey(key) {
    var details = { strategies: [] };
    var ae = document.activeElement;
    details.activeTag = ae ? ae.tagName : 'null';
    details.activeClass = ae ? (ae.className || '').substring(0, 50) : '';

    // Only use execCommand — the one strategy proven to work
    try {
      var ok = document.execCommand('insertText', false, key);
      details.strategies.push('execCommand=' + ok);
    } catch (e) {
      details.strategies.push('execCommand=err');
    }

    return details;
  }

  function typeWordAsync(word, result) {
    var idx = 0;
    var allDetails = [];
    function next() {
      if (idx >= word.length) {
        result.keyDetails = allDetails;
        window.postMessage(result, '*');
        return;
      }
      var details = typeOneKey(word[idx]);
      allDetails.push(details);
      idx++;
      setTimeout(next, 80);
    }
    next();
  }

  // ---- DRAGGING ----

  function doDragAsync(srcSel, tgtSel, result) {
    var srcEl = document.querySelector(srcSel);
    var tgtEl = document.querySelector(tgtSel);
    if (!srcEl || !tgtEl) {
      result.ok = false;
      result.error = 'drag elements not found';
      window.postMessage(result, '*');
      return;
    }

    var sr = srcEl.getBoundingClientRect();
    var tr = tgtEl.getBoundingClientRect();
    var sx = sr.left + sr.width / 2, sy = sr.top + sr.height / 2;
    var ex = tr.left + tr.width / 2, ey = tr.top + tr.height / 2;

    // Full pointer properties — button/buttons are critical for drag recognition
    var ptrDown = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, width: 1, height: 1, pressure: 0.5 };
    var ptrMove = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, width: 1, height: 1, pressure: 0.5 };
    var ptrUp   = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0, width: 1, height: 1, pressure: 0 };
    var mouseDown = { button: 0, buttons: 1 };
    var mouseMove = { button: 0, buttons: 1 };
    var mouseUp   = { button: 0, buttons: 0 };

    // Pointerdown on source
    srcEl.dispatchEvent(new PointerEvent('pointerdown', assign({ clientX: sx, clientY: sy, screenX: sx, screenY: sy, bubbles: true, cancelable: true }, ptrDown)));
    srcEl.dispatchEvent(new MouseEvent('mousedown', assign({ clientX: sx, clientY: sy, screenX: sx, screenY: sy, bubbles: true, cancelable: true }, mouseDown)));

    var step = 0, steps = 20;
    function dragStep() {
      step++;
      if (step > steps) {
        // Pointerup at target position
        srcEl.dispatchEvent(new PointerEvent('pointerup', assign({ clientX: ex, clientY: ey, screenX: ex, screenY: ey, bubbles: true, cancelable: true }, ptrUp)));
        document.dispatchEvent(new PointerEvent('pointerup', assign({ clientX: ex, clientY: ey, screenX: ex, screenY: ey, bubbles: true, cancelable: true }, ptrUp)));
        srcEl.dispatchEvent(new MouseEvent('mouseup', assign({ clientX: ex, clientY: ey, screenX: ex, screenY: ey, bubbles: true, cancelable: true }, mouseUp)));
        document.dispatchEvent(new MouseEvent('mouseup', assign({ clientX: ex, clientY: ey, screenX: ex, screenY: ey, bubbles: true, cancelable: true }, mouseUp)));
        window.postMessage(result, '*');
        return;
      }
      var t = step / steps;
      var e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      var cx = sx + (ex - sx) * e, cy = sy + (ey - sy) * e;
      var moveOpts = { clientX: cx, clientY: cy, screenX: cx, screenY: cy, bubbles: true, cancelable: true };

      // Dispatch on source, document, AND element under cursor
      srcEl.dispatchEvent(new PointerEvent('pointermove', assign({}, moveOpts, ptrMove)));
      document.dispatchEvent(new PointerEvent('pointermove', assign({}, moveOpts, ptrMove)));
      srcEl.dispatchEvent(new MouseEvent('mousemove', assign({}, moveOpts, mouseMove)));
      document.dispatchEvent(new MouseEvent('mousemove', assign({}, moveOpts, mouseMove)));

      var elAtPoint = document.elementFromPoint(cx, cy);
      if (elAtPoint && elAtPoint !== srcEl && elAtPoint !== document.documentElement) {
        elAtPoint.dispatchEvent(new PointerEvent('pointermove', assign({}, moveOpts, ptrMove)));
        elAtPoint.dispatchEvent(new MouseEvent('mousemove', assign({}, moveOpts, mouseMove)));
      }

      setTimeout(dragStep, 16);
    }
    setTimeout(dragStep, 150);
  }

  // ---- DOM REORDER (fallback when drag events are ignored) ----
  // Directly rearranges DOM children of the sortable container to match the target order.
  // Then attempts to notify the Ember/framework layer of the change.

  function reorderDOM(targetWords, result) {
    var container = document.querySelector('.crossclimb__guess__container');
    if (!container) {
      result.ok = false;
      result.error = 'no guess container found';
      return;
    }

    // Get all middle rows sorted by current visual position
    var middleRows = [];
    var allChildren = container.querySelectorAll('.crossclimb__guess--middle');
    for (var i = 0; i < allChildren.length; i++) {
      var row = allChildren[i];
      var inputs = row.querySelectorAll('.crossclimb__guess_box input');
      var word = '';
      for (var j = 0; j < inputs.length; j++) {
        word += (inputs[j].value || '').toUpperCase();
      }
      middleRows.push({ el: row, word: word, y: row.getBoundingClientRect().top });
    }
    middleRows.sort(function(a, b) { return a.y - b.y; });

    // Build a word-to-element map
    var wordMap = {};
    for (var k = 0; k < middleRows.length; k++) {
      wordMap[middleRows[k].word] = middleRows[k].el;
    }

    // Find the locked top row (reference point for insertion)
    var lockedTop = container.querySelector('.crossclimb__guess--lock') ||
                    container.parentElement.querySelector('.crossclimb__guess--lock');
    // Find the first non-locked element as reference
    var firstMiddle = middleRows.length > 0 ? middleRows[0].el : null;

    // Reorder: insert each row in target order
    var reordered = 0;
    for (var m = 0; m < targetWords.length; m++) {
      var targetEl = wordMap[targetWords[m]];
      if (!targetEl) {
        result.error = 'word not found in DOM: ' + targetWords[m];
        continue;
      }

      // Get the reference element: the item currently at this position
      var currentAtPos = container.querySelectorAll('.crossclimb__guess--middle');
      var currentSorted = Array.prototype.slice.call(currentAtPos);
      currentSorted.sort(function(a, b) { return a.getBoundingClientRect().top - b.getBoundingClientRect().top; });

      if (m < currentSorted.length && currentSorted[m] !== targetEl) {
        // Insert targetEl before the element currently at position m
        container.insertBefore(targetEl, currentSorted[m]);
        reordered++;
      }
    }

    result.reordered = reordered;

    // Re-tag with data-cs-row
    var finalRows = container.querySelectorAll('.crossclimb__guess--middle');
    var sorted = Array.prototype.slice.call(finalRows);
    sorted.sort(function(a, b) { return a.getBoundingClientRect().top - b.getBoundingClientRect().top; });
    for (var n = 0; n < sorted.length; n++) {
      sorted[n].setAttribute('data-cs-row', String(n));
    }

    // Try to notify the framework of the change
    // Strategy 1: Dispatch events on the container
    container.dispatchEvent(new Event('change', { bubbles: true }));
    container.dispatchEvent(new Event('input', { bubbles: true }));

    // Strategy 2: Try to trigger Ember rerender via Ember.run if available
    if (typeof Ember !== 'undefined' && Ember.run) {
      try {
        Ember.run(function() {
          // Try to find and notify the Ember component
          var emberKeys = Object.keys(container);
          for (var ek = 0; ek < emberKeys.length; ek++) {
            if (emberKeys[ek].indexOf('__ember') === 0) {
              result.emberKey = emberKeys[ek];
              break;
            }
          }
        });
      } catch (e) {
        result.emberError = e.message;
      }
    }

    // Strategy 3: Find the Ember view/component and trigger a rerender
    try {
      var viewKeys = Object.keys(container).filter(function(k) {
        return k.startsWith('__ember_meta__') || k.startsWith('__ember');
      });
      result.emberViewKeys = viewKeys;

      // Also check parent elements for Ember component
      var parent = container.parentElement;
      while (parent && parent !== document.body) {
        var pKeys = Object.keys(parent).filter(function(k) {
          return k.startsWith('__ember');
        });
        if (pKeys.length > 0) {
          result.parentEmberKeys = pKeys;
          break;
        }
        parent = parent.parentElement;
      }
    } catch (e) {
      result.emberSearchError = e.message;
    }
  }

  // ---- TOUCH-EVENT DRAG ----
  // Touch events are handled differently from pointer events by many sortable libraries.
  // Ember-sortable and similar addons often have dedicated touch handlers that may not
  // check event.isTrusted, since touch simulation is less commonly blocked.
  // The strategy: dispatch touchstart on the drag handle, then a series of touchmove
  // events tracing a path to the target, and finally touchend at the destination.

  function doTouchDragAsync(srcSel, tgtSel, result) {
    var srcEl = document.querySelector(srcSel);
    var tgtEl = document.querySelector(tgtSel);
    if (!srcEl || !tgtEl) {
      result.ok = false;
      result.error = 'touch drag elements not found';
      window.postMessage(result, '*');
      return;
    }

    var sr = srcEl.getBoundingClientRect();
    var tr = tgtEl.getBoundingClientRect();
    var sx = sr.left + sr.width / 2, sy = sr.top + sr.height / 2;
    var ex = tr.left + tr.width / 2, ey = tr.top + tr.height / 2;

    // Touch identifier must be consistent across all events in a single gesture.
    // radiusX/Y and force mimic a realistic finger touch on a mobile screen.
    var touchId = Date.now() % 100000;

    function makeTouch(x, y) {
      return new Touch({
        identifier: touchId,
        target: srcEl,
        clientX: x,
        clientY: y,
        pageX: x + window.scrollX,
        pageY: y + window.scrollY,
        screenX: x,
        screenY: y,
        radiusX: 11.5,
        radiusY: 11.5,
        force: 1
      });
    }

    // Phase 1: touchstart on the drag handle
    var startTouch = makeTouch(sx, sy);
    srcEl.dispatchEvent(new TouchEvent('touchstart', {
      touches: [startTouch],
      targetTouches: [startTouch],
      changedTouches: [startTouch],
      bubbles: true,
      cancelable: true
    }));

    // Phase 2: touchmove in incremental steps with easing
    var step = 0, steps = 25;
    function touchStep() {
      step++;
      if (step > steps) {
        // Phase 3: touchend at the target position
        var endTouch = makeTouch(ex, ey);
        var endOpts = {
          touches: [],
          targetTouches: [],
          changedTouches: [endTouch],
          bubbles: true,
          cancelable: true
        };
        srcEl.dispatchEvent(new TouchEvent('touchend', endOpts));
        // Also on document — many sortable libraries bind touchend there
        document.dispatchEvent(new TouchEvent('touchend', endOpts));
        window.postMessage(result, '*');
        return;
      }

      var t = step / steps;
      // Ease in-out cubic for natural finger movement
      var e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      var cx = sx + (ex - sx) * e;
      var cy = sy + (ey - sy) * e;

      var moveTouch = makeTouch(cx, cy);
      var moveOpts = {
        touches: [moveTouch],
        targetTouches: [moveTouch],
        changedTouches: [moveTouch],
        bubbles: true,
        cancelable: true
      };

      // Dispatch on the source element (where the gesture started)
      srcEl.dispatchEvent(new TouchEvent('touchmove', moveOpts));
      // Also dispatch on document — libraries like ember-sortable bind touchmove here
      document.dispatchEvent(new TouchEvent('touchmove', moveOpts));

      // Dispatch on the element currently under the touch point
      var elAtPoint = document.elementFromPoint(cx, cy);
      if (elAtPoint && elAtPoint !== srcEl && elAtPoint !== document.documentElement) {
        elAtPoint.dispatchEvent(new TouchEvent('touchmove', moveOpts));
      }

      setTimeout(touchStep, 16); // ~60fps
    }

    // Start moving after 200ms — a realistic delay between finger down and first move,
    // long enough for most libraries to register the touch as a potential drag gesture.
    setTimeout(touchStep, 200);
  }

  // ---- POINTER DRAG WITH setPointerCapture BYPASS ----
  // The game's sortable library (ember-drag-drop or similar) likely calls
  // element.setPointerCapture(event.pointerId) during pointerdown handling.
  // This API requires isTrusted:true events — it silently fails for synthetic events,
  // which causes the entire drag operation to be abandoned.
  //
  // Solution: Temporarily override setPointerCapture, releasePointerCapture, and
  // hasPointerCapture to succeed silently for synthetic events. We also dispatch
  // gotpointercapture/lostpointercapture events that the browser normally sends
  // after a successful capture.

  function doDragCaptureBypassAsync(srcSel, tgtSel, result) {
    var srcEl = document.querySelector(srcSel);
    var tgtEl = document.querySelector(tgtSel);
    if (!srcEl || !tgtEl) {
      result.ok = false;
      result.error = 'elements not found';
      window.postMessage(result, '*');
      return;
    }

    // Save original methods
    var origSet = Element.prototype.setPointerCapture;
    var origRelease = Element.prototype.releasePointerCapture;
    var origHas = Element.prototype.hasPointerCapture;

    // Track captured pointer IDs so hasPointerCapture returns correctly
    var capturedPointers = {};
    result.captureOverridden = true;

    Element.prototype.setPointerCapture = function(pointerId) {
      capturedPointers[pointerId] = this;
      result.captureAttempted = true;
    };
    Element.prototype.releasePointerCapture = function(pointerId) {
      delete capturedPointers[pointerId];
    };
    Element.prototype.hasPointerCapture = function(pointerId) {
      return capturedPointers[pointerId] === this;
    };

    var sr = srcEl.getBoundingClientRect();
    var tr = tgtEl.getBoundingClientRect();
    var sx = sr.left + sr.width / 2, sy = sr.top + sr.height / 2;
    var ex = tr.left + tr.width / 2, ey = tr.top + tr.height / 2;

    var ptrDown = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, width: 1, height: 1, pressure: 0.5 };
    var ptrMove = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, width: 1, height: 1, pressure: 0.5 };
    var ptrUp   = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0, width: 1, height: 1, pressure: 0 };
    var mouseDown = { button: 0, buttons: 1 };
    var mouseMove = { button: 0, buttons: 1 };
    var mouseUp   = { button: 0, buttons: 0 };

    // pointerdown on source
    srcEl.dispatchEvent(new PointerEvent('pointerdown', assign({
      clientX: sx, clientY: sy, screenX: sx, screenY: sy, bubbles: true, cancelable: true
    }, ptrDown)));

    // Simulate gotpointercapture — the browser sends this after setPointerCapture succeeds
    srcEl.dispatchEvent(new PointerEvent('gotpointercapture', assign({
      clientX: sx, clientY: sy, screenX: sx, screenY: sy, bubbles: true, cancelable: true
    }, ptrDown)));

    srcEl.dispatchEvent(new MouseEvent('mousedown', assign({
      clientX: sx, clientY: sy, screenX: sx, screenY: sy, bubbles: true, cancelable: true
    }, mouseDown)));

    var step = 0, steps = 25;
    function dragStep() {
      step++;
      if (step > steps) {
        // Restore originals BEFORE dispatching final events
        Element.prototype.setPointerCapture = origSet;
        Element.prototype.releasePointerCapture = origRelease;
        Element.prototype.hasPointerCapture = origHas;

        // pointerup + lostpointercapture at target position
        srcEl.dispatchEvent(new PointerEvent('pointerup', assign({
          clientX: ex, clientY: ey, screenX: ex, screenY: ey, bubbles: true, cancelable: true
        }, ptrUp)));
        srcEl.dispatchEvent(new PointerEvent('lostpointercapture', assign({
          clientX: ex, clientY: ey, screenX: ex, screenY: ey, bubbles: true, cancelable: true
        }, ptrUp)));
        document.dispatchEvent(new PointerEvent('pointerup', assign({
          clientX: ex, clientY: ey, screenX: ex, screenY: ey, bubbles: true, cancelable: true
        }, ptrUp)));
        srcEl.dispatchEvent(new MouseEvent('mouseup', assign({
          clientX: ex, clientY: ey, screenX: ex, screenY: ey, bubbles: true, cancelable: true
        }, mouseUp)));
        document.dispatchEvent(new MouseEvent('mouseup', assign({
          clientX: ex, clientY: ey, screenX: ex, screenY: ey, bubbles: true, cancelable: true
        }, mouseUp)));

        window.postMessage(result, '*');
        return;
      }

      var t = step / steps;
      var e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      var cx = sx + (ex - sx) * e;
      var cy = sy + (ey - sy) * e;
      var moveOpts = { clientX: cx, clientY: cy, screenX: cx, screenY: cy, bubbles: true, cancelable: true };

      srcEl.dispatchEvent(new PointerEvent('pointermove', assign({}, moveOpts, ptrMove)));
      document.dispatchEvent(new PointerEvent('pointermove', assign({}, moveOpts, ptrMove)));
      srcEl.dispatchEvent(new MouseEvent('mousemove', assign({}, moveOpts, mouseMove)));
      document.dispatchEvent(new MouseEvent('mousemove', assign({}, moveOpts, mouseMove)));

      // Also dispatch on element under cursor for drop target detection
      var elAtPoint = document.elementFromPoint(cx, cy);
      if (elAtPoint && elAtPoint !== srcEl && elAtPoint !== document.documentElement) {
        elAtPoint.dispatchEvent(new PointerEvent('pointermove', assign({}, moveOpts, ptrMove)));
        elAtPoint.dispatchEvent(new MouseEvent('mousemove', assign({}, moveOpts, mouseMove)));
      }

      setTimeout(dragStep, 16);
    }
    setTimeout(dragStep, 150);
  }

  // ---- HTML5 DRAG AND DROP ----
  // The game uses ember-drag-drop addon, which listens for the HTML5 Drag and Drop API
  // (dragstart, dragenter, dragover, drop, dragend) rather than pointer/touch events.
  // This approach creates a DataTransfer object and dispatches the full DnD event sequence.

  function doDragHtml5Async(srcSel, tgtSel, result) {
    var srcEl = document.querySelector(srcSel);
    var tgtEl = document.querySelector(tgtSel);
    if (!srcEl || !tgtEl) {
      result.ok = false;
      result.error = 'elements not found';
      window.postMessage(result, '*');
      return;
    }

    var sr = srcEl.getBoundingClientRect();
    var tr = tgtEl.getBoundingClientRect();
    var sx = sr.left + sr.width / 2, sy = sr.top + sr.height / 2;
    var ex = tr.left + tr.width / 2, ey = tr.top + tr.height / 2;

    try {
      var dataTransfer = new DataTransfer();
      // Set some data — ember-drag-drop may check for this
      dataTransfer.setData('text/plain', 'crossclimb-drag');
      dataTransfer.effectAllowed = 'move';

      // Step 1: dragstart on source
      srcEl.dispatchEvent(new DragEvent('dragstart', {
        dataTransfer: dataTransfer,
        clientX: sx, clientY: sy,
        screenX: sx, screenY: sy,
        bubbles: true, cancelable: true
      }));

      result.html5Started = true;

      // Step 2: drag sequence with intermediate positions
      var step = 0, steps = 10;
      function dndStep() {
        step++;
        if (step > steps) {
          // Step 3: Final dragover + drop on target
          dataTransfer.dropEffect = 'move';
          tgtEl.dispatchEvent(new DragEvent('dragover', {
            dataTransfer: dataTransfer,
            clientX: ex, clientY: ey,
            bubbles: true, cancelable: true
          }));

          tgtEl.dispatchEvent(new DragEvent('drop', {
            dataTransfer: dataTransfer,
            clientX: ex, clientY: ey,
            screenX: ex, screenY: ey,
            bubbles: true, cancelable: true
          }));

          srcEl.dispatchEvent(new DragEvent('dragend', {
            dataTransfer: dataTransfer,
            clientX: ex, clientY: ey,
            bubbles: true, cancelable: true
          }));

          result.html5Completed = true;
          window.postMessage(result, '*');
          return;
        }

        var t = step / steps;
        var cx = sx + (ex - sx) * t;
        var cy = sy + (ey - sy) * t;

        // dragover on the element under cursor
        var elAtPt = document.elementFromPoint(cx, cy);
        if (elAtPt) {
          elAtPt.dispatchEvent(new DragEvent('dragenter', {
            dataTransfer: dataTransfer,
            clientX: cx, clientY: cy,
            bubbles: true, cancelable: true
          }));
          elAtPt.dispatchEvent(new DragEvent('dragover', {
            dataTransfer: dataTransfer,
            clientX: cx, clientY: cy,
            bubbles: true, cancelable: true
          }));
        }

        setTimeout(dndStep, 50);
      }
      setTimeout(dndStep, 100);
    } catch (err) {
      result.ok = false;
      result.error = 'html5 dnd error: ' + err.message;
      window.postMessage(result, '*');
    }
  }

  // ---- EMBER EXPLORATION V2 ----
  // Improved version that searches requirejs for crossclimb-specific modules
  // and attempts to load the drag-coordinator service directly.

  function emberExploreV2(result) {
    var info = {};

    // --- 1. Targeted module search ---
    info.modules = {};
    if (typeof requirejs !== 'undefined') {
      var entries = requirejs.entries || {};
      var allModules = Object.keys(entries);
      info.modules.total = allModules.length;

      // Search for crossclimb-specific modules
      info.modules.crossclimb = allModules.filter(function(m) {
        return m.indexOf('crossclimb') >= 0;
      }).slice(0, 30);

      // Search for sortable-specific modules
      info.modules.sortable = allModules.filter(function(m) {
        return m.indexOf('sortable') >= 0;
      }).slice(0, 20);

      // Search for the game route/controller/component modules
      info.modules.playRoutes = allModules.filter(function(m) {
        return m.indexOf('play-routes') >= 0 || m.indexOf('play_routes') >= 0;
      }).slice(0, 20);

      // Search for ember-drag-drop specifically
      info.modules.dragDrop = allModules.filter(function(m) {
        return m.indexOf('ember-drag-drop') >= 0;
      });
    }

    // --- 2. Try to load and inspect the drag-coordinator service ---
    info.dragCoordinator = { loaded: false };
    if (typeof requirejs !== 'undefined') {
      try {
        var coordModule = requirejs('ember-drag-drop/services/drag-coordinator');
        if (coordModule && coordModule.default) {
          info.dragCoordinator.loaded = true;
          info.dragCoordinator.moduleKeys = Object.keys(coordModule).slice(0, 20);
          info.dragCoordinator.defaultKeys = Object.keys(coordModule.default).slice(0, 20);
          // Check prototype for available methods
          if (coordModule.default.prototype) {
            info.dragCoordinator.protoKeys = Object.keys(coordModule.default.prototype).slice(0, 30);
          }
          // Check for PrototypeMixin (classic Ember class pattern)
          if (coordModule.default.PrototypeMixin) {
            var mixinProps = [];
            coordModule.default.PrototypeMixin.mixins.forEach(function(m) {
              if (m.properties) {
                mixinProps = mixinProps.concat(Object.keys(m.properties));
              }
            });
            info.dragCoordinator.mixinProps = mixinProps.slice(0, 30);
          }
        }
      } catch (e) {
        info.dragCoordinator.error = e.message;
      }
    }

    // --- 3. Try to load the sortable-objects component ---
    info.sortableObjects = { loaded: false };
    if (typeof requirejs !== 'undefined') {
      try {
        var sortModule = requirejs('ember-drag-drop/components/sortable-objects');
        if (sortModule && sortModule.default) {
          info.sortableObjects.loaded = true;
          info.sortableObjects.moduleKeys = Object.keys(sortModule).slice(0, 20);
          if (sortModule.default.prototype) {
            info.sortableObjects.protoKeys = Object.keys(sortModule.default.prototype).slice(0, 30);
          }
          if (sortModule.default.PrototypeMixin) {
            var soProps = [];
            sortModule.default.PrototypeMixin.mixins.forEach(function(m) {
              if (m.properties) {
                soProps = soProps.concat(Object.keys(m.properties));
              }
            });
            info.sortableObjects.mixinProps = soProps.slice(0, 30);
          }
        }
      } catch (e) {
        info.sortableObjects.error = e.message;
      }
    }

    // --- 4. Try loading Ember utilities via requirejs ---
    info.emberUtils = {};
    var utilModules = [
      ['@ember/application', 'getOwner'],
      ['@ember/runloop', 'run,schedule,next'],
      ['@ember/object', 'get,set,notifyPropertyChange'],
      ['@ember/debug', 'inspect']
    ];
    for (var ui = 0; ui < utilModules.length; ui++) {
      var modName = utilModules[ui][0];
      var expectFns = utilModules[ui][1];
      try {
        var mod = requirejs(modName);
        if (mod) {
          info.emberUtils[modName] = {
            loaded: true,
            keys: Object.keys(mod).slice(0, 20),
            hasFns: expectFns.split(',').filter(function(fn) { return typeof mod[fn] === 'function'; })
          };
        }
      } catch (e) {
        info.emberUtils[modName] = { loaded: false, error: e.message };
      }
    }

    // --- 5. Try to find the Ember app instance via requirejs ---
    info.appSearch = {};
    if (typeof requirejs !== 'undefined') {
      var entries2 = requirejs.entries || {};
      // Look for app module patterns
      var appModules = Object.keys(entries2).filter(function(m) {
        return m.match(/\/app$/) || m.match(/\/application\//) || m.match(/instance-initializer/);
      }).slice(0, 20);
      info.appSearch.appModules = appModules;

      // Look for the main app by checking common LinkedIn Ember app names
      var appNames = ['voyager-web', 'linkedin-voyager-web', 'ember-app'];
      for (var an = 0; an < appNames.length; an++) {
        try {
          var appMod = requirejs(appNames[an] + '/app');
          if (appMod) {
            info.appSearch.foundApp = appNames[an];
            info.appSearch.appKeys = Object.keys(appMod).slice(0, 20);
            break;
          }
        } catch (e) {}
      }
    }

    // --- 6. Inspect .sortable-item elements ---
    info.sortableItems = [];
    var items = document.querySelectorAll('.sortable-item');
    for (var si = 0; si < items.length; si++) {
      var item = items[si];
      var iAttrs = [];
      for (var ia = 0; ia < item.attributes.length; ia++) {
        iAttrs.push(item.attributes[ia].name + '=' + item.attributes[ia].value.substring(0, 50));
      }
      info.sortableItems.push({
        tag: item.tagName,
        class: (item.className || '').toString().substring(0, 100),
        attrs: iAttrs,
        childCount: item.children.length,
        draggable: item.draggable,
        objKeyCount: Object.keys(item).length,
        emberKeys: Object.keys(item).filter(function(k) {
          return k.indexOf('ember') >= 0 || k.indexOf('glimmer') >= 0;
        })
      });
    }

    result.data = info;
  }

  // ---- EMBER EXPLORATION ----
  // Comprehensive diagnostic that inspects the Ember.js framework internals
  // to understand how the game's sortable list is managed.
  //
  // Ember apps store metadata on DOM elements via special properties:
  //   __ember_meta__       : Core metadata (classic Ember)
  //   __emberXXXXXXXXXX    : View GUID references (random hex suffix)
  //   __glimmerXXXXXXXX    : Glimmer VM metadata (Octane/modern Ember)
  //
  // Ember also uses AMD modules (requirejs) — we can inspect the module registry
  // to find sortable/drag-related modules that reveal which addon is used.
  //
  // The goal is to find the component managing the sortable list so we can
  // directly call its reorder action or mutate its backing array.

  function emberExplore(result) {
    var info = {};

    // --- 1. Global Ember object ---
    info.hasEmber = typeof Ember !== 'undefined';
    if (info.hasEmber) {
      info.emberVersion = typeof Ember.VERSION === 'string' ? Ember.VERSION : 'unknown';
      info.hasRun = typeof Ember.run === 'function';
      info.hasGetOwner = typeof Ember.getOwner === 'function';

      // Ember.Namespace.NAMESPACES lists all Ember apps on the page
      try {
        info.namespaces = [];
        var ns = (Ember.Namespace && Ember.Namespace.NAMESPACES) || [];
        for (var i = 0; i < ns.length; i++) {
          info.namespaces.push(String(ns[i]));
        }
      } catch (e) { info.namespaceError = e.message; }

      // Application instances
      try {
        info.applications = [];
        var apps = (Ember.Application && Ember.Application.NAMESPACES) || [];
        for (var a = 0; a < apps.length; a++) {
          info.applications.push({
            name: String(apps[a]),
            rootElement: apps[a].rootElement || 'unknown'
          });
        }
      } catch (e) { info.appError = e.message; }

      // View registry (available in Ember <= 3.x, removed in 4.x)
      try {
        if (Ember.View && Ember.View.views) {
          info.viewCount = Object.keys(Ember.View.views).length;
        }
      } catch (e) {}
    }

    // --- 2. AMD module registry (requirejs) ---
    // Ember CLI apps use AMD modules. Searching the registry reveals which
    // sortable/drag addon the game uses (ember-sortable, ember-drag-sort, etc.)
    info.moduleRegistry = { available: false };
    try {
      if (typeof requirejs !== 'undefined') {
        info.moduleRegistry.available = true;
        var entries = requirejs.entries || requirejs._eak_seen || {};
        var allModules = Object.keys(entries);
        info.moduleRegistry.totalModules = allModules.length;
        info.moduleRegistry.relevantModules = allModules.filter(function(m) {
          return m.indexOf('sort') >= 0 || m.indexOf('drag') >= 0 ||
                 m.indexOf('crossclimb') >= 0 || m.indexOf('reorder') >= 0 ||
                 m.indexOf('games') >= 0;
        }).slice(0, 40);
      }
    } catch (e) { info.moduleRegistry.error = e.message; }

    // --- 3. Walk DOM elements for Ember/Glimmer metadata ---
    var container = document.querySelector('.crossclimb__guess__container');
    info.domWalk = { containerFound: !!container, elementsWithMeta: [] };

    if (container) {
      var searchEls = [];

      // Check ancestors up 10 levels (the component may wrap the container)
      var anc = container;
      for (var lvl = 0; lvl < 10 && anc && anc !== document.documentElement; lvl++) {
        searchEls.push({ el: anc, source: 'ancestor-' + lvl });
        anc = anc.parentElement;
      }

      // Check all descendants (rows, handles, inputs, etc.)
      var childNodes = container.querySelectorAll('*');
      for (var c = 0; c < Math.min(childNodes.length, 150); c++) {
        searchEls.push({ el: childNodes[c], source: 'descendant' });
      }

      for (var s = 0; s < searchEls.length; s++) {
        var el = searchEls[s].el;
        var elKeys = Object.keys(el);
        var metaKeys = [];
        for (var ki = 0; ki < elKeys.length; ki++) {
          var key = elKeys[ki];
          if (key.indexOf('__ember') === 0 || key.indexOf('__glimmer') === 0 ||
              key.indexOf('_ember') === 0) {
            metaKeys.push(key);
          }
        }

        if (metaKeys.length > 0) {
          var entry = {
            tag: el.tagName,
            class: (el.className || '').toString().substring(0, 100),
            id: el.id || '',
            source: searchEls[s].source,
            metaKeys: metaKeys
          };

          // Extract what we can from the Ember metadata
          for (var mk = 0; mk < metaKeys.length; mk++) {
            try {
              var metaVal = el[metaKeys[mk]];
              if (metaVal && typeof metaVal === 'object') {
                if (metaVal._view) entry.hasView = true;
                if (metaVal.component) entry.hasComponent = true;
                if (metaVal.source) entry.metaSource = String(metaVal.source).substring(0, 80);
                if (metaVal._debugContainerKey) entry.containerKey = metaVal._debugContainerKey;
                // List the metadata object's own keys for further inspection
                entry.metaObjKeys = Object.keys(metaVal).slice(0, 20);
              }
            } catch (e) {}
          }
          info.domWalk.elementsWithMeta.push(entry);
        }
      }
    }

    // --- 4. Inspect drag handle elements specifically ---
    info.dragHandles = [];
    var draggers = document.querySelectorAll('.crossclimb__guess-dragger');
    for (var d = 0; d < draggers.length; d++) {
      var dragger = draggers[d];
      var dKeys = Object.keys(dragger);
      var dEmber = dKeys.filter(function(k) {
        return k.indexOf('ember') >= 0 || k.indexOf('glimmer') >= 0;
      });
      // Collect all HTML attributes (some Ember addons use data-* attributes)
      var dAttrs = [];
      for (var ai = 0; ai < dragger.attributes.length; ai++) {
        dAttrs.push(dragger.attributes[ai].name + '=' + dragger.attributes[ai].value.substring(0, 40));
      }
      info.dragHandles.push({
        index: d,
        tag: dragger.tagName,
        emberKeys: dEmber,
        attributes: dAttrs,
        parentClass: (dragger.parentElement ? dragger.parentElement.className || '' : '').substring(0, 80),
        totalObjKeys: dKeys.length
      });
    }

    // --- 5. Check for sortable addon patterns ---
    info.addonPatterns = {};
    // ember-sortable classes/attributes
    info.addonPatterns.sortableItems = document.querySelectorAll('.sortable-item, [data-sortable-item]').length;
    info.addonPatterns.sortableGroup = document.querySelectorAll('.sortable-group, [data-sortable-group]').length;
    // ember-drag-sort
    info.addonPatterns.dragSortItems = document.querySelectorAll('[data-drag-sort]').length;
    // Classic Ember action bindings ({{action}}) add data-ember-action-* attributes
    info.addonPatterns.emberActions = document.querySelectorAll('[data-ember-action]').length;
    // ARIA drag attributes
    info.addonPatterns.ariaGrabbed = document.querySelectorAll('[aria-grabbed]').length;
    info.addonPatterns.ariaDrop = document.querySelectorAll('[aria-dropeffect]').length;

    // --- 6. Try accessing the Ember owner (DI container) from DOM elements ---
    // Ember.getOwner() returns the application's dependency injection container
    // from any Ember object (component, service, etc.). From there we can look up
    // any registered service or component by name.
    if (typeof Ember !== 'undefined' && Ember.getOwner && container) {
      try {
        var searchEl2 = container;
        for (var oi = 0; oi < 15 && searchEl2; oi++) {
          var ownerKeys = Object.keys(searchEl2);
          for (var ok = 0; ok < ownerKeys.length; ok++) {
            if (ownerKeys[ok].indexOf('__ember') === 0) {
              var viewRef = searchEl2[ownerKeys[ok]];
              if (viewRef) {
                // Try to get owner from various possible references
                var targets = [viewRef, viewRef._view, viewRef.component];
                for (var ti = 0; ti < targets.length; ti++) {
                  if (targets[ti]) {
                    try {
                      var owner = Ember.getOwner(targets[ti]);
                      if (owner) {
                        info.ownerFound = true;
                        info.ownerElement = {
                          tag: searchEl2.tagName,
                          class: (searchEl2.className || '').toString().substring(0, 80),
                          level: oi,
                          viaPath: ti === 0 ? 'direct' : ti === 1 ? '_view' : 'component'
                        };
                        // Try to look up game-related factories
                        info.lookupResults = [];
                        var lookupNames = [
                          'component:crossclimb-grid', 'component:sortable-group',
                          'component:crossclimb-guess', 'component:drag-sort-list',
                          'service:game', 'service:crossclimb', 'controller:crossclimb'
                        ];
                        for (var ln = 0; ln < lookupNames.length; ln++) {
                          try {
                            var found = owner.lookup(lookupNames[ln]);
                            if (found) {
                              info.lookupResults.push(lookupNames[ln] + ': FOUND');
                            }
                          } catch (e2) {}
                        }
                      }
                    } catch (e3) {}
                  }
                }
              }
            }
          }
          if (info.ownerFound) break;
          searchEl2 = searchEl2.parentElement;
        }
      } catch (e) { info.ownerError = e.message; }
    }

    result.data = info;
  }

  // ---- EMBER REORDER ----
  // Attempts to find and directly manipulate the Ember component's model
  // to achieve the target row order. This bypasses the DOM entirely and
  // goes straight to the framework's data layer.

  function emberReorder(targetWords, result) {
    var container = document.querySelector('.crossclimb__guess__container');
    if (!container) {
      result.ok = false;
      result.error = 'no container';
      return;
    }

    result.strategies = [];

    // --- Strategy 1: Find Ember component via DOM element metadata ---
    // Walk from the container upward through ancestors, checking each element
    // for __ember* properties that reference an Ember view or component.
    var component = null;
    var componentKey = null;

    var searchEl = container;
    for (var lvl = 0; lvl < 15 && searchEl && searchEl !== document.documentElement; lvl++) {
      var keys = Object.keys(searchEl);
      for (var ki = 0; ki < keys.length; ki++) {
        if (keys[ki].indexOf('__ember') === 0) {
          var ref = searchEl[keys[ki]];
          if (ref) {
            var comp = ref._view || ref.component || ref;
            // Check if this looks like a component (has properties like 'model', 'items', etc.)
            if (comp && typeof comp === 'object') {
              var compKeys = Object.keys(comp);
              var hasModel = compKeys.some(function(k) {
                return k === 'model' || k === 'items' || k === 'sortableItems' ||
                       k === 'content' || k === 'list' || k === 'guesses';
              });
              if (hasModel) {
                component = comp;
                componentKey = keys[ki] + (ref._view ? '._view' : ref.component ? '.component' : '');
                result.strategies.push('found-model-component-level-' + lvl);
                break;
              }
              // Even without a model prop, save the first component we find
              if (!component && compKeys.length > 5) {
                component = comp;
                componentKey = keys[ki];
              }
            }
          }
        }
      }
      if (componentKey && component) break;
      searchEl = searchEl.parentElement;
    }

    if (component) {
      result.componentFound = true;
      result.componentKey = componentKey;

      // List component properties for debugging
      try {
        result.componentProps = Object.keys(component).slice(0, 60);
      } catch (e) {}

      // Try to find and reorder the backing array
      var arrayProps = ['model', 'items', 'sortableItems', 'content', 'list',
                        'guesses', 'rows', 'children', 'arrangedContent'];
      for (var pi = 0; pi < arrayProps.length; pi++) {
        var propName = arrayProps[pi];
        try {
          var propVal = component.get ? component.get(propName) : component[propName];
          if (!propVal) continue;

          var arr = propVal.toArray ? propVal.toArray() : (Array.isArray(propVal) ? propVal : null);
          if (!arr || arr.length === 0) continue;

          result.strategies.push('found-array: ' + propName + ' len=' + arr.length);

          // Build word → item mapping
          var itemMap = {};
          for (var ii = 0; ii < arr.length; ii++) {
            var item = arr[ii];
            var word = '';
            if (typeof item === 'string') {
              word = item.toUpperCase();
            } else if (item.get) {
              word = (item.get('word') || item.get('answer') || item.get('text') || item.get('value') || '').toUpperCase();
            } else {
              word = (item.word || item.answer || item.text || item.value || '').toUpperCase();
            }
            if (word) itemMap[word] = item;
          }

          // Reorder the array
          var newOrder = [];
          for (var ti = 0; ti < targetWords.length; ti++) {
            if (itemMap[targetWords[ti]]) {
              newOrder.push(itemMap[targetWords[ti]]);
            }
          }

          if (newOrder.length === arr.length) {
            // Apply via Ember's MutableArray.replace() if available (triggers observers)
            if (propVal.replace && typeof propVal.replace === 'function') {
              propVal.replace(0, propVal.length, newOrder);
              result.strategies.push('reordered-via-mutablearray-replace');
              result.reordered = true;
            } else if (component.set) {
              component.set(propName, newOrder);
              result.strategies.push('reordered-via-component-set');
              result.reordered = true;
            }
            break;
          } else {
            result.strategies.push('word-match: ' + newOrder.length + '/' + arr.length);
          }
        } catch (e) {
          result.strategies.push('array-error-' + propName + ': ' + e.message);
        }
      }

      // Try calling known action names
      var actionNames = ['reorderItems', 'onReorder', 'updateSort', 'sortEndAction',
                         'onChange', '_updateItems', 'update', 'onSortEnd'];
      for (var ai = 0; ai < actionNames.length; ai++) {
        try {
          var action = component.get ? component.get(actionNames[ai]) : component[actionNames[ai]];
          if (typeof action === 'function') {
            result.strategies.push('found-action: ' + actionNames[ai]);
          }
        } catch (e) {}
      }
    } else {
      result.componentFound = false;
      result.strategies.push('no-component-found-in-dom-walk');
    }

    // --- Strategy 2: Use requirejs to load and inspect sortable modules ---
    if (typeof requirejs !== 'undefined') {
      try {
        var entries = requirejs.entries || {};
        var sortModules = Object.keys(entries).filter(function(m) {
          return m.indexOf('sort') >= 0 || m.indexOf('drag') >= 0;
        });
        if (sortModules.length > 0) {
          result.strategies.push('requirejs-modules: ' + sortModules.slice(0, 10).join(', '));
        }
      } catch (e) {}
    }

    // --- Strategy 3: DOM reorder + Ember notification ---
    // If we couldn't find the component's model, fall back to DOM reorder
    // and try to trigger Ember's change detection via property notifications.
    if (!result.reordered) {
      try {
        var middleRows = container.querySelectorAll('.crossclimb__guess--middle');
        var rowArr = Array.prototype.slice.call(middleRows);
        rowArr.sort(function(a, b) { return a.getBoundingClientRect().top - b.getBoundingClientRect().top; });

        var wordMap = {};
        for (var wi = 0; wi < rowArr.length; wi++) {
          var inputs = rowArr[wi].querySelectorAll('.crossclimb__guess_box input');
          var w = '';
          for (var ij = 0; ij < inputs.length; ij++) w += (inputs[ij].value || '').toUpperCase();
          wordMap[w] = rowArr[wi];
        }

        var moved = 0;
        for (var mi = 0; mi < targetWords.length; mi++) {
          var targetEl = wordMap[targetWords[mi]];
          if (!targetEl) continue;
          var currentRows = Array.prototype.slice.call(container.querySelectorAll('.crossclimb__guess--middle'));
          currentRows.sort(function(a, b) { return a.getBoundingClientRect().top - b.getBoundingClientRect().top; });
          if (mi < currentRows.length && currentRows[mi] !== targetEl) {
            container.insertBefore(targetEl, currentRows[mi]);
            moved++;
          }
        }
        result.domMoved = moved;

        // Try Ember.run + notifyPropertyChange to trigger observers
        if (typeof Ember !== 'undefined' && Ember.run) {
          Ember.run(function() {
            try {
              if (Ember.notifyPropertyChange) {
                // Walk elements looking for something to notify
                var notifyTargets = [container, container.parentElement];
                for (var nt = 0; nt < notifyTargets.length; nt++) {
                  if (!notifyTargets[nt]) continue;
                  var ntKeys = Object.keys(notifyTargets[nt]);
                  for (var nk = 0; nk < ntKeys.length; nk++) {
                    if (ntKeys[nk].indexOf('__ember') === 0) {
                      var obj = notifyTargets[nt][ntKeys[nk]];
                      var notifyTarget = obj && (obj._view || obj.component || obj);
                      if (notifyTarget) {
                        Ember.notifyPropertyChange(notifyTarget, 'model');
                        Ember.notifyPropertyChange(notifyTarget, 'items');
                        Ember.notifyPropertyChange(notifyTarget, 'arrangedContent');
                        result.strategies.push('notified-property-change');
                      }
                    }
                  }
                }
              }
            } catch (e) {
              result.strategies.push('notify-error: ' + e.message);
            }
          });
        }

        result.strategies.push('dom-reorder-fallback: moved=' + moved);
      } catch (e) {
        result.strategies.push('dom-reorder-error: ' + e.message);
      }
    }
  }

  // ---- READ BOARD ORDER ----
  // Reads the current row order by visual position (y-coordinate), NOT DOM order.
  // The game may reorder rows visually via CSS transforms without moving DOM elements,
  // so we must sort by getBoundingClientRect().top to get the true visual order.
  // Also re-tags rows with data-cs-row in visual order so subsequent drag selectors
  // target the correct elements.

  function readBoardOrder() {
    // The middle rows live inside an <ol class="crossclimb__guess__container">
    var container = document.querySelector('.crossclimb__guess__container');
    if (!container) {
      // Fallback: find rows inside the grid
      container = document.querySelector('.crossclimb__grid');
    }
    if (!container) return { error: 'no container found' };

    var rawRows = [];
    var children = container.querySelectorAll('.crossclimb__guess--middle');
    for (var i = 0; i < children.length; i++) {
      var row = children[i];
      var inputs = row.querySelectorAll('.crossclimb__guess_box input');
      var word = '';
      for (var j = 0; j < inputs.length; j++) {
        word += (inputs[j].value || '').toUpperCase();
      }
      rawRows.push({
        el: row,
        word: word,
        y: Math.round(row.getBoundingClientRect().top)
      });
    }

    // Sort by visual position (y-coordinate) — critical for correct reordering
    rawRows.sort(function(a, b) { return a.y - b.y; });

    // Re-tag rows with data-cs-row in visual order so drag selectors stay correct
    var rows = [];
    for (var k = 0; k < rawRows.length; k++) {
      rawRows[k].el.setAttribute('data-cs-row', String(k));
      rows.push({
        word: rawRows[k].word,
        csRow: String(k),
        y: rawRows[k].y
      });
    }

    return { rows: rows };
  }

  // ---- UTILITIES ----

  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      for (var k in src) {
        if (src.hasOwnProperty(k)) target[k] = src[k];
      }
    }
    return target;
  }

  function rectStr(el) {
    var r = el.getBoundingClientRect();
    return Math.round(r.width) + 'x' + Math.round(r.height) + '@' + Math.round(r.left) + ',' + Math.round(r.top);
  }

  console.log('[CrossclimbSolver] Page bridge v4 ready (capture bypass + HTML5 DnD + Ember v2)');
})();
