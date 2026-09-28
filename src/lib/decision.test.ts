import {
  CLOSE_MARGIN,
  presetCriteria,
  rank,
  scoreOption,
  verdict,
  type Criterion,
  type Option,
} from './decision'

const A: Option = { id: 'a', name: 'A' }
const B: Option = { id: 'b', name: 'B' }
const crit: Criterion[] = [
  { id: 'x', name: 'X', weight: 4 },
  { id: 'y', name: 'Y', weight: 1 },
]

describe('scoreOption', () => {
  it('maps the 1–5 scale onto 0–100 (1 is worst, not 20%)', () => {
    expect(scoreOption(A, crit, { a: { x: 1, y: 1 } }).score).toBe(0)
    expect(scoreOption(A, crit, { a: { x: 5, y: 5 } }).score).toBe(100)
    expect(scoreOption(A, crit, { a: { x: 3, y: 3 } }).score).toBe(50)
  })

  it('weights criteria — the weight-4 criterion dominates', () => {
    // x=5 (unit 1) ×4, y=1 (unit 0) ×1 → 4/5 = 80
    expect(scoreOption(A, crit, { a: { x: 5, y: 1 } }).score).toBe(80)
    expect(scoreOption(A, crit, { a: { x: 1, y: 5 } }).score).toBe(20)
  })

  it('reports coverage and scores only what has been scored', () => {
    const r = scoreOption(A, crit, { a: { x: 5 } })
    expect(r.coverage).toBe(0.5)
    expect(r.score).toBe(100)
  })

  it('treats all-zero weights as score 0, never NaN', () => {
    const zero = crit.map((c) => ({ ...c, weight: 0 }))
    expect(scoreOption(A, zero, { a: { x: 5, y: 5 } }).score).toBe(0)
  })

  it('clamps out-of-range scores', () => {
    expect(scoreOption(A, crit, { a: { x: 9, y: -3 } }).score).toBe(80)
  })
})

describe('rank + verdict', () => {
  it('orders best first and keeps entry order on ties', () => {
    expect(
      rank([A, B], crit, { a: { x: 2, y: 2 }, b: { x: 4, y: 4 } }).map((r) => r.option.id),
    ).toEqual(['b', 'a'])
    expect(
      rank([A, B], crit, { a: { x: 3, y: 3 }, b: { x: 3, y: 3 } }).map((r) => r.option.id),
    ).toEqual(['a', 'b'])
  })

  it('needs two options', () => {
    expect(verdict(rank([A], crit, {}))).toEqual({ kind: 'empty' })
  })

  it('refuses to crown a winner while any option is partly scored', () => {
    const v = verdict(rank([A, B], crit, { a: { x: 5, y: 5 }, b: { x: 1 } }))
    expect(v).toEqual({ kind: 'incomplete', missing: 1 })
  })

  it('calls a clear winner with its margin', () => {
    const v = verdict(rank([A, B], crit, { a: { x: 5, y: 5 }, b: { x: 3, y: 3 } }))
    expect(v).toEqual({ kind: 'clear', winner: A, margin: 50 })
  })

  it(`calls it close under ${CLOSE_MARGIN} points`, () => {
    // A: x=4,y=4 → 75 ; B: x=4,y=3 → (0.75*4 + 0.5*1)/5 = 70 → margin 5 = clear boundary
    const atEdge = verdict(rank([A, B], crit, { a: { x: 4, y: 4 }, b: { x: 4, y: 3 } }))
    expect(atEdge.kind).toBe('clear')
    const inside = verdict(rank([A, B], crit, { a: { x: 4, y: 4 }, b: { x: 4, y: 4 } }))
    expect(inside).toMatchObject({ kind: 'close', margin: 0 })
  })
})

describe('presetCriteria', () => {
  it('weights risk & compliance up with organisation scale in Waterfall', () => {
    const w = (s: 'small' | 'enterprise') =>
      presetCriteria('waterfall', s).find((c) => c.name === 'Risk & compliance')!.weight
    expect(w('enterprise')).toBeGreaterThan(w('small'))
  })

  it('gives every preset unique ids and weights within 1–5', () => {
    for (const m of ['waterfall', 'agile', 'yolo'] as const)
      for (const s of ['small', 'mid', 'enterprise'] as const) {
        const cs = presetCriteria(m, s)
        expect(new Set(cs.map((c) => c.id)).size).toBe(cs.length)
        for (const c of cs) expect(c.weight).toBeGreaterThanOrEqual(1)
        for (const c of cs) expect(c.weight).toBeLessThanOrEqual(5)
      }
  })
})
