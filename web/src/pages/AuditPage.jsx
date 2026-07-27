import { useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuthStore } from '../lib/useAuthStore'
import { apiFetch, INPUT_CLS, PAGE_SIZE, SELECT_CLS, THEAD_CLS } from '../lib/shared'
import { formatEventTime } from '../lib/datetime'
import { useRegions } from '../lib/useRegions'
import PaginationBar from '../components/PaginationBar'
import RecordCard from '../components/RecordCard'

// Human-readable Thai labels for every raw `action` code the backend audit
// log can emit. Dependency: must stay in sync with the server's action enum;
// any action not present here falls back to showing the raw code (see render).
const ACTION_LABELS = {
  'fire.reserve': 'จองจุดไฟ',
  'fire.resolve': 'ดับไฟสำเร็จ',
  'fire.false_report': 'แจ้งว่าไม่ใช่ไฟ',
  'fire.false_cancel': 'ยกเลิกสถานะไม่ใช่ไฟ',
  'fire.appoint': 'มอบหมายเจ้าหน้าที่',
  'fire.release': 'ยกเลิกการจอง',
  'fire.cancel_booking': 'ยกเลิกการมอบหมาย',
  'fire.expire': 'หมดอายุอัตโนมัติ',
  'fire.ingest': 'นำเข้าข้อมูลดาวเทียม',
  'officer.verify': 'ยืนยันเจ้าหน้าที่',
  'officer.update': 'แก้ไขข้อมูลเจ้าหน้าที่',
  'officer.online': 'เข้าปฏิบัติงาน',
  'officer.offline': 'ออกปฏิบัติงาน',
  'officer.delete': 'ลบเจ้าหน้าที่',
  'dispatcher.create': 'สร้างผู้ดูแล',
  'dispatcher.update': 'แก้ไขผู้ดูแล',
  'dispatcher.delete': 'ลบผู้ดูแล',
  'region_change.request': 'ขอย้ายพื้นที่',
  'region_change.approved': 'อนุมัติย้ายพื้นที่',
  'region_change.rejected': 'ปฏิเสธย้ายพื้นที่',
  'settings.location_poll': 'ตั้งค่ารอบส่งตำแหน่ง',
  'auth.login': 'เข้าสู่ระบบ',
  'auth.register': 'สมัครบัญชี',
  'auth.revoke_user': 'ระงับสิทธิ์ผู้ใช้',
  'auth.restore_user': 'คืนสิทธิ์ผู้ใช้',
}

// Badge color per action "category" (the prefix before the dot, e.g. 'fire' from 'fire.reserve').
const ACTION_COLORS = {
  fire: 'bg-orange-100 text-orange-700',
  officer: 'bg-blue-100 text-blue-700',
  dispatcher: 'bg-purple-100 text-purple-700',
  region_change: 'bg-teal-100 text-teal-700',
  settings: 'bg-amber-100 text-amber-700',
  auth: 'bg-gray-100 text-gray-600',
}

// Labels for the category filter <select>; keys must match the action-code prefixes above.
const CATEGORY_LABELS = {
  fire: 'จุดไฟ',
  officer: 'เจ้าหน้าที่',
  dispatcher: 'ผู้ดูแล',
  region_change: 'คำขอย้ายพื้นที่',
  settings: 'การตั้งค่า',
  auth: 'บัญชีผู้ใช้',
}

/**
 * provName
 * @param {Record<string, string>} names - map of region ltree path -> Thai display name
 * @param {string|undefined} path - ltree path of a region (e.g. 'th.north.chiangmai')
 * @returns {string|undefined} the resolved display name, or the raw path if unmapped, or the input unchanged if falsy
 * Assumption: `names` may be incomplete (regions still loading) — falls back to the raw path.
 */
const provName = (names, path) => (path ? (names[path] ?? path) : path)

/**
 * summarize
 * Builds the free-text "รายละเอียด" (detail) column for one audit log row.
 * @param {object} item - one audit log entry as returned by the API
 * @param {object} [item.detail] - action-specific payload, shape varies by item.action
 * @param {string} item.action - dotted action code, used to pick the formatting branch
 * @param {Record<string, string>} [names] - region path -> name lookup, used to resolve ltree paths to Thai names
 * @returns {string} a (possibly multi-line, '\n'-joined) human-readable summary; '' if the action has no known format
 * Note: every field on `detail` is optional/nullable since it originates from historical
 * log rows that may predate a given field being added server-side; hence the extensive `??` fallbacks.
 */
function summarize(item, names = {}) {
  const d = item.detail ?? {}
  const prov = (path) => provName(names, path)
  // Renders "<old province> → " when a previous path exists, else '' (for region-change rows).
  const arrowFrom = (prevPath) => (prevPath ? `${prov(prevPath)} → ` : '')
  // Shared multi-line renderer for "create/verify/delete officer|dispatcher" style entries.
  const entity = (label, path) =>
    `${label}: ${d.name}\n สังกัด: ${d.division ?? '—'}\n ขอบเขต: ${prov(path)}`
  // Builds the common "field changed: old → new" lines shared by officer.update / dispatcher.update.
  const renameParts = () => {
    const parts = []
    if (d.name) parts.push(`เปลี่ยนชื่อ: ${d.previous_name ? `${d.previous_name} → ` : ''}${d.name}`)
    if (d.username) parts.push(`เปลี่ยนชื่อผู้ใช้: ${d.previous_username ? `${d.previous_username} → ` : ''}${d.username}`)
    if ('division' in d) parts.push(`เปลี่ยนสังกัด: ${d.previous_division ? `${d.previous_division} → ` : ''}${d.division ?? '—'}`)
    return parts
  }

  switch (item.action) {
    case 'fire.ingest': {
      const base = `ดึงข้อมูล ${d.fetched ?? 0} รายการ · เพิ่มใหม่ ${d.inserted ?? 0}`
      const by = d.by_satellite
      // Optional per-satellite breakdown; omitted entirely if the backend didn't send it.
      return by
        ? `${base}\n${Object.entries(by).map(([s, n]) => `${s}: ${n}`).join(' · ')}`
        : base
    }
    case 'fire.expire':
      return `${d.count ?? 0} รายการ`
    case 'fire.reserve':
    case 'fire.resolve':
    case 'fire.false_report':
    case 'fire.false_cancel':
      return d.name ?? ''
    case 'fire.appoint':
      return d.officer_name ? `${d.name ?? ''} → ${d.officer_name}` : (d.name ?? '')
    case 'fire.release':
      return `${d.name ?? ''}`.trim()
    case 'fire.cancel_booking':
      return `ยกเลิกจุดไฟ ${d.name ?? ''}${d.officer_name ? ` ของ ${d.officer_name}` : ''}`.trim()
    case 'region_change.request':
      return `${arrowFrom(d.previous_province_path)}${prov(d.province_path)}`
    case 'region_change.approved':
    case 'region_change.rejected': {
      const who = d.officer_name ? `${d.officer_name}: ` : ''
      return `${who}${arrowFrom(d.previous_province_path)}${prov(d.province_path)}`
    }
    case 'settings.location_poll':
      return d.minutes != null ? `ทุก ${d.minutes} นาที` : ''
    case 'auth.revoke_user':
    case 'auth.restore_user':
      return d.name ?? ''
    case 'officer.verify':
    case 'officer.delete':
      return entity('เจ้าหน้าที่', d.province_path)
    case 'dispatcher.create':
    case 'dispatcher.delete':
      return entity('ผู้ดูแล', d.region_path)
    case 'dispatcher.update': {
      const parts = renameParts()
      if (d.region_path) parts.push(`ย้ายพื้นที่: ${prov(d.region_path)}`)
      if (d.password_changed) parts.push('รีเซ็ตรหัสผ่าน')
      return parts.join('\n')
    }
    case 'officer.update': {
      const parts = renameParts()
      if (d.province_path) parts.push(`ย้ายไป: ${arrowFrom(d.previous_province_path)}${prov(d.province_path)}`)
      if (d.password_changed) parts.push(`รีเซ็ตรหัสผ่าน${d.officer_name ? `: ${d.officer_name}` : ''}`)
      return parts.join('\n')
    }
    // Actions with no dedicated formatter (e.g. auth.login, officer.online/offline) show '—' via the caller's `|| '—'`.
    default:
      return ''
  }
}

/**
 * AuditPage
 * Route-level component (no props). Superuser-only audit log viewer: lists
 * every recorded system action with filtering by category, date, and actor,
 * plus server-side pagination.
 *
 * Returns: JSX.Element, or a redirect to '/' when the signed-in user is not a superuser.
 */
export default function AuditPage() {
  const user = useAuthStore((s) => s.user)
  const [items, setItems] = useState(null) // array|null: null = loading, [] = loaded-but-empty
  const [total, setTotal] = useState(0) // number: total row count from server, drives PaginationBar
  const [page, setPage] = useState(0) // number: zero-based current page index
  const [error, setError] = useState(null) // string|null: load error message shown in place of the table
  const [action, setAction] = useState('') // string: selected category filter ('' = all)
  const [onDate, setOnDate] = useState('') // string: 'YYYY-MM-DD' date filter from the date input
  const [actorInput, setActorInput] = useState('') // string: live text of the actor search box (uncommitted)
  const [actor, setActor] = useState('') // string: committed actor filter, applied on submit/blur
  const [reload, setReload] = useState(0) // number: bumped to force-retrigger the fetch effect (manual "refresh")
  const { regions } = useRegions()
  // Precompute a path -> Thai name lookup once per regions change, so summarize() avoids repeated scans.
  const provinceNames = useMemo(
    () => Object.fromEntries((regions ?? []).map((p) => [p.path, p.name_th])),
    [regions],
  )

  // Fetches one page of audit log entries whenever any filter, the page, or `reload` changes.
  useEffect(() => {
    let cancelled = false // guards against a stale response overwriting state after unmount/re-run
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    })
    if (action) params.set('action', action)
    if (actor) params.set('actor', actor)
    if (onDate) {
      // Converts the local-date input into a [start-of-day, +24h) UTC ISO range for the API.
      const start = new Date(`${onDate}T00:00:00`)
      params.set('since', start.toISOString())
      params.set('until', new Date(start.getTime() + 86_400_000).toISOString())
    }
    ;(async () => {
      try {
        const res = await apiFetch(`/audit?${params}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (cancelled) return
        setItems(data.items ?? [])
        setTotal(data.total ?? 0)
        setError(null)
      } catch (e) {
        console.warn('[AuditPage] load failed:', e)
        if (cancelled) return
        setItems([])
        setError('โหลดประวัติไม่สำเร็จ')
      }
    })()
    return () => { cancelled = true }
  }, [page, action, actor, onDate, reload])

  // Access control: only superusers may view the audit log; everyone else is bounced to home.
  if (!user?.is_superuser) return <Navigate to="/" replace />

  return (
    <div className="flex-1 min-h-0 overflow-hidden bg-background">
      <div className="mx-auto flex h-full max-w-[1600px] flex-col gap-3 px-3 py-3 lg:px-8">
        <div className='flex flex-col md:flex-row md:gap-4 md:items-center pl-12 lg:pl-0'>
          <h1 className='mt-2 pl-2 font-bold text-3xl text-primary'>บันทึกเหตุการณ์</h1>
          <p className='pl-2 md:pl-0 font-medium text-md text-accent'>รายการเหตุการณ์ต่างที่เกิดขึ้นในระบบ</p>
        </div>

        <div className="flex flex-col flex-1 min-h-0 w-full bg-foreground rounded-2xl p-4 shadow-md">

          <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center pb-2 border-b border-gray-300">

            {/* Category + date filters: two-up on phones, inline at md+ */}
            <div className="grid grid-cols-2 gap-2 md:contents">
              <select
                value={action}
                onChange={(e) => { setAction(e.target.value); setPage(0) }}
                className={`${SELECT_CLS} w-full md:max-w-fit`}
              >
                <option value="">ทุกเหตุการณ์</option>
                {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>

              <input
                type="date"
                value={onDate}
                onChange={(e) => { setOnDate(e.target.value); setPage(0) }}
                className={`${INPUT_CLS} w-full md:max-w-fit text-accent`}
              />
            </div>

            {/* Actor search + refresh share a row on phones */}
            <div className="flex items-center gap-2 w-full md:contents">
              {/* Actor search: committed on Enter (form submit) or on blur, not on every keystroke,
                  to avoid refetching on each character typed */}
              <form
                onSubmit={(e) => { e.preventDefault(); setActor(actorInput.trim()); setPage(0) }}
                className="flex flex-1 flex-row md:ml-auto md:w-78 md:flex-none items-center gap-2"
              >
                <input
                  type="text"
                  value={actorInput}
                  title="ค้นหาด้วยชื่อผู้ใช้หรือผู้กระทำ"
                  onChange={(e) => setActorInput(e.target.value)}
                  onBlur={() => { setActor(actorInput.trim()); setPage(0) }}
                  placeholder="ค้นหาด้วยชื่อผู้ใช้หรือผู้กระทำ…"
                  autoComplete="off"
                  className={`${INPUT_CLS} flex-1 min-w-0 text-accent`}
                />
              </form>

              {/* Manual refresh: increments `reload` purely to retrigger the fetch effect */}
              <button
                type="button"
                onClick={() => setReload((n) => n + 1)}
                className="shrink-0 text-md font-semibold text-blue-400 hover:text-blue-700 px-2 py-1.5"
              >
                รีเฟรช
              </button>
            </div>
          </div>

          {/* Centers the loading/error/empty states; switches to a scrollable column layout once rows exist */}
          <div className={`flex flex-1 min-h-0 ${(items === null) || error || (items !== null && !error && items.length === 0) ? 'justify-center items-center min-h-72' : 'flex-col'}`}>
            {items === null && <p className="text-gray-400">กำลังโหลด…</p>}
            {error && <p className="text-destructive">{error}</p>}
            {items !== null && !error && items.length === 0 && (
              <p className="text-gray-400">ไม่พบประวัติ</p>
            )}

            {items !== null && !error && items.length > 0 && (
              <div className="flex-1 min-h-72 overflow-auto minimal-scrollbar">
                <table className="hidden md:table w-full table-fixed text-left border-collapse">
                  <colgroup>
                    <col className="w-36" />
                    <col className="w-40" />
                    <col />
                    <col className="w-32" />
                  </colgroup>
                  <thead className={THEAD_CLS}>
                    <tr className="text-accent text-sm">
                      <th className="px-3 py-2 font-medium">เหตุการณ์</th>
                      <th className="px-3 py-2 font-medium">ผู้กระทำ</th>
                      <th className="px-3 py-2 font-medium">รายละเอียด</th>
                      <th className="px-3 py-2 font-medium text-right whitespace-nowrap">เวลา</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id} className="border-b border-background hover:bg-background/50">
                        <td className="px-3 py-2.5 align-top">
                          {/* Badge color keyed by the action's category prefix (text before the first dot) */}
                          <span title={ACTION_LABELS[item.action] ?? item.action} className={`block w-32 text-center text-xs font-semibold px-2 py-1.5 rounded-full truncate ${ACTION_COLORS[item.action.split('.')[0]] ?? 'bg-gray-100 text-gray-600'}`}>
                            {ACTION_LABELS[item.action] ?? item.action}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 align-top text-sm text-gray-500 font-light break-all">
                          {/* 'system' is the synthetic actor username for automated jobs (e.g. satellite ingest) */}
                          {item.actor_username === 'system' ? 'ระบบ' : item.actor_username}
                        </td>
                        <td className="px-3 py-2.5 align-top text-sm text-gray-500 font-light whitespace-pre-line wrap-break-word">
                          {summarize(item, provinceNames) || '—'}
                        </td>
                        <td className="px-3 py-2.5 align-top text-sm text-gray-500 whitespace-nowrap text-right">
                          {formatEventTime(item.at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Mobile: same entries as cards (the table is hidden below md). */}
                <div className="md:hidden space-y-2">
                  {items.map((item) => {
                    const detail = summarize(item, provinceNames)
                    return (
                      <RecordCard
                        key={item.id}
                        titleSlot={
                          <span title={ACTION_LABELS[item.action] ?? item.action} className={`inline-block text-xs font-semibold px-2 py-1 rounded-full ${ACTION_COLORS[item.action.split('.')[0]] ?? 'bg-gray-100 text-gray-600'}`}>
                            {ACTION_LABELS[item.action] ?? item.action}
                          </span>
                        }
                        rows={[
                          { label: 'ผู้กระทำ', value: item.actor_username === 'system' ? 'ระบบ' : item.actor_username },
                          { label: 'เวลา', value: formatEventTime(item.at) },
                        ]}
                      >
                        {detail && (
                          <div>
                            <p className="mb-0.5 text-gray-500">รายละเอียด</p>
                            <p className="whitespace-pre-line wrap-break-word font-light">{detail}</p>
                          </div>
                        )}
                      </RecordCard>
                    )
                  })}
                </div>
              </div>
            )}

            {items?.length > 0 && (
              <PaginationBar page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
