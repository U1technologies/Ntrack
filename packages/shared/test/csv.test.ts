import { describe, expect, it } from 'vitest';
import { parseCsv, parseReportDate, parseReportNumber } from '../src/csv';

describe('parseCsv', () => {
  it('handles quotes, embedded commas, escaped quotes, CRLF and a BOM', () => {
    const { headers, records } = parseCsv('﻿Date,Feed,"Revenue"\r\n2026-10-01,"feed, A","1,234.50"\r\n2026-10-02,"say ""hi""",5\r\n');
    expect(headers).toEqual(['date', 'feed', 'revenue']);
    expect(records[0]).toEqual({ line: 2, values: { date: '2026-10-01', feed: 'feed, A', revenue: '1,234.50' } });
    expect(records[1]?.values.feed).toBe('say "hi"');
  });

  it('skips blank lines and enforces the row limit', () => {
    expect(parseCsv('a\n\n1\n').records).toHaveLength(1);
    expect(() => parseCsv('a\n1\n2\n', 1)).toThrow();
  });
});

describe('report value parsing', () => {
  it('normalises money and percentages', () => {
    expect(parseReportNumber('$1,234.50')).toBe('1234.50');
    expect(parseReportNumber('12%')).toBe('12');
    expect(parseReportNumber('abc')).toBeNull();
  });

  it('parses common date formats and rejects invalid dates', () => {
    expect(parseReportDate('2026/10/03')).toBe('2026-10-03');
    expect(parseReportDate('10/03/2026', 'mdy')).toBe('2026-10-03');
    expect(parseReportDate('03-10-2026', 'dmy')).toBe('2026-10-03');
    expect(parseReportDate('2026-13-01')).toBeNull();
  });
});
