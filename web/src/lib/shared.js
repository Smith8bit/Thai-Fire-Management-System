// Central HTTP/API layer for the web client: wraps fetch with cookie-based auth,
// transparent session refresh, and app-wide validation/UI constants. Keeping this
// logic in one module means every caller inherits the same auth behaviour for free.

// Base URL of the backend. Empty string => same-origin (Vite dev proxy / prod build).
// Sourced from the build-time env so deployments can point at different hosts.
export const API_URL = import.meta.env.VITE_API_URL ?? ''

// Shared page size for every paginated list/table in the UI.
export const PAGE_SIZE = 20

// Holds the single in-flight refresh promise so concurrent 401s share one refresh
// call instead of stampeding the auth endpoint (request de-duplication).
let refreshing = null

/**
 * Attempt to renew the auth cookie via the refresh endpoint.
 * @returns {Promise<boolean>} true if the session was refreshed, false on any failure.
 */
export function refreshSession() {
  // credentials:'include' is required so the browser sends/receives the auth cookie.
  return fetch(`${API_URL}/auth/cookie/refresh`, { method: 'POST', credentials: 'include' })
    .then((r) => r.ok)
    .catch(() => false) // network errors are treated as "refresh failed", never thrown.
}

// Callback invoked when the session is unrecoverable; the auth store wires this up
// (see useAuthStore) to reset user state and bounce back to the login screen.
let onSessionExpired = null
export function setOnSessionExpired(fn) {
  onSessionExpired = fn
}

/**
 * Authenticated fetch wrapper. On a 401 it transparently refreshes the session
 * once and replays the original request, so callers never handle token expiry.
 * @param {string} path  API path appended to API_URL (e.g. '/regions').
 * @param {RequestInit} [init]  Standard fetch options; credentials are forced on.
 * @returns {Promise<Response>} The final response (retried once if a refresh succeeded).
 * @remarks Auth endpoints ('/auth/...') are excluded from the retry to avoid an
 *   infinite refresh loop when the refresh itself returns 401.
 */
export async function apiFetch(path, init = {}) {
  const opts = { credentials: 'include', ...init }
  let res = await fetch(`${API_URL}${path}`, opts)
  if (res.status === 401 && !path.startsWith('/auth/')) {
    // Coalesce parallel refreshes: only the first caller triggers refreshSession(),
    // the rest await the same promise.
    refreshing = refreshing ?? refreshSession()
    const ok = await refreshing
    refreshing = null
    if (ok) {
      res = await fetch(`${API_URL}${path}`, opts) // replay original request with the fresh cookie.
    } else {
      onSessionExpired?.() // give up: notify the app to log the user out.
    }
  }
  return res
}

// Username rules kept in one place so client and server validation stay in sync.
// PATTERN feeds an HTML <input pattern>; the RE additionally enforces 3–32 length.
export const USERNAME_PATTERN = '[A-Za-z0-9._@+-]+'
const USERNAME_RE = /^[A-Za-z0-9._@+-]{3,32}$/
/** @param {string} v  @returns {boolean} true if v (trimmed) is a valid username. */
export const isValidUsername = (v) => USERNAME_RE.test((v ?? '').trim())

/**
 * Generic client-side list filter used by search boxes across the app.
 * @param {object} item  The record to test.
 * @param {string[]} fields  Property names on `item` to search within.
 * @param {string} query  Already-lowercased search term.
 * @returns {boolean} true when query is empty (match-all) or any field contains it.
 */
export const matchesQuery = (item, fields, query) =>
  !query || fields.some((f) => (item[f] ?? '').toLowerCase().includes(query))

// Maps backend error codes to user-facing Thai messages; see errorText() for lookup.
export const ERROR_MESSAGES = {
  username_taken: 'ชื่อผู้ใช้นี้ถูกใช้งานแล้ว',
  invalid_username: 'ชื่อผู้ใช้ต้องมี 3-32 ตัว ใช้ได้เฉพาะ ตัวอักษร ตัวเลข . _ @ + -',
  weak_password: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร',
  out_of_scope: 'อยู่นอกพื้นที่รับผิดชอบของคุณ',
  nothing_to_update: 'ไม่มีการเปลี่ยนแปลง',
  invalid_region: 'กรุณาเลือกพื้นที่ให้ถูกต้อง',
  forbidden: 'คุณไม่มีสิทธิ์ดำเนินการนี้',
}

// Thai labels for the three region tiers of the ltree region hierarchy.
export const REGION_LEVEL_TH = { national: 'ประเทศ', regional: 'ภาค', province: 'จังหวัด' }

/**
 * Resolve a backend error code to a display string.
 * @param {string} [code]  Known key in ERROR_MESSAGES, or any unmapped code.
 * @returns {string} Localized message; unknown codes fall back to a generic prefix.
 */
export const errorText = (code) =>
  ERROR_MESSAGES[code] ?? ('เกิดข้อผิดพลาด: ' + (code ?? 'unknown'))

// Shared Tailwind class strings so form inputs/tables render consistently everywhere.
// `min-h-11` (44px) guarantees a touch-sized target on phones; `text-base` on
// phone (→ `md:text-sm`) also stops iOS Safari from auto-zooming on focus, while
// desktop keeps the compact size. Width is set per-call site and overrides `w-full`.
export const INPUT_CLS = 'w-full min-w-0 min-h-11 border border-gray-200 rounded-lg px-3 py-1.5 text-base md:text-sm'
export const SELECT_CLS = 'w-full min-w-0 min-h-11 border border-gray-200 rounded-lg px-2 py-1.5 text-base md:text-sm text-gray-700'

export const THEAD_CLS = 'sticky top-0 bg-foreground z-10 [&_th]:shadow-[inset_0_-1px_0_#d1d5db]'
