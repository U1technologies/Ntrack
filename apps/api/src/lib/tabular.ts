import ExcelJS from 'exceljs';

type Row = Record<string, unknown>;

/**
 * Spreadsheet apps execute cells that start with = + - @ (CSV/formula injection). Text values
 * get a leading apostrophe; real numbers are left alone so negative amounts stay numeric.
 */
const neutralize = (value: unknown): string | number => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? value : '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
};

const csvCell = (value: unknown) => `"${String(neutralize(value)).replace(/"/g, '""')}"`;

/** One CSV line (with trailing newline) for streaming exports. */
export const csvLine = (values: unknown[]): string => `${values.map(csvCell).join(',')}\n`;

export const toCsv = (rows: Row[], columns: string[]): string =>
  [columns.join(','), ...rows.map((row) => columns.map((c) => csvCell(row[c])).join(','))].join('\n');

export const toXlsx = async (rows: Row[], columns: string[], sheetName = 'Report'): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'NTrack';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Report');
  sheet.columns = columns.map((key) => ({ header: key, key, width: Math.min(40, Math.max(12, key.length + 2)) }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  for (const row of rows) sheet.addRow(Object.fromEntries(columns.map((c) => [c, neutralize(row[c])])));
  return Buffer.from(await workbook.xlsx.writeBuffer());
};

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
