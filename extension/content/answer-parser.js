// CrossclimbSolver - Answer Parser
// Parses HTML from crossclimbanswer.io to extract puzzle solutions
//
// The site is a Next.js React app. The most reliable data source is the
// __NEXT_DATA__ JSON embedded in a <script> tag. Fallback strategies parse
// the rendered HTML directly.

const AnswerParser = {
  // Parse the answer page HTML and return structured puzzle data
  parse(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const result = {
      wordLadder: [],
      clueAnswerPairs: [],
      startWord: null,
      endWord: null,
      puzzleNumber: null,
      theme: null
    };

    // Strategy 1 (best): Extract from __NEXT_DATA__ JSON
    const nextData = this._extractNextData(doc);
    if (nextData) {
      console.log('[CrossclimbSolver] Found __NEXT_DATA__, extracting structured data');
      this._parseFromNextData(nextData, result);
    }

    // Strategy 2: Parse from rendered HTML if __NEXT_DATA__ didn't yield results
    if (result.wordLadder.length < 7) {
      console.log('[CrossclimbSolver] Falling back to HTML parsing');
      const htmlLadder = this._extractWordLadderFromHTML(doc);
      if (htmlLadder.length > result.wordLadder.length) {
        result.wordLadder = htmlLadder;
      }
    }

    if (result.clueAnswerPairs.length < 5) {
      const htmlPairs = this._extractClueAnswerPairsFromHTML(doc);
      if (htmlPairs.length > result.clueAnswerPairs.length) {
        result.clueAnswerPairs = htmlPairs;
      }
    }

    // Strategy 3: Brute-force scan all text for uppercase words and build ladder
    if (result.wordLadder.length < 7) {
      console.log('[CrossclimbSolver] Falling back to text scan');
      const textLadder = this._extractWordLadderFromText(doc);
      if (textLadder.length > result.wordLadder.length) {
        result.wordLadder = textLadder;
      }
    }

    // If we have clue-answer pairs but no full ladder, reconstruct the ladder
    if (result.wordLadder.length < 7 && result.clueAnswerPairs.length === 5) {
      console.log('[CrossclimbSolver] Attempting to reconstruct ladder from answers');
      const reconstructed = this._reconstructLadder(result.clueAnswerPairs.map(p => p.answer), result.startWord, result.endWord);
      if (reconstructed.length >= result.wordLadder.length) {
        result.wordLadder = reconstructed;
      }
    }

    // Derive start/end words from the ladder
    if (result.wordLadder.length >= 2) {
      result.startWord = result.startWord || result.wordLadder[0];
      result.endWord = result.endWord || result.wordLadder[result.wordLadder.length - 1];
    }

    // Extract puzzle number if not already found
    if (!result.puzzleNumber) {
      result.puzzleNumber = this._extractPuzzleNumber(doc);
    }

    // Validate
    this._validate(result);

    console.log('[CrossclimbSolver] Parsed result:', JSON.stringify(result, null, 2));
    return result;
  },

  // ----- STRATEGY 1: __NEXT_DATA__ -----

  _extractNextData(doc) {
    const script = doc.querySelector('script#__NEXT_DATA__');
    if (!script) return null;

    try {
      return JSON.parse(script.textContent);
    } catch (e) {
      console.warn('[CrossclimbSolver] Failed to parse __NEXT_DATA__:', e);
      return null;
    }
  },

  _parseFromNextData(nextData, result) {
    // Navigate the Next.js data structure to find puzzle content
    // The page props are typically at nextData.props.pageProps
    const pageProps = nextData?.props?.pageProps;
    if (!pageProps) return;

    // Search recursively for puzzle-related data
    const flatText = JSON.stringify(pageProps);

    // Extract puzzle number
    const numMatch = flatText.match(/"puzzleNumber"\s*:\s*(\d+)/) ||
                     flatText.match(/#(\d{3,4})/) ||
                     flatText.match(/crossclimb[- ](\d{3,4})/i);
    if (numMatch) {
      result.puzzleNumber = parseInt(numMatch[1], 10);
    }

    // Extract start/end words - look for "top"/"bottom" or similar fields
    const topMatch = flatText.match(/"top"\s*:\s*"([A-Z]{3,7})"/) ||
                     flatText.match(/"startWord"\s*:\s*"([A-Z]{3,7})"/);
    const bottomMatch = flatText.match(/"bottom"\s*:\s*"([A-Z]{3,7})"/) ||
                        flatText.match(/"endWord"\s*:\s*"([A-Z]{3,7})"/);
    if (topMatch) result.startWord = topMatch[1];
    if (bottomMatch) result.endWord = bottomMatch[1];

    // Extract all uppercase words from the data - these are answer candidates
    const allUpperWords = flatText.match(/\b[A-Z]{3,7}\b/g) || [];

    // Find the word ladder: sequence of same-length words differing by 1 letter
    const wordLength = result.startWord?.length || result.endWord?.length;
    const candidates = [...new Set(allUpperWords.filter(w =>
      w.length === wordLength && !['FAQ', 'CSS', 'SEO', 'URL', 'HTML', 'JSON', 'NEXT', 'GET', 'POST', 'HEAD', 'HTTP'].includes(w)
    ))];

    if (candidates.length >= 7) {
      const ladder = this._buildLadderFromCandidates(candidates, result.startWord, result.endWord);
      if (ladder.length >= 7) {
        result.wordLadder = ladder;
      }
    }

    // Extract clue-answer pairs from the JSON
    // Look for arrays of objects with clue/answer fields
    this._findClueAnswerPairsInObject(pageProps, result);
  },

  _findClueAnswerPairsInObject(obj, result, depth = 0) {
    if (depth > 10 || !obj || typeof obj !== 'object') return;

    // Check if this object looks like a clue-answer pair
    if (obj.clue && obj.answer) {
      result.clueAnswerPairs.push({
        clue: String(obj.clue).trim(),
        answer: String(obj.answer).toUpperCase().trim()
      });
      return;
    }

    // Recurse into arrays and objects
    if (Array.isArray(obj)) {
      for (const item of obj) {
        this._findClueAnswerPairsInObject(item, result, depth + 1);
      }
    } else {
      for (const value of Object.values(obj)) {
        this._findClueAnswerPairsInObject(value, result, depth + 1);
      }
    }
  },

  // ----- STRATEGY 2: HTML PARSING -----

  _extractWordLadderFromHTML(doc) {
    // The site shows the ladder as vertically stacked divs with Tailwind classes.
    // Start/end words use bg-primary, middle words use bg-muted.
    // Each word is in its own div with tracking-[0.3em] uppercase.

    // Strategy A: Find styled word divs (the vertical ladder display)
    // Look for a container with 7 children that are all uppercase words
    const allDivs = doc.querySelectorAll('div');
    for (const container of allDivs) {
      const children = container.children;
      if (children.length >= 7 && children.length <= 9) {
        const words = [];
        for (const child of children) {
          const text = child.textContent.trim();
          if (/^[A-Z]{3,7}$/.test(text)) {
            words.push(text);
          }
        }
        if (words.length >= 7 && this._isValidLadder(words)) {
          return words;
        }
      }
    }

    // Strategy B: Find uppercase words in sequence that form a valid ladder
    // Scan for elements with "uppercase" or "tracking" in their class (Tailwind)
    const styledEls = doc.querySelectorAll('[class*="uppercase"], [class*="tracking"]');
    const styledWords = [];
    for (const el of styledEls) {
      const text = el.textContent.trim();
      if (/^[A-Z]{3,7}$/.test(text) && !styledWords.includes(text)) {
        styledWords.push(text);
      }
    }
    if (styledWords.length >= 7 && this._isValidLadder(styledWords.slice(0, 7))) {
      return styledWords.slice(0, 7);
    }

    // Strategy C: Look for divs with specific Tailwind-like classes
    const ladderWords = [];
    doc.querySelectorAll('[class*="border"]').forEach(el => {
      const text = el.textContent.trim();
      if (/^[A-Z]{3,7}$/.test(text)) {
        ladderWords.push(text);
      }
    });

    // Deduplicate while preserving order
    const unique = [...new Set(ladderWords)];
    if (unique.length >= 7 && this._isValidLadder(unique.slice(0, 7))) {
      return unique.slice(0, 7);
    }

    return unique;
  },

  _extractClueAnswerPairsFromHTML(doc) {
    const pairs = [];

    // Strategy A: Find table with Clue/Answer columns
    const tables = doc.querySelectorAll('table');
    for (const table of tables) {
      const rows = table.querySelectorAll('tr');
      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 2) {
          const clueText = cells[0].textContent.trim();
          // Answer might be in a <strong> tag within the cell
          const answerEl = cells[1].querySelector('strong') || cells[1];
          const answerText = answerEl.textContent.trim().toUpperCase();

          if (clueText.length > 3 && /^[A-Z]{3,7}$/.test(answerText)) {
            pairs.push({ clue: clueText, answer: answerText });
          }
        }
      }
    }
    if (pairs.length >= 5) return pairs;

    // Strategy B: Look for <strong> tags with uppercase words near descriptive text
    const strongs = doc.querySelectorAll('strong');
    for (const strong of strongs) {
      const text = strong.textContent.trim().toUpperCase();
      if (/^[A-Z]{3,7}$/.test(text)) {
        // Look for adjacent clue text
        const parent = strong.closest('td, li, p, div');
        if (parent) {
          // Check previous sibling or parent for clue text
          const prevSibling = parent.previousElementSibling;
          if (prevSibling) {
            const clue = prevSibling.textContent.trim();
            if (clue.length > 5 && clue.length < 200) {
              pairs.push({ clue, answer: text });
            }
          }
        }
      }
    }

    // Strategy C: Look for patterns like "Clue text → ANSWER" or "ANSWER: Clue text"
    const allText = doc.body.textContent || '';
    const patternMatches = allText.matchAll(/([A-Z]{3,7})\s*[-–—:]\s*(.{5,80}?)(?:\n|$)/g);
    for (const match of patternMatches) {
      const word = match[1];
      const clue = match[2].trim();
      if (clue.length > 5 && !/[A-Z]{3,}/.test(clue)) {
        pairs.push({ clue, answer: word });
      }
    }

    return pairs;
  },

  // ----- STRATEGY 3: TEXT SCAN -----

  _extractWordLadderFromText(doc) {
    const allText = doc.body.textContent || '';

    // Find all uppercase words of the same length
    const allUpperWords = allText.match(/\b[A-Z]{3,7}\b/g) || [];

    // Filter out common non-answer words
    const skipWords = new Set([
      'FAQ', 'CSS', 'SEO', 'URL', 'HTML', 'JSON', 'NEXT', 'GET', 'POST',
      'HEAD', 'HTTP', 'API', 'THE', 'AND', 'FOR', 'ARE', 'BUT', 'NOT',
      'YOU', 'ALL', 'HER', 'WAS', 'ONE', 'OUR', 'OUT', 'HAS', 'HIS',
      'HOW', 'ITS', 'MAY', 'NEW', 'NOW', 'OLD', 'USE', 'WAY', 'WHO',
      'DID', 'HIM', 'LET', 'SAY', 'SHE', 'TOO', 'OWN', 'RSS'
    ]);

    // Group by word length and find the most common length
    const byLength = {};
    for (const w of allUpperWords) {
      if (skipWords.has(w)) continue;
      byLength[w.length] = byLength[w.length] || [];
      byLength[w.length].push(w);
    }

    // The puzzle word length is the one with the most unique words
    let bestLength = 0;
    let bestCount = 0;
    for (const [len, words] of Object.entries(byLength)) {
      const uniqueCount = new Set(words).size;
      if (uniqueCount > bestCount) {
        bestCount = uniqueCount;
        bestLength = parseInt(len);
      }
    }

    if (!bestLength) return [];

    // Get unique words of that length, in order of first appearance
    const seen = new Set();
    const candidates = [];
    for (const w of allUpperWords) {
      if (w.length === bestLength && !skipWords.has(w) && !seen.has(w)) {
        seen.add(w);
        candidates.push(w);
      }
    }

    // Try to find a valid 7-word ladder within these candidates
    return this._buildLadderFromCandidates(candidates);
  },

  // ----- LADDER CONSTRUCTION -----

  // Build a valid word ladder from candidate words
  _buildLadderFromCandidates(candidates, knownStart = null, knownEnd = null) {
    if (candidates.length < 7) return candidates;

    // If we know start and end, find a path between them
    if (knownStart && knownEnd) {
      const path = this._findPath(knownStart, knownEnd, candidates);
      if (path && path.length === 7) return path;
    }

    // Try every pair of candidates as start/end and find a 7-word path
    for (let i = 0; i < candidates.length; i++) {
      for (let j = 0; j < candidates.length; j++) {
        if (i === j) continue;
        const path = this._findPath(candidates[i], candidates[j], candidates);
        if (path && path.length === 7) return path;
      }
    }

    // Fall back to finding the longest valid chain
    return this._findLongestChain(candidates);
  },

  // BFS to find a path of exactly 7 words from start to end
  _findPath(start, end, wordPool) {
    if (start.length !== end.length) return null;

    const pool = new Set(wordPool);
    pool.add(start);
    pool.add(end);

    // BFS
    const queue = [[start]];
    const visited = new Set([start]);

    while (queue.length > 0) {
      const path = queue.shift();
      if (path.length > 7) continue;

      const last = path[path.length - 1];
      if (last === end && path.length === 7) return path;
      if (path.length >= 7) continue;

      for (const word of pool) {
        if (!visited.has(word) && this._differsByOneLetter(last, word)) {
          visited.add(word);
          queue.push([...path, word]);
        }
      }
    }

    return null;
  },

  // Find the longest chain of words differing by one letter
  _findLongestChain(words) {
    let bestChain = [];

    for (const startWord of words) {
      const chain = [startWord];
      const used = new Set([startWord]);

      let current = startWord;
      while (chain.length < words.length) {
        const next = words.find(w => !used.has(w) && this._differsByOneLetter(current, w));
        if (!next) break;
        chain.push(next);
        used.add(next);
        current = next;
      }

      if (chain.length > bestChain.length) {
        bestChain = chain;
      }
    }

    return bestChain;
  },

  // Reconstruct the full ladder given middle answers and start/end words
  _reconstructLadder(middleAnswers, startWord, endWord) {
    if (!startWord || !endWord) return middleAnswers;

    const allWords = [startWord, ...middleAnswers, endWord];
    const path = this._findPath(startWord, endWord, allWords);
    return path || allWords;
  },

  // ----- VALIDATION -----

  _isValidLadder(words) {
    if (words.length < 2) return false;
    for (let i = 0; i < words.length - 1; i++) {
      if (!this._differsByOneLetter(words[i], words[i + 1])) return false;
    }
    return true;
  },

  _differsByOneLetter(word1, word2) {
    if (word1.length !== word2.length) return false;
    let diffs = 0;
    for (let i = 0; i < word1.length; i++) {
      if (word1[i] !== word2[i]) diffs++;
      if (diffs > 1) return false;
    }
    return diffs === 1;
  },

  _extractPuzzleNumber(doc) {
    const text = doc.body.textContent || '';
    const match = text.match(/#\s*(\d{3,4})/) ||
                  text.match(/Crossclimb\s*#?\s*(\d{3,4})/i) ||
                  text.match(/Puzzle\s*#?\s*(\d{3,4})/i);
    return match ? parseInt(match[1], 10) : null;
  },

  _validate(result) {
    const { wordLadder, clueAnswerPairs } = result;

    if (wordLadder.length > 0 && !this._isValidLadder(wordLadder)) {
      console.warn('[CrossclimbSolver] Word ladder validation FAILED - consecutive words differ by more than one letter');
      // Log which steps fail
      for (let i = 0; i < wordLadder.length - 1; i++) {
        if (!this._differsByOneLetter(wordLadder[i], wordLadder[i + 1])) {
          console.warn(`  Step ${i + 1}: "${wordLadder[i]}" → "${wordLadder[i + 1]}" (invalid)`);
        }
      }
    } else if (wordLadder.length >= 7) {
      console.log('[CrossclimbSolver] Word ladder validation PASSED');
    }

    // Validate that answers appear in the word ladder
    for (const pair of clueAnswerPairs) {
      if (wordLadder.length > 0 && !wordLadder.includes(pair.answer)) {
        console.warn(`[CrossclimbSolver] Answer "${pair.answer}" not found in word ladder`);
      }
    }
  },

  // ----- PUBLIC HELPERS -----

  // Get the correct top-to-bottom ordering for the 5 middle answers
  getMiddleAnswersOrdered(result) {
    if (result.wordLadder.length >= 7) {
      return result.wordLadder.slice(1, 6);
    }
    // Fallback: try to order clue answers to form a valid ladder
    return this._findLongestChain(result.clueAnswerPairs.map(p => p.answer));
  }
};
