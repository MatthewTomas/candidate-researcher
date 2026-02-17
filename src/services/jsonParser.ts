/**
 * Robust JSON extraction and parsing for AI responses.
 *
 * AI models sometimes return JSON wrapped in markdown fences, preceded by
 * explanatory text, or truncated mid-stream.  This module provides a single
 * `parseJSONResponse<T>(text, providerName)` that every provider should call
 * instead of rolling its own `JSON.parse` logic.
 *
 * Extraction strategies (tried in order):
 *  1. Strip markdown code fences, then `JSON.parse`
 *  2. Regex-extract the first `{…}` block, then `JSON.parse`
 *  3. Regex-extract the first `[…]` block, then `JSON.parse`
 *  4. Attempt truncated-JSON repair (add closing brackets)
 */

/** Maximum depth of brackets we'll attempt to repair */
const MAX_REPAIR_DEPTH = 64;

/**
 * Parse a (possibly messy) JSON response from an AI provider.
 *
 * @throws {Error} with a message containing both "parse" and the provider
 *   name so the error-parser can classify it correctly.
 */
export function parseJSONResponse<T>(text: string, providerName: string): T {
  if (!text || !text.trim()) {
    throw new Error(`Empty ${providerName} response — no JSON to parse`);
  }

  // Strategy 1: strip markdown fences and try direct parse
  const stripped = text
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();

  try {
    return JSON.parse(stripped) as T;
  } catch {
    // continue to next strategy
  }

  // Strategy 2: extract first { … } block
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]) as T;
    } catch {
      // The regex may have been too greedy or the JSON is truncated — try repair
      const repaired = repairTruncatedJSON(objMatch[0]);
      if (repaired) {
        try {
          return JSON.parse(repaired) as T;
        } catch {
          // continue
        }
      }
    }
  }

  // Strategy 3: extract first [ … ] block (for array responses)
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      return JSON.parse(arrMatch[0]) as T;
    } catch {
      // continue
    }
  }

  // Strategy 4: try to repair the full stripped text if it starts with { or [
  if (stripped.startsWith('{') || stripped.startsWith('[')) {
    const repaired = repairTruncatedJSON(stripped);
    if (repaired) {
      try {
        return JSON.parse(repaired) as T;
      } catch {
        // continue
      }
    }
  }

  // All strategies failed
  throw new Error(
    `Failed to parse ${providerName} JSON response: ${text.slice(0, 200)}`
  );
}

/**
 * Attempt to repair truncated JSON by closing unclosed brackets / braces.
 *
 * Works by scanning the string for unclosed `{`, `[`, and `"` and appending
 * the necessary closing characters.  This handles the common case where the
 * model ran out of tokens mid-output.
 *
 * Returns `null` if the input doesn't look salvageable.
 */
function repairTruncatedJSON(text: string): string | null {
  // Quick sanity check
  if (!text || text.length < 2) return null;

  // Remove any trailing comma (model often truncates after a comma)
  let cleaned = text.replace(/,\s*$/, '');

  // Track bracket stack
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{' || ch === '[') {
      stack.push(ch);
      if (stack.length > MAX_REPAIR_DEPTH) return null; // too deeply nested, bail
    } else if (ch === '}') {
      if (stack.length === 0 || stack[stack.length - 1] !== '{') return null;
      stack.pop();
    } else if (ch === ']') {
      if (stack.length === 0 || stack[stack.length - 1] !== '[') return null;
      stack.pop();
    }
  }

  // If we're inside a string, close it
  if (inString) {
    cleaned += '"';
  }

  // Close remaining brackets in reverse order
  if (stack.length === 0) return null; // nothing to repair
  if (stack.length > 20) return null;  // too many unclosed brackets — probably garbage

  // If we ended mid-key or mid-value inside an object, try to make it valid
  // Remove a trailing colon (truncated after key)
  cleaned = cleaned.replace(/:\s*$/, ': null');
  // Remove trailing comma if we added the quote
  cleaned = cleaned.replace(/,\s*$/, '');

  while (stack.length > 0) {
    const opener = stack.pop()!;
    cleaned += opener === '{' ? '}' : ']';
  }

  return cleaned;
}
