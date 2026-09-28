import { fireEvent, render, screen, within } from '@testing-library/react'
import App from './App'

function score(option: string, criterion: string, n: number) {
  fireEvent.click(
    within(screen.getByRole('group', { name: `${option} on ${criterion}` })).getByRole('button', {
      name: String(n),
    }),
  )
}

describe('App', () => {
  it('loads Agile / Mid-size preset criteria by default', () => {
    render(<App />)
    expect(screen.getByRole('radio', { name: 'Agile' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getAllByDisplayValue('Customer value').length).toBe(1)
  })

  it('switching method swaps the criteria', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('radio', { name: 'Waterfall' }))
    expect(screen.getByDisplayValue('Risk & compliance')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('Customer value')).toBeNull()
  })

  it('names a winner only once every option is fully scored', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('radio', { name: 'YOLO' }))
    const crits = [
      'Upside if it works',
      'Speed to ship',
      'Survivable if wrong',
      'Momentum / morale',
    ]
    expect(screen.getByText(/still need scoring/)).toBeInTheDocument()
    for (const c of crits) score('Option A', c, 5)
    for (const c of crits) score('Option B', c, 2)
    expect(screen.getByText(/leads by/)).toHaveTextContent('Option A leads by 75 points')
  })
})

describe('brand', () => {
  it('carries the Themis wordmark and presents unbuilt modules as roadmap, not features', () => {
    render(<App />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('THEMIS')
    const roadmap = screen.getByRole('list', { name: 'Planned modules' })
    expect(within(roadmap).getByText('SWOT analysis')).toBeInTheDocument()
    expect(screen.getByText(/Not live yet/)).toBeInTheDocument()
  })
})
