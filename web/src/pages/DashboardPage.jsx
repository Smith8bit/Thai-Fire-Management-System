import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowPathIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  FireIcon,
  MapPinIcon,
  ShieldCheckIcon,
  UserGroupIcon,
} from '@heroicons/react/24/outline'
import { useFireData } from '../lib/useFireData'
import { useMapSelection, useSocketStore } from '../lib/stateStore'
import { useAuthStore, can } from '../lib/useAuthStore'
import { apiFetch } from '../lib/shared'

// Thai-locale string comparator, reused by every sort in this file so province/district
// names order the way a Thai reader expects (not raw code-point order).
const collator = new Intl.Collator('th')
const DAY_MS = 24 * 60 * 60 * 1000
const EMPTY_FIRES = []
// Fire timestamps from the backend are UTC; this offset re-bases "day" boundaries and
// display formatting onto Thailand's UTC+7 clock without needing a timezone library.
const THAI_OFFSET_MS = 7 * 60 * 60 * 1000
// Matches the backend's auto-expiry window for unassigned fires; used to warn on the watchlist.
const EXPIRE_DAYS = 10

/**
 * asDate
 * @param {string|number|null|undefined} value
 * @returns {Date|null} parsed Date, or null if `value` is falsy or unparseable
 */
function asDate(value) {
  const date = value ? new Date(value) : null
  return date && !Number.isNaN(date.getTime()) ? date : null
}

/**
 * detectedAgeMs
 * @param {string} value - ISO timestamp a fire was detected (UTC)
 * @param {number} nowMs - current time in epoch ms (passed in, not read live, so callers/memos stay pure)
 * @returns {number|null} age in ms, adjusted by THAI_OFFSET_MS; null if `value` doesn't parse
 */
function detectedAgeMs(value, nowMs) {
  const t = Date.parse(value)
  return Number.isNaN(t) ? null : nowMs - t + THAI_OFFSET_MS
}

/**
 * detectedDayKey
 * @param {string} value - ISO detection timestamp
 * @returns {string|null} 'YYYY-MM-DD' UTC day key for grouping, or null if unparseable
 */
function detectedDayKey(value) {
  const d = asDate(value)
  return d ? d.toISOString().slice(0, 10) : null
}

/**
 * utcDayKey
 * @param {number} ms - epoch ms, expected to already be Thai-offset-adjusted by the caller
 * @returns {string} 'YYYY-MM-DD' day key
 */
function utcDayKey(ms) {
  return new Date(ms + THAI_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * formatDateTime
 * @param {string} value - ISO timestamp
 * @returns {string} Thai-locale 'DD MMM HH:mm' string, or '-' if unparseable
 * Note: timeZone 'UTC' is intentional — callers pass already-offset values, so
 * formatting in UTC avoids the runtime's local timezone double-shifting the display.
 */
function formatDateTime(value) {
  const date = asDate(value)
  if (!date) return '-'
  return new Intl.DateTimeFormat('th-TH', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(date)
}

/**
 * formatAge
 * @param {string} value - ISO detection timestamp
 * @param {number} nowMs - current time in epoch ms
 * @returns {string} human-readable elapsed time in Thai ('X นาที' / 'X ชม. Y นาที' / 'X วัน Y ชม.'), or '-' if unparseable
 */
function formatAge(value, nowMs) {
  const ageMs = detectedAgeMs(value, nowMs)
  if (ageMs === null) return '-'
  const minutes = Math.max(0, Math.round(ageMs / 60000))
  if (minutes < 60) return `${minutes} นาที`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ชม. ${minutes % 60} นาที`
  return `${Math.floor(hours / 24)} วัน ${hours % 24} ชม.`
}

/** formatDateOnly - @param {Date} value @returns {string} Thai-locale 'D MMM YYYY', formatted in UTC (see formatDateTime note) */
function formatDateOnly(value) {
  return new Intl.DateTimeFormat('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(value)
}

/** formatShortDay - @param {Date} value @returns {string} Thai-locale 'DD MMM' axis label for the velocity chart */
function formatShortDay(value) {
  return new Intl.DateTimeFormat('th-TH', { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(value)
}

/** percent - @param {number} value @param {number} total @returns {number} rounded value/total*100, or 0 if total is falsy (avoids divide-by-zero/NaN) */
function percent(value, total) {
  if (!total) return 0
  return Math.round((value / total) * 100)
}

/** clampPercent - same as percent() but clamped to [0,100], for safe use as a CSS width */
function clampPercent(value, total) {
  return Math.max(0, Math.min(100, percent(value, total)))
}

/**
 * groupRows
 * Generic group-by-key reducer shared by every province/district aggregation below.
 * @param {Array<object>} items - source records (fires)
 * @param {(item: object) => string} keyFn - extracts the grouping key from an item; falsy keys fall back to 'ไม่ระบุ' (unspecified)
 * @param {(key: string, item: object) => object} factory - builds a fresh accumulator row the first time a key is seen
 * @param {(row: object, item: object) => void} update - mutates the row's running totals for each item (called once per item, including the first)
 * @returns {Array<object>} one row per distinct key, insertion order (Map preserves it)
 */
function groupRows(items, keyFn, factory, update) {
  const grouped = new Map()
  for (const item of items) {
    const key = keyFn(item) || 'ไม่ระบุ'
    const row = grouped.get(key) ?? factory(key, item)
    update(row, item)
    grouped.set(key, row)
  }
  return [...grouped.values()]
}

/** Partition a fire dataset into the status groups used by dashboard metrics. */
function summarizeFires(items) {
  const open = items.filter((f) => !f.status)
  const assigned = open.filter((f) => f.booked)
  const unassigned = open.filter((f) => !f.booked)
  const resolved = items.filter((f) => f.status && !f.expired && !f.false_alarm)
  const expired = items.filter((f) => f.expired)
  const falseAlarm = items.filter((f) => f.false_alarm)
  const newest = [...items].sort(
    (a, b) => (asDate(b.detected_at)?.getTime() ?? 0) - (asDate(a.detected_at)?.getTime() ?? 0),
  )[0]
  return { open, assigned, unassigned, resolved, expired, falseAlarm, newest }
}

/**
 * Build a fixed-length daily event series ending today.
 * Detection dates use the upstream feed's local-day encoding; resolution
 * timestamps are converted to a Thailand day by utcDayKey().
 */
function buildDailyRows(items, nowMs, days) {
  const todayKey = utcDayKey(nowMs)
  const endMs = Date.parse(`${todayKey}T00:00:00Z`)
  const span = Math.max(1, days)
  const rows = Array.from({ length: span }, (_, index) => {
    const dayMs = endMs - (span - 1 - index) * DAY_MS
    const key = new Date(dayMs).toISOString().slice(0, 10)
    return {
      key,
      label: formatShortDay(new Date(dayMs)),
      detected: 0,
      resolved: 0,
      falseAlarm: 0,
      expired: 0,
    }
  })
  const byKey = new Map(rows.map((row) => [row.key, row]))
  for (const fire of items) {
    const detectedRow = byKey.get(detectedDayKey(fire.detected_at))
    if (detectedRow) detectedRow.detected += 1
    if (fire.status && fire.resolve_time) {
      const closeRow = byKey.get(utcDayKey(Date.parse(fire.resolve_time)))
      if (closeRow) {
        if (fire.false_alarm) closeRow.falseAlarm += 1
        else if (fire.expired) closeRow.expired += 1
        else closeRow.resolved += 1
      }
    }
  }
  return rows
}

/**
 * MetricCard
 * Top-row KPI tile.
 * @param {object} props
 * @param {React.ComponentType} props.icon - heroicon component rendered in the tile's badge
 * @param {string} props.title - small label above the value
 * @param {string|number} props.value - the headline metric
 * @param {string} props.detail - supporting context line below the value
 * @param {'forest'|'red'|'amber'|'blue'|'slate'} [props.tone='forest'] - color scheme signaling severity/status
 * @returns {JSX.Element}
 */
function MetricCard({ icon: Icon, title, value, detail, tone = 'forest' }) {
  const tones = {
    forest: 'border-flame bg-flame-light text-brand',
    red: 'border-red-200 bg-red-50 text-red-700',
    amber: 'border-amber-200 bg-amber-50 text-amber-700',
    blue: 'border-blue-200 bg-blue-50 text-blue-700',
    slate: 'border-gray-200 bg-background text-accent',
  }

  return (
    <div className="rounded-2xl bg-foreground p-4 shadow-md">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-gray-500">{title}</p>
          <p className="mt-1 truncate text-2xl font-semibold leading-none text-accent">{value}</p>
        </div>
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${tones[tone]}`}>
          <Icon className="h-5 w-5" />
        </span>
      </div>
      <p className="mt-2 truncate text-sm text-gray-500">{detail}</p>
    </div>
  )
}

/**
 * Panel
 * Shared card chrome (header + scrollable body) for every dashboard section.
 * @param {object} props
 * @param {string} props.title
 * @param {string} props.subtitle
 * @param {React.ComponentType} [props.icon] - optional heroicon shown at the header's end
 * @param {React.ReactNode} props.children - scrollable panel body
 * @returns {JSX.Element}
 */
function Panel({ title, subtitle, icon: Icon, children }) {
  return (
    <section className="flex min-h-0 min-w-0 flex-col rounded-2xl bg-foreground shadow-md p-2">
      <div className="flex items-center justify-between gap-3 border-b border-gray-300 px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-accent">{title}</h2>
          <p className="truncate text-sm text-gray-500">{subtitle}</p>
        </div>
        {Icon && <Icon className="h-5 w-5 shrink-0 text-gray-400" />}
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto minimal-scrollbar">{children}</div>
    </section>
  )
}

/**
 * StatusBadge
 * @param {object} props
 * @param {React.ReactNode} props.children - badge label
 * @param {'green'|'red'|'amber'|'blue'|'slate'} [props.tone='slate']
 * @returns {JSX.Element}
 */
function StatusBadge({ children, tone = 'slate' }) {
  const tones = {
    green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    slate: 'bg-gray-50 text-gray-600 border-gray-200',
  }
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-sm font-semibold ${tones[tone]}`}>
      {children}
    </span>
  )
}

/**
 * ProgressBar
 * @param {object} props
 * @param {number} props.value - numerator
 * @param {number} props.total - denominator; 0/falsy renders an empty bar via clampPercent's guard
 * @param {string} [props.tone='bg-primary'] - Tailwind background class for the filled portion
 * @returns {JSX.Element}
 */
function ProgressBar({ value, total, tone = 'bg-primary' }) {
  return (
    <div className="h-2 w-full rounded-full bg-background">
      <div className={`h-2 rounded-full ${tone}`} style={{ width: `${clampPercent(value, total)}%` }} />
    </div>
  )
}

/**
 * VelocityColumnChart
 * Dual-series (detected vs. resolved) column chart for the "info" tab.
 * @param {object} props
 * @param {Array<{key:string,label:string,detected:number,resolved:number}>} props.rows - one column per day, in chronological order
 * @param {number} props.maxValue - largest single-series value across all rows, used to scale bar heights
 * @returns {JSX.Element}
 * Edge case: negative detected/resolved counts are clamped to 0 defensively (shouldn't occur, but guards the bar height math).
 */
function VelocityColumnChart({ rows, maxValue }) {
  const safeMax = Math.max(maxValue, 1) // avoids division by zero when every row is empty
  const scrollRef = useRef(null)

  // Longer ranges scroll inside the chart rather than widening the dashboard.
  // Start at the newest dates because they are the most operationally relevant.
  useEffect(() => {
    const element = scrollRef.current
    if (element) element.scrollLeft = element.scrollWidth
  }, [rows])

  if (!rows.length) {
    return <EmptyState>ยังไม่มีข้อมูลในช่วงที่แสดง</EmptyState>
  }

  return (
    <div className="flex h-full min-h-[260px] min-w-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-3 py-2 text-sm text-gray-500">
        <div className="flex shrink-0 items-center gap-3">
          <span className="inline-flex items-center gap-1"><span className="h-2 w-4 rounded-full bg-blue-400" />พบไฟ</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-4 rounded-full bg-primary" />ปิดงาน</span>
        </div>
        <span className="truncate">สูงสุด {safeMax} จุด/วัน · ปิดงานตามวันที่ปิดจริง</span>
      </div>
      <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-x-auto minimal-scrollbar">
        <div
          className="grid h-full min-h-[210px] items-end gap-1.5 px-3 py-3"
          style={{
            gridTemplateColumns: `repeat(${rows.length}, minmax(38px, 1fr))`,
            minWidth: rows.length > 14 ? `${rows.length * 42}px` : '100%',
          }}
        >
          {rows.map((row) => {
            const detected = Math.max(0, row.detected)
            const resolved = Math.max(0, row.resolved)

            return (
              <div key={row.key} className="flex h-full min-w-0 flex-col items-center justify-end gap-2">
                <div className="text-center leading-tight">
                  <p className="text-sm font-semibold text-blue-700">{detected}</p>
                  <p className="text-sm font-medium text-primary">{resolved} ปิด</p>
                </div>
                <div className="flex h-36 w-full items-end justify-center gap-1">
                  <div
                    className="w-2.5 rounded-t bg-blue-400"
                    style={{ height: `${clampPercent(detected, safeMax)}%` }}
                    title={`พบ ${detected} จุด`}
                  />
                  <div
                    className="w-2.5 rounded-t bg-primary"
                    style={{ height: `${clampPercent(resolved, safeMax)}%` }}
                    title={`ปิด ${resolved} จุด`}
                  />
                </div>
                <p className="truncate text-center text-sm font-medium text-gray-500">{row.label}</p>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** EmptyState - @param {object} props @param {React.ReactNode} props.children - message shown in place of an empty list/table */
function EmptyState({ children }) {
  return <p className="px-3 py-5 text-sm text-gray-400">{children}</p>
}

/**
 * CompactRows
 * Renders a divided list of rows, or an EmptyState if there are none.
 * @param {object} props
 * @param {Array<object>} props.rows
 * @param {(row: object, index: number) => JSX.Element} props.renderRow - row renderer; each result must supply its own `key`
 * @returns {JSX.Element}
 */
function CompactRows({ rows, renderRow }) {
  if (!rows.length) return <EmptyState>ยังไม่มีข้อมูลในช่วงที่แสดง</EmptyState>
  return <div className="divide-y divide-background">{rows.map(renderRow)}</div>
}

/**
 * DashboardPage
 * Route-level component (no props). Two-tab operational overview:
 * "ops" (live status: open fires, backlog, officer availability, watchlist)
 * and "info" (historical stats: closure rates, top provinces/districts, daily velocity).
 * Operational fire data comes from the shared useFireData hook. The info tab
 * fetches its own longer, region-scoped report window over HTTP.
 *
 * Returns: JSX.Element.
 */
export default function DashboardPage() {
  const navigate = useNavigate()
  const fires = useFireData()
  const ready = useSocketStore((s) => s.ready)
  const send = useSocketStore((s) => s.send)
  const officersMsg = useSocketStore((s) => s.byType?.officers_in_region)
  const pendingMsg = useSocketStore((s) => s.byType?.pending_officers)
  const canViewOfficers = can(useAuthStore((s) => s.user), 'officers.view')
  const setFocusedFire = useMapSelection((s) => s.setFocused)

  const [activeTab, setActiveTab] = useState('ops') // 'ops' | 'info'
  const [reportDays, setReportDays] = useState(7) // 7 | 30: rolling window for the info tab only
  const [reportFires, setReportFires] = useState(null) // null while the selected report is loading
  const [reportError, setReportError] = useState(null)
  const [reportReload, setReportReload] = useState(0)
  // Snapshotted rather than read live so all age/backlog calculations in a render agree;
  // refreshed explicitly by `refresh()`, not on a timer.
  const [nowMs, setNowMs] = useState(() => Date.now())
  const officers = useMemo(() => officersMsg?.officers ?? [], [officersMsg])
  const pendingOfficers = useMemo(() => pendingMsg?.officers ?? [], [pendingMsg])

  // Requests officer data once the socket is ready, only if the user is permitted to see it.
  useEffect(() => {
    if (!ready || !canViewOfficers) return
    send({ type: 'list_officers' })
    send({ type: 'list_pending_officers' })
  }, [ready, send, canViewOfficers])

  // Summary reporting is intentionally fetched over HTTP, separately from the
  // two-day WebSocket dataset used by operations and the map.
  useEffect(() => {
    if (activeTab !== 'info') return
    const controller = new AbortController()
    let cancelled = false
    ;(async () => {
      try {
        const response = await apiFetch(`/fires?days=${reportDays}`, { signal: controller.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.json()
        if (!cancelled) setReportFires(Array.isArray(data) ? data : [])
      } catch (error) {
        if (error.name === 'AbortError') return
        console.warn('[DashboardPage] report load failed:', error)
        if (!cancelled) setReportError('โหลดข้อมูลสรุปไม่สำเร็จ')
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [activeTab, reportDays, reportReload])

  /**
   * refresh
   * Manual refresh handler bound to the header's reload button: re-stamps
   * `nowMs` (so all age-based metrics recompute) and re-requests officer/fire
   * data over the socket.
   */
  const refresh = useCallback(() => {
    setNowMs(Date.now())
    if (activeTab === 'info') {
      setReportFires(null)
      setReportError(null)
      setReportReload((value) => value + 1)
      return
    }
    if (ready) {
      if (canViewOfficers) {
        send({ type: 'list_officers' })
        send({ type: 'list_pending_officers' })
      }
      send({ type: 'resync_fires' })
    }
  }, [activeTab, ready, send, canViewOfficers])

  /**
   * openFireOnMap
   * @param {string} fireId - id of the fire to focus
   * Sets the shared map-selection state then navigates to the map view,
   * so the fire's detail panel is already open on arrival.
   */
  const openFireOnMap = useCallback(
    (fireId) => {
      setFocusedFire(fireId)
      navigate('/map')
    },
    [navigate, setFocusedFire],
  )

  // Operational calculations keep using only the live WebSocket dataset.
  const summary = useMemo(() => summarizeFires(fires), [fires])
  const reportSource = reportFires ?? EMPTY_FIRES
  const reportSummary = useMemo(() => summarizeFires(reportSource), [reportSource])

  const officerSummary = useMemo(() => {
    const online = officers.filter((o) => o.active)
    const busy = officers.filter((o) => o.fire_id)
    const available = officers.filter((o) => o.active && !o.fire_id)
    return { online, busy, available }
  }, [officers])

  // Per-province open/assigned/resolved counts, sorted so provinces with the most open fires lead.
  const provinceRows = useMemo(() => {
    return groupRows(
      fires,
      (f) => f.province,
      (province) => ({ province, total: 0, open: 0, assigned: 0, resolved: 0 }),
      (row, f) => {
        row.total += 1
        if (!f.status) row.open += 1
        if (!f.status && f.booked) row.assigned += 1
        if (f.status && !f.false_alarm && !f.expired) row.resolved += 1
      },
    )
      .sort((a, b) => b.open - a.open || b.total - a.total || collator.compare(a.province, b.province))
  }, [fires])

  // Top 3 provinces by resolved-fire count, for the "info" tab leaderboard.
  const topProvinceRows = useMemo(() => {
    return groupRows(
      reportSource,
      (f) => f.province,
      (province) => ({ province, total: 0, resolved: 0 }),
      (row, f) => {
        row.total += 1
        if (f.status && !f.false_alarm && !f.expired) row.resolved += 1
      },
    )
      .sort((a, b) => b.resolved - a.resolved || b.total - a.total || collator.compare(a.province, b.province))
      .slice(0, 3)
  }, [reportSource])

  // Top 3 districts (aumper), grouped by "district|province" so same-named districts
  // in different provinces aren't merged together.
  const topDistrictRows = useMemo(() => {
    return groupRows(
      reportSource,
      (f) => `${f.aumper || 'ไม่ระบุอำเภอ'}|${f.province || 'ไม่ระบุจังหวัด'}`,
      (_key, f) => ({
        district: f.aumper || 'ไม่ระบุอำเภอ',
        province: f.province || 'ไม่ระบุจังหวัด',
        total: 0,
        resolved: 0,
      }),
      (row, f) => {
        row.total += 1
        if (f.status && !f.false_alarm && !f.expired) row.resolved += 1
      },
    )
      .sort((a, b) => b.resolved - a.resolved || b.total - a.total || collator.compare(a.district, b.district))
      .slice(0, 3)
  }, [reportSource])

  // Unassigned fires, oldest-first, so the most urgent items surface at the top of the watchlist.
  const watchlist = useMemo(() => {
    return [...summary.unassigned]
      .sort((a, b) => (asDate(a.detected_at)?.getTime() ?? 0) - (asDate(b.detected_at)?.getTime() ?? 0))
  }, [summary.unassigned])

  const dailyRows = useMemo(
    () => buildDailyRows(reportSource, nowMs, reportDays),
    [reportSource, nowMs, reportDays],
  )
  const todayRows = useMemo(() => buildDailyRows(fires, nowMs, 1), [fires, nowMs])

  // Count of unassigned fires older than 3 days — the "at risk of going stale" backlog metric.
  const backlog = useMemo(
    () => summary.unassigned.filter((f) => (detectedAgeMs(f.detected_at, nowMs) ?? 0) > 3 * DAY_MS).length,
    [summary.unassigned, nowMs],
  )

  // Cohort analysis: of fires old enough (>2 days) to reasonably have been handled by now,
  // what fraction were actually closed (excluding auto-expired)? Avoids penalizing very fresh fires.
  const cohort = useMemo(() => {
    const matured = reportSource.filter((f) => (detectedAgeMs(f.detected_at, nowMs) ?? 0) > 2 * DAY_MS)
    const handled = matured.filter((f) => f.status && !f.expired)
    return { total: matured.length, handled: handled.length }
  }, [reportSource, nowMs])

  const todayLabel = useMemo(() => formatDateOnly(new Date(nowMs + THAI_OFFSET_MS)), [nowMs])
  const todayOutcomes = todayRows[0] ?? { detected: 0, resolved: 0, falseAlarm: 0, expired: 0 }
  // Coverage defaults to 100% when there are no open fires (nothing left uncovered).
  const openCoverage = summary.open.length ? percent(summary.assigned.length, summary.open.length) : 100
  const cohortClosureRate = cohort.total ? percent(cohort.handled, cohort.total) : 0
  const attendedCloses = reportSummary.resolved.length + reportSummary.falseAlarm.length
  const falseAlarmRate = attendedCloses ? percent(reportSummary.falseAlarm.length, attendedCloses) : 0
  const maxDailyValue = Math.max(...dailyRows.map((row) => Math.max(row.detected, row.resolved)), 1)

  return (
    <div className="flex-1 min-h-0 overflow-hidden bg-background">
      <div className="mx-auto flex h-full max-w-[1600px] flex-col gap-3 px-5 py-3 lg:px-8">
        <header className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
          <div className="flex min-w-0 flex-row items-center gap-4">
            <h1 className="truncate pl-2 font-bold text-3xl text-primary">สรุปสถานการณ์ไฟป่า</h1>
            <p className="hidden font-medium text-md text-accent lg:block">ภาพรวมการปฏิบัติงานและสถิติไฟป่า</p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2 justify-self-end">
            <div className="flex rounded-lg bg-foreground p-1 shadow-md">
              {[
                { key: 'ops', label: 'ปฏิบัติการ' },
                { key: 'info', label: 'ข้อมูลสรุป' },
              ].map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => {
                    if (tab.key === 'info' && activeTab !== 'info') {
                      setReportFires(null)
                      setReportError(null)
                    }
                    setActiveTab(tab.key)
                  }}
                  className={`rounded-md px-3 py-1.5 text-sm font-semibold transition ${activeTab === tab.key
                      ? 'bg-primary text-white shadow-sm'
                      : 'text-accent hover:bg-background'
                    }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            {activeTab === 'info' && (
              <div
                role="group"
                className="flex rounded-lg border border-gray-200 bg-foreground p-1 shadow-md"
                aria-label="ช่วงข้อมูลสรุป"
              >
                {[7, 30].map((days) => (
                  <button
                    key={days}
                    type="button"
                    aria-pressed={reportDays === days}
                    onClick={() => {
                      if (days === reportDays) return
                      setReportFires(null)
                      setReportError(null)
                      setReportDays(days)
                    }}
                    className={`rounded-md px-2.5 py-1.5 text-sm font-semibold transition ${
                      reportDays === days
                        ? 'bg-primary text-white shadow-sm'
                        : 'text-gray-600 hover:bg-background'
                    }`}
                  >
                    {days} วัน
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={refresh}
              title="รีเฟรชข้อมูล"
              aria-label="รีเฟรชข้อมูล"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-gray-300 bg-foreground text-accent shadow-md hover:bg-background"
            >
              <ArrowPathIcon className="h-4 w-4" />
            </button>
          </div>
        </header>

        {activeTab === 'ops' ? (
          <>
            {/* Live operational KPIs: open fires, stale backlog, officer availability, most recent detection */}
            <section className="grid shrink-0 gap-3 md:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                icon={FireIcon}
                title="ไฟที่ยังเปิด"
                value={summary.open.length}
                detail={`${summary.unassigned.length} จุดยังไม่มีเจ้าหน้าที่`}
                tone={summary.unassigned.length ? 'red' : 'forest'}
              />
              <MetricCard
                icon={ShieldCheckIcon}
                title="งานค้างเกิน 3 วัน"
                value={backlog}
                detail={`ความครอบคลุม ${openCoverage}% · ${summary.assigned.length}/${summary.open.length} จุดมีผู้รับผิดชอบ`}
                tone={backlog ? 'red' : 'blue'}
              />
              <MetricCard
                icon={UserGroupIcon}
                title="เจ้าหน้าที่ว่าง"
                value={`${officerSummary.available.length} ว่าง`}
                detail={`จาก ${officerSummary.online.length} คนออนไลน์`}
                tone={officerSummary.available.length ? 'forest' : 'amber'}
              />
              <MetricCard
                icon={ClockIcon}
                title="จุดล่าสุด"
                value={summary.newest ? formatAge(summary.newest.detected_at, nowMs) : '-'}
                detail={summary.newest ? summary.newest.province ?? 'จุดที่ตรวจพบล่าสุด' : 'ยังไม่มีจุดไฟในหน้าปัจจุบัน'}
                tone="slate"
              />
            </section>

            <section className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[1.05fr_0.95fr_0.95fr]">
              <Panel title="จังหวัดที่ต้องติดตาม" subtitle="ไฟที่ยังเปิดและความครอบคลุมปัจจุบัน" icon={MapPinIcon}>
                <CompactRows
                  rows={provinceRows}
                  renderRow={(row) => (
                    <div key={row.province} className="px-3 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="truncate text-sm font-semibold text-accent">{row.province}</p>
                        <div className="flex shrink-0 gap-1.5">
                          <StatusBadge tone={row.open ? 'red' : 'green'}>{row.open} เปิด</StatusBadge>
                          <StatusBadge tone="blue">{row.assigned} ครอบคลุม</StatusBadge>
                        </div>
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <ProgressBar value={row.assigned} total={Math.max(row.open, 1)} tone="bg-blue-500" />
                        <span className="w-10 text-right text-sm text-gray-500">{percent(row.assigned, row.open)}%</span>
                      </div>
                    </div>
                  )}
                />
              </Panel>

              <Panel title="รอมอบหมาย" subtitle="เรียงจากจุดที่รอนานที่สุด · เตือนใกล้หมดอายุ" icon={FireIcon}>
                <CompactRows
                  rows={watchlist}
                  renderRow={(fire) => {
                    // Remaining days before this unassigned fire auto-expires server-side.
                    const daysLeft = EXPIRE_DAYS - (detectedAgeMs(fire.detected_at, nowMs) ?? 0) / DAY_MS
                    const nearExpiry = daysLeft <= 2
                    return (
                      <button
                        key={fire.id}
                        type="button"
                        onClick={() => openFireOnMap(fire.id)}
                        className="block w-full px-3 py-3 text-left transition hover:bg-background/50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-accent">{fire.name}</p>
                            <p className="truncate text-sm text-gray-500">{[fire.tumboon, fire.aumper, fire.province].filter(Boolean).join(' / ')}</p>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            <StatusBadge tone="amber">{formatAge(fire.detected_at, nowMs)}</StatusBadge>
                            {nearExpiry && (
                              <StatusBadge tone="red">หมดอายุใน {Math.max(0, Math.ceil(daysLeft))} วัน</StatusBadge>
                            )}
                          </div>
                        </div>
                        <p className="mt-1 text-sm font-medium text-brand">เปิดในแผนที่เพื่อมอบหมายเจ้าหน้าที่</p>
                      </button>
                    )
                  }}
                />
              </Panel>

              <Panel title="ทรัพยากร" subtitle="ความพร้อมเจ้าหน้าที่และสถานะวันนี้" icon={UserGroupIcon}>
                <div className="space-y-3 p-3">
                  <div>
                    <div className="mb-1.5 flex items-center justify-between text-sm">
                      <span className="font-medium text-accent">เจ้าหน้าที่ออนไลน์</span>
                      <span className="text-gray-500">{officerSummary.online.length}/{officers.length}</span>
                    </div>
                    <ProgressBar value={officerSummary.online.length} total={officers.length} tone="bg-primary" />
                  </div>
                  <div>
                    <div className="mb-1.5 flex items-center justify-between text-sm">
                      <span className="font-medium text-accent">พร้อมปฏิบัติงาน</span>
                      <span className="text-gray-500">{officerSummary.available.length}/{officerSummary.online.length}</span>
                    </div>
                    <ProgressBar value={officerSummary.available.length} total={officerSummary.online.length} tone="bg-blue-500" />
                  </div>
                  <div className="border-t border-gray-200 pt-3">
                    <p className="mb-2 text-sm font-semibold text-accent">บัญชีเจ้าหน้าที่</p>
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-center">
                      <p className="text-xl font-semibold text-amber-900">{pendingOfficers.length}</p>
                      <p className="text-sm text-amber-700">รอยืนยันบัญชี</p>
                    </div>
                  </div>
                  <div className="border-t border-gray-200 pt-3">
                    <p className="mb-2 text-sm font-semibold text-accent">สรุปกิจกรรมวันนี้ {todayLabel}</p>
                    <div className="grid grid-cols-2 gap-2 text-center">
                      <div className="rounded-lg border border-blue-200 bg-blue-50 p-2">
                        <p className="text-xl font-semibold text-blue-900">{todayOutcomes.detected}</p>
                        <p className="text-sm text-blue-700">พบวันนี้</p>
                      </div>
                      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2">
                        <p className="text-xl font-semibold text-emerald-900">{todayOutcomes.resolved}</p>
                        <p className="text-sm text-emerald-700">ปิดงานวันนี้</p>
                      </div>
                      <div className="rounded-lg border border-gray-200 p-2">
                        <p className="text-xl font-semibold text-accent">{todayOutcomes.falseAlarm}</p>
                        <p className="text-sm text-gray-500">ปิด: ไม่พบไฟ</p>
                      </div>
                      <div className="rounded-lg border border-gray-200 p-2">
                        <p className="text-xl font-semibold text-accent">{todayOutcomes.expired}</p>
                        <p className="text-sm text-gray-500">หมดอายุ</p>
                      </div>
                    </div>
                  </div>
                  <div className="rounded-lg bg-background p-2 text-sm text-gray-600">
                    จุดล่าสุด: <span className="font-semibold text-accent">{summary.newest ? formatDateTime(summary.newest.detected_at) : '-'}</span>
                  </div>
                </div>
              </Panel>
            </section>
          </>
        ) : reportError ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-2xl bg-foreground p-6 text-center shadow-md">
            <p className="font-semibold text-red-700">{reportError}</p>
            <p className="text-sm text-gray-500">ตรวจสอบว่า backend เริ่มทำงานแล้ว จากนั้นลองโหลดอีกครั้ง</p>
            <button
              type="button"
              onClick={refresh}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
            >
              ลองใหม่
            </button>
          </div>
        ) : reportFires === null ? (
          <div className="flex min-h-0 flex-1 items-center justify-center rounded-2xl bg-foreground p-6 text-sm font-medium text-gray-500 shadow-md">
            กำลังโหลดข้อมูลย้อนหลัง {reportDays} วัน…
          </div>
        ) : (
          <>
            {/* Analytical KPIs from the selected region-scoped HTTP report window. */}
            <section className="grid shrink-0 gap-3 md:grid-cols-3">
              <MetricCard
                icon={MapPinIcon}
                title={`จุดไฟย้อนหลัง ${reportDays} วัน`}
                value={reportSource.length}
                detail={`${reportSummary.resolved.length} จุดปิดแล้วในช่วงนี้`}
                tone="blue"
              />
              <MetricCard
                icon={CheckCircleIcon}
                title="อัตราปิดงาน (อายุเกิน 2 วัน)"
                value={`${cohortClosureRate}%`}
                detail={`${cohort.handled}/${cohort.total} จุดที่โตพอจะปิดได้`}
                tone="forest"
              />
              <MetricCard
                icon={ExclamationTriangleIcon}
                title="อัตราไม่พบไฟ"
                value={`${falseAlarmRate}%`}
                detail={`${reportSummary.falseAlarm.length}/${attendedCloses} การออกตรวจไม่พบไฟ`}
                tone="amber"
              />
            </section>

            <section className="grid min-h-0 min-w-0 flex-1 gap-3 xl:grid-cols-[minmax(260px,0.8fr)_minmax(0,2.2fr)]">
              <Panel title="อันดับพื้นที่" subtitle={`เรียงตามจำนวนงานปิดย้อนหลัง ${reportDays} วัน`} icon={MapPinIcon}>
                <div>
                  <div className="border-b border-gray-200 bg-background/60 px-3 py-2">
                    <h3 className="text-sm font-semibold text-accent">Top 3 จังหวัด</h3>
                  </div>
                  <CompactRows
                    rows={topProvinceRows}
                    renderRow={(row, index) => (
                      <div key={row.province} className="px-3 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-background text-sm font-semibold text-gray-600">{index + 1}</span>
                            <p className="truncate text-sm font-semibold text-accent">{row.province}</p>
                          </div>
                          <StatusBadge tone="green">{row.resolved} ปิด</StatusBadge>
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <ProgressBar value={row.resolved} total={row.total} tone="bg-emerald-500" />
                          <span className="w-16 text-right text-sm text-gray-500">{row.resolved}/{row.total} จุด</span>
                        </div>
                      </div>
                    )}
                  />
                </div>

                <div className="border-t border-gray-200">
                  <div className="border-b border-gray-200 bg-background/60 px-3 py-2">
                    <h3 className="text-sm font-semibold text-accent">Top 3 อำเภอ</h3>
                  </div>
                  <CompactRows
                    rows={topDistrictRows}
                    renderRow={(row, index) => (
                      <div key={`${row.district}-${row.province}`} className="px-3 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-background text-sm font-semibold text-gray-600">{index + 1}</span>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-accent">{row.district}</p>
                              <p className="truncate text-sm text-gray-500">{row.province}</p>
                            </div>
                          </div>
                          <StatusBadge tone="green">{row.resolved} ปิด</StatusBadge>
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <ProgressBar value={row.resolved} total={row.total} tone="bg-blue-500" />
                          <span className="w-16 text-right text-sm text-gray-500">{row.resolved}/{row.total} จุด</span>
                        </div>
                      </div>
                    )}
                  />
                </div>
              </Panel>

              <Panel title="Velocity รายวัน" subtitle={`พบไฟเทียบงานปิดย้อนหลัง ${reportDays} วัน`} icon={ClockIcon}>
                <VelocityColumnChart rows={dailyRows} maxValue={maxDailyValue} />
              </Panel>
            </section>
          </>
        )}
      </div>
    </div>
  )
}
