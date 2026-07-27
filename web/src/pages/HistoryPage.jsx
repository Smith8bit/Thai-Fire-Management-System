import { useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuthStore, can } from '../lib/useAuthStore'
import { API_URL, apiFetch, INPUT_CLS, PAGE_SIZE, SELECT_CLS, THEAD_CLS } from '../lib/shared'
import { formatEventTime } from '../lib/datetime'
import { useRegions } from '../lib/useRegions'
import PaginationBar from '../components/PaginationBar'
import RecordCard from '../components/RecordCard'

// Maps evidence attachment MIME types to a file extension for downloaded filenames.
// Assumption: any content_type not listed here still downloads, just with a generic '.bin' extension.
const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/quicktime': 'mov',
}

/**
 * HistoryPage
 * Route-level component (no props). Read-only log of resolved/false-alarm
 * fires: filterable by outcome, province, date range, and free-text search,
 * with server-side pagination, CSV/zip export, and an evidence media viewer.
 *
 * Returns: JSX.Element, or a redirect to '/' when the user lacks 'fires.history' permission.
 */
export default function HistoryPage() {
  const user = useAuthStore((s) => s.user)
  const [items, setItems] = useState(null) // array|null: null = loading, [] = loaded-but-empty
  const [total, setTotal] = useState(0) // number: total matching rows from server, for PaginationBar
  const [page, setPage] = useState(0) // number: zero-based current page index
  const [kind, setKind] = useState('') // '' | 'resolved' | 'falsealarm' | 'expired': outcome filter
  const [province, setProvince] = useState('') // string: exact province name filter, '' = all
  const { provinces: provinceRegions } = useRegions()
  // Province filter options derived from the region tree's province-level nodes.
  const provinces = useMemo(() => (provinceRegions ?? []).map((p) => p.name_th), [provinceRegions])
  const [dateFrom, setDateFrom] = useState('') // string: 'YYYY-MM-DD' lower bound (inclusive)
  const [dateTo, setDateTo] = useState('') // string: 'YYYY-MM-DD' upper bound (inclusive)
  const [searchInput, setSearchInput] = useState('') // string: live text of the search box (uncommitted)
  const [search, setSearch] = useState('') // string: committed search term, applied on submit/blur
  const [error, setError] = useState(null) // string|null: load/export error message
  const [reload, setReload] = useState(0) // number: bumped to force-retrigger the fetch effect (manual "refresh")
  const [downloading, setDownloading] = useState(false) // boolean: disables the export button mid-download
  const [viewer, setViewer] = useState(null) // {path,url,isVideo,filename}|null: currently open evidence lightbox
  const [savingEvidence, setSavingEvidence] = useState(false) // boolean: disables the viewer's download button mid-request

  /**
   * saveEvidence
   * @param {string} path - API-relative path used to re-fetch the asset with auth headers (apiFetch)
   * @param {string} filename - suggested filename for the browser download
   * @returns {Promise<void>}
   * Re-fetches the asset (rather than reusing the <img>/<video> src) because the
   * displayed URL is unauthenticated; apiFetch attaches the credentials needed
   * to actually retrieve the bytes, then triggers a synthetic anchor-click download.
   */
  async function saveEvidence(path, filename) {
    setSavingEvidence(true)
    try {
      const res = await apiFetch(path)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      console.warn('[HistoryPage] evidence download failed:', e)
    } finally {
      setSavingEvidence(false)
    }
  }

  /**
   * buildFilterParams
   * @returns {URLSearchParams} query params shared by both the list fetch and the zip export,
   * so the exported data always matches what's currently on screen.
   */
  const buildFilterParams = () => {
    const p = new URLSearchParams()
    // Three mutually exclusive outcomes over two backend booleans:
    // extinguished = not false-alarm AND not expired; false alarm = false_alarm;
    // expired = auto-timed-out.
    if (kind === 'resolved') { p.set('false_alarm', 'false'); p.set('expired', 'false') }
    else if (kind === 'falsealarm') p.set('false_alarm', 'true')
    else if (kind === 'expired') p.set('expired', 'true')
    if (province) p.set('province', province)
    if (search) p.set('search', search)
    // Converts local-date inputs into UTC ISO bounds; dateTo is exclusive-end-of-day (+24h).
    if (dateFrom) p.set('since', new Date(`${dateFrom}T00:00:00`).toISOString())
    if (dateTo) p.set('until', new Date(new Date(`${dateTo}T00:00:00`).getTime() + 86_400_000).toISOString())
    return p
  }

  /**
   * download
   * @returns {Promise<void>}
   * Exports the currently filtered history as a zip (resolutions + evidence)
   * and triggers a browser download named with the active date range.
   */
  async function download() {
    setDownloading(true)
    setError(null)
    try {
      const res = await apiFetch(`/fires/resolutions/export?${buildFilterParams()}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = `fire-history${dateFrom ? '_' + dateFrom : ''}${dateTo ? '_' + dateTo : ''}.zip`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      console.warn('[HistoryPage] export failed:', e)
      setError('ดาวน์โหลดไม่สำเร็จ')
    } finally {
      setDownloading(false)
    }
  }

  // Fetches one page of resolution history whenever any filter, the page, or `reload` changes.
  useEffect(() => {
    let cancelled = false // guards against a stale response overwriting state after unmount/re-run
    const params = buildFilterParams()
    params.set('limit', String(PAGE_SIZE))
    params.set('offset', String(page * PAGE_SIZE))
    ;(async () => {
      try {
        const res = await apiFetch(`/fires/resolutions?${params}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (cancelled) return
        setItems(data.items ?? [])
        setTotal(data.total ?? 0)
        setError(null)
      } catch (e) {
        console.warn('[HistoryPage] load failed:', e)
        if (cancelled) return
        setItems([])
        setError('โหลดประวัติไม่สำเร็จ')
      }
    })()
    return () => { cancelled = true }
  }, [page, kind, province, dateFrom, dateTo, search, reload])

  // Access control: only users with the fires.history permission may view this page.
  if (!can(user, 'fires.history')) return <Navigate to="/" replace />

  return (
    <div className="flex-1 min-h-0 overflow-hidden bg-background">
        <div className="mx-auto flex h-full lg:max-w-[1600px] flex-col gap-3 px-3 py-3 lg:px-8">
      <div className='flex flex-col md:flex-row md:gap-4 md:items-center pl-12 lg:pl-0'>
        <h1 className='mt-2 pl-2 font-bold text-3xl text-primary'>ประวัติการดับไฟ</h1>
        <p className='pl-2 md:pl-0 font-medium text-md text-accent'>รายการจุดไฟที่ดำเนินการเสร็จสิ้นแล้ว</p>
      </div>

      <div className="flex flex-col flex-1 min-h-0 w-full bg-foreground rounded-2xl p-4 shadow-md">

        <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center pb-2 border-b border-gray-300">
          {/* Outcome + province filters: two-up on phones, inline at md+ */}
          <div className="grid grid-cols-2 gap-2 md:contents">
            <select
              value={kind}
              onChange={(e) => { setKind(e.target.value); setPage(0) }}
              className={`${SELECT_CLS} w-full md:max-w-fit`}
            >
              <option value="">ทั้งหมด</option>
              <option value="resolved">ดับแล้ว</option>
              <option value="falsealarm">ไม่ใช่ไฟ</option>
              <option value="expired">หมดอายุ</option>
            </select>

            <select
              value={province}
              onChange={(e) => { setProvince(e.target.value); setPage(0) }}
              className={`${SELECT_CLS} w-full md:max-w-fit`}
            >
              <option value="">ทุกจังหวัด</option>
              {provinces.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </div>

          {/* Date range: each bound's min/max is clamped to the other, preventing an inverted range */}
          <div className="flex items-center gap-1 w-full md:w-auto">
            <input
              type="date"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(e) => { setDateFrom(e.target.value); setPage(0) }}
              className={`${INPUT_CLS} flex-1 md:max-w-fit text-accent`}
            />
            <span className="text-accent">–</span>
            <input
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(e) => { setDateTo(e.target.value); setPage(0) }}
              className={`${INPUT_CLS} flex-1 md:max-w-fit text-accent`}
            />
          </div>

          {/* Actions + search share a row on phones */}
          <div className="flex items-center gap-2 w-full md:contents">
            <button
              type="button"
              onClick={download}
              disabled={downloading}
              className="shrink-0 text-md font-semibold text-blue-400 hover:text-blue-700 px-2 py-1.5 disabled:opacity-40"
            >
              {downloading ? 'กำลังดาวน์โหลด…' : 'ดาวน์โหลด'}
            </button>

            {/* Search: committed on Enter (form submit) or on blur, not on every keystroke */}
            <form
              onSubmit={(e) => { e.preventDefault(); setSearch(searchInput.trim()); setPage(0) }}
              className="flex flex-1 flex-row md:ml-auto md:w-78 md:flex-none items-center gap-2"
            >
              <input
                type="text"
                value={searchInput}
                title="ค้นหาด้วยชื่อจุดไฟ ชื่อเจ้าหน้าที่ หรือที่ตั้ง"
                onChange={(e) => setSearchInput(e.target.value)}
                onBlur={() => { setSearch(searchInput.trim()); setPage(0) }}
                placeholder="ค้นหาชื่อจุดไฟ เจ้าหน้าที่ หรือที่ตั้ง…"
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
            <p className="text-gray-400">ยังไม่มีประวัติการดับไฟ</p>
          )}

          {items !== null && !error && items.length > 0 && (
            <div className="flex-1 min-h-72 overflow-auto minimal-scrollbar">
              <table className="hidden md:table w-full table-fixed text-left border-collapse">
                <colgroup>
                  <col className="w-24" />
                  <col className="w-32" />
                  <col className="w-64" />
                  <col className="w-48" />
                  <col />
                  <col className="w-32" />
                </colgroup>
                <thead className={THEAD_CLS}>
                  <tr className="text-accent text-sm">
                    <th className="px-3 py-2 font-medium">สถานะ</th>
                    <th className="px-3 py-2 font-medium">จุดไฟ</th>
                    <th className="px-3 py-2 font-medium">ที่ตั้ง</th>
                    <th className="px-3 py-2 font-medium">ดับโดย</th>
                    <th className="px-3 py-2 font-medium">รายละเอียด</th>
                    <th className="px-3 py-2 font-medium text-right whitespace-nowrap">เวลาดับ</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={it.fire_id} className="border-b border-background hover:bg-background/50">
                      <td className="px-3 py-2.5 align-top">
                        {/* Three outcomes: expired (auto-timeout) takes precedence over the
                            false_alarm flag, then genuine extinguish. */}
                        <span className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${it.expired ? 'bg-amber-100 text-amber-700' : it.false_alarm ? 'bg-gray-100 text-gray-600' : 'bg-green-100 text-green-700'}`}>
                          {it.expired ? 'หมดอายุ' : it.false_alarm ? 'ไม่ใช่ไฟ' : 'ดับแล้ว'}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 align-top text-sm font-medium text-gray-900 wrap-break-word">
                        {it.name}
                      </td>
                      <td className="px-3 py-2.5 align-top text-sm text-gray-500 font-light wrap-break-word">
                        {[it.tumboon, it.aumper, it.province].filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td className="px-3 py-2.5 align-top text-sm text-gray-500 font-light break-all">
                        {/* Expired fires auto-close with no acting officer. */}
                        {it.expired ? '—' : (it.officer_name ?? 'ไม่ทราบ')}
                      </td>
                      <td className="px-3 py-2.5 align-top text-sm text-gray-500 font-light whitespace-pre-line wrap-break-word">
                        {it.note || '—'}
                        {it.images.length > 0 && (
                          <div className="mt-1 flex gap-1.5 flex-wrap">
                            {it.images.map(({ id, content_type }) => {
                              // Builds both the API-relative path (for authenticated re-fetch on download)
                              // and the direct URL (for inline <img>/<video> preview) from the same id.
                              const path = `/fires/${it.fire_id}/images/${id}`
                              const url = `${API_URL}${path}`
                              const isVideo = content_type?.startsWith('video/')
                              const filename = `evidence-${id}.${EXT[content_type] ?? 'bin'}`
                              return (
                                <button
                                  key={id}
                                  type="button"
                                  onClick={() => setViewer({ path, url, isVideo, filename })}
                                  className="relative h-16 w-16 overflow-hidden rounded-lg border border-gray-200 bg-black"
                                >
                                  {isVideo ? (
                                    <>
                                      {/* preload="metadata" avoids downloading full video just to show a thumbnail */}
                                      <video src={url} muted preload="metadata" className="h-16 w-16 object-cover" />
                                      <span className="absolute inset-0 flex items-center justify-center">
                                        <svg viewBox="0 0 24 24" className="h-7 w-7 fill-white/90 drop-shadow">
                                          <path d="M8 5v14l11-7z" />
                                        </svg>
                                      </span>
                                    </>
                                  ) : (
                                    <img src={url} alt="หลักฐาน" className="h-16 w-16 object-cover" />
                                  )}
                                </button>
                              )
                            })}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 align-top text-sm text-gray-500 whitespace-nowrap text-right">
                        {formatEventTime(it.resolved_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Mobile: same rows as cards (the table is hidden below md). */}
              <div className="md:hidden space-y-2">
                {items.map((it) => (
                  <RecordCard
                    key={it.fire_id}
                    title={it.name}
                    badge={
                      <span className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${it.expired ? 'bg-amber-100 text-amber-700' : it.false_alarm ? 'bg-gray-100 text-gray-600' : 'bg-green-100 text-green-700'}`}>
                        {it.expired ? 'หมดอายุ' : it.false_alarm ? 'ไม่ใช่ไฟ' : 'ดับแล้ว'}
                      </span>
                    }
                    rows={[
                      { label: 'ที่ตั้ง', value: [it.tumboon, it.aumper, it.province].filter(Boolean).join(' · ') || '—' },
                      { label: 'ดับโดย', value: it.expired ? '—' : (it.officer_name ?? 'ไม่ทราบ') },
                      { label: 'เวลาดับ', value: formatEventTime(it.resolved_at) },
                    ]}
                  >
                    {(it.note || it.images.length > 0) && (
                      <div>
                        <p className="mb-0.5 text-gray-500">รายละเอียด</p>
                        <div className="whitespace-pre-line wrap-break-word font-light">
                        {it.note || '—'}
                        {it.images.length > 0 && (
                          <div className="mt-1.5 flex gap-1.5 flex-wrap">
                            {it.images.map(({ id, content_type }) => {
                              const path = `/fires/${it.fire_id}/images/${id}`
                              const url = `${API_URL}${path}`
                              const isVideo = content_type?.startsWith('video/')
                              const filename = `evidence-${id}.${EXT[content_type] ?? 'bin'}`
                              return (
                                <button
                                  key={id}
                                  type="button"
                                  onClick={() => setViewer({ path, url, isVideo, filename })}
                                  className="relative h-16 w-16 overflow-hidden rounded-lg border border-gray-200 bg-black"
                                >
                                  {isVideo ? (
                                    <>
                                      <video src={url} muted preload="metadata" className="h-16 w-16 object-cover" />
                                      <span className="absolute inset-0 flex items-center justify-center">
                                        <svg viewBox="0 0 24 24" className="h-7 w-7 fill-white/90 drop-shadow">
                                          <path d="M8 5v14l11-7z" />
                                        </svg>
                                      </span>
                                    </>
                                  ) : (
                                    <img src={url} alt="หลักฐาน" className="h-16 w-16 object-cover" />
                                  )}
                                </button>
                              )
                            })}
                          </div>
                        )}
                        </div>
                      </div>
                    )}
                  </RecordCard>
                ))}
              </div>
            </div>
          )}

          {items?.length > 0 && (
            <PaginationBar page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} />
          )}
        </div>
      </div>
      </div>

      {/* Fullscreen evidence lightbox; clicking the backdrop closes it, clicking the media itself does not */}
      {viewer && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
          onClick={() => setViewer(null)}
        >
          {viewer.isVideo ? (
            <video
              src={viewer.url}
              controls
              autoPlay
              onClick={(e) => e.stopPropagation()}
              className="max-h-[85vh] max-w-[90vw]"
            />
          ) : (
            <img
              src={viewer.url}
              alt="หลักฐาน"
              onClick={(e) => e.stopPropagation()}
              className="max-h-[85vh] max-w-[90vw] object-contain"
            />
          )}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); saveEvidence(viewer.path, viewer.filename) }}
            disabled={savingEvidence}
            className="absolute right-20 top-5 flex h-10 items-center rounded-full bg-white/90 px-4 text-sm font-semibold text-gray-900 hover:bg-white disabled:opacity-50"
          >
            {savingEvidence ? 'กำลังดาวน์โหลด…' : 'ดาวน์โหลด'}
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setViewer(null) }}
            className="absolute right-5 top-5 flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-2xl text-white hover:bg-black/70"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  )
}
