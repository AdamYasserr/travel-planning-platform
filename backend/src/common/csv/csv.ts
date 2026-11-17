/**
 * CSV for spreadsheets, safe against formula (CSV) injection: a cell that starts with = + - @ (or a
 * tab / carriage return, which some spreadsheets also treat as a formula start) gets a leading single
 * quote, so it is shown as text and never evaluated. Cells containing a quote, comma or line break are
 * wrapped in double quotes, with inner quotes doubled (RFC 4180). Lines end with CRLF.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
