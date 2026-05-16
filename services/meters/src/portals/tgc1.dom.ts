import { parse } from 'node-html-parser';

export interface ParsedBalance {
  accountId: string;
  balanceText: string;
}

export interface ParsedMeterCard {
  meter: string;
  kind: string;
  accountId: string;
  lastDate: string; // 'DD.MM.YYYY'
  lastValue: number;
}

const BALANCE_RE = /№\s*(\d+)\s+имеется\s+(.+?)\s+в\s+размере\s+([\d.,]+)\s+руб/u;

export function parseBalance(html: string): ParsedBalance | null {
  const root = parse(html);
  const section = root.querySelector('section.account-summary');
  if (!section) {
    return null;
  }
  const text = section.text.replace(/\s+/g, ' ').trim();
  const m = text.match(BALANCE_RE);
  if (!m) {
    return null;
  }
  return {
    accountId: m[1],
    balanceText: `${m[2].trim()} ${m[3]} руб`,
  };
}

function toNumber(raw: string): number {
  return Number(raw.replace(',', '.'));
}

export function parseMeterCards(html: string): ParsedMeterCard[] {
  const root = parse(html);
  const cards = root.querySelectorAll('article.meter-card');
  return cards.map((card) => {
    const meter = card.getAttribute('data-meter') ?? '';
    const kind = card.querySelector('.kind')?.text.trim() ?? '';
    const accountId = card.querySelector('.account')?.text.trim() ?? '';
    const lastDate = card.querySelector('.last-date')?.text.trim() ?? '';
    const lastValueRaw = card.querySelector('.last-value')?.text.trim() ?? '';
    return { meter, kind, accountId, lastDate, lastValue: toNumber(lastValueRaw) };
  });
}
