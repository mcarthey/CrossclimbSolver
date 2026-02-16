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
    var pp = { pointerId: 1, pointerType: 'mouse', isPrimary: true };

    srcEl.dispatchEvent(new PointerEvent('pointerdown', assign({ clientX: sx, clientY: sy, bubbles: true, cancelable: true }, pp)));
    srcEl.dispatchEvent(new MouseEvent('mousedown', { clientX: sx, clientY: sy, bubbles: true, cancelable: true }));

    var step = 0, steps = 20;
    function dragStep() {
      step++;
      if (step > steps) {
        srcEl.dispatchEvent(new PointerEvent('pointerup', assign({ clientX: ex, clientY: ey, bubbles: true, cancelable: true }, pp)));
        document.dispatchEvent(new PointerEvent('pointerup', assign({ clientX: ex, clientY: ey, bubbles: true, cancelable: true }, pp)));
        srcEl.dispatchEvent(new MouseEvent('mouseup', { clientX: ex, clientY: ey, bubbles: true, cancelable: true }));
        document.dispatchEvent(new MouseEvent('mouseup', { clientX: ex, clientY: ey, bubbles: true, cancelable: true }));
        window.postMessage(result, '*');
        return;
      }
      var t = step / steps;
      var e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      var cx = sx + (ex - sx) * e, cy = sy + (ey - sy) * e;
      srcEl.dispatchEvent(new PointerEvent('pointermove', assign({ clientX: cx, clientY: cy, bubbles: true, cancelable: true }, pp)));
      document.dispatchEvent(new PointerEvent('pointermove', assign({ clientX: cx, clientY: cy, bubbles: true, cancelable: true }, pp)));
      srcEl.dispatchEvent(new MouseEvent('mousemove', { clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
      setTimeout(dragStep, 16);
    }
    setTimeout(dragStep, 150);
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

  console.log('[CrossclimbSolver] Page bridge v2 ready');
})();
