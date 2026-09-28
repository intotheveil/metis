// The decision model — pure functions, no React. Everything the UI shows as a
// result is computed here so it can be tested without rendering.

export type Methodology = 'waterfall' | 'agile' | 'yolo'
export type Scale = 'small' | 'mid' | 'enterprise'

export interface Criterion {
  id: string
  name: string
  /** Importance, 1 (nice to have) … 5 (decisive). */
  weight: number
}

export interface Option {
  id: string
  name: string
}

/** scores[optionId][criterionId] = 1 (poor) … 5 (excellent). Missing = unscored. */
export type Scores = Record<string, Record<string, number>>

export interface Ranked {
  option: Option
  /** Weighted score normalised to 0–100 over the scored criteria. */
  score: number
  /** Share of criteria this option has been scored on, 0–1. */
  coverage: number
}

export type Verdict =
  | { kind: 'empty' }
  | { kind: 'incomplete'; missing: number }
  | { kind: 'clear'; winner: Option; margin: number }
  | { kind: 'close'; leaders: [Option, Option]; margin: number }

export const MIN_SCORE = 1
export const MAX_SCORE = 5
/** Below this many points (of 100) between #1 and #2, the call is too close to make. */
export const CLOSE_MARGIN = 5

export const METHODOLOGIES: Record<Methodology, { label: string; tagline: string }> = {
  waterfall: { label: 'Waterfall', tagline: 'Plan-driven. Commit once, commit right.' },
  agile: { label: 'Agile', tagline: 'Iterative. Optimise for learning and reversibility.' },
  yolo: { label: 'YOLO', tagline: 'Ship-first. Bias to speed, bounded downside.' },
}

export const SCALES: Record<Scale, { label: string; hint: string }> = {
  small: { label: 'Startup / small', hint: '1–50 people' },
  mid: { label: 'Mid-size', hint: '50–1,000 people' },
  enterprise: { label: 'Enterprise', hint: '1,000+ people' },
}

type Preset = { name: string; weight: Record<Scale, number> }

const PRESETS: Record<Methodology, Preset[]> = {
  waterfall: [
    { name: 'Requirements fit', weight: { small: 4, mid: 5, enterprise: 5 } },
    { name: 'Risk & compliance', weight: { small: 2, mid: 4, enterprise: 5 } },
    { name: 'Cost certainty', weight: { small: 4, mid: 4, enterprise: 4 } },
    { name: 'Schedule impact', weight: { small: 3, mid: 3, enterprise: 3 } },
    { name: 'Stakeholder alignment', weight: { small: 2, mid: 3, enterprise: 5 } },
  ],
  agile: [
    { name: 'Customer value', weight: { small: 5, mid: 5, enterprise: 5 } },
    { name: 'Time to feedback', weight: { small: 5, mid: 4, enterprise: 3 } },
    { name: 'Reversibility', weight: { small: 3, mid: 4, enterprise: 4 } },
    { name: 'Team capacity', weight: { small: 4, mid: 3, enterprise: 3 } },
    { name: 'Technical debt', weight: { small: 2, mid: 3, enterprise: 4 } },
  ],
  yolo: [
    { name: 'Upside if it works', weight: { small: 5, mid: 5, enterprise: 4 } },
    { name: 'Speed to ship', weight: { small: 5, mid: 4, enterprise: 3 } },
    { name: 'Survivable if wrong', weight: { small: 3, mid: 4, enterprise: 5 } },
    { name: 'Momentum / morale', weight: { small: 3, mid: 2, enterprise: 2 } },
  ],
}

export function presetCriteria(methodology: Methodology, scale: Scale): Criterion[] {
  return PRESETS[methodology].map((p, i) => ({
    id: `c${i + 1}`,
    name: p.name,
    weight: p.weight[scale],
  }))
}

export function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo
  return Math.min(hi, Math.max(lo, n))
}

/**
 * Weighted score for one option, normalised to 0–100 over the criteria it has
 * been scored on. A 1 maps to 0 and a 5 to 100, so the scale's floor means
 * "worst", not "20% good". Weights of 0 contribute nothing.
 */
export function scoreOption(option: Option, criteria: Criterion[], scores: Scores): Ranked {
  const row = scores[option.id] ?? {}
  let num = 0
  let den = 0
  let scored = 0
  for (const c of criteria) {
    const s = row[c.id]
    if (s === undefined) continue
    scored++
    const unit = (clamp(s, MIN_SCORE, MAX_SCORE) - MIN_SCORE) / (MAX_SCORE - MIN_SCORE)
    num += unit * c.weight
    den += c.weight
  }
  return {
    option,
    score: den === 0 ? 0 : Math.round((num / den) * 1000) / 10,
    coverage: criteria.length === 0 ? 0 : scored / criteria.length,
  }
}

/** All options, best first. Ties keep the order the options were entered in. */
export function rank(options: Option[], criteria: Criterion[], scores: Scores): Ranked[] {
  return options
    .map((o) => scoreOption(o, criteria, scores))
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.score - a.r.score || a.i - b.i)
    .map(({ r }) => r)
}

export function verdict(ranked: Ranked[]): Verdict {
  if (ranked.length < 2) return { kind: 'empty' }
  const missing = ranked.filter((r) => r.coverage < 1).length
  if (missing > 0) return { kind: 'incomplete', missing }
  const [a, b] = ranked
  const margin = Math.round((a.score - b.score) * 10) / 10
  return margin < CLOSE_MARGIN
    ? { kind: 'close', leaders: [a.option, b.option], margin }
    : { kind: 'clear', winner: a.option, margin }
}
