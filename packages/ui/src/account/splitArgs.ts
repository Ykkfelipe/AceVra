/**
 * Splits an argument line into argv entries (quotes group words). This is only a typing aid:
 * the result is sent as a structured args[] and is NEVER interpreted by a shell.
 */
export function splitArgs(line: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || current) args.push(current);
      current = "";
      has = false;
    } else {
      current += ch;
    }
  }
  if (has || current) args.push(current);
  return args;
}
