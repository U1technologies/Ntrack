import { describe, expect, it } from 'vitest';
import { parseTemplate, renderJsonTemplate, renderTemplate, validateJsonTemplate } from '../src/macros';

describe('parseTemplate', () => {
  it('reports unknown macros instead of leaving them in the URL', () => {
    expect(parseTemplate('https://x.com/?a={nope}', 'destination').errors).toEqual(['Unknown macro {nope}.']);
  });

  it('rejects postback-only macros in destination templates', () => {
    expect(parseTemplate('https://x.com/?p={payout}', 'destination').errors[0]).toContain('not available in destination');
  });

  it('treats doubled braces as literal braces', () => {
    expect(renderTemplate('https://x.com/?t={{raw}}', {}, { context: 'destination', encoding: 'query' })).toBe('https://x.com/?t={raw}');
  });
});

describe('renderTemplate', () => {
  it('URL-encodes values so they cannot add parameters', () => {
    const url = renderTemplate('https://x.com/?s={subid1}&c={click_id}', { subid1: 'a&evil=1', click_id: 'ABC' }, { context: 'destination', encoding: 'query' });
    expect(url).toBe('https://x.com/?s=a%26evil%3D1&c=ABC');
  });

  it('renders missing values as empty strings', () => {
    expect(renderTemplate('https://x.com/?s={subid2}', {}, { context: 'destination', encoding: 'query' })).toBe('https://x.com/?s=');
  });
});

describe('JSON templates', () => {
  it('renders macros in string values without encoding', () => {
    expect(renderJsonTemplate({ id: '{conversion_id}', amount: '{payout}', n: 1 }, { conversion_id: 'c1', payout: '2.50' })).toEqual({
      id: 'c1',
      amount: '2.50',
      n: 1,
    });
  });

  it('collects errors from nested values', () => {
    expect(validateJsonTemplate({ a: ['{bad}'] })).toEqual(['Unknown macro {bad}.']);
  });
});
