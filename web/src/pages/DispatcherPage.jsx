import { useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useSocketStore } from '../lib/stateStore'
import { useAuthStore, can } from '../lib/useAuthStore'
import { toast } from '../lib/toastStore'
import { useMessageEffect } from '../lib/useMessageEffect'
import { ERROR_MESSAGES, INPUT_CLS, PAGE_SIZE, SELECT_CLS, THEAD_CLS, USERNAME_PATTERN, errorText, isValidUsername, matchesQuery } from '../lib/shared'
import { useRegions } from '../lib/useRegions'
import PaginationBar from '../components/PaginationBar'
import CenteredMessage from '../components/CenteredMessage'
import RecordCard from '../components/RecordCard'

// Region option display text (Thai name); kept as a function for a single override point.
const regionLabel = (r) => r.name_th

// Sort weight for region levels so broader regions (national) list before narrower ones (province).
const REGION_LEVEL_ORDER = { national: 0, regional: 1, province: 2 }
const byRegion = (a, b) =>
  (REGION_LEVEL_ORDER[a.level] ?? 99) - (REGION_LEVEL_ORDER[b.level] ?? 99) ||
  (a.name_th ?? '').localeCompare(b.name_th ?? '', 'th')

// Permission ids/labels selectable in the create/edit dispatcher forms.
// Dependency: ids must match the backend's permission string constants exactly.
const PERMISSION_OPTIONS = [
  { id: 'officers.view', label: 'มองเห็นเจ้าหน้าที่' },
  { id: 'officer.manage', label: 'จัดการเจ้าหน้าที่' },
  { id: 'officer.verify', label: 'อนุมัติเจ้าหน้าที่ที่รอยืนยัน' },
  { id: 'region_requests.view', label: 'ดูคำขอย้ายพื้นที่' },
  { id: 'fire.appoint', label: 'มอบหมายงานดับไฟ' },
  { id: 'fire.false', label: 'แจ้งว่าไม่ใช่ไฟ' },
  { id: 'region_request.decide', label: 'อนุมัติคำขอย้ายพื้นที่' },
  { id: 'fires.history', label: 'ดูประวัติการดับไฟ' },
  { id: 'dispatchers.view', label: 'มองเห็นผู้ดูแล' },
]
// Default permission set pre-selected when creating a new dispatcher.
const DISPATCHER_DEFAULT = [
  'fires.view', 'officers.view', 'region_requests.view', 'officer.verify',
  'officer.manage', 'fire.appoint', 'fire.false', 'region_request.decide', 'fires.history'
]

// Permission dependency graph: selecting a key permission auto-grants (and locks) its listed
// dependencies, so an admin can't create an inconsistent permission set (e.g. manage without view).
const IMPLIES = {
  'officer.verify': ['officers.view'],
  'officer.manage': ['officers.view'],
  'fire.appoint': ['officers.view', 'fires.view'],
  'fire.false': ['fires.view'],
  'region_requests.view': ['officers.view'],
  'region_request.decide': ['region_requests.view', 'officers.view'],
  'dispatcher.manage': ['dispatchers.view'],
}

/**
 * impliedPerms
 * @param {string[]} perms - currently selected permission ids
 * @returns {Set<string>} the union of all permissions implied by `perms` via IMPLIES
 */
const impliedPerms = (perms) => {
  const out = new Set()
  for (const p of perms) for (const v of IMPLIES[p] ?? []) out.add(v)
  return out
}

const ALL_PERMISSION_IDS = PERMISSION_OPTIONS.map((p) => p.id)

/**
 * PermissionFields
 * Shared checkbox-grid editor for a dispatcher's permission set, used by both
 * the create form and the inline edit row.
 * @param {object} props
 * @param {string[]} props.perms - currently selected (explicit) permission ids
 * @param {(id: string) => void} props.onToggle - toggles a single permission id in `perms`
 * @param {(perms: string[]) => void} props.onSet - replaces the entire `perms` array (select-all/clear/revert)
 * @param {string[]} [props.revertTo] - permission set restored by the "คืนค่าเดิม" (revert) button
 * @returns {JSX.Element}
 * Note: an implied permission renders checked+disabled regardless of whether it's in `perms`,
 * since IMPLIES guarantees it's effectively granted anyway.
 */
function PermissionFields({ perms, onToggle, onSet, revertTo }) {
  const implied = impliedPerms(perms)
  return (
    <fieldset className="border border-gray-200 rounded-lg p-3">
      <legend className="text-sm text-gray-600 px-1">สิทธิ์การใช้งาน</legend>
      <div className="flex flex-wrap gap-2 mb-2">
        <button
          type="button"
          onClick={() => onSet([...ALL_PERMISSION_IDS])}
          className="text-xs text-primary hover:underline"
        >
          เลือกทั้งหมด
        </button>
        <span className="text-gray-300">·</span>
        <button
          type="button"
          onClick={() => onSet([])}
          className="text-xs text-gray-500 hover:underline"
        >
          ยกเลิกทั้งหมด
        </button>
        <span className="text-gray-300">·</span>
        <button
          type="button"
          onClick={() => onSet([...(revertTo ?? [])])}
          className="text-xs text-gray-500 hover:underline"
        >
          คืนค่าเดิม
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {PERMISSION_OPTIONS.map((p) => {
          const auto = implied.has(p.id)
          return (
            <label
              key={p.id}
              title={auto ? 'อัตโนมัติจากสิทธิ์ที่เลือก' : undefined}
              className={`flex items-center gap-2 text-sm ${auto ? 'text-primary' : 'text-gray-700'}`}
            >
              <input
                type="checkbox"
                checked={perms.includes(p.id) || auto}
                disabled={auto}
                onChange={() => onToggle(p.id)}
                className="rounded border-gray-300 text-brand focus:ring-primary disabled:opacity-60"
              />
              {p.label}
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

/**
 * DispatcherPage
 * Route-level component (no props). Lists all regional dispatchers; superusers
 * additionally get inline edit/delete on each row and a create-dispatcher form.
 * Data flows over the shared websocket (useSocketStore) rather than plain REST:
 * this component sends command messages and reacts to their typed responses.
 *
 * Returns: JSX.Element, or a redirect to '/' when the user lacks 'dispatchers.view'.
 */
export default function DispatcherPage() {
  const user = useAuthStore((s) => s.user)
  const send = useSocketStore((s) => s.send)
  const canManage = user?.is_superuser // gates edit/delete/create UI; view access is a separate, broader permission
  const dispatchersMsg = useSocketStore((s) => s.byType?.dispatchers)
  const createdMsg = useSocketStore((s) => s.byType?.dispatcher_created)
  const updatedMsg = useSocketStore((s) => s.byType?.dispatcher_updated)
  const deletedMsg = useSocketStore((s) => s.byType?.dispatcher_deleted)
  const errorMsg = useSocketStore((s) => s.byType?.error)

  const [dispatchers, setDispatchers] = useState(null) // array|null: null = awaiting first 'dispatchers' socket message
  const { regions: allRegions } = useRegions()
  // Sorted once per regions change so both the create <select> and edit <select> share the same ordering.
  const regions = useMemo(() => (allRegions ? [...allRegions].sort(byRegion) : null), [allRegions])
  const [query, setQuery] = useState('') // string: client-side search across name/username/division/region
  const [sort, setSort] = useState('name') // 'name' | 'new': sort key
  const [dir, setDir] = useState('asc') // 'asc' | 'desc': sort direction
  const [page, setPage] = useState(0) // number: zero-based current page index (client-side pagination)

  // --- Create-dispatcher form state (canManage only) ---
  const [creating, setCreating] = useState(false) // boolean: true while awaiting the server's create response
  const [newUsername, setNewUsername] = useState('')
  const [newName, setNewName] = useState('')
  const [newDivision, setNewDivision] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newRegion, setNewRegion] = useState('') // string: selected region id, required to submit
  const [newPerms, setNewPerms] = useState(DISPATCHER_DEFAULT)

  // --- Inline edit-row state (canManage only; one row editable at a time via editingId) ---
  const [editingId, setEditingId] = useState(null) // string|null: user_id of the dispatcher currently being edited
  const [editName, setEditName] = useState('')
  const [editDivision, setEditDivision] = useState('')
  const [editUsername, setEditUsername] = useState('')
  const [editPassword, setEditPassword] = useState('') // string: left blank = keep existing password (see saveEdit)
  const [editRegion, setEditRegion] = useState('')
  const [editPerms, setEditPerms] = useState([])
  const [savingId, setSavingId] = useState(null) // string|null: user_id currently being saved (disables Save button)
  const [deletingId, setDeletingId] = useState(null) // string|null: user_id currently being deleted (disables Delete button)

  // Requests the full dispatcher list once on mount (and if `send`'s identity ever changes).
  useEffect(() => { send({ type: 'list_dispatchers' }) }, [send])

  // Applies the latest 'dispatchers' snapshot pushed over the socket.
  useEffect(() => {
    if (!dispatchersMsg) return
    setDispatchers(dispatchersMsg.dispatchers ?? [])
  }, [dispatchersMsg])

  // useMessageEffect (vs plain useEffect) ensures each distinct server message fires its
  // handler exactly once, even if the underlying store object reference is reused.
  useMessageEffect(createdMsg, () => {
    setCreating(false)
    setNewUsername(''); setNewName(''); setNewDivision(''); setNewPassword(''); setNewRegion('')
    setNewPerms(DISPATCHER_DEFAULT)
    toast.success('สร้างผู้ดูแลสำเร็จ')
  })

  useMessageEffect(updatedMsg, () => {
    setEditingId(null)
    setSavingId(null)
    toast.success('บันทึกข้อมูลผู้ดูแลแล้ว')
  })

  useMessageEffect(deletedMsg, (m) => {
    // Optimistically removes the deleted dispatcher locally rather than waiting for a full re-list.
    setDispatchers((prev) => prev ? prev.filter((d) => d.user_id !== m.user_id) : prev)
    setEditingId(null)
    setDeletingId(null)
    toast.success('ลบผู้ดูแลแล้ว')
  })

  // Single shared error handler: clears whichever in-flight action state was pending,
  // since the socket message doesn't indicate which request it was responding to.
  useMessageEffect(errorMsg, (m) => {
    setCreating(false)
    setSavingId(null)
    setDeletingId(null)
    toast.error(errorText(m.code))
  })

  // Access control: viewing the dispatcher list requires the 'dispatchers.view' permission.
  if (!can(user, 'dispatchers.view')) return <Navigate to="/" replace />

  // Curried toggle helper: toggle(id) returns a list-updater fn, usable directly as a setState updater.
  const toggle = (id) => (list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id])
  const togglePerm = (id) => setNewPerms(toggle(id))
  const toggleEditPerm = (id) => setEditPerms(toggle(id))

  /**
   * createDispatcher
   * @param {React.FormEvent<HTMLFormElement>} e
   * Validates username format and that a region was chosen, then sends a
   * 'create_dispatcher' command over the socket. Server response is handled
   * asynchronously by the createdMsg/errorMsg effects above.
   */
  const createDispatcher = (e) => {
    e.preventDefault()
    if (!isValidUsername(newUsername)) { toast.error(ERROR_MESSAGES.invalid_username); return }
    if (!newRegion) { toast.error(ERROR_MESSAGES.invalid_region); return }
    setCreating(true)
    send({ type: 'create_dispatcher', username: newUsername, password: newPassword, name: newName, division: newDivision, region_id: newRegion, permissions: newPerms })
  }

  const clearCreateForm = () => {
    setNewUsername(''); setNewName(''); setNewDivision(''); setNewPassword(''); setNewRegion('')
    setNewPerms(DISPATCHER_DEFAULT)
  }

  /**
   * startEdit
   * @param {object} d - the dispatcher row to edit
   * Seeds the edit-row state from the selected dispatcher's current values.
   * Password is always started blank since the server never returns it.
   */
  const startEdit = (d) => {
    setEditingId(d.user_id)
    setEditName(d.name ?? '')
    setEditDivision(d.division ?? '')
    setEditUsername(d.username ?? '')
    setEditPassword('')
    setEditRegion(d.region_id ?? '')
    setEditPerms(d.permissions ?? [])
  }

  /**
   * saveEdit
   * @param {object} d - the dispatcher row being saved (source of the immutable user_id)
   * Sends an 'update_dispatcher' command. `region_id` and `password` are only
   * included when set, so the server keeps the existing value for either field
   * when the admin didn't intend to change it.
   */
  const saveEdit = (d) => {
    if (!isValidUsername(editUsername)) { toast.error(ERROR_MESSAGES.invalid_username); return }
    setSavingId(d.user_id)
    const payload = { type: 'update_dispatcher', user_id: d.user_id, name: editName, username: editUsername, division: editDivision, permissions: editPerms }
    if (editRegion) payload.region_id = editRegion
    if (editPassword) payload.password = editPassword
    send(payload)
  }

  /**
   * removeDispatcher
   * @param {object} d - the dispatcher row to delete
   * Confirms via a native dialog (irreversible action) before sending 'delete_dispatcher'.
   */
  const removeDispatcher = (d) => {
    if (!window.confirm(`ลบผู้ดูแล ${d.name ?? d.username}?\nการกระทำนี้ไม่สามารถย้อนกลับได้`)) return
    setDeletingId(d.user_id)
    send({ type: 'delete_dispatcher', user_id: d.user_id })
  }

  const loading = dispatchers === null

  const q = query.trim().toLowerCase()
  // Client-side filter: full dispatcher list is small enough that server-side search isn't needed.
  const filteredDispatchers = (dispatchers ?? []).filter((d) =>
    matchesQuery(d, ['name', 'username', 'division', 'region_name_th'], q))
  const dispatcherCols = canManage ? 4 : 3 // colSpan for the inline edit row must match the visible column count

  const cmp =
    sort === 'new'
      ? (a, b) => new Date(a.created_at ?? 0) - new Date(b.created_at ?? 0)
      : (a, b) => (a.name ?? a.username ?? '').localeCompare(b.name ?? b.username ?? '', 'th')
  const sortedDispatchers = [...filteredDispatchers].sort(
    (a, b) => (dir === 'desc' ? -cmp(a, b) : cmp(a, b)))

  const total = sortedDispatchers.length
  const lastPage = Math.max(Math.ceil(total / PAGE_SIZE) - 1, 0)
  // Clamps `page` if a search/filter shrank the result set below the current page's range.
  const safePage = Math.min(page, lastPage)
  const pagedDispatchers = sortedDispatchers.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)
  // Syncs the clamped page back into state; guarded by the equality check so it only
  // fires (and re-renders) when clamping actually changed something.
  if (page !== safePage) setPage(safePage)

  /**
   * renderEditForm
   * @param {object} d - the dispatcher row being edited
   * Shared edit form for a dispatcher row, rendered inside the desktop table
   * cell and inside the mobile card so the two presentations stay identical.
   */
  const renderEditForm = (d) => (
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
        placeholder="ชื่อผู้ดูแล"
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
        value={editRegion}
        onChange={(e) => setEditRegion(e.target.value)}
        className={SELECT_CLS}
      >
        {(regions ?? []).map((r) => (
          <option key={r.id} value={r.id}>{regionLabel(r)}</option>
        ))}
      </select>
      <PermissionFields perms={editPerms} onToggle={toggleEditPerm} onSet={setEditPerms} revertTo={d.permissions ?? []} />
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
          onClick={() => removeDispatcher(d)}
          disabled={deletingId === d.user_id}
          className="text-sm text-destructive hover:text-white hover:bg-destructive border-2 rounded-full px-3 py-1.5 disabled:opacity-50"
        >
          {deletingId === d.user_id ? 'กำลังลบ…' : 'ลบผู้ดูแล'}
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
            onClick={() => saveEdit(d)}
            disabled={savingId === d.user_id}
            className="bg-primary hover:bg-brand text-white rounded-xl px-4 py-1.5 text-sm disabled:opacity-50"
          >
            {savingId === d.user_id ? 'กำลังบันทึก…' : 'บันทึก'}
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="flex-1 min-h-0 overflow-scroll bg-background">
      <div className="mx-auto flex min-h-full lg:h-full max-w-[1600px] flex-col gap-3 px-3 py-3 lg:px-8">

      <div className='flex flex-col md:flex-row md:gap-4 md:items-center pl-12 lg:pl-0'>
        <h1 className='mt-2 pl-2 font-bold text-3xl text-primary'>ผู้ดูแล</h1>
        <p className='pl-2 md:pl-0 font-medium text-md text-accent'>ผู้ดูแลประจำพื้นที่ (สร้าง แก้ไข และลบบัญชี)</p>
      </div>

      <div className="w-full flex flex-col lg:flex-row gap-4 lg:flex-1 lg:min-h-0">

        <div className="flex flex-col bg-foreground rounded-2xl p-4 shadow-md max-w-full lg:flex-2 lg:min-h-0 lg:h-full">

          <div className="mb-2 pb-2 border-b border-gray-300 flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:justify-between">
            <p className="font-medium text-accent text-lg whitespace-nowrap">ผู้ดูแลประจำพื้นที่ ({dispatchers?.length ?? 0})</p>
            <div className="flex flex-row items-center gap-2 w-full md:w-auto">
              <div className="flex flex-row gap-2 border border-gray-300 p-1.5 rounded-xl">
                <select
                  value={sort}
                  onChange={(e) => { setSort(e.target.value); setPage(0) }}
                  title="เรียงลำดับ"
                  className={`${SELECT_CLS} w-fit! text-accent`}
                >
                  <option value="name">ตามชื่อ</option>
                  <option value="new">ตามเวลาที่เพิ่ม</option>
                </select>
                <button
                  type="button"
                  onClick={() => { setDir((d) => (d === 'asc' ? 'desc' : 'asc')); setPage(0) }}
                  title={dir === 'asc' ? 'จากน้อยไปมาก' : 'จากมากไปน้อย'}
                  className="shrink-0 px-2 py-1.5 rounded-lg border border-gray-300 text-accent hover:bg-gray-50"
                >
                  {dir === 'asc' ? '↑' : '↓'}
                </button>
              </div>
              <input
                type="text"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setPage(0) }}
                placeholder="ค้นหาชื่อ ชื่อผู้ใช้ สังกัด หรือพื้นที่"
                title="ค้นหาชื่อ ชื่อผู้ใช้ สังกัด หรือพื้นที่"
                autoComplete="off"
                className={`${INPUT_CLS} flex-1 md:max-w-56 text-accent`}
              />
            </div>
          </div>

          <div className="min-h-72 max-h-[60vh] overflow-y-auto lg:max-h-none lg:min-h-0 lg:flex-1 minimal-scrollbar">
            {loading ? (
              <CenteredMessage>กำลังโหลด…</CenteredMessage>
            ) : dispatchers.length === 0 ? (
              <CenteredMessage>ยังไม่มีผู้ดูแล</CenteredMessage>
            ) : filteredDispatchers.length === 0 ? (
              <CenteredMessage>ไม่พบผู้ดูแลที่ตรงกับการค้นหา</CenteredMessage>
            ) : (
              <>
              <table className="hidden md:table w-full table-fixed text-left border-collapse">
                <thead className={THEAD_CLS}>
                  <tr className="text-accent text-sm">
                    <th title="ชื่อ / ชื่อผู้ใช้" className="px-3 py-2 font-medium w-[24%]">ชื่อ / ชื่อผู้ใช้</th>
                    <th title="สังกัด" className="px-3 py-2 font-medium w-[24%]">สังกัด</th>
                    <th title="พื้นที่รับผิดชอบ" className="px-3 py-2 font-medium w-[52%]">พื้นที่รับผิดชอบ</th>
                    {canManage && <th className="px-3 py-2 font-medium w-20"></th>}
                  </tr>
                </thead>
                <tbody>
                  {pagedDispatchers.map((d) => (
                    editingId === d.user_id ? (
                      // Edit mode: replaces the entire row with a single full-width cell containing the edit form.
                      <tr key={d.user_id}>
                        <td colSpan={dispatcherCols} className="px-3 py-3">
                          {renderEditForm(d)}
                        </td>
                      </tr>
                    ) : (
                      <tr key={d.user_id} className="border-b border-background hover:bg-background/50">
                        <td className="px-3 py-2.5">
                          <p title={d.name ?? d.username} className="text-md text-primary font-medium truncate">{d.name ?? d.username}</p>
                          <p title={d.username} className="text-sm text-gray-500 font-light truncate">{d.username}</p>
                        </td>
                        <td title={d.division || '—'} className="px-3 py-2.5 text-sm text-gray-500 font-light truncate">{d.division || '—'}</td>
                        <td title={d.region_name_th} className="px-3 py-2.5 text-sm text-gray-500 font-light truncate">{d.region_name_th}</td>
                        {canManage && (
                          <td className="px-3 py-2 text-right">
                            <button
                              type="button"
                              onClick={() => startEdit(d)}
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
                {pagedDispatchers.map((d) => (
                  editingId === d.user_id ? (
                    <div key={d.user_id} className="rounded-xl border border-flame/40 bg-foreground p-3 shadow-sm">
                      {renderEditForm(d)}
                    </div>
                  ) : (
                    <RecordCard
                      key={d.user_id}
                      titleSlot={
                        <div className="min-w-0">
                          <p title={d.name ?? d.username} className="truncate font-semibold text-primary">{d.name ?? d.username}</p>
                          <p title={d.username} className="truncate text-sm font-light text-gray-500">{d.username}</p>
                        </div>
                      }
                      rows={[
                        { label: 'สังกัด', value: d.division || '—' },
                        { label: 'พื้นที่รับผิดชอบ', value: d.region_name_th },
                      ]}
                      actions={canManage && (
                        <button
                          type="button"
                          onClick={() => startEdit(d)}
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

          {!loading && filteredDispatchers.length > 0 && (
            <PaginationBar page={safePage} pageSize={PAGE_SIZE} total={total} onPage={setPage} className="mt-2 border-t border-gray-300" />
          )}
        </div>

        {/* Create-dispatcher panel only rendered for superusers */}
        {canManage && (
          <div className="flex flex-col bg-foreground rounded-2xl p-4 shadow-md max-w-full lg:flex-1 lg:min-h-0 lg:h-full">

            <div className="mb-2 pb-2 border-b border-gray-300 flex flex-row items-center justify-between gap-4">
              <p className="font-medium text-accent text-lg">สร้างผู้ดูแลใหม่</p>
            </div>

            <div className="px-2 lg:flex-1 lg:min-h-0 lg:overflow-y-auto minimal-scrollbar">
              <form onSubmit={createDispatcher} className="space-y-2 text-accent">
                <input
                  type="text"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  placeholder="ชื่อผู้ใช้"
                  autoComplete="off"
                  required
                  minLength={3}
                  maxLength={32}
                  pattern={USERNAME_PATTERN}
                  title={ERROR_MESSAGES.invalid_username}
                  className={INPUT_CLS}
                />
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="ชื่อผู้ดูแล"
                  className={INPUT_CLS}
                />
                <input
                  type="text"
                  value={newDivision}
                  onChange={(e) => setNewDivision(e.target.value)}
                  placeholder="สังกัด"
                  className={INPUT_CLS}
                />
                <select
                  value={newRegion}
                  onChange={(e) => setNewRegion(e.target.value)}
                  required
                  className={SELECT_CLS}
                >
                  <option value="">— เลือกพื้นที่รับผิดชอบ —</option>
                  {(regions ?? []).map((r) => (
                    <option key={r.id} value={r.id}>{regionLabel(r)}</option>
                  ))}
                </select>
                <PermissionFields perms={newPerms} onToggle={togglePerm} onSet={setNewPerms} revertTo={DISPATCHER_DEFAULT} />
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="รหัสผ่าน (อย่างน้อย 8 ตัวอักษร)"
                  autoComplete="new-password"
                  required
                  className={INPUT_CLS}
                />
                <div className="flex justify-between gap-2">
                  <button
                    type="button"
                    onClick={clearCreateForm}
                    disabled={creating}
                    className="border border-gray-300 text-accent hover:bg-gray-100 rounded-xl px-4 py-1.5 text-sm disabled:opacity-50"
                  >
                    ล้างทั้งหมด
                  </button>
                  <button
                    type="submit"
                    disabled={creating}
                    className="bg-primary hover:bg-brand text-white rounded-xl px-4 py-1.5 text-sm disabled:opacity-50"
                  >
                    {creating ? 'กำลังสร้าง…' : 'สร้างผู้ดูแล'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  )
}
