import { useMemo, useState } from 'react'
import {
  MAX_SCORE,
  METHODOLOGIES,
  SCALES,
  presetCriteria,
  rank,
  verdict,
  type Criterion,
  type Methodology,
  type Option,
  type Scale,
  type Scores,
} from './lib/decision'
import { Mark } from './Mark'

// Modules from the brand brief that are NOT built yet — shown as roadmap, never as features.
const ROADMAP = [
  'SWOT analysis',
  'Scenario planning',
  'Risk analysis',
  'Cost–benefit',
  'Stakeholder mapping',
  'Executive reports',
]

let seq = 0
const uid = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`

const STARTER_OPTIONS: Option[] = [
  { id: 'o1', name: 'Option A' },
  { id: 'o2', name: 'Option B' },
]

export default function App() {
  const [methodology, setMethodology] = useState<Methodology>('agile')
  const [scale, setScale] = useState<Scale>('mid')
  const [question, setQuestion] = useState('')
  const [criteria, setCriteria] = useState<Criterion[]>(() => presetCriteria('agile', 'mid'))
  const [options, setOptions] = useState<Option[]>(STARTER_OPTIONS)
  const [scores, setScores] = useState<Scores>({})

  const applyPreset = (m: Methodology, s: Scale) => {
    setMethodology(m)
    setScale(s)
    setCriteria(presetCriteria(m, s))
    setScores({})
  }

  const ranked = useMemo(() => rank(options, criteria, scores), [options, criteria, scores])
  const result = verdict(ranked)

  const setScore = (o: string, c: string, v: number | undefined) =>
    setScores((prev) => {
      const row = { ...(prev[o] ?? {}) }
      if (v === undefined) delete row[c]
      else row[c] = v
      return { ...prev, [o]: row }
    })

  return (
    <div className="min-h-screen">
      <Header />

      <main className="mx-auto max-w-7xl px-4 pb-24 sm:px-6 lg:px-8">
        <section className="flex flex-col items-center pt-14 pb-12 text-center sm:pt-20">
          <div className="relative">
            <div className="absolute inset-0 -z-10 scale-150 rounded-full bg-accent/10 blur-3xl" />
            <Mark className="h-24 w-24 sm:h-28 sm:w-28" />
          </div>
          <h1 className="text-gold mt-8 font-display text-6xl font-semibold tracking-[0.12em] sm:text-8xl">
            THEMIS
          </h1>
          <p className="mt-4 font-display text-sm tracking-[0.42em] text-accent sm:text-base">
            DECISION INTELLIGENCE PLATFORM
          </p>
          <div className="rule-gold mt-5 h-px w-full max-w-xl" />
          <p className="mt-5 text-xs tracking-[0.3em] text-stone-400 uppercase sm:text-sm">
            Better analysis. Clearer options.{' '}
            <span className="text-accent">Stronger decisions.</span>
          </p>
          <p className="mt-8 max-w-2xl text-base leading-relaxed text-stone-400 sm:text-lg">
            Structure any decision into options, criteria and evidence — weighted for how your team
            delivers, Waterfall, Agile or YOLO, from a five-person startup to a regulated
            enterprise.
          </p>
        </section>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="space-y-6">
            <Panel step="01" title="Frame the decision">
              <label className="block text-sm font-medium text-stone-300" htmlFor="question">
                What are you deciding?
              </label>
              <input
                id="question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="e.g. Which vendor should run our data platform migration?"
                className="mt-2 w-full rounded-lg border border-ink-600 bg-ink-900 px-4 py-3 text-white placeholder:text-stone-500 focus:border-accent focus:ring-2 focus:ring-accent/30 focus:outline-none"
              />

              <div className="mt-6 grid gap-6 md:grid-cols-2">
                <Segmented
                  label="Delivery method"
                  value={methodology}
                  items={Object.entries(METHODOLOGIES).map(([k, v]) => ({
                    key: k as Methodology,
                    label: v.label,
                  }))}
                  onChange={(m) => applyPreset(m, scale)}
                  hint={METHODOLOGIES[methodology].tagline}
                />
                <Segmented
                  label="Organisation scale"
                  value={scale}
                  items={Object.entries(SCALES).map(([k, v]) => ({
                    key: k as Scale,
                    label: v.label.split(' ')[0],
                  }))}
                  onChange={(s) => applyPreset(methodology, s)}
                  hint={`${SCALES[scale].label} · ${SCALES[scale].hint}`}
                />
              </div>
              <p className="mt-4 text-xs text-stone-500">
                Changing method or scale reloads the recommended criteria and clears scores.
              </p>
            </Panel>

            <Panel
              step="02"
              title="Weigh the criteria"
              action={
                <GhostButton
                  onClick={() =>
                    setCriteria((c) => [...c, { id: uid('c'), name: 'New criterion', weight: 3 }])
                  }
                >
                  + Criterion
                </GhostButton>
              }
            >
              <ul className="divide-y divide-ink-700">
                {criteria.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-4 py-3">
                    <input
                      aria-label="Criterion name"
                      value={c.name}
                      onChange={(e) =>
                        setCriteria((all) =>
                          all.map((x) => (x.id === c.id ? { ...x, name: e.target.value } : x)),
                        )
                      }
                      className="min-w-0 flex-1 basis-full rounded-md border border-transparent bg-transparent px-2 py-1 text-stone-100 sm:basis-0 hover:border-ink-600 focus:border-accent focus:outline-none"
                    />
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={0}
                        max={5}
                        value={c.weight}
                        aria-label={`Weight for ${c.name}`}
                        onChange={(e) =>
                          setCriteria((all) =>
                            all.map((x) =>
                              x.id === c.id ? { ...x, weight: Number(e.target.value) } : x,
                            ),
                          )
                        }
                        className="w-32"
                      />
                      <span className="w-6 text-right font-mono text-sm text-accent">
                        {c.weight}
                      </span>
                      <RemoveButton
                        label={`Remove ${c.name}`}
                        disabled={criteria.length <= 1}
                        onClick={() => setCriteria((all) => all.filter((x) => x.id !== c.id))}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel
              step="03"
              title="Score the options"
              action={
                <GhostButton
                  onClick={() =>
                    setOptions((o) => [
                      ...o,
                      { id: uid('o'), name: `Option ${String.fromCharCode(65 + o.length)}` },
                    ])
                  }
                >
                  + Option
                </GhostButton>
              }
            >
              <div className="-mx-2 overflow-x-auto px-2">
                <table className="w-full min-w-[36rem] border-separate border-spacing-0 text-sm">
                  <thead>
                    <tr>
                      <th className="py-2 pr-4 text-left font-medium text-stone-500">Criterion</th>
                      {options.map((o) => (
                        <th key={o.id} className="px-2 py-2 text-left">
                          <div className="flex items-center gap-1">
                            <input
                              aria-label="Option name"
                              value={o.name}
                              onChange={(e) =>
                                setOptions((all) =>
                                  all.map((x) =>
                                    x.id === o.id ? { ...x, name: e.target.value } : x,
                                  ),
                                )
                              }
                              className="w-full min-w-0 rounded-md border border-transparent bg-transparent px-1 py-1 font-semibold text-white hover:border-ink-600 focus:border-accent focus:outline-none"
                            />
                            <RemoveButton
                              label={`Remove ${o.name}`}
                              disabled={options.length <= 2}
                              onClick={() => setOptions((all) => all.filter((x) => x.id !== o.id))}
                            />
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {criteria.map((c) => (
                      <tr key={c.id}>
                        <td className="border-t border-ink-700 py-2 pr-4 text-stone-300">
                          {c.name}
                          <span className="ml-2 font-mono text-xs text-stone-500">×{c.weight}</span>
                        </td>
                        {options.map((o) => (
                          <td key={o.id} className="border-t border-ink-700 px-2 py-2">
                            <ScorePicker
                              label={`${o.name} on ${c.name}`}
                              value={scores[o.id]?.[c.id]}
                              onChange={(v) => setScore(o.id, c.id, v)}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-4 text-xs text-stone-500">
                1 = poor · 3 = acceptable · 5 = excellent. Click a selected score again to clear it.
              </p>
            </Panel>
          </div>

          <aside className="space-y-6 lg:sticky lg:top-6 lg:self-start">
            <Panel step="04" title="Recommendation">
              {question && <p className="mb-4 text-sm text-stone-400 italic">“{question}”</p>}
              <VerdictBanner result={result} />
              <ol className="mt-5 space-y-4" aria-label="Ranking">
                {ranked.map((r, i) => (
                  <li key={r.option.id}>
                    <div className="flex items-baseline justify-between text-sm">
                      <span className="font-medium text-stone-200">
                        <span className="mr-2 font-mono text-stone-500">{i + 1}</span>
                        {r.option.name}
                      </span>
                      <span className="font-mono text-white">{r.score.toFixed(1)}</span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-700">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${i === 0 ? 'bg-accent' : 'bg-stone-500'}`}
                        style={{ width: `${r.score}%` }}
                      />
                    </div>
                    {r.coverage < 1 && (
                      <p className="mt-1 text-xs text-amber-300/80">
                        {Math.round(r.coverage * 100)}% scored
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            </Panel>

            <div className="rounded-2xl border border-dashed border-ink-600 p-5">
              <p className="font-mono text-[11px] tracking-[0.18em] text-stone-500 uppercase">
                On the roadmap
              </p>
              <h3 className="mt-2 font-semibold text-stone-200">AI analyst</h3>
              <p className="mt-1 text-sm leading-relaxed text-stone-400">
                Challenge assumptions, surface missing criteria and stress-test the winner with
                frontier models. Not live yet — today every number here is yours.
              </p>
              <ul className="mt-4 flex flex-wrap gap-2" aria-label="Planned modules">
                {ROADMAP.map((m) => (
                  <li
                    key={m}
                    className="rounded-full border border-ink-600 px-2.5 py-1 text-[11px] text-stone-400"
                  >
                    {m}
                  </li>
                ))}
              </ul>
            </div>
          </aside>
        </div>
      </main>

      <footer className="border-t border-ink-800">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-xs text-stone-500 sm:px-6 lg:px-8">
          <span>Themis · named for the Titaness of divine law and order, who holds the scales</span>
          <span>Runs entirely in your browser — nothing you enter leaves this page.</span>
        </div>
      </footer>
    </div>
  )
}

function Header() {
  return (
    <header className="border-b border-ink-800/80 bg-ink-950/70 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <Mark className="h-9 w-9" />
          <span className="text-gold font-display text-lg font-semibold tracking-[0.2em]">
            THEMIS
          </span>
        </div>
        <span className="rounded-full border border-accent/30 px-3 py-1 font-mono text-[11px] tracking-wider text-accent/80">
          PREVIEW
        </span>
      </div>
    </header>
  )
}

function Panel(props: {
  step: string
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="rounded-2xl border border-ink-700 bg-ink-850/80 p-5 shadow-xl shadow-black/20 sm:p-6">
      <div className="mb-5 flex items-center justify-between gap-4">
        <h2 className="flex items-center gap-3 text-base font-semibold text-white">
          <span className="font-mono text-xs text-accent">{props.step}</span>
          {props.title}
        </h2>
        {props.action}
      </div>
      {props.children}
    </section>
  )
}

function Segmented<K extends string>(props: {
  label: string
  value: K
  items: { key: K; label: string }[]
  onChange: (k: K) => void
  hint: string
}) {
  return (
    <div role="radiogroup" aria-label={props.label}>
      <p className="text-sm font-medium text-stone-300">{props.label}</p>
      <div className="mt-2 grid auto-cols-fr grid-flow-col rounded-lg border border-ink-600 bg-ink-900 p-1">
        {props.items.map((it) => {
          const on = it.key === props.value
          return (
            <button
              key={it.key}
              role="radio"
              aria-checked={on}
              onClick={() => props.onChange(it.key)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                on ? 'bg-ink-700 text-white shadow' : 'text-stone-400 hover:text-stone-200'
              }`}
            >
              {it.label}
            </button>
          )
        })}
      </div>
      <p className="mt-2 text-xs text-stone-500">{props.hint}</p>
    </div>
  )
}

function ScorePicker(props: {
  label: string
  value: number | undefined
  onChange: (v: number | undefined) => void
}) {
  return (
    <div role="group" aria-label={props.label} className="flex gap-1">
      {Array.from({ length: MAX_SCORE }, (_, i) => i + 1).map((n) => {
        const on = props.value === n
        return (
          <button
            key={n}
            aria-label={`${n}`}
            aria-pressed={on}
            onClick={() => props.onChange(on ? undefined : n)}
            className={`h-7 w-7 rounded-md font-mono text-xs transition-colors ${
              on
                ? 'bg-accent font-semibold text-ink-950'
                : props.value !== undefined && n < props.value
                  ? 'bg-accent/15 text-accent'
                  : 'bg-ink-800 text-stone-500 hover:bg-ink-700 hover:text-stone-200'
            }`}
          >
            {n}
          </button>
        )
      })}
    </div>
  )
}

function VerdictBanner({ result }: { result: ReturnType<typeof verdict> }) {
  const base = 'rounded-xl border px-4 py-3 text-sm'
  switch (result.kind) {
    case 'empty':
      return (
        <div className={`${base} border-ink-600 text-stone-400`}>Add at least two options.</div>
      )
    case 'incomplete':
      return (
        <div className={`${base} border-amber-400/30 bg-amber-400/5 text-amber-200`}>
          {result.missing} option{result.missing > 1 ? 's' : ''} still need scoring on every
          criterion.
        </div>
      )
    case 'close':
      return (
        <div className={`${base} border-zinc-400/30 bg-zinc-400/5 text-zinc-200`}>
          <strong className="font-semibold">Too close to call.</strong> {result.leaders[0].name} and{' '}
          {result.leaders[1].name} are {result.margin} points apart — gather more evidence on the
          heaviest criteria.
        </div>
      )
    case 'clear':
      return (
        <div className={`${base} border-accent/30 bg-accent/5 text-amber-50`}>
          <strong className="font-semibold">{result.winner.name}</strong> leads by {result.margin}{' '}
          points.
        </div>
      )
  }
}

function RemoveButton(props: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className="rounded-md p-1 text-stone-500 hover:bg-ink-700 hover:text-rose-300 disabled:pointer-events-none disabled:opacity-30"
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden>
        <path
          d="M4 4l8 8M12 4l-8 8"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    </button>
  )
}

function GhostButton(props: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={props.onClick}
      className="rounded-lg border border-ink-600 px-3 py-1.5 text-sm font-medium text-stone-300 transition-colors hover:border-accent/60 hover:text-white"
    >
      {props.children}
    </button>
  )
}
