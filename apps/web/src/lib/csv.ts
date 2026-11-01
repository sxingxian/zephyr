/**
 * CSV for spreadsheets. Every cell is quoted, and a cell that a spreadsheet would treat as a formula
 * (starting with = + - @, a tab or a carriage return) is prefixed with an apostrophe, so text a guest typed
 * can never run as a formula when the photographer opens the file (OWASP "CSV injection").
 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
export function toCsv(rows: unknown[][]): string {
  // CRLF line ends and a byte-order mark so Excel opens UTF-8 names correctly.
  return `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
