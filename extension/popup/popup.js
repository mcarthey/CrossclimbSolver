// CrossclimbSolver - Extension Popup

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const puzzlePreview = document.getElementById('puzzlePreview');
const puzzleValue = document.getElementById('puzzleValue');
const solveBtn = document.getElementById('solveBtn');
const inspectBtn = document.getElementById('inspectBtn');
const toggleBtn = document.getElementById('toggleBtn');

// Check if we're on the Crossclimb page
async function checkStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (tab && tab.url && tab.url.includes('linkedin.com/games/crossclimb')) {
      statusDot.classList.add('active');
      statusText.textContent = 'Connected to Crossclimb page';
      solveBtn.disabled = false;

      // Try to get puzzle data from the content script
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' });
        if (response && response.puzzleData) {
          puzzlePreview.style.display = 'block';
          const ladder = response.puzzleData.wordLadder;
          puzzleValue.textContent = `#${response.puzzleData.puzzleNumber}: ${ladder[0]} → ${ladder[ladder.length - 1]}`;
        }
      } catch {
        // Content script might not be ready yet
      }
    } else {
      statusDot.classList.add('inactive');
      statusText.textContent = 'Not on Crossclimb page';
      solveBtn.disabled = true;
    }
  } catch {
    statusDot.classList.add('inactive');
    statusText.textContent = 'Cannot access tab';
    solveBtn.disabled = true;
  }
}

// Send a command to the content script
async function sendCommand(command) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    await chrome.tabs.sendMessage(tab.id, { type: command });
  } catch (error) {
    console.error('Failed to send command:', error);
    statusText.textContent = 'Error: ' + error.message;
  }
}

// Button handlers
solveBtn.addEventListener('click', async () => {
  solveBtn.disabled = true;
  solveBtn.textContent = 'Solving...';
  await sendCommand('SOLVE');
  // Close popup after triggering solve
  setTimeout(() => window.close(), 500);
});

inspectBtn.addEventListener('click', async () => {
  await sendCommand('INSPECT');
  statusText.textContent = 'Inspection running... check console';
});

toggleBtn.addEventListener('click', async () => {
  await sendCommand('TOGGLE_OVERLAY');
});

// Listen for messages from content script in main.js
// (Add message listener to content/main.js to handle these popup commands)

// Initialize
checkStatus();
