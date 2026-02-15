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
    const allText = doc.body?.textContent || doc.body?.innerText || html;

    const result = {
      wordLadder: [],
      clueAnswerPairs: [],
      startWord: null,
      endWord: null,
      puzzleNumber: null,
      theme: null
    };

    console.log('[CrossclimbSolver] Parsing answer page, HTML length:', html.length);

    // --- STEP 1: Extract start/end words (most reliable patterns) ---
    this._extractStartEndWords(allText, html, result);
    console.log('[CrossclimbSolver] Start word:', result.startWord, 'End word:', result.endWord);

    // --- STEP 2: Extract clue-answer pairs from tables ---
    result.clueAnswerPairs = this._extractClueAnswerPairsFromHTML(doc);
    if (result.clueAnswerPairs.length === 0) {
      // Try regex on raw HTML as fallback (handles cases where DOMParser strips content)
      result.clueAnswerPairs = this._extractClueAnswerPairsFromRawHTML(html);
    }
    console.log('[CrossclimbSolver] Found', result.clueAnswerPairs.length, 'clue-answer pairs:',
      result.clueAnswerPairs.map(p => `${p.answer}: ${p.clue.substring(0, 30)}`));

    // --- STEP 3: Extract word ladder from HTML structure ---
    const htmlLadder = this._extractWordLadderFromHTML(doc);
    if (htmlLadder.length >= 7 && this._isValidLadder(htmlLadder)) {
      result.wordLadder = htmlLadder;
      console.log('[CrossclimbSolver] Ladder from HTML:', htmlLadder.join(' → '));
    }

    // --- STEP 4: Try __NEXT_DATA__ ---
    if (result.wordLadder.length < 7) {
      const nextData = this._extractNextData(doc);
      if (nextData) {
        this._parseFromNextData(nextData, result);
      }
    }

    // --- STEP 5: Reconstruct ladder from known parts ---
    if (result.wordLadder.length < 7 && result.startWord && result.endWord) {
      console.log('[CrossclimbSolver] Reconstructing ladder from start/end + answers');
      const middleAnswers = result.clueAnswerPairs.map(p => p.answer);
      const allWords = [result.startWord, ...middleAnswers, result.endWord];
      const path = this._findPath(result.startWord, result.endWord, allWords);
      if (path && path.length === 7) {
        result.wordLadder = path;
        console.log('[CrossclimbSolver] Reconstructed ladder:', path.join(' → '));
      }
    }

    // --- STEP 6: Brute-force text scan as last resort ---
    if (result.wordLadder.length < 7) {
      console.log('[CrossclimbSolver] Falling back to text scan');
      const textLadder = this._extractWordLadderFromText(allText, result.startWord, result.endWord);
      if (textLadder.length > result.wordLadder.length) {
        result.wordLadder = textLadder;
      }
    }

    // --- Derive start/end from ladder if still missing ---
    if (result.wordLadder.length >= 2) {
      result.startWord = result.startWord || result.wordLadder[0];
      result.endWord = result.endWord || result.wordLadder[result.wordLadder.length - 1];
    }

    if (!result.puzzleNumber) {
      result.puzzleNumber = this._extractPuzzleNumber(allText);
    }

    this._validate(result);
    console.log('[CrossclimbSolver] Final parsed result:', JSON.stringify(result, null, 2));
    return result;
  },

  // ----- START/END WORD EXTRACTION -----

  _extractStartEndWords(allText, rawHtml, result) {
    // Pattern 1: "Top: WORD" and "Bottom: WORD" (from the info table)
    const topMatch = allText.match(/Top[:\s]+([A-Z]{3,7})/i) ||
                     rawHtml.match(/Top[:\s<>/span]*([A-Z]{3,7})/i);
    const bottomMatch = allText.match(/Bottom[:\s]+([A-Z]{3,7})/i) ||
                        rawHtml.match(/Bottom[:\s<>/span]*([A-Z]{3,7})/i);

    if (topMatch) result.startWord = topMatch[1].toUpperCase();
    if (bottomMatch) result.endWord = bottomMatch[1].toUpperCase();

    // Pattern 2: "WORD → WORD" (arrow display in hero section)
    if (!result.startWord || !result.endWord) {
      // Match both actual arrow and HTML entities
      const arrowMatch = allText.match(/\b([A-Z]{3,7})\s*[→\u2192]\s*([A-Z]{3,7})\b/i) ||
                         rawHtml.match(/([A-Z]{3,7})\s*(?:→|&rarr;|&#8594;|&#x2192;)\s*([A-Z]{3,7})/i);
      if (arrowMatch) {
        result.startWord = result.startWord || arrowMatch[1].toUpperCase();
        result.endWord = result.endWord || arrowMatch[2].toUpperCase();
      }
    }

    // Pattern 3: Look in raw HTML for "top" and "bottom" near uppercase words
    if (!result.startWord || !result.endWord) {
      const topHtml = rawHtml.match(/[Tt]op.*?([A-Z]{3,7})/);
      const bottomHtml = rawHtml.match(/[Bb]ottom.*?([A-Z]{3,7})/);
      if (topHtml) result.startWord = result.startWord || topHtml[1];
      if (bottomHtml) result.endWord = result.endWord || bottomHtml[1];
    }
  },

  // ----- CLUE-ANSWER EXTRACTION FROM RAW HTML -----

  // Fallback: extract clue-answer pairs by regex on the raw HTML string
  // This works even when DOMParser doesn't fully render the content
  _extractClueAnswerPairsFromRawHTML(html) {
    const pairs = [];

    // Pattern: <td>clue text</td><td><strong>ANSWER</strong></td>
    const tdPattern = /<td[^>]*>(.*?)<\/td>\s*<td[^>]*>\s*<strong>([A-Z]{3,7})<\/strong>/gi;
    let match;
    while ((match = tdPattern.exec(html)) !== null) {
      const clue = match[1].replace(/<[^>]+>/g, '').trim();
      const answer = match[2].toUpperCase();
      if (clue.length > 3) {
        pairs.push({ clue, answer });
      }
    }

    // Pattern: "clue text" near "ANSWER" in close proximity
    if (pairs.length < 5) {
      const strongPattern = /<strong>([A-Z]{3,7})<\/strong>/gi;
      while ((match = strongPattern.exec(html)) !== null) {
        const answer = match[1].toUpperCase();
        if (pairs.find(p => p.answer === answer)) continue;
        // Look backwards for nearby text that could be a clue
        const before = html.substring(Math.max(0, match.index - 300), match.index);
        const clueMatch = before.match(/<td[^>]*>([^<]{5,100})<\/td>/);
        if (clueMatch) {
          pairs.push({ clue: clueMatch[1].trim(), answer });
        }
      }
    }

    return pairs;
  },

  // ----- __NEXT_DATA__ -----

  _extractNextData(doc) {
    const script = doc.querySelector('script#__NEXT_DATA__');
    if (!script) {
      console.log('[CrossclimbSolver] No __NEXT_DATA__ script tag found');
      return null;
    }

    try {
      return JSON.parse(script.textContent);
    } catch (e) {
      console.warn('[CrossclimbSolver] Failed to parse __NEXT_DATA__:', e);
      return null;
    }
  },

  _parseFromNextData(nextData, result) {
    const pageProps = nextData?.props?.pageProps;
    if (!pageProps) return;

    const flatText = JSON.stringify(pageProps);

    // Extract start/end words
    const topMatch = flatText.match(/"top"\s*:\s*"([A-Za-z]{3,7})"/i);
    const bottomMatch = flatText.match(/"bottom"\s*:\s*"([A-Za-z]{3,7})"/i);
    if (topMatch) result.startWord = result.startWord || topMatch[1].toUpperCase();
    if (bottomMatch) result.endWord = result.endWord || bottomMatch[1].toUpperCase();

    // Extract clue-answer pairs
    this._findClueAnswerPairsInObject(pageProps, result);
  },

  _findClueAnswerPairsInObject(obj, result, depth = 0) {
    if (depth > 10 || !obj || typeof obj !== 'object') return;

    if (obj.clue && obj.answer) {
      result.clueAnswerPairs.push({
        clue: String(obj.clue).trim(),
        answer: String(obj.answer).toUpperCase().trim()
      });
      return;
    }

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
    // Note: words may be lowercase in HTML with CSS text-transform:uppercase
    const allDivs = doc.querySelectorAll('div');
    for (const container of allDivs) {
      const children = container.children;
      if (children.length >= 7 && children.length <= 9) {
        const words = [];
        for (const child of children) {
          const text = child.textContent.trim().toUpperCase();
          if (/^[A-Z]{3,7}$/.test(text)) {
            words.push(text);
          }
        }
        if (words.length >= 7 && this._isValidLadder(words)) {
          return words;
        }
      }
    }

    // Strategy B: Find words in elements with Tailwind "uppercase" or "tracking" classes
    // These words may be lowercase in source but displayed uppercase via CSS
    const styledEls = doc.querySelectorAll('[class*="uppercase"], [class*="tracking"]');
    const styledWords = [];
    for (const el of styledEls) {
      const text = el.textContent.trim().toUpperCase();
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

  // ----- TEXT SCAN -----

  _extractWordLadderFromText(allText, knownStart = null, knownEnd = null) {
    // Find all uppercase words of the same length
    // Also handle words that might be lowercase in source but uppercase via CSS
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
    return this._buildLadderFromCandidates(candidates, knownStart, knownEnd);
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

  _extractPuzzleNumber(text) {
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
