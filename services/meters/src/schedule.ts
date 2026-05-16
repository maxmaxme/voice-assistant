/** 1 = Mon, ..., 5 = Fri, 6 = Sat, 0 = Sun (JS Date.getDay()). */
function isWeekday(year: number, month: number, day: number): boolean {
  // month is 1-12, Date expects 0-11
  const d = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return d >= 1 && d <= 5;
}

/** First Mon-Fri date on or after the 15th. Always in [15,21]. */
export function targetDay(year: number, month: number): number {
  for (let d = 15; d <= 21; d++) {
    if (isWeekday(year, month, d)) {
      return d;
    }
  }
  throw new Error(`No weekday in window for ${year}-${month}`); // unreachable
}

/** Latest Mon-Fri date in [15,21]. */
export function lastWeekdayOfWindow(year: number, month: number): number {
  for (let d = 21; d >= 15; d--) {
    if (isWeekday(year, month, d)) {
      return d;
    }
  }
  throw new Error(`No weekday in window for ${year}-${month}`); // unreachable
}

/** True if `day` is a weekday in [15,21]. */
export function isInWindow(year: number, month: number, day: number): boolean {
  if (day < 15 || day > 21) {
    return false;
  }
  return isWeekday(year, month, day);
}
