// Copyright 2025 mcarthey
// SPDX-License-Identifier: Apache-2.0
//
// CrossclimbSolver - Background Service Worker
// Handles cross-origin fetching from crossclimbanswer.io and trusted drag via debugger API.
// Content scripts can't fetch cross-origin, so they message us to do it.
// The debugger API produces isTrusted:true input events that React/Ember state machines accept.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FETCH_ANSWERS') {
    handleFetchAnswers(message.puzzleNumber)
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep channel open for async response
  }

  if (message.type === 'FETCH_LATEST') {
    handleFetchLatest()
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'DEBUGGER_DRAG') {
    handleDebuggerDrag(sender.tab?.id, message)
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  // Broadcast a message to all frames in the sender's tab
  if (message.type === 'BROADCAST_TO_FRAMES') {
    if (sender.tab?.id) {
      chrome.tabs.sendMessage(sender.tab.id, message.payload, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse(null);
        } else {
          sendResponse(response);
        }
      });
      return true;
    }
    sendResponse(null);
    return;
  }

  // Relay GAME_FRAME_READY to the top frame
  if (message.type === 'GAME_FRAME_READY') {
    if (sender.tab?.id) {
      console.log('[CrossclimbSolver BG] Game frame ready in tab', sender.tab.id, message);
    }
    return;
  }
});

// ----- DEBUGGER DRAG -----
// Uses Chrome DevTools Protocol Input.dispatchMouseEvent to produce trusted
// pointer/mouse events. These have isTrusted:true and trigger setPointerCapture,
// React/Ember state transitions, and all other native browser behaviors.
//
// The sequence mirrors a real user drag:
//   1. mousePressed at source center
//   2. Series of mouseMoved events tracing a path to the target
//   3. mouseReleased at target center

async function handleDebuggerDrag(tabId, message) {
  if (!tabId) throw new Error('No tab ID available');

  const { startX, startY, endX, endY, steps = 20, stepDelay = 16, pauseAfterPress = 150 } = message;
  if (typeof startX !== 'number' || typeof startY !== 'number' ||
      typeof endX !== 'number' || typeof endY !== 'number') {
    throw new Error('Missing coordinates: startX, startY, endX, endY required');
  }

  const debugTarget = { tabId };

  // Attach debugger (user will see the "debugging" banner on first attach)
  try {
    await chrome.debugger.attach(debugTarget, '1.3');
  } catch (e) {
    // Already attached is fine
    if (!e.message?.includes('Already attached')) {
      throw new Error('Debugger attach failed: ' + e.message);
    }
  }

  try {
    // Helper to send a CDP Input.dispatchMouseEvent
    const dispatch = (type, x, y, extra = {}) => {
      return chrome.debugger.sendCommand(debugTarget, 'Input.dispatchMouseEvent', {
        type,
        x: Math.round(x),
        y: Math.round(y),
        button: 'left',
        clickCount: type === 'mousePressed' ? 1 : 0,
        pointerType: 'mouse',
        ...extra,
      });
    };

    // Step 1: Press at source
    await dispatch('mousePressed', startX, startY, { buttons: 1 });
    await sleep(pauseAfterPress);

    // Step 2: Move in incremental steps with easing
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      // Ease in-out quadratic for natural movement
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const cx = startX + (endX - startX) * eased;
      const cy = startY + (endY - startY) * eased;
      await dispatch('mouseMoved', cx, cy, { buttons: 1 });
      await sleep(stepDelay);
    }

    // Step 3: Release at target
    await dispatch('mouseReleased', endX, endY);

    return { dragged: true, from: { x: startX, y: startY }, to: { x: endX, y: endY } };

  } finally {
    // Always detach to remove the debugging banner
    try {
      await chrome.debugger.detach(debugTarget);
    } catch { /* already detached */ }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fetch the homepage to discover the latest puzzle number
async function handleFetchLatest() {
  const response = await fetch('https://crossclimbanswer.io/');
  if (!response.ok) {
    throw new Error(`Homepage fetch failed: ${response.status}`);
  }
  const html = await response.text();

  // Extract the latest puzzle number from links like /crossclimb-654/
  const matches = [...html.matchAll(/crossclimb-(\d+)/g)];
  if (matches.length === 0) {
    throw new Error('Could not find any puzzle numbers on homepage');
  }

  // Get the highest puzzle number (latest)
  const puzzleNumbers = matches.map(m => parseInt(m[1], 10));
  const latest = Math.max(...puzzleNumbers);

  return { puzzleNumber: latest, homepageHtml: html };
}

// Fetch a specific puzzle's answer page
async function handleFetchAnswers(puzzleNumber) {
  const url = `https://crossclimbanswer.io/linkedin-crossclimb-answer/crossclimb-${puzzleNumber}/`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Puzzle page fetch failed: ${response.status}`);
  }
  const html = await response.text();
  return { html, puzzleNumber, url };
}
