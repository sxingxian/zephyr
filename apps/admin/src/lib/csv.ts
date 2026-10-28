const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Max addresses per send (the API accepts up to 50). */
export const MAX_PER_SEND = 50;

export interface ParsedEmails {
  emails: string[];
  invalid: string[];
  /** Valid addresses beyond the per-send cap. */
  overflow: number;
}

function cells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',' || ch === ';' || ch === '\t') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/**
 * Reads email addresses from CSV text in the browser. Uses the column headed "email" when there is one,
 * otherwise the first column. Lower-cases, de-duplicates and caps at MAX_PER_SEND.
 */
export function parseEmailsCsv(text: string): ParsedEmails {
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim());
  if (!lines.length) return { emails: [], invalid: [], overflow: 0 };
  const head = cells(lines[0] as string).map((c) => c.toLowerCase());
  const idx = head.findIndex((h) => h === 'email' || h === 'e-mail' || h === 'email address');
  const rows = idx >= 0 ? lines.slice(1) : lines;
  const col = Math.max(idx, 0);
  return collect(rows.map((l) => cells(l)[col] ?? ''));
}

/** Same rules for a pasted list separated by commas, spaces or new lines. */
export function parseEmailList(text: string): ParsedEmails {
  return collect(text.split(/[\s,;]+/));
}

function collect(values: string[]): ParsedEmails {
  const seen = new Set<string>();
  const invalid: string[] = [];
  for (const v of values) {
    const e = v.trim().toLowerCase();
    if (!e) continue;
    if (EMAIL_RE.test(e) && e.length <= 254) seen.add(e);
    else invalid.push(v.trim());
  }
  const all = [...seen];
  return { emails: all.slice(0, MAX_PER_SEND), invalid, overflow: Math.max(0, all.length - MAX_PER_SEND) };
}
