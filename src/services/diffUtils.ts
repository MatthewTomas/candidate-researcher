/**
 * Simple word-level diff using LCS (Longest Common Subsequence).
 * Used to highlight changes between Writer rounds.
 */

export type DiffSegment = { type: 'same' | 'add' | 'remove'; text: string };

/**
 * Compute a word-level diff between two texts.
 * Returns an array of segments tagged as same, added, or removed.
 */
export function diffText(oldText: string, newText: string): DiffSegment[] {
  if (oldText === newText) return [{ type: 'same', text: oldText }];
  if (!oldText && newText) return [{ type: 'add', text: newText }];
  if (oldText && !newText) return [{ type: 'remove', text: oldText }];
  if (!oldText && !newText) return [];

  // Split on whitespace boundaries, preserving whitespace as tokens
  const oldTokens = oldText.split(/(\s+)/);
  const newTokens = newText.split(/(\s+)/);
  const m = oldTokens.length;
  const n = newTokens.length;

  // Guard against very large diffs — fall back to full replace
  if (m * n > 500_000) {
    return [
      { type: 'remove', text: oldText },
      { type: 'add', text: newText },
    ];
  }

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldTokens[i - 1] === newTokens[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build edit script
  const raw: DiffSegment[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldTokens[i - 1] === newTokens[j - 1]) {
      raw.unshift({ type: 'same', text: oldTokens[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      raw.unshift({ type: 'add', text: newTokens[j - 1] });
      j--;
    } else {
      raw.unshift({ type: 'remove', text: oldTokens[i - 1] });
      i--;
    }
  }

  // Merge adjacent segments of the same type
  const merged: DiffSegment[] = [];
  for (const seg of raw) {
    if (merged.length > 0 && merged[merged.length - 1].type === seg.type) {
      merged[merged.length - 1].text += seg.text;
    } else {
      merged.push({ ...seg });
    }
  }

  return merged;
}

/**
 * Return true if two texts are meaningfully different (after whitespace normalization).
 */
export function textsAreDifferent(a: string | undefined, b: string | undefined): boolean {
  const norm = (s?: string) => (s || '').replace(/\s+/g, ' ').trim();
  return norm(a) !== norm(b);
}
