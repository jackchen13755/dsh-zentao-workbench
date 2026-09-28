/**
 * Severity colours for the panel.
 *
 * Driven by the **numeric** level the list markup carries (`data-severity='3'`)
 * rather than the Chinese label, because instances rename their levels — this
 * one displays 主要/次要 while the attribute still says 3/4, and stock ZenTao
 * calls the same ranks 一般/建议.
 *
 * Colours are plain hex on purpose: they must stay readable on both the light
 * and the dark shell theme, and a badge is the one place where a fixed palette
 * beats a theme variable.
 */

export interface SeverityTone {
  /** Badge background. */
  bg: string
  /** Badge text colour. */
  fg: string
  /** Human hint for tooltips, e.g. "致命". */
  rank: string
}

/** Level → tone. Extend the map, not the call sites, when a new rank appears. */
const TONES: Record<number, SeverityTone> = {
  1: { bg: '#b91c1c', fg: '#ffffff', rank: '1 · 致命/最高' },
  2: { bg: '#ef4444', fg: '#ffffff', rank: '2 · 严重' },
  3: { bg: '#f59e0b', fg: '#1f2937', rank: '3 · 主要/一般' },
  4: { bg: '#3b82f6', fg: '#ffffff', rank: '4 · 次要/建议' },
  5: { bg: '#6b7280', fg: '#ffffff', rank: '5 · 轻微' },
}

/** Neutral tone for an unknown rank — never guess a severity colour. */
export const NEUTRAL_TONE: SeverityTone = { bg: '#e5e7eb', fg: '#374151', rank: '未知级别' }

/** Tone for one row, by numeric level when known, else by label, else neutral. */
export function severityTone(level: number | null | undefined, label = ''): SeverityTone {
  if (typeof level === 'number' && Number.isFinite(level)) {
    return TONES[level] ?? NEUTRAL_TONE
  }
  // Fallbacks for markup without `data-severity`: both vocabularies, since this
  // instance and stock ZenTao name the same ranks differently.
  const text = label.trim()
  if (/致命|严重|主要|blocker|critical|major/.test(text)) return TONES[1]!
  if (/一般|normal/.test(text)) return TONES[3]!
  if (/次要|建议|轻微|minor|trivial|suggestion/.test(text)) return TONES[4]!
  return NEUTRAL_TONE
}
