export function judgmentPreview(e, fallback = '') {
  const text = Array.from(String(e?.msg ?? fallback ?? ''))
  return JSON.stringify(text.slice(0, 30).join('') + (text.length > 30 ? '...' : ''))
}

export function writeJudgmentLog(level, message) {
  // Diagnostics must not change decisions or strand queued callers.
  try { globalThis.logger?.[level]?.(message) } catch {}
}
