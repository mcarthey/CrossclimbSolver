// Copyright 2025 mcarthey
// SPDX-License-Identifier: Apache-2.0
//
// CrossclimbSolver - Answer Parser
// Parses HTML from crossclimbanswer.io to extract puzzle solutions

const AnswerParser = {
  // Parse the answer page HTML and return structured puzzle data
  parse(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const allText = doc.body?.textContent || '';

    const result = {
      wordLadder: [],
      clueAnswerPairs: [],
      startWord: null,
      endWord: null,
      puzzleNumber: null,
      theme: null
    };

    console.log('[CrossclimbSolver] Parsing answer page, HTML length:', html.length, 'text length:', allText.length);

    // --- STEP 1: Extract clue-answer pairs from tables (most reliable) ---
    result.clueAnswerPairs = this._extractClueAnswerPairsFromHTML(doc);
    if (result.clueAnswerPairs.length === 0) {
      result.clueAnswerPairs = this._extractClueAnswerPairsFromRawHTML(html);
    }
    const middleAnswers = result.clueAnswerPairs.map(p => p.answer);
    console.log('[CrossclimbSolver] Found', result.clueAnswerPairs.length, 'clue-answer pairs:', middleAnswers.join(', '));

    // --- STEP 2: Extract word ladder from HTML structure ---
    // The site displays all 7 words in stacked divs with tracking/uppercase classes
    const htmlLadder = this._extractWordLadderFromHTML(doc);
    console.log('[CrossclimbSolver] HTML ladder extraction:', htmlLadder.join(', '), `(${htmlLadder.length} words)`);
    if (htmlLadder.length >= 7 && this._isValidLadder(htmlLadder)) {
      result.wordLadder = htmlLadder;
      result.startWord = htmlLadder[0];
      result.endWord = htmlLadder[htmlLadder.length - 1];
      console.log('[CrossclimbSolver] Valid 7-word ladder from HTML:', htmlLadder.join(' → '));
    }

    // --- STEP 3: Extract start/end words (multiple strategies) ---
    if (!result.startWord || !result.endWord) {
      this._extractStartEndWords(allText, html, doc, result);
      console.log('[CrossclimbSolver] Start word:', result.startWord, 'End word:', result.endWord);
    }

    // --- STEP 4: Try __NEXT_DATA__ ---
    if (result.wordLadder.length < 7) {
      const nextData = this._extractNextData(doc);
      if (nextData) {
        this._parseFromNextData(nextData, result);
      }
    }

    // --- STEP 5: Reconstruct ladder from known parts ---
    if (result.wordLadder.length < 7 && result.startWord && result.endWord && middleAnswers.length >= 5) {
      console.log('[CrossclimbSolver] Reconstructing ladder via BFS:', result.startWord, '→', result.endWord, 'through', middleAnswers.join(', '));
      const allWords = [result.startWord, ...middleAnswers, result.endWord];
      const path = this._findPath(result.startWord, result.endWord, allWords);
      if (path && path.length === 7) {
        result.wordLadder = path;
        console.log('[CrossclimbSolver] Reconstructed ladder:', path.join(' → '));
      } else {
        console.log('[CrossclimbSolver] BFS failed, trying brute force ordering');
        // Try brute force: we have 5 middle + 2 endpoints, order them
        const ordered = this._bruteForceOrder(result.startWord, result.endWord, middleAnswers);
        if (ordered && ordered.length === 7) {
          result.wordLadder = ordered;
          console.log('[CrossclimbSolver] Brute-force ordered ladder:', ordered.join(' → '));
        }
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

  _extractStartEndWords(allText, rawHtml, doc, result) {
    // Strategy A: Find "Top" and "Bottom" labels in the HTML structure
    // The site uses: <p>Top</p><p>HORNS</p> and <p>Bottom</p><p>BRASS</p>
    if (doc) {
      const allPs = doc.querySelectorAll('p');
      for (let i = 0; i < allPs.length - 1; i++) {
        const label = allPs[i].textContent.trim().toLowerCase();
        const word = allPs[i + 1].textContent.trim().toUpperCase();
        if (label === 'top' && /^[A-Z]{3,7}$/.test(word)) {
          result.startWord = word;
        }
        if (label === 'bottom' && /^[A-Z]{3,7}$/.test(word)) {
          result.endWord = word;
        }
      }
    }
    if (result.startWord && result.endWord) return;

    // Strategy B: Text pattern "Top: WORD" or "Top WORD"
    const topMatch = allText.match(/\bTop\b[:\s]+([A-Z]{3,7})\b/i);
    const bottomMatch = allText.match(/\bBottom\b[:\s]+([A-Z]{3,7})\b/i);
    if (topMatch) result.startWord = result.startWord || topMatch[1].toUpperCase();
    if (bottomMatch) result.endWord = result.endWord || bottomMatch[1].toUpperCase();
    if (result.startWord && result.endWord) return;

    // Strategy C: "WORD → WORD" arrow pattern
    const arrowMatch = allText.match(/\b([A-Z]{3,7})\s*[→\u2192]\s*([A-Z]{3,7})\b/i) ||
                       rawHtml.match(/([A-Z]{3,7})\s*(?:→|&rarr;|&#8594;|&#x2192;)\s*([A-Z]{3,7})/i);
    if (arrowMatch) {
      result.startWord = result.startWord || arrowMatch[1].toUpperCase();
      result.endWord = result.endWord || arrowMatch[2].toUpperCase();
    }
    if (result.startWord && result.endWord) return;

    // Strategy D: "WORD into WORD" pattern (from page description)
    const intoMatch = allText.match(/\b([A-Z]{3,7})\s+into\s+([A-Z]{3,7})\b/i);
    if (intoMatch) {
      result.startWord = result.startWord || intoMatch[1].toUpperCase();
      result.endWord = result.endWord || intoMatch[2].toUpperCase();
    }
    if (result.startWord && result.endWord) return;

    // Strategy E: Find words NOT in clue-answer pairs that form valid ladder endpoints
    if (result.clueAnswerPairs.length >= 5) {
      const middleSet = new Set(result.clueAnswerPairs.map(p => p.answer));
      const wordLen = result.clueAnswerPairs[0]?.answer.length;

      if (wordLen) {
        // Find all uppercase words of the same length in the text
        const allWords = allText.match(new RegExp(`\\b[A-Z]{${wordLen}}\\b`, 'g')) || [];
        const candidates = [...new Set(allWords.map(w => w.toUpperCase()))].filter(w => !middleSet.has(w));

        console.log('[CrossclimbSolver] Start/end candidates (not in middle):', candidates.join(', '));

        // Try each pair as start/end and see if BFS finds a valid 7-word path
        for (const c1 of candidates) {
          for (const c2 of candidates) {
            if (c1 === c2) continue;
            const path = this._findPath(c1, c2, [c1, ...middleSet, c2]);
            if (path && path.length === 7) {
              result.startWord = result.startWord || c1;
              result.endWord = result.endWord || c2;
              console.log('[CrossclimbSolver] Found endpoints via BFS:', c1, '→', c2);
              return;
            }
          }
        }
      }
    }

    // Strategy F: Scan raw HTML for "Top" and "Bottom" near words
    if (!result.startWord) {
      const topHtml = rawHtml.match(/[Tt]op<\/\w+>\s*<\w+[^>]*>\s*([A-Z]{3,7})\b/);
      if (topHtml) result.startWord = topHtml[1].toUpperCase();
    }
    if (!result.endWord) {
      const bottomHtml = rawHtml.match(/[Bb]ottom<\/\w+>\s*<\w+[^>]*>\s*([A-Z]{3,7})\b/);
      if (bottomHtml) result.endWord = bottomHtml[1].toUpperCase();
    }
  },

  // ----- CLUE-ANSWER EXTRACTION FROM RAW HTML -----

  _extractClueAnswerPairsFromRawHTML(html) {
    const pairs = [];

    // Pattern: <td>clue text</td><td><strong>ANSWER</strong></td>
    const tdPattern = /<td[^>]*>(.*?)<\/td>\s*<td[^>]*>\s*<strong[^>]*>([A-Za-z]{3,7})<\/strong>/gi;
    let match;
    while ((match = tdPattern.exec(html)) !== null) {
      const clue = match[1].replace(/<[^>]+>/g, '').trim();
      const answer = match[2].toUpperCase();
      if (clue.length > 3) {
        pairs.push({ clue, answer });
      }
    }

    // Pattern: <strong>ANSWER</strong> near a clue <td>
    if (pairs.length < 5) {
      const strongPattern = /<strong[^>]*>([A-Za-z]{3,7})<\/strong>/gi;
      while ((match = strongPattern.exec(html)) !== null) {
        const answer = match[1].toUpperCase();
        if (pairs.find(p => p.answer === answer)) continue;
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
    if (!script) return null;

    try {
      return JSON.parse(script.textContent);
    } catch {
      return null;
    }
  },

  _parseFromNextData(nextData, result) {
    const pageProps = nextData?.props?.pageProps;
    if (!pageProps) return;

    const flatText = JSON.stringify(pageProps);
    const topMatch = flatText.match(/"top"\s*:\s*"([A-Za-z]{3,7})"/i);
    const bottomMatch = flatText.match(/"bottom"\s*:\s*"([A-Za-z]{3,7})"/i);
    if (topMatch) result.startWord = result.startWord || topMatch[1].toUpperCase();
    if (bottomMatch) result.endWord = result.endWord || bottomMatch[1].toUpperCase();

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
      for (const item of obj) this._findClueAnswerPairsInObject(item, result, depth + 1);
    } else {
      for (const value of Object.values(obj)) this._findClueAnswerPairsInObject(value, result, depth + 1);
    }
  },

  // ----- HTML PARSING -----

  _extractWordLadderFromHTML(doc) {
    // Strategy A: Find a container with exactly 7 children that are uppercase words
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
        if (words.length >= 7) {
          // Try the first 7 words
          if (this._isValidLadder(words.slice(0, 7))) return words.slice(0, 7);
          // Try all 7-word windows
          for (let i = 0; i <= words.length - 7; i++) {
            if (this._isValidLadder(words.slice(i, i + 7))) return words.slice(i, i + 7);
          }
        }
      }
    }

    // Strategy B: Find elements with Tailwind "uppercase" or "tracking" classes
    // These mark the word ladder display on crossclimbanswer.io
    const styledEls = doc.querySelectorAll('[class*="uppercase"], [class*="tracking"]');
    const styledWords = [];
    for (const el of styledEls) {
      const text = el.textContent.trim().toUpperCase();
      if (/^[A-Z]{3,7}$/.test(text) && !styledWords.includes(text)) {
        styledWords.push(text);
      }
    }
    console.log('[CrossclimbSolver] Styled words found:', styledWords.join(', '));

    // Try sliding window of 7 words
    if (styledWords.length >= 7) {
      for (let i = 0; i <= styledWords.length - 7; i++) {
        const slice = styledWords.slice(i, i + 7);
        if (this._isValidLadder(slice)) return slice;
      }
    }

    // Strategy C: Look for divs with border classes containing words
    const ladderWords = [];
    doc.querySelectorAll('[class*="border"]').forEach(el => {
      const text = el.textContent.trim().toUpperCase();
      if (/^[A-Z]{3,7}$/.test(text) && !ladderWords.includes(text)) {
        ladderWords.push(text);
      }
    });
    if (ladderWords.length >= 7) {
      for (let i = 0; i <= ladderWords.length - 7; i++) {
        const slice = ladderWords.slice(i, i + 7);
        if (this._isValidLadder(slice)) return slice;
      }
    }

    // Strategy D: Find all elements whose text is a single uppercase word
    // (catches cases where class names don't contain "uppercase" after DOMParser)
    const boldEls = doc.querySelectorAll('strong, b, [class*="bold"], [class*="font-bold"]');
    const boldWords = [];
    for (const el of boldEls) {
      const text = el.textContent.trim().toUpperCase();
      if (/^[A-Z]{3,7}$/.test(text) && !boldWords.includes(text)) {
        boldWords.push(text);
      }
    }
    if (boldWords.length >= 7) {
      for (let i = 0; i <= boldWords.length - 7; i++) {
        const slice = boldWords.slice(i, i + 7);
        if (this._isValidLadder(slice)) return slice;
      }
    }

    return styledWords.length > 0 ? styledWords : ladderWords;
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
          const answerEl = cells[1].querySelector('strong') || cells[1];
          const answerText = answerEl.textContent.trim().toUpperCase();

          if (clueText.length > 3 && /^[A-Z]{3,7}$/.test(answerText)) {
            pairs.push({ clue: clueText, answer: answerText });
          }
        }
      }
    }
    if (pairs.length >= 5) return pairs;

    // Strategy B: Find <strong> tags with uppercase words
    const strongs = doc.querySelectorAll('strong');
    for (const strong of strongs) {
      const text = strong.textContent.trim().toUpperCase();
      if (/^[A-Z]{3,7}$/.test(text)) {
        const parent = strong.closest('td, li, p, div');
        if (parent) {
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

    return pairs;
  },

  // ----- TEXT SCAN -----

  _extractWordLadderFromText(allText, knownStart = null, knownEnd = null) {
    const allUpperWords = allText.match(/\b[A-Z]{3,7}\b/g) || [];

    const skipWords = new Set([
      'FAQ', 'CSS', 'SEO', 'URL', 'HTML', 'JSON', 'NEXT', 'GET', 'POST',
      'HEAD', 'HTTP', 'API', 'THE', 'AND', 'FOR', 'ARE', 'BUT', 'NOT',
      'YOU', 'ALL', 'HER', 'WAS', 'ONE', 'OUR', 'OUT', 'HAS', 'HIS',
      'HOW', 'ITS', 'MAY', 'NEW', 'NOW', 'OLD', 'USE', 'WAY', 'WHO',
      'DID', 'HIM', 'LET', 'SAY', 'SHE', 'TOO', 'OWN', 'RSS'
    ]);

    const byLength = {};
    for (const w of allUpperWords) {
      if (skipWords.has(w)) continue;
      byLength[w.length] = byLength[w.length] || [];
      byLength[w.length].push(w);
    }

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

    const seen = new Set();
    const candidates = [];
    for (const w of allUpperWords) {
      if (w.length === bestLength && !skipWords.has(w) && !seen.has(w)) {
        seen.add(w);
        candidates.push(w);
      }
    }

    return this._buildLadderFromCandidates(candidates, knownStart, knownEnd);
  },

  // ----- LADDER CONSTRUCTION -----

  _buildLadderFromCandidates(candidates, knownStart = null, knownEnd = null) {
    if (candidates.length < 7) return candidates;

    if (knownStart && knownEnd) {
      const path = this._findPath(knownStart, knownEnd, candidates);
      if (path && path.length === 7) return path;
    }

    for (let i = 0; i < Math.min(candidates.length, 20); i++) {
      for (let j = 0; j < Math.min(candidates.length, 20); j++) {
        if (i === j) continue;
        const path = this._findPath(candidates[i], candidates[j], candidates);
        if (path && path.length === 7) return path;
      }
    }

    return this._findLongestChain(candidates);
  },

  // BFS to find a path of exactly 7 words from start to end
  _findPath(start, end, wordPool) {
    if (!start || !end || start.length !== end.length) return null;

    const pool = new Set(wordPool.map(w => w.toUpperCase()));
    pool.add(start.toUpperCase());
    pool.add(end.toUpperCase());

    const startUpper = start.toUpperCase();
    const endUpper = end.toUpperCase();

    const queue = [[startUpper]];
    const visited = new Set([startUpper]);

    while (queue.length > 0) {
      const path = queue.shift();
      if (path.length > 7) continue;

      const last = path[path.length - 1];
      if (last === endUpper && path.length === 7) return path;
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

  // Brute-force: try all permutations of middle answers to find valid ordering
  _bruteForceOrder(start, end, middleAnswers) {
    if (middleAnswers.length !== 5) return null;

    // Try permutations (5! = 120, manageable)
    const permute = (arr) => {
      if (arr.length <= 1) return [arr];
      const result = [];
      for (let i = 0; i < arr.length; i++) {
        const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
        for (const perm of permute(rest)) {
          result.push([arr[i], ...perm]);
        }
      }
      return result;
    };

    for (const perm of permute(middleAnswers)) {
      const full = [start, ...perm, end];
      if (this._isValidLadder(full)) return full;
    }

    return null;
  },

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
      if (chain.length > bestChain.length) bestChain = chain;
    }
    return bestChain;
  },

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
    if (!word1 || !word2 || word1.length !== word2.length) return false;
    const a = word1.toUpperCase();
    const b = word2.toUpperCase();
    let diffs = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) diffs++;
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
      console.warn('[CrossclimbSolver] Word ladder validation FAILED');
      for (let i = 0; i < wordLadder.length - 1; i++) {
        if (!this._differsByOneLetter(wordLadder[i], wordLadder[i + 1])) {
          console.warn(`  Step ${i + 1}: "${wordLadder[i]}" → "${wordLadder[i + 1]}" (invalid)`);
        }
      }
    } else if (wordLadder.length >= 7) {
      console.log('[CrossclimbSolver] Word ladder validation PASSED');
    }

    for (const pair of clueAnswerPairs) {
      if (wordLadder.length > 0 && !wordLadder.includes(pair.answer)) {
        console.warn(`[CrossclimbSolver] Answer "${pair.answer}" not found in word ladder`);
      }
    }
  },

  // ----- PUBLIC HELPERS -----

  getMiddleAnswersOrdered(result) {
    if (result.wordLadder.length >= 7) {
      return result.wordLadder.slice(1, 6);
    }
    return this._findLongestChain(result.clueAnswerPairs.map(p => p.answer));
  }
};
