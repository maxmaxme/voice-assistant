const TZ = 'Europe/Moscow';

export function currentPeriod(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);

  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  if (!year || !month) {
    throw new Error('Intl.DateTimeFormat returned no year/month');
  }
  return `${year}-${month}`;
}
