import { describe, expect, it } from 'vitest'
import { NEUTRAL_TONE, severityTone } from '../src/severity.js'

/**
 * Severity colours are driven by the numeric rank the markup carries, because
 * instances rename their levels (this one shows 主要/次要 where stock ZenTao
 * says 一般/建议) while `data-severity` stays numeric.
 */
describe('severityTone', () => {
  it('gives every known rank its own background', () => {
    const backgrounds = [1, 2, 3, 4, 5].map((level) => severityTone(level).bg)
    expect(new Set(backgrounds).size).toBe(backgrounds.length)
  })

  it('maps the numeric rank regardless of the label', () => {
    expect(severityTone(1, '主要')).toEqual(severityTone(1, '致命'))
    expect(severityTone(3, '主要').bg).toBe(severityTone(3, '一般').bg)
    expect(severityTone(3, '主要').bg).not.toBe(severityTone(4, '次要').bg)
  })

  it('falls back to the label when the markup has no rank', () => {
    expect(severityTone(null, '主要').bg).toBe(severityTone(1).bg)
    expect(severityTone(null, '一般').bg).toBe(severityTone(3).bg)
    expect(severityTone(null, '次要').bg).toBe(severityTone(4).bg)
    expect(severityTone(null, '建议').bg).toBe(severityTone(4).bg)
  })

  it('never invents a colour for an unknown level', () => {
    expect(severityTone(99)).toEqual(NEUTRAL_TONE)
    expect(severityTone(null, '什么级别')).toEqual(NEUTRAL_TONE)
    expect(severityTone(undefined, '')).toEqual(NEUTRAL_TONE)
  })

  it('keeps text readable on its background (dark text on light fills, light on dark)', () => {
    for (const level of [1, 2, 3, 4, 5]) {
      const tone = severityTone(level)
      const luminance = (hex: string) => {
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
      }
      const bg = luminance(tone.bg)
      const fg = luminance(tone.fg)
      expect(Math.abs(bg - fg)).toBeGreaterThan(0.35)
    }
  })
})
