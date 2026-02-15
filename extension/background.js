// CrossclimbSolver - Background Service Worker
// Handles cross-origin fetching from crossclimbanswer.io
// Content scripts can't fetch cross-origin, so they message us to do it.

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
