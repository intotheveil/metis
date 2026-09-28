// The Themis mark: the scales of judgement inside a gold ring, after the brand artwork.
// One component so header, hero and favicon (public/favicon.svg) stay the same drawing.
export function Mark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <defs>
        <linearGradient id="themis-gold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff3d1" />
          <stop offset="0.45" stopColor="#e3b964" />
          <stop offset="1" stopColor="#9a6f2a" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="30" fill="#0d0b09" stroke="url(#themis-gold)" strokeWidth="1.6" />
      <g
        fill="none"
        stroke="url(#themis-gold)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* pillar + finial + base */}
        <path d="M32 14v34M27 48h10M24 51h16" />
        <circle cx="32" cy="12.5" r="1.8" fill="url(#themis-gold)" />
        {/* beam */}
        <path d="M17 20h30" />
        {/* chains */}
        <path d="M18 20l-5 13M18 20l5 13M46 20l-5 13M46 20l5 13" strokeWidth="1.2" />
        {/* pans */}
        <path
          d="M11.5 33h13a6.5 4 0 0 1-13 0zM39.5 33h13a6.5 4 0 0 1-13 0z"
          fill="url(#themis-gold)"
        />
      </g>
    </svg>
  )
}
