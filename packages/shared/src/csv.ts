/**
 * RFC 4180 CSV parsing for partner report imports: quoted fields, escaped quotes (""), commas and
 * newlines inside quotes, CRLF line endings, optional UTF-8 BOM. Returns header-keyed records with
 * lowercase, trimmed header names.
 */
export const parseCsvRows = (text: string): string[][] => {
  const input = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field === '') inQuotes = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  return rows;
};

export interface CsvRecords {
  headers: string[];
  records: Array<{ line: number; values: Record<string, string> }>;
}

export const parseCsv = (text: string, maxRows = 50_000): CsvRecords => {
  const rows = parseCsvRows(text);
  const [header, ...body] = rows;
  if (!header) return { headers: [], records: [] };
  const headers = header.map((h) => h.trim().toLowerCase());
  if (body.length > maxRows) throw new Error(`CSV has ${body.length} rows; the limit is ${maxRows}`);
  return {
    headers,
    records: body.map((cells, index) => ({ line: index + 2, values: Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? '').trim()])) })),
  };
};

/** Parses report numbers like "1,234.50", "$12.00" or "12%" into a plain decimal string, or null. */
export const parseReportNumber = (raw: string | undefined): string | null => {
  if (raw === undefined) return null;
  const cleaned = raw.replace(/[\s,$€£₹%]/g, '');
  if (cleaned === '') return null;
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? cleaned : null;
};

/** Accepts YYYY-MM-DD, YYYY/MM/DD, MM/DD/YYYY or DD-MM-YYYY (with explicit format) and returns YYYY-MM-DD. */
export const parseReportDate = (raw: string | undefined, format: 'ymd' | 'mdy' | 'dmy' = 'ymd'): string | null => {
  if (!raw) return null;
  const parts = raw.trim().split(/[-/.]/).map((p) => p.padStart(2, '0'));
  if (parts.length !== 3) return null;
  const [a, b, c] = parts as [string, string, string];
  const [y, m, d] = format === 'ymd' ? [a, b, c] : format === 'mdy' ? [c, a, b] : [c, b, a];
  if (!/^\d{4}$/.test(y) || Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  const iso = `${y}-${m}-${d}`;
  return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? null : iso;
};
