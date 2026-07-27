import { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useSocketStore, useMapSelection } from '../lib/stateStore'
import { useAuthStore, can } from '../lib/useAuthStore'
import { toast } from '../lib/toastStore'
import { useMessageEffect } from '../lib/useMessageEffect'
import { ERROR_MESSAGES, INPUT_CLS, PAGE_SIZE, SELECT_CLS, THEAD_CLS, USERNAME_PATTERN, errorText, isValidUsername, matchesQuery } from '../lib/shared'
import { formatLastSeen } from '../lib/datetime'
import { useRegions } from '../lib/useRegions'
import PaginationBar from '../components/PaginationBar'
import CenteredMessage from '../components/CenteredMessage'
import RecordCard from '../components/RecordCard'

/**
 * OfficerPage
 * Route-level component (no props). Three-panel officer management screen:
 * verified officers (edit/delete, paginated), accounts pending verification,
 * and pending region-change requests. All data is driven by the shared
 * websocket (useSocketStore) — this component sends command messages and
 * reacts to their typed responses rather than issuing REST calls directly.
 * Panel/action visibility is permission-gated per the canManage/canVerify/canViewReq/canDecide checks below.
 *
 * Returns: JSX.Element, or a redirect to '/' when the user lacks 'officers.view'.
 */
export default function OfficerPage() {
  const user = useAuthStore((s) => s.user)
  const send = useSocketStore((s) => s.send)
  const navigate = useNavigate()
  const setFocusedFire = useMapSelection((s) => s.setFocused)
  const canManage = can(user, 'officer.manage') // edit/delete on verified officers
  const canVerify = can(user, 'officer.verify') // approve/reject pending registrations
  const canViewReq = can(user, 'region_requests.view') // see the region-change-requests panel at all
  const canDecide = can(user, 'region_request.decide') // approve/reject region-change requests

  const officersMsg = useSocketStore((s) => s.byType?.officers_in_region)
  const updatedMsg = useSocketStore((s) => s.byType?.officer_updated)
  const deletedMsg = useSocketStore((s) => s.byType?.officer_deleted)
  const pendingMsg = useSocketStore((s) => s.byType?.pending_officers)
  const verifiedMsg = useSocketStore((s) => s.byType?.officer_verified)
  const requestsMsg = useSocketStore((s) => s.byType?.region_change_requests)
  const decidedMsg = useSocketStore((s) => s.byType?.region_request_decided)
  const errorMsg = useSocketStore((s) => s.byType?.error)

  const [officers, setOfficers] = useState([]) // array: verified officers in the caller's managed region(s)
  const [query, setQuery] = useState('') // string: search box for the officers table
  const [statusFilter, setStatusFilter] = useState('all') // 'all' | 'online' | 'offline' | 'busy'
  const [sort, setSort] = useState('name') // 'name' | 'new' | 'updated'
  const [dir, setDir] = useState('asc') // 'asc' | 'desc'
  const [page, setPage] = useState(0) // number: zero-based page index (client-side pagination)
  const { provinces } = useRegions()
  // --- Inline edit-row state (one officer editable at a time via editingId) ---
  const [editingId, setEditingId] = useState(null) // string|null: user_id of the officer being edited
  const [editName, setEditName] = useState('')
  const [editDivision, setEditDivision] = useState('')
  const [editProvince, setEditProvince] = useState('') // string: province code; '' = keep officer's current province
  const [editUsername, setEditUsername] = useState('')
  const [editPassword, setEditPassword] = useState('') // string: left blank = keep existing password (see saveEdit)
  const [savingId, setSavingId] = useState(null) // string|null: user_id currently being saved
  const [deletingId, setDeletingId] = useState(null) // string|null: user_id currently being deleted

  const [pending, setPending] = useState(null) // array|null: null = awaiting first 'pending_officers' message
  const [requests, setRequests] = useState(null) // array|null: null = awaiting first 'region_change_requests' message
  const [busyId, setBusyId] = useState(null) // string|null: id (officer or request) currently mid-action, shared across the verify/reject/decide buttons
  const [pendingQuery, setPendingQuery] = useState('') // string: search box for the pending-officers table
  const [requestQuery, setRequestQuery] = useState('') // string: search box for the region-requests table

  // Requests the officer list, pending registrations, and (if permitted) region-change
  // requests once on mount. Re-fires if canViewReq flips true (e.g. after a permission change).
  useEffect(() => {
    send({ type: 'list_officers' })
    send({ type: 'list_pending_officers' })
    if (canViewReq) send({ type: 'list_region_requests' })
  }, [send, canViewReq])

  useEffect(() => {
    if (!officersMsg) return
    setOfficers(officersMsg.officers ?? [])
  }, [officersMsg])

  useEffect(() => {
    if (!pendingMsg) return
    setPending(pendingMsg.officers ?? [])
  }, [pendingMsg])

  useEffect(() => {
    if (!requestsMsg) return
    setRequests(requestsMsg.requests ?? [])
  }, [requestsMsg])

  // useMessageEffect (vs plain useEffect) ensures each distinct server message fires its
  // handler exactly once, even if the underlying store object reference is reused.
  useMessageEffect(updatedMsg, () => {
    setEditingId(null)
    setSavingId(null)
    toast.success('บันทึกข้อมูลเจ้าหน้าที่แล้ว')
  })

  useMessageEffect(deletedMsg, (m) => {
    // 'delete_officer' is reused for both real deletions and pending-registration rejection;
    // check whether the id was pending beforehand to show the right toast message.
    const wasPending = (pending ?? []).some((o) => o.user_id === m.user_id)
    setOfficers((prev) => prev.filter((o) => o.user_id !== m.user_id))
    setPending((prev) => prev ? prev.filter((o) => o.user_id !== m.user_id) : prev)
    setEditingId(null)
    setDeletingId(null)
    setBusyId(null)
    toast.success(wasPending ? 'ไม่อนุมัติการลงทะเบียนแล้ว' : 'ลบเจ้าหน้าที่แล้ว')
  })

  useMessageEffect(verifiedMsg, (m) => {
    setPending((prev) => prev ? prev.filter((o) => o.user_id !== m.user_id) : prev)
    setBusyId(null)
    toast.success('ยืนยันเจ้าหน้าที่สำเร็จ')
  })

  useMessageEffect(decidedMsg, (m) => {
    setRequests((prev) => prev ? prev.filter((r) => r.request_id !== m.request_id) : prev)
    setBusyId(null)
    toast.success(m.status === 'approved' ? 'อนุมัติการย้ายพื้นที่แล้ว' : 'ปฏิเสธคำขอแล้ว')
  })

  // Single shared error handler: clears whichever in-flight action state was pending,
  // since the socket message doesn't indicate which request it was responding to.
  useMessageEffect(errorMsg, (m) => {
    setSavingId(null)
    setDeletingId(null)
    setBusyId(null)
    toast.error(errorText(m.code))
  })

  // Access control: viewing this page at all requires 'officers.view'.
  if (!can(user, 'officers.view')) return <Navigate to="/" replace />

  /**
   * startEdit
   * @param {object} o - the officer row to edit
   * Seeds edit-row state from the officer's current values. `editProvince` is
   * resolved from the officer's ltree province_path back to a province code
   * (the form's dropdown works in codes); password always starts blank.
   */
  const startEdit = (o) => {
    setEditingId(o.user_id)
    setEditName(o.name ?? '')
    setEditDivision(o.division ?? '')
    setEditProvince((provinces ?? []).find((p) => p.path === o.province_path)?.code ?? '')
    setEditUsername(o.username ?? '')
    setEditPassword('')
  }

  /**
   * saveEdit
   * @param {object} o - the officer row being saved (source of the immutable user_id)
   * Sends 'update_officer'. `province_code` and `password` are only included
   * when set, so leaving either field untouched preserves the existing value server-side.
   */
  const saveEdit = (o) => {
    if (!isValidUsername(editUsername)) { toast.error(ERROR_MESSAGES.invalid_username); return }
    setSavingId(o.user_id)
    const payload = { type: 'update_officer', user_id: o.user_id, name: editName, username: editUsername, division: editDivision }
    if (editProvince) payload.province_code = editProvince
    if (editPassword) payload.password = editPassword
    send(payload)
  }

  /**
   * removeOfficer
   * @param {object} o - the officer row to delete
   * Confirms via a native dialog (irreversible action) before sending 'delete_officer'.
   */
  const removeOfficer = (o) => {
    if (!window.confirm(`ลบเจ้าหน้าที่ ${o.name ?? o.username}?\nการกระทำนี้ไม่สามารถย้อนกลับได้`)) return
    setDeletingId(o.user_id)
    send({ type: 'delete_officer', user_id: o.user_id })
  }

  /** verify - @param {string} id user_id of a pending officer to approve */
  const verify = (id) => {
    setBusyId(id)
    send({ type: 'verify_officer', user_id: id })
  }

  /**
   * goToSpot
   * @param {object} o - an officer row; only acts if they're currently assigned to a fire (o.fire_id)
   * Focuses that fire on the shared map-selection store, then navigates to the map view.
   */
  const goToSpot = (o) => {
    if (!o.fire_id) return
    setFocusedFire(o.fire_id)
    navigate('/map')
  }

  /**
   * reject
   * @param {object} o - a pending officer registration to reject
   * Rejecting a pending registration reuses 'delete_officer' since the account
   * is simply removed either way; the toast wording is chosen by the deletedMsg handler.
   */
  const reject = (o) => {
    if (!window.confirm(`ไม่อนุมัติการลงทะเบียนของ ${o.name ?? o.username}?\nบัญชีนี้จะถูกลบและไม่สามารถย้อนกลับได้`)) return
    setBusyId(o.user_id)
    send({ type: 'delete_officer', user_id: o.user_id })
  }

  /** decide - @param {string} requestId - @param {'approve'|'reject'} action */
  const decide = (requestId, action) => {
    setBusyId(requestId)
    send({ type: 'decide_region_request', request_id: requestId, action })
  }

  const loadingPending = pending === null
  const loadingRequests = requests === null

  const q = query.trim().toLowerCase()
  // Client-side filter: status filter first (cheap field checks), then the shared text-query matcher.
  const filteredOfficers = officers.filter((o) => {
    if (statusFilter === 'online' && !o.active) return false
    if (statusFilter === 'offline' && o.active) return false
    if (statusFilter === 'busy' && !o.fire_id) return false
    return matchesQuery(o, ['name', 'username', 'division', 'province_name_th'], q)
  })
  const officerCols = canManage ? 5 : 4 // colSpan for the inline edit row must match the visible column count

  const cmp =
    sort === 'new'
      ? (a, b) => new Date(a.created_at ?? 0) - new Date(b.created_at ?? 0)
      : sort === 'updated'
      ? (a, b) => new Date(a.last_updated ?? 0) - new Date(b.last_updated ?? 0)
      : (a, b) => (a.name ?? a.username ?? '').localeCompare(b.name ?? b.username ?? '', 'th')
  const sortedOfficers = [...filteredOfficers].sort(
    (a, b) => (dir === 'desc' ? -cmp(a, b) : cmp(a, b)))

  const total = sortedOfficers.length
  const lastPage = Math.max(Math.ceil(total / PAGE_SIZE) - 1, 0)
  // Clamps `page` if a search/filter shrank the result set below the current page's range.
  const safePage = Math.min(page, lastPage)
  const pagedOfficers = sortedOfficers.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)
  // Syncs the clamped page back into state; guarded so it only fires when clamping changed something.
  if (page !== safePage) setPage(safePage)

  const pq = pendingQuery.trim().toLowerCase()
  // Pending/request lists are small and unpaginated, so filtering happens directly on render.
  const filteredPending = (pending ?? []).filter((o) =>
    matchesQuery(o, ['name', 'username', 'division', 'province_name_th'], pq))

  const rq = requestQuery.trim().toLowerCase()
  const filteredRequests = (requests ?? []).filter((r) =>
    matchesQuery(r, ['officer_name', 'username', 'current_province', 'requested_province'], rq))

  // Shared inline edit form for one officer — rendered by both the desktop table
  // (in a full-width cell) and the mobile card list, so they never diverge.
  const renderEditForm = (o) => (
    <div className="space-y-2 text-accent">
      <input
        type="text"
        value={editUsername}
        onChange={(e) => setEditUsername(e.target.value)}
        placeholder="ชื่อผู้ใช้"
        autoComplete="off"
        minLength={3}
        maxLength={32}
        pattern={USERNAME_PATTERN}
        title={ERROR_MESSAGES.invalid_username}
        className={INPUT_CLS}
      />
      <input
        type="text"
        value={editName}
        onChange={(e) => setEditName(e.target.value)}
        placeholder="ชื่อเจ้าหน้าที่"
        className={INPUT_CLS}
      />
      <input
        type="text"
        value={editDivision}
        onChange={(e) => setEditDivision(e.target.value)}
        placeholder="สังกัด"
        className={INPUT_CLS}
      />
      <select
        value={editProvince}
        onChange={(e) => setEditProvince(e.target.value)}
        className={SELECT_CLS}
      >
        <option value="">— จังหวัดเดิม —</option>
        {(provinces ?? []).map((p) => (
          <option key={p.code} value={p.code}>{p.name_th}</option>
        ))}
      </select>
      <input
        type="password"
        value={editPassword}
        onChange={(e) => setEditPassword(e.target.value)}
        placeholder="ตั้งรหัสผ่านใหม่ (เว้นว่างหากไม่เปลี่ยน)"
        autoComplete="new-password"
        className={INPUT_CLS}
      />
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => removeOfficer(o)}
          disabled={deletingId === o.user_id}
          className="text-sm text-destructive hover:text-white hover:bg-destructive border-2 rounded-full px-3 py-1.5 disabled:opacity-50"
        >
          {deletingId === o.user_id ? 'กำลังลบ…' : 'ลบเจ้าหน้าที่'}
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setEditingId(null)}
            className="text-sm text-gray-500 hover:text-accent px-3 py-1.5"
          >
            ยกเลิก
          </button>
          <button
            type="button"
            onClick={() => saveEdit(o)}
            disabled={savingId === o.user_id}
            className="bg-primary hover:bg-brand text-white rounded-xl px-4 py-1.5 text-sm disabled:opacity-50"
          >
            {savingId === o.user_id ? 'กำลังบันทึก…' : 'บันทึก'}
          </button>
        </div>
      </div>
    </div>
  )

  return (
    // Mobile: the whole page scrolls and the three panels stack. Desktop keeps the
    // fixed-height, two-column, internally-scrolling ops layout.
    <div className="flex-1 min-h-0 overflow-y-auto lg:overflow-hidden bg-background">
      <div className="mx-auto flex min-h-full lg:h-full max-w-[1600px] flex-col gap-3 px-3 py-3 lg:px-8">

        <div className='flex flex-col md:flex-row md:gap-4 md:items-center pl-12 lg:pl-0'>
          <h1 className='mt-2 pl-2 font-bold text-3xl text-primary'>เจ้าหน้าที่</h1>
          <p className='pl-2 md:pl-0 font-medium text-md text-accent'>รายการเจ้าที่ในขอบเขตที่ดูแล</p>
        </div>

        <div className="w-full flex flex-col lg:flex-row gap-4 lg:flex-1 lg:min-h-0">

          {/* Left panel: verified officers, paginated */}
          <div className="flex flex-col bg-foreground rounded-2xl p-4 shadow-md max-w-full lg:max-w-1/2 lg:flex-1 lg:min-h-0 lg:h-full">

            <div className="mb-2 pb-2 border-b border-gray-300 flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:justify-between">
              <p className="font-medium text-accent text-lg whitespace-nowrap">เจ้าหน้าที่ในเขตของคุณ ({officers.length})</p>
              <div className="flex flex-col gap-2 w-full md:w-auto md:flex-row md:items-center">
                <div className="flex flex-row gap-2 border border-gray-300 p-1.5 rounded-xl w-full md:w-auto">
                  <select
                    value={sort}
                    onChange={(e) => { setSort(e.target.value); setPage(0) }}
                    title="เรียงลำดับ"
                    className={`${SELECT_CLS} flex-1 md:w-fit!`}
                  >
                    <option value="name">ตามชื่อ</option>
                    <option value="new">ตามเวลาที่เพิ่ม</option>
                    <option value="updated">ตามการอัปเดต</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => { setDir((d) => (d === 'asc' ? 'desc' : 'asc')); setPage(0) }}
                    title={dir === 'asc' ? 'จากน้อยไปมาก' : 'จากมากไปน้อย'}
                    className="shrink-0 min-h-11 px-2 rounded-lg border border-gray-300 text-accent hover:bg-gray-50"
                  >
                    {dir === 'asc' ? '↑' : '↓'}
                  </button>
                </div>
                <select
                  value={statusFilter}
                  onChange={(e) => { setStatusFilter(e.target.value); setPage(0) }}
                  className={`${SELECT_CLS} w-full md:max-w-fit`}
                >
                  <option value="all">ทั้งหมด</option>
                  <option value="online">ออนไลน์</option>
                  <option value="offline">ออฟไลน์</option>
                  <option value="busy">มีงานอยู่</option>
                </select>
                <input
                  type="text"
                  value={query}
                  title='ค้นหาชื่อ ชื่อผู้ใช้ สังกัด หรือจังหวัด'
                  onChange={(e) => { setQuery(e.target.value); setPage(0) }}
                  placeholder="ค้นหาชื่อ ชื่อผู้ใช้ สังกัด หรือจังหวัด"
                  autoComplete="off"
                  className={`${INPUT_CLS} w-full md:w-40 text-accent`}
                />
              </div>
            </div>

            <div className="min-h-72 max-h-[60vh] overflow-y-auto lg:max-h-none lg:min-h-0 lg:flex-1 minimal-scrollbar">
              {officers.length === 0 ? (
                <CenteredMessage>ยังไม่มีเจ้าหน้าที่ที่ได้รับการยืนยัน</CenteredMessage>
              ) : filteredOfficers.length === 0 ? (
                <CenteredMessage>ไม่พบเจ้าหน้าที่ที่ตรงกับการค้นหา</CenteredMessage>
              ) : (
                <>
                <table className="hidden md:table w-full table-fixed text-left border-collapse">
                  <thead className={THEAD_CLS}>
                    <tr className="text-accent text-sm">
                      <th title="ชื่อ / ชื่อผู้ใช้" className="px-3 py-2 font-medium w-[34%]">ชื่อ / ชื่อผู้ใช้</th>
                      <th title="สังกัด" className="px-3 py-2 font-medium w-[26%]">สังกัด</th>
                      <th title="จังหวัด" className="px-3 py-2 font-medium w-[26%]">จังหวัด</th>
                      <th title="สถานะ" className="px-3 py-2 font-medium w-[14%]">สถานะ</th>
                      {canManage && <th className="px-3 py-2 font-medium w-20"></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {pagedOfficers.map((o) => (
                      editingId === o.user_id ? (
                        // Edit mode: replaces the entire row with a single full-width cell containing the edit form.
                        <tr key={o.field_officer_id} >
                          <td colSpan={officerCols} className="px-3 py-3">
                            {renderEditForm(o)}
                          </td>
                        </tr>
                      ) : (
                        <tr key={o.field_officer_id} className="border-b border-background hover:bg-background/50">
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-2">
                              {o.fire_id && (
                                <span title="มีงานอยู่" className="shrink-0 w-2.5 h-2.5 rounded-full bg-yellow-400" />
                              )}
                              {/* Name/username is clickable only when the officer is assigned to a fire, jumping to it on the map */}
                              {o.fire_id ? (
                                <button type="button" onClick={() => goToSpot(o)} title="มีงานอยู่ — ดูบนแผนที่" className="min-w-0 text-left">
                                  <p className="text-md text-primary font-medium truncate hover:text-brand">{o.name ?? o.username}</p>
                                  <p className="text-sm text-gray-500 font-light truncate">{o.username}</p>
                                </button>
                              ) : (
                                <div className="min-w-0">
                                  <p title={o.name ?? o.username} className="text-md text-primary font-medium truncate">{o.name ?? o.username}</p>
                                  <p title={o.username} className="text-sm text-gray-500 font-light truncate">{o.username}</p>
                                </div>
                              )}
                            </div>
                          </td>
                          <td title={o.division || '—'} className="px-3 py-2.5 text-sm text-gray-500 font-light truncate">{o.division || '—'}</td>
                          <td title={o.province_name_th} className="px-3 py-2.5 text-sm text-gray-500 font-light truncate">{o.province_name_th}</td>
                          <td className="px-3 py-2.5">
                            <div className="flex flex-col items-start gap-1">
                              <span title={o.active ? 'ออนไลน์' : 'ออฟไลน์'} className={`text-xs font-semibold px-2 py-1 rounded-full whitespace-nowrap ${o.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                                {o.active ? 'ออนไลน์' : 'ออฟไลน์'}
                              </span>
                              {o.last_updated && (
                                <span className="text-xs text-gray-500 font-light whitespace-nowrap">{formatLastSeen(o.last_updated)}</span>
                              )}
                            </div>
                          </td>
                          {canManage && (
                            <td className="px-3 py-2 text-right">
                              <button
                                type="button"
                                onClick={() => startEdit(o)}
                                className="text-sm text-primary hover:text-brand border-2 border-flame hover:border-brand hover:bg-flame-light rounded-xl px-3 py-1.5"
                              >
                                แก้ไข
                              </button>
                            </td>
                          )}
                        </tr>
                      )
                    ))}
                  </tbody>
                </table>

                {/* Mobile: same rows as cards (the table is hidden below md). */}
                <div className="md:hidden space-y-2">
                  {pagedOfficers.map((o) => (
                    editingId === o.user_id ? (
                      <div key={o.field_officer_id} className="rounded-xl border border-flame/40 bg-foreground p-3 shadow-sm">
                        {renderEditForm(o)}
                      </div>
                    ) : (
                      <RecordCard
                        key={o.field_officer_id}
                        titleSlot={
                          <div className="flex items-center gap-2 min-w-0">
                            {o.fire_id && <span title="มีงานอยู่" className="shrink-0 w-2.5 h-2.5 rounded-full bg-yellow-400" />}
                            {o.fire_id ? (
                              <button type="button" onClick={() => goToSpot(o)} title="มีงานอยู่ — ดูบนแผนที่" className="min-w-0 text-left">
                                <p className="truncate font-semibold text-primary hover:text-brand">{o.name ?? o.username}</p>
                                <p className="truncate text-sm font-light text-gray-500">{o.username}</p>
                              </button>
                            ) : (
                              <div className="min-w-0">
                                <p className="truncate font-semibold text-primary">{o.name ?? o.username}</p>
                                <p className="truncate text-sm font-light text-gray-500">{o.username}</p>
                              </div>
                            )}
                          </div>
                        }
                        badge={
                          <div className="flex flex-col items-end gap-1">
                            <span className={`text-xs font-semibold px-2 py-1 rounded-full whitespace-nowrap ${o.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                              {o.active ? 'ออนไลน์' : 'ออฟไลน์'}
                            </span>
                            {o.last_updated && (
                              <span className="text-xs text-gray-500 font-light whitespace-nowrap">{formatLastSeen(o.last_updated)}</span>
                            )}
                          </div>
                        }
                        rows={[
                          { label: 'สังกัด', value: o.division || '—' },
                          { label: 'จังหวัด', value: o.province_name_th },
                        ]}
                        actions={canManage && (
                          <button
                            type="button"
                            onClick={() => startEdit(o)}
                            className="text-sm text-primary hover:text-brand border-2 border-flame hover:border-brand hover:bg-flame-light rounded-xl px-3 py-1.5"
                          >
                            แก้ไข
                          </button>
                        )}
                      />
                    )
                  ))}
                </div>
                </>
              )}
            </div>

            {filteredOfficers.length > 0 && (
              <PaginationBar page={safePage} pageSize={PAGE_SIZE} total={total} onPage={setPage} className="mt-2 border-t border-gray-300" />
            )}
          </div>

          {/* Right column: pending registrations + region-change requests, stacked */}
          <div className="flex flex-col gap-4 rounded-2xl max-w-full lg:max-w-1/2 lg:flex-1">

            <div className="flex flex-col bg-foreground rounded-2xl max-w-full p-4 shadow-md lg:flex-1 lg:min-h-0">

              <div className="mb-2 pb-2 border-b border-gray-300 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <p className="font-medium text-accent text-lg">บัญชีที่รอการยืนยัน ({pending?.length ?? 0})</p>
                <input
                  type="text"
                  value={pendingQuery}
                  onChange={(e) => setPendingQuery(e.target.value)}
                  placeholder="ค้นหาชื่อ ชื่อผู้ใช้ สังกัด หรือจังหวัด"
                  title="ค้นหาชื่อ ชื่อผู้ใช้ สังกัด หรือจังหวัด"
                  autoComplete="off"
                  className={`${INPUT_CLS} w-full md:max-w-56 text-accent`}
                />
              </div>

              <div className="max-h-[50vh] overflow-y-auto lg:max-h-none lg:flex-1 lg:min-h-0 minimal-scrollbar">
                {loadingPending ? (
                  <CenteredMessage>กำลังโหลด…</CenteredMessage>
                ) : pending.length === 0 ? (
                  <CenteredMessage>ไม่มีบัญชีที่รอการยืนยัน</CenteredMessage>
                ) : filteredPending.length === 0 ? (
                  <CenteredMessage>ไม่พบบัญชีที่ตรงกับการค้นหา</CenteredMessage>
                ) : (
                  <>
                  <table className="hidden md:table w-full table-fixed text-left border-collapse">
                    <thead className={THEAD_CLS}>
                      <tr className="text-accent text-sm">
                        <th title="ชื่อ / ชื่อผู้ใช้" className="px-3 py-2 font-medium w-[22%]">ชื่อ / ชื่อผู้ใช้</th>
                        <th title="สังกัด" className="px-3 py-2 font-medium w-[24%]">สังกัด</th>
                        <th title="จังหวัด" className="px-3 py-2 font-medium w-[22%]">จังหวัด</th>
                        {canVerify && <th className="px-3 py-2 font-medium w-fit"></th>}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredPending.map((o) => (
                        <tr key={o.user_id} className="border-b border-background hover:bg-background/50">
                          <td className="px-3 py-2.5">
                            <p title={o.name ?? o.username} className="text-md text-primary font-medium truncate">{o.name ?? o.username}</p>
                            <p title={o.username} className="text-sm text-gray-500 font-light truncate">{o.username}</p>
                          </td>
                          <td title={o.division || '—'} className="px-3 py-2.5 text-sm text-gray-500 font-light truncate">{o.division || '—'}</td>
                          <td title={o.province_name_th} className="px-3 py-2.5 text-sm text-gray-500 font-light truncate">{o.province_name_th}</td>
                          {canVerify && (
                            <td className="px-3 py-2 text-right">
                              <div className="flex flex-row justify-end gap-2">

                                <button
                                  type="button"
                                  onClick={() => verify(o.user_id)}
                                  disabled={busyId === o.user_id}
                                  className="text-sm text-primary hover:text-brand border-2 border-flame hover:border-brand hover:bg-flame-light rounded-xl px-3 py-1.5 disabled:opacity-50 whitespace-nowrap"
                                >
                                  {busyId === o.user_id ? 'กำลังยืนยัน…' : 'ยืนยัน'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => reject(o)}
                                  disabled={busyId === o.user_id}
                                  className="text-sm text-red-600 hover:text-white border-2 border-red-300 hover:border-red-600 hover:bg-red-600 rounded-xl px-3 py-1.5 disabled:opacity-50 whitespace-nowrap"
                                >
                                  ไม่อนุมัติ
                                </button>
                              </div>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {/* Mobile: same rows as cards (the table is hidden below md). */}
                  <div className="md:hidden space-y-2">
                    {filteredPending.map((o) => (
                      <RecordCard
                        key={o.user_id}
                        title={o.name ?? o.username}
                        subtitle={o.username}
                        rows={[
                          { label: 'สังกัด', value: o.division || '—' },
                          { label: 'จังหวัด', value: o.province_name_th },
                        ]}
                        actions={canVerify && (
                          <>
                            <button
                              type="button"
                              onClick={() => verify(o.user_id)}
                              disabled={busyId === o.user_id}
                              className="text-sm text-primary hover:text-brand border-2 border-flame hover:border-brand hover:bg-flame-light rounded-xl px-3 py-1.5 disabled:opacity-50 whitespace-nowrap"
                            >
                              {busyId === o.user_id ? 'กำลังยืนยัน…' : 'ยืนยัน'}
                            </button>
                            <button
                              type="button"
                              onClick={() => reject(o)}
                              disabled={busyId === o.user_id}
                              className="text-sm text-red-600 hover:text-white border-2 border-red-300 hover:border-red-600 hover:bg-red-600 rounded-xl px-3 py-1.5 disabled:opacity-50 whitespace-nowrap"
                            >
                              ไม่อนุมัติ
                            </button>
                          </>
                        )}
                      />
                    ))}
                  </div>
                  </>
                )}
              </div>
            </div>

            {/* Region-change-requests panel only rendered for users permitted to view them */}
            {canViewReq && (
              <div className="flex flex-col bg-foreground rounded-2xl max-w-full p-4 shadow-md lg:flex-1 lg:min-h-0">

                <div className="mb-2 pb-2 border-b border-gray-300 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <p className="font-medium text-accent text-lg">คำขอย้ายพื้นที่ ({requests?.length ?? 0})</p>
                  <input
                    type="text"
                    value={requestQuery}
                    onChange={(e) => setRequestQuery(e.target.value)}
                    placeholder="ค้นหาชื่อ ชื่อผู้ใช้ หรือจังหวัด"
                    title="ค้นหาชื่อ ชื่อผู้ใช้ หรือจังหวัด"
                    autoComplete="off"
                    className={`${INPUT_CLS} w-full md:max-w-56 text-accent`}
                  />
                </div>

                <div className="max-h-[50vh] overflow-y-auto lg:max-h-none lg:flex-1 lg:min-h-0 minimal-scrollbar">
                  {loadingRequests ? (
                    <CenteredMessage>กำลังโหลด…</CenteredMessage>
                  ) : requests.length === 0 ? (
                    <CenteredMessage>ไม่มีคำขอย้ายพื้นที่</CenteredMessage>
                  ) : filteredRequests.length === 0 ? (
                    <CenteredMessage>ไม่พบคำขอที่ตรงกับการค้นหา</CenteredMessage>
                  ) : (
                    <>
                    <table className="hidden md:table w-full table-fixed text-left border-collapse">
                      <thead className={THEAD_CLS}>
                        <tr className="text-accent text-sm">
                          <th title="ชื่อ / ชื่อผู้ใช้" className="px-3 py-2 font-medium w-[28%]">ชื่อ / ชื่อผู้ใช้</th>
                          <th title="สังกัด" className="px-3 py-2 font-medium w-[20%]">สังกัด</th>
                          <th title="การย้ายพื้นที่" className="px-3 py-2 font-medium w-[28%]">การย้ายพื้นที่</th>
                          {canDecide && <th className="px-3 py-2 font-medium w-[24%]"></th>}
                        </tr>
                      </thead>
                      <tbody>
                        {filteredRequests.map((r) => (
                          <tr key={r.request_id} className="border-b border-background hover:bg-background/50">
                            <td className="px-3 py-2.5">
                              <p title={r.officer_name ?? r.username} className="text-md text-primary font-medium truncate">{r.officer_name ?? r.username}</p>
                              <p title={r.username} className="text-sm text-gray-500 font-light truncate">{r.username}</p>
                            </td>
                            <td title={r.division || '—'} className="px-3 py-2.5 text-sm text-gray-500 font-light truncate">{r.division || '—'}</td>
                            <td title={`${r.current_province} → ${r.requested_province}`} className="px-3 py-2.5 text-sm text-gray-500 font-light truncate">{r.current_province} → {r.requested_province}</td>
                            {canDecide && (
                              <td className="px-3 py-2 text-right">
                                <div className="flex gap-2 justify-end">
                                  <button
                                    type="button"
                                    onClick={() => decide(r.request_id, 'approve')}
                                    disabled={busyId === r.request_id}
                                    className="text-sm text-primary hover:text-brand border-2 border-flame hover:border-brand hover:bg-flame-light rounded-xl px-3 py-1.5 disabled:opacity-50 whitespace-nowrap"
                                  >
                                    อนุมัติ
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => decide(r.request_id, 'reject')}
                                    disabled={busyId === r.request_id}
                                    className="text-sm text-gray-500 hover:text-accent px-3 py-1.5 disabled:opacity-50 whitespace-nowrap"
                                  >
                                    ปฏิเสธ
                                  </button>
                                </div>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    {/* Mobile: same rows as cards (the table is hidden below md). */}
                    <div className="md:hidden space-y-2">
                      {filteredRequests.map((r) => (
                        <RecordCard
                          key={r.request_id}
                          title={r.officer_name ?? r.username}
                          subtitle={r.username}
                          rows={[
                            { label: 'สังกัด', value: r.division || '—' },
                            { label: 'การย้ายพื้นที่', value: `${r.current_province} → ${r.requested_province}` },
                          ]}
                          actions={canDecide && (
                            <>
                              <button
                                type="button"
                                onClick={() => decide(r.request_id, 'approve')}
                                disabled={busyId === r.request_id}
                                className="text-sm text-primary hover:text-brand border-2 border-flame hover:border-brand hover:bg-flame-light rounded-xl px-3 py-1.5 disabled:opacity-50 whitespace-nowrap"
                              >
                                อนุมัติ
                              </button>
                              <button
                                type="button"
                                onClick={() => decide(r.request_id, 'reject')}
                                disabled={busyId === r.request_id}
                                className="text-sm text-gray-500 hover:text-accent px-3 py-1.5 disabled:opacity-50 whitespace-nowrap"
                              >
                                ปฏิเสธ
                              </button>
                            </>
                          )}
                        />
                      ))}
                    </div>
                    </>
                  )}
                </div>
              </div>

            )}
          </div>
        </div>
      </div>
    </div>
  )
}
