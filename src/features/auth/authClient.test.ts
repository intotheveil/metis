// P2.10 — the pure helpers of the auth seam: the callback URL, reading an auth error from the
// redirect URL, and turning any failure into a sentence a person can act on.

import { callbackUrl, describeAuthError, hasAuthCode, readUrlError } from './authClient'

describe('callbackUrl', () => {
  it.each([
    ['https://themis.adeonanalytics.com', '/', 'https://themis.adeonanalytics.com/auth/callback'],
    ['http://localhost:5173', '/', 'http://localhost:5173/auth/callback'],
    [
      'https://intotheveil.github.io',
      '/themis/',
      'https://intotheveil.github.io/themis/auth/callback',
    ],
    [
      'https://intotheveil.github.io',
      '/themis',
      'https://intotheveil.github.io/themis/auth/callback',
    ],
  ])('%s + base %s → %s', (origin, base, expected) => {
    expect(callbackUrl(origin, base)).toBe(expected)
  })

  it('defaults to the current origin and Vite base', () => {
    expect(callbackUrl()).toBe(`${window.location.origin}/auth/callback`)
  })
})

describe('readUrlError', () => {
  it('reads Supabase error params from the query', () => {
    expect(
      readUrlError(
        '?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
        '',
      ),
    ).toEqual({ message: 'Email link is invalid or has expired', code: 'otp_expired' })
  })

  it('reads them from the hash too', () => {
    expect(readUrlError('', '#error=server_error&error_description=Boom')).toEqual({
      message: 'Boom',
      code: 'server_error',
    })
  })

  it('falls back to the error name when there is no description', () => {
    expect(readUrlError('?error=access_denied', '')).toEqual({
      message: 'access_denied',
      code: 'access_denied',
    })
  })

  it.each([
    ['', ''],
    ['?code=abc&state=x', ''],
    ['', '#access_token=x'],
  ])('no error in %j %j → null', (search, hash) => {
    expect(readUrlError(search, hash)).toBeNull()
  })
})

describe('hasAuthCode', () => {
  it.each([
    ['?code=abc', true],
    ['code=abc', true],
    ['?state=x&code=', true],
    ['', false],
    ['?error=x', false],
    ['?codex=1', false],
  ])('%j → %s', (search, expected) => {
    expect(hasAuthCode(search)).toBe(expected)
  })
})

describe('describeAuthError', () => {
  it.each([
    [{ message: 'Email link is invalid or has expired', code: 'otp_expired' }, /has expired/],
    [{ message: 'Token has expired or is invalid' }, /has expired/],
    [{ message: 'invalid flow state', code: 'flow_state_not_found' }, /different browser/],
    [{ message: 'code verifier should be non-empty' }, /different browser/],
    [{ message: 'x', code: 'bad_code_verifier' }, /different browser/],
    [{ message: 'User denied access', code: 'access_denied' }, /cancelled or refused/],
    [{ message: 'email rate limit exceeded' }, /Too many sign-in attempts/],
    [{ message: 'x', code: 'over_email_send_rate_limit' }, /Too many sign-in attempts/],
    [{ message: 'Database error saving new user' }, /^Sign-in failed: Database error/],
    [{ message: '   ' }, /^Sign-in failed: Unknown error$/],
  ])('%j → %s', (failure, expected) => {
    expect(describeAuthError(failure)).toMatch(expected)
  })
})
