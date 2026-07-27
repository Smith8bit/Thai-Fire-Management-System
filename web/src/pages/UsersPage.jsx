import { useEffect, useState, useCallback } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuthStore } from '../lib/useAuthStore'
import { toast } from '../lib/toastStore'
import { apiFetch, INPUT_CLS, PAGE_SIZE, THEAD_CLS } from '../lib/shared'
import CenteredMessage from '../components/CenteredMessage'
import RecordCard from '../components/RecordCard'

// Thai display labels for backend role codes.
const ROLE_TH = { admin: 'ผู้ดูแลระบบ', dispatcher: 'ผู้ดูแล', field_officer: 'เจ้าหน้าที่' }

/**
 * UsersPage
 * Route-level component (no props). Superuser-only account administration
 * screen: search/filter/sort every user account, and revoke or restore
 * account access (superuser accounts are exempt from revoke/restore).
 *
 * Returns: JSX.Element, or a redirect to '/' when the signed-in user is not a superuser.
 */
export default function UsersPage() {
  const user = useAuthStore((s) => s.user)

  const [items, setItems] = useState([]) // array: current page of user rows
  const [total, setTotal] = useState(0) // number: total matching accounts, drives the manual pagination footer
  const [divisions, setDivisions] = useState([]) // array<string>: distinct division names for the filter dropdown (server-supplied, matches current filters)
  const [query, setQuery] = useState('') // string: free-text search (username/division), debounced via the load effect
  const [status, setStatus] = useState('') // '' | 'active' | 'suspended': account status filter
  const [division, setDivision] = useState('') // string: exact division filter, '' = all
  const [sort, setSort] = useState('name') // 'name' | 'sessions': sort key
  const [order, setOrder] = useState('asc') // 'asc' | 'desc': sort direction
  const [page, setPage] = useState(0) // number: zero-based current page index
  const [loading, setLoading] = useState(true) // boolean: true while a list fetch is in flight
  const [busyId, setBusyId] = useState(null) // string|null: id of the user row currently being revoked/restored (disables its button)

  /**
   * load
   * @returns {Promise<void>}
   * Fetches the current page of users using all active filters/sort/search.
   * Memoized with useCallback so the debounce effect below can safely depend
   * on it without re-creating the timer on every render.
   */
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE), sort, order })
      if (query.trim()) params.set('q', query.trim())
      if (status) params.set('status', status)
      if (division) params.set('division', division)
      const res = await apiFetch(`/users/list?${params}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setItems(data.items ?? [])
      setTotal(data.total ?? 0)
      setDivisions(data.divisions ?? [])
    } catch (e) {
      console.warn('[UsersPage] load failed:', e)
      toast.error('โหลดรายชื่อผู้ใช้ไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }, [query, page, status, division, sort, order])

  // Debounces `load` by 300ms so fast typing in the search box doesn't fire a request per keystroke;
  // non-text filters (status/division/sort/page) still settle quickly since they change `load`'s identity too.
  useEffect(() => {
    const id = setTimeout(load, 300)
    return () => clearTimeout(id)
  }, [load])

  // Access control: only superusers may manage account access; everyone else is bounced to home.
  if (!user?.is_superuser) return <Navigate to="/" replace />

  /**
   * action
   * @param {object} u - the target user row (must include id, username)
   * @param {'revoke'|'restore'} kind - which account-access action to perform
   * @returns {Promise<void>}
   * Confirms with the user via a native dialog, calls the corresponding
   * endpoint, then reloads the list so status/session counts stay accurate.
   */
  const action = async (u, kind) => {
    const verb = kind === 'revoke' ? 'ระงับสิทธิ์' : 'คืนสิทธิ์'
    if (!window.confirm(`${verb}บัญชี ${u.username}?`)) return
    setBusyId(u.id)
    try {
      const res = await apiFetch(`/users/${u.id}/${kind}`, { method: 'POST' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d?.detail || `HTTP ${res.status}`)
      }
      toast.success(`${verb}แล้ว`)
      await load()
    } catch (e) {
      toast.error(`${verb}ไม่สำเร็จ: ${e.message}`)
    } finally {
      setBusyId(null)
    }
  }

  // Last valid page index given the current total; clamps to 0 when there are no results.
  const lastPage = Math.max(Math.ceil(total / PAGE_SIZE) - 1, 0)

  return (
    <div className="flex-1 min-h-0 overflow-hidden bg-background">
      <div className="mx-auto flex h-full max-w-[1200px] flex-col gap-3 px-3 py-3 lg:px-8">

        <div className="flex flex-col md:flex-row md:gap-4 md:items-center pl-12 lg:pl-0">
          <h1 className="mt-2 pl-2 font-bold text-3xl text-primary">จัดการสิทธิ์ผู้ใช้</h1>
          <p className="pl-2 md:pl-0 font-medium text-md text-accent">ระงับหรือคืนสิทธิ์การเข้าถึงของบัญชีใดก็ได้</p>
        </div>

        <div className="flex flex-col bg-foreground rounded-2xl p-4 shadow-md flex-1 min-h-0">

          <div className="mb-2 pb-2 border-b border-gray-300 flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
            <p className="font-medium text-accent text-lg whitespace-nowrap md:mr-auto">บัญชีทั้งหมด ({total})</p>

            {/* Filters: two-up on phones, inline at md+ */}
            <div className="grid grid-cols-2 gap-2 md:contents">
              <select
                value={status}
                onChange={(e) => { setStatus(e.target.value); setPage(0) }}
                title="กรองตามสถานะ"
                className={`${INPUT_CLS} w-full md:w-32! text-accent`}
              >
                <option value="">ทุกสถานะ</option>
                <option value="active">ใช้งานได้</option>
                <option value="suspended">ถูกระงับ</option>
              </select>

              <select
                value={division}
                onChange={(e) => { setDivision(e.target.value); setPage(0) }}
                title="กรองตามสังกัด"
                className={`${INPUT_CLS} w-full md:w-32! text-accent`}
              >
                <option value="">ทุกสังกัด</option>
                {divisions.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>

            <div className='flex flex-row gap-2 border border-gray-300 p-1.5 rounded-xl w-full md:w-auto'>
              <select
                value={sort}
                onChange={(e) => { setSort(e.target.value); setPage(0) }}
                title="เรียงตาม"
                className={`${INPUT_CLS} flex-1 md:w-32! text-accent`}
              >
                <option value="name">ชื่อผู้ใช้</option>
                <option value="sessions">จำนวนเซสชัน</option>
              </select>

              <button
                type="button"
                onClick={() => { setOrder((o) => (o === 'asc' ? 'desc' : 'asc')); setPage(0) }}
                title={order === 'asc' ? 'น้อยไปมาก' : 'มากไปน้อย'}
                className="shrink-0 min-h-11 px-3 rounded-xl border border-gray-300 text-accent hover:bg-gray-50"
              >
                {order === 'asc' ? '↑' : '↓'}
              </button>
            </div>

            {/* Search + refresh share a row on phones */}
            <div className="flex gap-2 w-full md:contents">
              <input
                type="text"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setPage(0) }}
                placeholder="ค้นหาชื่อผู้ใช้ หรือสังกัด"
                title="ค้นหาชื่อผู้ใช้ หรือสังกัด"
                autoComplete="off"
                className={`${INPUT_CLS} flex-1 md:w-56 text-accent`}
              />

              <button
                type="button"
                onClick={load}
                disabled={loading}
                title="รีเฟรช"
                className="shrink-0 min-h-11 px-3 rounded-xl border border-gray-300 text-accent hover:bg-gray-50 disabled:opacity-50"
              >
                ⟳
              </button>
            </div>
          </div>

          <div className="flex-1 min-h-72 overflow-y-auto minimal-scrollbar">
            {loading ? (
              <CenteredMessage>กำลังโหลด…</CenteredMessage>
            ) : items.length === 0 ? (
              <CenteredMessage>ไม่พบบัญชี</CenteredMessage>
            ) : (
              <>
              <table className="hidden md:table w-full table-fixed text-left border-collapse">
                <thead className={THEAD_CLS}>
                  <tr className="text-accent text-sm">
                    <th className="px-3 py-2 font-medium w-[28%]">ชื่อผู้ใช้</th>
                    <th className="px-3 py-2 font-medium w-[20%]">สังกัด</th>
                    <th className="px-3 py-2 font-medium w-[14%]">บทบาท</th>
                    <th className="px-3 py-2 font-medium w-[12%]">เซสชัน</th>
                    <th className="px-3 py-2 font-medium w-[14%]">สถานะ</th>
                    <th className="px-3 py-2 font-medium w-[12%]"></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((u) => (
                    <tr key={u.id} className="border-b border-background hover:bg-background/50">
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <p title={u.username} className="text-md text-primary font-medium truncate">{u.username}</p>
                          {u.is_superuser && (
                            <span className="shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">ผู้ดูแลระบบ</span>
                          )}
                        </div>
                      </td>
                      <td title={u.division || '—'} className="px-3 py-2.5 text-sm text-gray-500 font-light truncate">{u.division || '—'}</td>
                      <td className="px-3 py-2.5 text-sm text-gray-500 font-light truncate">{ROLE_TH[u.role] ?? '—'}</td>
                      <td className="px-3 py-2.5 text-sm text-gray-600">{u.active_sessions}</td>
                      <td className="px-3 py-2.5">
                        <span className={`text-xs font-semibold px-2 py-1 rounded-full whitespace-nowrap ${u.is_active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                          {u.is_active ? 'ใช้งานได้' : 'ถูกระงับ'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        {/* Superuser accounts can't be revoked/restored from this UI — no action shown */}
                        {u.is_superuser ? (
                          <span className="text-xs text-gray-400">—</span>
                        ) : u.is_active ? (
                          <button
                            type="button"
                            onClick={() => action(u, 'revoke')}
                            disabled={busyId === u.id}
                            className="text-sm text-red-600 hover:text-white border-2 border-red-300 hover:border-red-600 hover:bg-red-600 rounded-xl px-3 py-1.5 disabled:opacity-50 whitespace-nowrap"
                          >
                            {busyId === u.id ? '…' : 'ระงับสิทธิ์'}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => action(u, 'restore')}
                            disabled={busyId === u.id}
                            className="text-sm text-primary hover:text-brand border-2 border-flame hover:border-brand hover:bg-flame-light rounded-xl px-3 py-1.5 disabled:opacity-50 whitespace-nowrap"
                          >
                            {busyId === u.id ? '…' : 'คืนสิทธิ์'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Mobile: same rows as cards (the table is hidden below md). */}
              <div className="md:hidden space-y-2">
                {items.map((u) => (
                  <RecordCard
                    key={u.id}
                    titleSlot={
                      <div className="flex items-center gap-2 min-w-0">
                        <p title={u.username} className="truncate font-semibold text-primary">{u.username}</p>
                        {u.is_superuser && (
                          <span className="shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">ผู้ดูแลระบบ</span>
                        )}
                      </div>
                    }
                    badge={
                      <span className={`text-xs font-semibold px-2 py-1 rounded-full whitespace-nowrap ${u.is_active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                        {u.is_active ? 'ใช้งานได้' : 'ถูกระงับ'}
                      </span>
                    }
                    rows={[
                      { label: 'สังกัด', value: u.division || '—' },
                      { label: 'บทบาท', value: ROLE_TH[u.role] ?? '—' },
                      { label: 'เซสชัน', value: u.active_sessions },
                    ]}
                    actions={
                      u.is_superuser ? null : u.is_active ? (
                        <button
                          type="button"
                          onClick={() => action(u, 'revoke')}
                          disabled={busyId === u.id}
                          className="text-sm text-red-600 hover:text-white border-2 border-red-300 hover:border-red-600 hover:bg-red-600 rounded-xl px-3 py-1.5 disabled:opacity-50 whitespace-nowrap"
                        >
                          {busyId === u.id ? '…' : 'ระงับสิทธิ์'}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => action(u, 'restore')}
                          disabled={busyId === u.id}
                          className="text-sm text-primary hover:text-brand border-2 border-flame hover:border-brand hover:bg-flame-light rounded-xl px-3 py-1.5 disabled:opacity-50 whitespace-nowrap"
                        >
                          {busyId === u.id ? '…' : 'คืนสิทธิ์'}
                        </button>
                      )
                    }
                  />
                ))}
              </div>
              </>
            )}
          </div>

          {/* Manual (non-shared) pagination footer, only shown once results exceed one page */}
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between pt-3 mt-2 border-t border-gray-300 text-xs md:text-sm text-gray-600">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(p - 1, 0))}
                disabled={page === 0}
                className="px-2.5 py-1 text-xs md:text-sm md:px-3 rounded-lg border border-gray-300 disabled:opacity-40 hover:bg-gray-50"
              >
                ก่อนหน้า
              </button>
              <span>{page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} จาก {total}</span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(p + 1, lastPage))}
                disabled={page >= lastPage}
                className="px-2.5 py-1 text-xs md:text-sm md:px-3 rounded-lg border border-gray-300 disabled:opacity-40 hover:bg-gray-50"
              >
                ถัดไป
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
