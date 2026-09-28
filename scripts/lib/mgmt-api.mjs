// THE SUPABASE MANAGEMENT-API SQL CLIENT — used by `npm run db:apply` (PLAN P1.11, ADR-0002 rule 3)
//
// One call: POST https://api.supabase.com/v1/projects/{ref}/database/query with `{ query }` and a
// personal access token as a Bearer header. Nothing else. No `supabase` CLI, no .env loading: the
// caller hands in the token and ref it read from the environment.
//
// The HTTP layer is injectable (`fetch`), so the whole applier is testable with a fake and no
// network. Every error this module throws has the token redacted from its message, whatever the
// server or the network stack echoed back.

export const MGMT_API_BASE = 'https://api.supabase.com'
export const REDACTED = '[REDACTED]'

/**
 * Replace every occurrence of each secret in `text` with [REDACTED]. Empty secrets are ignored.
 * @param {string} text
 * @param {ReadonlyArray<string | undefined>} secrets
 * @returns {string}
 */
export function redact(text, secrets) {
  let out = String(text)
  for (const s of secrets) {
    if (s) out = out.split(s).join(REDACTED)
  }
  return out
}

/** An error from the Management API or the network, with the token already redacted. */
export class MgmtApiError extends Error {
  /**
   * @param {string} message
   * @param {number | null} status  HTTP status, or null when the request never got a response
   */
  constructor(message, status) {
    super(message)
    this.name = 'MgmtApiError'
    this.status = status
  }
}

/**
 * Pull a human-readable error out of a response body, or null when the body is a success payload.
 * The query endpoint answers a success with a JSON ARRAY of rows (empty for DDL / ROLLBACK); an
 * error arrives as an object carrying `message` or `error` (e.g. `{"message":"Failed to run sql
 * query: ERROR: …"}`), usually with a 4xx status but not always, so the body is checked too.
 * @param {unknown} body
 * @returns {string | null}
 */
export function errorFromPayload(body) {
  if (Array.isArray(body)) return null
  if (body && typeof body === 'object') {
    const o = /** @type {Record<string, unknown>} */ (body)
    for (const key of ['message', 'error', 'msg']) {
      const v = o[key]
      if (typeof v === 'string' && v) return v
      if (v && typeof v === 'object') return JSON.stringify(v)
    }
    return `unexpected response payload: ${JSON.stringify(body).slice(0, 300)}`
  }
  return `unexpected response payload: ${String(body).slice(0, 300)}`
}

/**
 * @typedef {Record<string, unknown>} Row
 * @typedef {{ query: (sql: string) => Promise<Row[]> }} MgmtClient
 */

/**
 * Create a SQL client for one project.
 * @param {{ token: string, ref: string, fetch?: typeof fetch, baseUrl?: string }} opts
 * @returns {MgmtClient}
 */
export function createMgmtClient({ token, ref, fetch: fetchImpl = globalThis.fetch, baseUrl }) {
  if (!token) throw new Error('createMgmtClient: token is required')
  if (!/^[a-z0-9]{20}$/.test(ref)) {
    throw new Error(
      `createMgmtClient: project ref must be 20 lower-case letters/digits, got "${ref}"`,
    )
  }
  const url = `${baseUrl ?? MGMT_API_BASE}/v1/projects/${ref}/database/query`
  const scrub = (/** @type {string} */ s) => redact(s, [token])

  return {
    async query(sql) {
      /** @type {Response} */
      let res
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ query: sql }),
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        throw new MgmtApiError(scrub(`network error calling the Management API: ${msg}`), null)
      }
      const text = await res.text()
      /** @type {unknown} */
      let body
      try {
        body = text === '' ? [] : JSON.parse(text)
      } catch {
        body = text
      }
      const payloadError = errorFromPayload(body)
      if (!res.ok || payloadError !== null) {
        const detail = payloadError ?? (text.slice(0, 300) || res.statusText)
        throw new MgmtApiError(scrub(`HTTP ${res.status}: ${detail}`), res.status)
      }
      return /** @type {Row[]} */ (body)
    },
  }
}
