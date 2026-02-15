// CrossclimbSolver - Page-Context Bridge
// This file runs in the PAGE's JavaScript context (not the content script's isolated world).
// It receives commands via window.postMessage from the content script and dispatches
// events that the page's Ember.js framework can see.
//
// Loaded via <script src="chrome-extension://..."> to bypass CSP restrictions on inline scripts.

(function() {
  'use strict';

  if (window.__csBridge) return;
  window.__csBridge = true;

  window.addEventListener('message', function(evt) {
    if (evt.source !== window || !evt.data || evt.data.src !== 'cs-cmd') return;

    var d = evt.data;
    var result = { src: 'cs-ack', id: d.id, ok: true };

    try {
      if (d.action === 'type-key') {
        typeOneKey(d.key);
      }
      else if (d.action === 'type-word') {
        typeWordAsync(d.word, result);
        return; // ack sent when done
      }
      else if (d.action === 'click') {
        var el = document.querySelector(d.selector);
        if (el) {
          var rect = el.getBoundingClientRect();
          var cx = rect.left + rect.width / 2;
          var cy = rect.top + rect.height / 2;
          // Full pointer+mouse+click sequence for Ember
          el.dispatchEvent(new PointerEvent('pointerdown', { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
          el.dispatchEvent(new MouseEvent('mousedown', { clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
          el.dispatchEvent(new PointerEvent('pointerup', { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
          el.dispatchEvent(new MouseEvent('mouseup', { clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent('click', { clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
          el.focus();
        } else {
          result.ok = false;
          result.error = 'not found: ' + d.selector;
        }
      }
      else if (d.action === 'focus') {
        var fel = document.querySelector(d.selector);
        if (fel) { fel.focus(); } else { result.ok = false; result.error = 'not found'; }
      }
      else if (d.action === 'drag') {
        doDragAsync(d.srcSel, d.tgtSel, result);
        return; // ack sent when done
      }
      else if (d.action === 'ping') {
        // Simple connectivity check
        result.pong = true;
      }
    } catch (err) {
      result.ok = false;
      result.error = err.message;
    }

    window.postMessage(result, '*');
  });

  // --- Helpers ---

  function typeOneKey(key) {
    var code = 'Key' + key.toUpperCase();
    var kc = key.toUpperCase().charCodeAt(0);
    var props = {
      key: key, code: code, keyCode: kc, which: kc,
      bubbles: true, cancelable: true, composed: true
    };
    var targets = [document.activeElement, document];
    for (var i = 0; i < targets.length; i++) {
      if (!targets[i]) continue;
      targets[i].dispatchEvent(new KeyboardEvent('keydown', props));
      targets[i].dispatchEvent(new KeyboardEvent('keypress', props));
      targets[i].dispatchEvent(new KeyboardEvent('keyup', props));
    }
  }

  function typeWordAsync(word, result) {
    var idx = 0;
    function next() {
      if (idx >= word.length) {
        window.postMessage(result, '*');
        return;
      }
      typeOneKey(word[idx]);
      idx++;
      setTimeout(next, 80);
    }
    next();
  }

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

    // Start drag
    srcEl.dispatchEvent(new PointerEvent('pointerdown', assign({ clientX: sx, clientY: sy, bubbles: true, cancelable: true }, pp)));
    srcEl.dispatchEvent(new MouseEvent('mousedown', { clientX: sx, clientY: sy, bubbles: true, cancelable: true }));

    var step = 0, steps = 20;
    function dragStep() {
      step++;
      if (step > steps) {
        // Release
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

  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      for (var k in src) {
        if (src.hasOwnProperty(k)) target[k] = src[k];
      }
    }
    return target;
  }

  console.log('[CrossclimbSolver] Page bridge ready (file-based)');
})();
