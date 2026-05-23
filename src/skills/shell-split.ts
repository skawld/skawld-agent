/** Minimal shell tokenizer for skill arg strings. Supports ' " \ as POSIX-lite. */

export function splitShellArgs(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quote: "'" | "\"" | undefined;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else current += ch;
      continue;
    }
    if (quote === "\"") {
      if (ch === "\"") {
        quote = undefined;
      } else if (ch === "\\" && i + 1 < raw.length) {
        current += raw[++i]!;
      } else {
        current += ch;
      }
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    inToken = true;
    if (ch === "'" || ch === "\"") {
      quote = ch;
    } else if (ch === "\\" && i + 1 < raw.length) {
      current += raw[++i]!;
    } else {
      current += ch;
    }
  }
  if (quote !== undefined) {
    // Mismatched quote: treat the remaining run as one token (lenient).
    tokens.push(current);
  } else if (inToken) {
    tokens.push(current);
  }
  return tokens;
}
