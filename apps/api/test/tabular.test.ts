import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { toCsv, toXlsx } from '../src/lib/tabular';

describe('toCsv', () => {
  it('neutralizes formula-like text but keeps negative numbers numeric', () => {
    const csv = toCsv([{ name: '=HYPERLINK("x")', profit: -12.5, note: '-not a number' }], ['name', 'profit', 'note']);
    expect(csv.split('\n')[1]).toBe(`"'=HYPERLINK(""x"")","-12.5","'-not a number"`);
  });
});

describe('toXlsx', () => {
  it('writes a header row and typed cells that open back as numbers', async () => {
    const buffer = await toXlsx([{ campaign: 'Spring', clicks: 120, profit: -3.25 }, { campaign: '@cmd', clicks: 1, profit: 0 }], ['campaign', 'clicks', 'profit'], 'Perf/Report');
    const workbook = new ExcelJS.Workbook();
    // exceljs types predate Node 22 Buffer generics.
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0]!;
    expect(sheet.name).toBe('Perf Report');
    expect(sheet.getRow(1).values).toEqual([undefined, 'campaign', 'clicks', 'profit']);
    expect(sheet.getCell('C2').value).toBe(-3.25);
    expect(sheet.getCell('A3').value).toBe("'@cmd");
  });
});
