// CrossclimbSolver - Answer Parser
// Parses HTML from crossclimbanswer.io to extract puzzle solutions

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

    // Strategy 1: Extract word ladder from structured content
    result.wordLadder = this._extractWordLadder(doc);

    // Strategy 2: Extract clue-answer pairs
    result.clueAnswerPairs = this._extractClueAnswerPairs(doc);

    // Derive start/end words from the ladder
    if (result.wordLadder.length >= 2) {
      result.startWord = result.wordLadder[0];
      result.endWord = result.wordLadder[result.wordLadder.length - 1];
    }

    // Extract puzzle number from the page
    result.puzzleNumber = this._extractPuzzleNumber(doc);

    // Extract theme
    result.theme = this._extractTheme(doc);

    // Validate and cross-reference
    this._validate(result);

    return result;
  },

  // Extract the word ladder sequence from the page
  _extractWordLadder(doc) {
    const words = [];

    // Strategy A: Look for an ordered list or sequence of words
    // The site typically shows the ladder as a visual sequence
    const allText = doc.body.innerText || doc.body.textContent;

    // Look for a pattern of 3-6 letter uppercase words in sequence
    // Word ladders are typically shown as: WORD1 → WORD2 → WORD3 ...
    const arrowPattern = allText.match(/\b([A-Z]{3,6})\s*[→\->]+\s*([A-Z]{3,6}(?:\s*[→\->]+\s*[A-Z]{3,6})*)/);
    if (arrowPattern) {
      const fullMatch = arrowPattern[0];
      const ladderWords = fullMatch.match(/[A-Z]{3,6}/g);
      if (ladderWords && ladderWords.length >= 3) {
        return ladderWords;
      }
    }

    // Strategy B: Look for words in a structured list/table
    const listItems = doc.querySelectorAll('li, td, .word, .ladder-word, .step');
    const candidateWords = [];
    listItems.forEach(el => {
      const text = (el.textContent || '').trim();
      if (/^[A-Z]{3,6}$/.test(text)) {
        candidateWords.push(text);
      }
    });
    if (candidateWords.length >= 3) {
      return candidateWords;
    }

    // Strategy C: Scan all text nodes for uppercase words that could be a ladder
    const upperWords = allText.match(/\b[A-Z]{3,6}\b/g) || [];
    // Filter to find a sequence where consecutive words differ by one letter
    return this._findWordLadderInCandidates(upperWords);
  },

  // Given a list of candidate words, find a subsequence forming a valid word ladder
  _findWordLadderInCandidates(candidates) {
    if (candidates.length < 3) return candidates;

    // Remove duplicates while preserving order
    const seen = new Set();
    const unique = candidates.filter(w => {
      if (seen.has(w)) return false;
      seen.add(w);
      return true;
    });

    // Find the longest chain where consecutive words differ by exactly one letter
    for (let start = 0; start < unique.length; start++) {
      const chain = [unique[start]];
      for (let j = start + 1; j < unique.length; j++) {
        if (this._differsByOneLetter(chain[chain.length - 1], unique[j])) {
          chain.push(unique[j]);
        }
      }
      if (chain.length >= 7) return chain; // Full ladder (7 words = start + 5 middle + end)
      if (chain.length >= 5) return chain; // Partial match
    }

    return unique.slice(0, 7); // Fallback: return first 7 words
  },

  // Check if two words differ by exactly one letter (same length)
  _differsByOneLetter(word1, word2) {
    if (word1.length !== word2.length) return false;
    let diffs = 0;
    for (let i = 0; i < word1.length; i++) {
      if (word1[i] !== word2[i]) diffs++;
      if (diffs > 1) return false;
    }
    return diffs === 1;
  },

  // Extract clue-answer pairs from the page
  _extractClueAnswerPairs(doc) {
    const pairs = [];

    // Strategy A: Look for table rows with clue and answer
    const tables = doc.querySelectorAll('table');
    for (const table of tables) {
      const rows = table.querySelectorAll('tr');
      for (const row of rows) {
        const cells = row.querySelectorAll('td, th');
        if (cells.length >= 2) {
          const clueText = (cells[0].textContent || '').trim();
          const answerText = (cells[1].textContent || '').trim();
          if (clueText.length > 5 && /^[A-Z]{3,6}$/.test(answerText)) {
            pairs.push({ clue: clueText, answer: answerText });
          }
        }
      }
    }
    if (pairs.length >= 5) return pairs;

    // Strategy B: Look for definition-list style or labeled content
    const allElements = doc.querySelectorAll('p, div, span, li, dt, dd');
    const texts = [];
    allElements.forEach(el => {
      const text = (el.textContent || '').trim();
      if (text.length > 0 && text.length < 200) {
        texts.push({ text, el });
      }
    });

    // Look for patterns: "Clue text: ANSWER" or "ANSWER - Clue text"
    for (const { text } of texts) {
      // Pattern: "Clue text: ANSWER" or "Clue text — ANSWER"
      const colonMatch = text.match(/^(.{5,}?)\s*[:–—-]\s*([A-Z]{3,6})$/);
      if (colonMatch) {
        pairs.push({ clue: colonMatch[1].trim(), answer: colonMatch[2] });
        continue;
      }
      // Pattern: "ANSWER: Clue text" or "ANSWER — Clue text"
      const reverseMatch = text.match(/^([A-Z]{3,6})\s*[:–—-]\s*(.{5,})$/);
      if (reverseMatch) {
        pairs.push({ clue: reverseMatch[2].trim(), answer: reverseMatch[1] });
      }
    }

    return pairs;
  },

  _extractPuzzleNumber(doc) {
    const text = doc.body.textContent || '';
    const match = text.match(/#\s*(\d{3,4})/) || text.match(/Crossclimb\s*#?\s*(\d{3,4})/i) ||
                  text.match(/Puzzle\s*#?\s*(\d{3,4})/i);
    return match ? parseInt(match[1], 10) : null;
  },

  _extractTheme(doc) {
    // Look for theme/description text - usually in a heading or prominent element
    const candidates = doc.querySelectorAll('h1, h2, h3, .theme, .description, blockquote, em');
    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      // Theme descriptions are typically short phrases, not single words
      if (text.length > 10 && text.length < 200 && !/crossclimb/i.test(text)) {
        return text;
      }
    }
    return null;
  },

  _validate(result) {
    const { wordLadder, clueAnswerPairs } = result;

    // Validate word ladder: consecutive words should differ by one letter
    for (let i = 0; i < wordLadder.length - 1; i++) {
      if (!this._differsByOneLetter(wordLadder[i], wordLadder[i + 1])) {
        console.warn(
          `[CrossclimbSolver] Word ladder validation: "${wordLadder[i]}" → "${wordLadder[i + 1]}" differ by more than one letter`
        );
      }
    }

    // Validate that answers appear in the word ladder
    for (const pair of clueAnswerPairs) {
      if (!wordLadder.includes(pair.answer)) {
        console.warn(
          `[CrossclimbSolver] Answer "${pair.answer}" not found in word ladder`
        );
      }
    }

    // The middle 5 words of a 7-word ladder should match the 5 answers
    if (wordLadder.length === 7 && clueAnswerPairs.length === 5) {
      const middleFive = wordLadder.slice(1, 6);
      const answers = clueAnswerPairs.map(p => p.answer);
      const allMatch = middleFive.every(w => answers.includes(w));
      if (!allMatch) {
        console.warn('[CrossclimbSolver] Middle ladder words do not all match clue answers');
      }
    }
  },

  // Convenience: get the correct top-to-bottom ordering for the 5 middle answers
  getMiddleAnswersOrdered(result) {
    if (result.wordLadder.length >= 7) {
      return result.wordLadder.slice(1, 6);
    }
    // Fallback: try to order clue answers to form a valid ladder
    return this._orderAnswersByLadder(result.clueAnswerPairs.map(p => p.answer));
  },

  // Try to order a set of words into a valid word ladder sequence
  _orderAnswersByLadder(words) {
    if (words.length <= 1) return words;

    // Try all permutations... but that's expensive for 5 words (120 permutations)
    // Use a greedy chain approach instead
    const used = new Set();
    const chain = [words[0]];
    used.add(words[0]);

    // Try building chains starting from each word
    let bestChain = [];
    for (const startWord of words) {
      const currentChain = [startWord];
      const currentUsed = new Set([startWord]);

      while (currentChain.length < words.length) {
        const last = currentChain[currentChain.length - 1];
        const next = words.find(w => !currentUsed.has(w) && this._differsByOneLetter(last, w));
        if (!next) break;
        currentChain.push(next);
        currentUsed.add(next);
      }

      if (currentChain.length > bestChain.length) {
        bestChain = currentChain;
      }
    }

    return bestChain;
  }
};
