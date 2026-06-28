export type DiffLine = { type: 'same' | 'add' | 'del', text: string }

/** Line-level diff from `oldText` (default) to `newText` (current), via an LCS
 *  walk. `del` = lines only in the default (removed, red), `add` = lines only in
 *  the current (added, green). Prompts are short, so O(n·m) is fine. */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i]! })
      i++
      j++
    }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: 'del', text: a[i]! })
      i++
    }
    else {
      out.push({ type: 'add', text: b[j]! })
      j++
    }
  }
  while (i < m) out.push({ type: 'del', text: a[i++]! })
  while (j < n) out.push({ type: 'add', text: b[j++]! })
  return out
}
