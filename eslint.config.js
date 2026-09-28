import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

// --- THE SERVER/CLIENT SECRET BOUNDARY (PLAN P2.1, constraint 6) ---------------------------------
// Themis is a static site: everything under src/** can end up in the public bundle, and Vite inlines
// `import.meta.env.X` at build time. Server-only secrets belong in Edge Functions
// (supabase/functions/**) and ops scripts (scripts/**), never here. Both the spec's bare names and
// the ADR-0002 `THEMIS_`-prefixed names are blocked. The companion check is `npm run check:bundle`,
// which scans the built dist/ for secret-looking values the lint rule cannot see (e.g. a secret
// pasted into an allowed VITE_ var).
const SERVER_SECRET =
  '/^(THEMIS_)?(ANTHROPIC_API_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET)$|^SUPABASE_SERVICE_ROLE_KEY$|^SUPABASE_ACCESS_TOKEN$/'
// Any VITE_ name except the constraint-6 allow-list: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
// VITE_STRIPE_PUBLISHABLE_KEY and the fleet-telemetry VITE_FLEET_* names.
const VITE_NOT_ALLOWED =
  '/^VITE_(?!(SUPABASE_URL|SUPABASE_ANON_KEY|STRIPE_PUBLISHABLE_KEY)$|FLEET_[A-Z0-9_]+$)/'

// `import.meta.env` and `process.env` as the object of a member access.
const META_ENV =
  "[object.type='MemberExpression'][object.object.type='MetaProperty'][object.property.name='env']"
const PROCESS_ENV =
  "[object.type='MemberExpression'][object.object.name='process'][object.property.name='env']"

const SECRET_MSG =
  'Server-only secret in browser code. Vite inlines env reads into the public bundle. This name belongs in supabase/functions/** (Edge Function secret) or scripts/**, never in src/** (PLAN constraint 6, ADR-0002).'
const VITE_MSG =
  'VITE_ name outside the allow-list. Every VITE_ var is inlined into the public bundle. Browser code may read only VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_STRIPE_PUBLISHABLE_KEY and VITE_FLEET_* (PLAN constraint 6).'

/** @param {string} name regex literal for the env var name  @param {string} message */
const envReads = (name, message) =>
  [META_ENV, PROCESS_ENV].flatMap((obj) => [
    // import.meta.env.X / process.env.X
    {
      selector: `MemberExpression${obj}[computed=false] > Identifier.property[name=${name}]`,
      message,
    },
    // import.meta.env['X'] / process.env['X']
    {
      selector: `MemberExpression${obj}[computed=true] > Literal.property[value=${name}]`,
      message,
    },
  ])

/** const { X } = import.meta.env / process.env */
const envDestructures = (name, message) => [
  {
    selector: `VariableDeclarator[init.type='MemberExpression'][init.object.type='MetaProperty'][init.property.name='env'] > ObjectPattern > Property > Identifier.key[name=${name}]`,
    message,
  },
  {
    selector: `VariableDeclarator[init.type='MemberExpression'][init.object.name='process'][init.property.name='env'] > ObjectPattern > Property > Identifier.key[name=${name}]`,
    message,
  },
]

export default tseslint.config(
  { ignores: ['dist', 'coverage', '.claude'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: { ecmaVersion: 2023, globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    // Browser code only. supabase/functions/**, scripts/** and e2e/** are deliberately outside
    // `files`: that is where server-side names are legitimately read.
    files: ['src/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...envReads(SERVER_SECRET, SECRET_MSG),
        ...envDestructures(SERVER_SECRET, SECRET_MSG),
        ...envReads(VITE_NOT_ALLOWED, VITE_MSG),
        ...envDestructures(VITE_NOT_ALLOWED, VITE_MSG),
      ],
    },
  },
)
