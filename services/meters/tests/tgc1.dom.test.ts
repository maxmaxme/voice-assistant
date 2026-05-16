import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseBalance, parseMeterCards } from '../src/portals/tgc1.dom.ts';

const here = dirname(fileURLToPath(import.meta.url));
const balanceHtml = readFileSync(resolve(here, 'fixtures/tgc1-balance.html'), 'utf8');
const readingsHtml = readFileSync(resolve(here, 'fixtures/tgc1-readings.html'), 'utf8');

describe('parseBalance', () => {
  it('extracts account id and the full balance phrase', () => {
    expect(parseBalance(balanceHtml)).toEqual({
      accountId: '7060001472',
      balanceText: 'переплата 75.18 руб',
    });
  });

  it('returns null when the section is missing', () => {
    expect(parseBalance('<html><body></body></html>')).toBeNull();
  });
});

describe('parseMeterCards', () => {
  it('extracts every meter card on the page', () => {
    const cards = parseMeterCards(readingsHtml);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      meter: '210214605',
      kind: 'ГВС м3',
      accountId: '7060001472',
      lastDate: '22.04.2026',
      lastValue: 15.013,
    });
    expect(cards[1]).toMatchObject({
      meter: '03599873',
      kind: 'Отопление',
      lastValue: 10.54,
    });
  });

  it('parses values that use a comma as decimal separator', () => {
    const html = readingsHtml.replace('15.013', '15,013');
    const cards = parseMeterCards(html);
    expect(cards[0].lastValue).toBe(15.013);
  });
});
