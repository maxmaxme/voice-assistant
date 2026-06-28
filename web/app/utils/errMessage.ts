export function errMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'statusMessage' in e) {
    return String((e as { statusMessage?: string }).statusMessage)
  }
  return e instanceof Error ? e.message : String(e)
}
