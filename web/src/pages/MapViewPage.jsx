import { useMemo, useState, useEffect, useRef } from 'react'
import { List } from 'react-window'
import { ArrowsPointingOutIcon, UserGroupIcon, ChevronDoubleRightIcon, ChevronDoubleLeftIcon, PlusIcon, MinusIcon, Cog6ToothIcon } from '@heroicons/react/20/solid'
import { useMapSelection, useSocketStore } from '../lib/stateStore'
import { useAuthStore, can } from '../lib/useAuthStore'
import { useFireData } from '../lib/useFireData'
import { FIRE_COLORS } from '../lib/fireColors'
import Map from '../components/map'
import Card from '../components/card'
import ExpandedCard from '../components/expandedCard'

import satelliteStyle from '../components/layers/satellite.json'
import baseStyle from '../components/layers/base.json'
import topoStyle from '../components/layers/topo.json'

// Map basemap style options keyed by their Thai display label (used both as
// the <select>/button labels and as the lookup key for the active style).
const LAYERS = { 'ค่าเริ่มต้น': baseStyle, 'ดาวเทียม': satelliteStyle, 'ภูมิประเทศ': topoStyle }
// Fallback camera position used when the signed-in user has no saved `home` location.
const DEFAULT_HOME = { lat: 13.05, lng: 101.45, zoom: 5.5 }
// Fixed row height (px) required by react-window's virtualization to compute scroll offsets.
const CARD_HEIGHT = 140
// Stable empty-array reference so passing "no officers" never triggers a
// downstream re-render solely due to a new [] identity on every render.
const EMPTY_OFFICERS = []

/**
 * LegendDot
 * @param {object} props
 * @param {string} [props.color] - fill color for a solid dot (fire status legend entries)
 * @param {string} [props.ring] - outline color for a ring-only dot (officer online/offline legend entries)
 * @param {string} props.label - Thai text shown next to the dot
 * @returns {JSX.Element} one row of the map legend
 * Note: `ring` and `color` are mutually exclusive by convention (ring takes precedence when both would apply).
 */
function LegendDot({ color, ring, label }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="w-3 h-3 rounded-full shrink-0"
        style={ring
          ? { border: `2.5px solid ${ring}`, background: 'white' }
          : { background: color, border: '1.5px solid white', boxShadow: '0 0 0 0.5px rgba(0,0,0,0.15)' }}
      />
      <span className="whitespace-nowrap">{label}</span>
    </div>
  )
}

/**
 * FireRow
 * react-window row renderer for the virtualized fire list.
 * @param {object} props
 * @param {number} props.index - row index supplied by react-window
 * @param {React.CSSProperties} props.style - absolute-position style supplied by react-window; must be applied verbatim
 * @param {Array<object>} props.fires - the full (already sorted/filtered) fire list, indexed by `index`
 * @returns {JSX.Element}
 */
function FireRow({ index, style, fires }) {
  const f = fires[index]
  return (
    <div style={style}>
      <Card
        id={f.id}
        Title={f.name}
        Area={f.type}
        Date={f.date}
        Time={f.time}
        status={f.status}
        booked={f.booked}
      />
    </div>
  )
}

/**
 * MapViewPage
 * Route-level component (no props). Primary operational view: full-screen
 * map of active/resolved fires plus a collapsible, sortable/filterable side
 * list, live officer positions (permission-gated), and layer/zoom controls.
 *
 * Returns: JSX.Element.
 */
export default function MapViewPage() {
  const [selectedLayer, setSelectedLayer] = useState(LAYERS['ค่าเริ่มต้น']) // object: currently active basemap style JSON
  const [listCollapsed, setListCollapsed] = useState(false) // boolean: whether the right-hand fire list is hidden
  const [controlsOpen, setControlsOpen] = useState(false) // boolean (phone only): whether the map-tool cluster is expanded
  const mapRef = useRef(null) // ref to the underlying Map component's imperative handle (resetView/zoomIn/zoomOut)

  // User's saved home view, or the module-level default if unset.
  const home = useAuthStore((s) => s.user?.home) ?? DEFAULT_HOME
  // Memoized so the Map component doesn't see a new object (and re-center) on every render.
  const startPoint = useMemo(() => ({ lat: home.lat, lng: home.lng }), [home.lat, home.lng])

  const [officers, setOfficers] = useState([]) // array: latest officer positions/status from the socket
  const [showOfficers, setShowOfficers] = useState(true) // boolean: toggles officer markers on the map
  const send = useSocketStore((s) => s.send) // (msg: object) => void — sends a message over the shared websocket
  const ready = useSocketStore((s) => s.ready) // boolean: whether the socket connection is open
  const officersMsg = useSocketStore((s) => s.byType?.officers_map) // latest 'officers_map' message payload, if any
  const canViewOfficers = can(useAuthStore((s) => s.user), 'officers.view') // permission gate for officer visibility/subscription

  // Subscribes to officer position updates once the socket is ready, only if permitted.
  // Dependency: server only responds to 'list_officers_MAP' for users with officers.view.
  useEffect(() => {
    if (!ready || !canViewOfficers) return
    send({ type: 'list_officers_MAP' })
  }, [ready, canViewOfficers])

  // Applies each incoming officers_map socket message to local state.
  useEffect(() => {
    if (!officersMsg) return
    setOfficers(officersMsg.officers ?? [])
  }, [officersMsg])

  const fires = useFireData() // array: live fire records from the shared fire-data hook/socket

  const [sortBy, setSortBy] = useState('time') // 'time' | 'name': active sort key for the side list
  const [sortAsc, setSortAsc] = useState(false) // boolean: sort direction for the current sortBy key
  const [statusFilter, setStatusFilter] = useState('all') // 'all' | 'free' | 'booked' | 'resolved'
  const [provinceFilter, setProvinceFilter] = useState('') // string: exact province match, '' = no filter
  const [satelliteFilter, setSatelliteFilter] = useState('') // string: exact satellite source match, '' = no filter

  /**
   * changeSort
   * @param {'time'|'name'} key - the column to sort by
   * Toggles direction when re-selecting the active key; switching to a new
   * key resets direction, defaulting to ascending only for 'name' (alphabetical)
   * since 'time' more usefully defaults to newest-first (descending).
   */
  const changeSort = (key) => {
    if (sortBy === key) {
      setSortAsc((v) => !v)
    } else {
      setSortBy(key)
      setSortAsc(key === 'name')
    }
  }

  // Distinct, Thai-locale-sorted province options derived from the live fire set (not a static list).
  const provinces = useMemo(
    () =>
      [...new Set(fires.map((f) => f.province).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b, 'th'),
      ),
    [fires],
  )

  // Distinct satellite-source options derived from the live fire set.
  const satellites = useMemo(
    () => [...new Set(fires.map((f) => f.satellite).filter(Boolean))].sort(),
    [fires],
  )

  // Applies status/province/satellite filters in sequence; feeds both the map points and the side list.
  const filteredFires = useMemo(() => {
    let result = fires
    if (statusFilter === 'free') result = result.filter((f) => !f.status && !f.booked)
    else if (statusFilter === 'booked') result = result.filter((f) => !f.status && f.booked)
    else if (statusFilter === 'resolved') result = result.filter((f) => f.status)
    if (provinceFilter) result = result.filter((f) => f.province === provinceFilter)
    if (satelliteFilter) result = result.filter((f) => f.satellite === satelliteFilter)
    return result
  }, [fires, statusFilter, provinceFilter, satelliteFilter])

  // Sorted copy of filteredFires for the side list (map points don't need sorting).
  const listFires = useMemo(() => {
    const sorted = [...filteredFires]
    const dir = sortAsc ? 1 : -1
    if (sortBy === 'name') {
      sorted.sort((a, b) => dir * a.name.localeCompare(b.name, 'th'))
    } else {
      sorted.sort((a, b) => dir * (new Date(a.detected_at) - new Date(b.detected_at)))
    }
    return sorted
  }, [filteredFires, sortBy, sortAsc])

  // Minimal projection of filteredFires for the map layer, to avoid passing unused fields down.
  const points = useMemo(
    () => filteredFires.map((f) => ({ id: f.id, lat: f.lat, lng: f.lng, status: f.status, booked: f.booked })),
    [filteredFires],
  )

  const focusedId = useMapSelection((s) => s.focusedId) // shared (cross-component) selection: id of the fire focused on the map
  const clearSelection = useMapSelection((s) => s.clear)
  // Assumption: focusedId always refers to a fire in `fires`; if not found (e.g. it just
  // expired/resolved off the list), `focused` becomes null and the detail panel closes.
  const focused = focusedId ? fires.find((f) => f.id === focusedId) : null

  // Auto-expands the side list whenever a fire becomes focused (e.g. selected on the map),
  // so its detail card is visible even if the user had collapsed the panel.
  useEffect(() => {
    if (focusedId) setListCollapsed(false)
  }, [focusedId])

  return (
    <div className="relative flex flex-1 w-full overflow-hidden">
      {/* Full-viewport map layer sits behind all UI chrome (z-0) */}
      <div className="fixed inset-0 z-0">
        <Map ref={mapRef} layer={selectedLayer} points={points} startPoint={startPoint} startZoom={home.zoom} officers={showOfficers ? officers : EMPTY_OFFICERS} />
      </div>

      {/* Floating map tools (layers/reset/officers/zoom). On desktop the full stack
          is always shown and shifts left when the side list is expanded. On phone the
          stack collapses behind a single hamburger-like toggle to keep the map clear. */}
      <div className={`fixed top-[calc(env(safe-area-inset-top)+0.75rem)] lg:top-3 z-10 flex flex-col items-end gap-2 right-3 transition-[right] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] ${listCollapsed ? '' : 'md:right-[calc(25vw+0.75rem)]'}`}>

        {/* Phone-only toggle for the tool cluster below. */}
        <button
          type="button"
          onClick={() => setControlsOpen((v) => !v)}
          aria-label="เครื่องมือแผนที่"
          aria-expanded={controlsOpen}
          className="md:hidden flex items-center justify-center w-11 h-11 rounded-xl border border-background bg-white text-primary shadow-md hover:bg-flame-light"
        >
          <Cog6ToothIcon className="w-6 h-6" />
        </button>

        <div className={`flex-col items-end gap-2 ${controlsOpen ? 'flex' : 'hidden'} md:flex`}>
          <div
            id="layers"
            className="flex rounded-lg overflow-hidden shadow-md divide-x divide-gray-300"
          >
            {Object.keys(LAYERS).map((key) => (
              <button
                key={key}
                className={`px-3 py-1.5 text-sm font-medium text-primary hover:bg-flame-light hover:text-primary ${selectedLayer === LAYERS[key] ? 'bg-primary text-white' : 'bg-white'}`}
                onClick={() => setSelectedLayer(LAYERS[key])}
              >
                {key}
              </button>
            ))}
          </div>

          <button
            title="กลับไปจุดเริ่มต้น"
            className="flex items-center gap-1.5 bg-white rounded-lg shadow-md px-3 py-1.5 text-sm text-primary font-medium hover:bg-flame-light hover:text-primary"
            onClick={() => mapRef.current?.resetView()}
          >
            <ArrowsPointingOutIcon className="w-5 h-5" />
            กลับไปจุดเริ่มต้น
          </button>

          {/* Officer visibility toggle only rendered for users permitted to view officers */}
          {canViewOfficers && (
            <button
              title={showOfficers ? 'ซ่อนเจ้าหน้าที่' : 'แสดงเจ้าหน้าที่'}
              aria-pressed={showOfficers}
              className={`flex items-center gap-1.5 rounded-lg shadow-md px-3 py-1.5 text-sm text-primary font-medium hover:bg-flame-light hover:text-primary ${showOfficers ? 'bg-primary text-white' : 'bg-white'}`}
              onClick={() => setShowOfficers((v) => !v)}
            >
              <UserGroupIcon className="w-5 h-5" />
              {showOfficers ? 'ซ่อนเจ้าหน้าที่' : 'แสดงเจ้าหน้าที่'}
            </button>
          )}

          <div id="zoom" className="flex flex-col rounded-lg overflow-hidden shadow-md divide-y divide-gray-300">
            <button
              title="ซูมเข้า"
              aria-label="ซูมเข้า"
              className="bg-white p-1.5 text-primary hover:bg-flame-light hover:text-primary"
              onClick={() => mapRef.current?.zoomIn()}
            >
              <PlusIcon className="w-5 h-5" />
            </button>
            <button
              title="ซูมออก"
              aria-label="ซูมออก"
              className="bg-white p-1.5 text-primary hover:bg-flame-light hover:text-primary"
              onClick={() => mapRef.current?.zoomOut()}
            >
              <MinusIcon className="w-5 h-5" />
            </button>
          </div>
        </div>

      </div>

      {/* Legend: tracks the side list on desktop; hidden on phone where the bottom
          sheet occupies the lower screen. */}
      <div className={`hidden md:block fixed bottom-3 z-10 bg-white/90 rounded-lg shadow-md px-3 py-2 text-xs text-primary transition-[right] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] ${listCollapsed ? 'right-3' : 'right-[calc(25vw+0.75rem)]'}`}>
        <p className="font-semibold mb-1.5">สัญลักษณ์</p>
        <div className="flex flex-col gap-1">
          <LegendDot color={FIRE_COLORS.free} label="ลุกไหม้" />
          <LegendDot color={FIRE_COLORS.booked} label="ถูกจอง" />
          <LegendDot color={FIRE_COLORS.resolved} label="ดับแล้ว" />
          {canViewOfficers && (
            <>
              <LegendDot ring="#22c55e" label="เจ้าหน้าที่ออนไลน์" />
              <LegendDot ring="#9ca3af" label="เจ้าหน้าที่ออฟไลน์" />
            </>
          )}
        </div>
      </div>

      {/* Fire list: a right-side panel on desktop (width animates 0 ↔ 25vw), a
          bottom sheet on phone (peeks a grab handle when collapsed). */}
      <div
        className={`fixed z-20 flex flex-col bg-white md:bg-background shadow-xl transition-[transform,width,height] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]
          inset-x-0 bottom-0 h-[60vh] rounded-t-2xl border-t border-background/50
          md:inset-x-auto md:top-0 md:right-0 md:bottom-auto md:h-full md:rounded-none md:border-t-0 md:border-l
          ${listCollapsed
            ? 'translate-y-[calc(100%-2.75rem)] md:translate-y-0 md:w-0'
            : 'translate-y-0 md:w-1/4'}`}
      >

        {/* Desktop collapse tab on the left edge. */}
        <button
          title={listCollapsed ? 'แสดงรายการไฟ' : 'ซ่อนรายการไฟ'}
          onClick={() => setListCollapsed((v) => !v)}
          className="hidden md:flex absolute top-1/2 -left-6 -translate-y-1/2 z-20 items-center justify-center w-6 h-12 bg-white border border-gray-300 rounded-l-lg shadow-md text-primary hover:bg-flame-light"
        >
          {listCollapsed
            ? <ChevronDoubleLeftIcon className="w-5 h-5" />
            : <ChevronDoubleRightIcon className="w-5 h-5" />}
        </button>

        {/* Mobile sheet grabber: full-width tap header that toggles the sheet. */}
        <button
          onClick={() => setListCollapsed((v) => !v)}
          aria-label={listCollapsed ? 'แสดงรายการไฟ' : 'ซ่อนรายการไฟ'}
          className="md:hidden flex shrink-0 items-center justify-center h-11 w-full rounded-t-2xl"
        >
          <span className="h-1.5 w-10 rounded-full bg-gray-400" />
        </button>

        <div
          className="flex-1 min-h-0 w-full md:w-[25vw] overflow-hidden flex flex-col"
          id="map-controller"
        >
          <div id="list-controls" className="px-4 py-2 space-y-2.5 bg-white border-b border-gray-300">
            <div className="flex items-center justify-between">
              <p className="font-semibold text-lg text-primary ">รายการไฟ ({listFires.length})</p>
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">เรียงตาม</span>
                {[{ key: 'time', label: 'เวลา' }, { key: 'name', label: 'ชื่อ' }].map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => changeSort(key)}
                    className={`px-2.5 py-1 rounded-lg text-sm font-semibold transition-colors ${sortBy === key
                        ? 'bg-primary text-white'
                        : 'bg-gray-100 text-gray-500 hover:bg-background'
                      }`}
                  >
                    {label}{sortBy === key ? (sortAsc ? ' ↑' : ' ↓') : ''}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <label className="flex-1 min-w-0">
                <span className="block text-sm text-gray-500 mb-0.5">สถานะ</span>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="w-full text-sm text-accent bg-white border border-gray-300 rounded-lg px-2 py-1"
                >
                  <option value="all">ทั้งหมด</option>
                  <option value="free">ลุกไหม้</option>
                  <option value="booked">ถูกจอง</option>
                  <option value="resolved">ดับแล้ว</option>
                </select>
              </label>
              <label className="flex-1 min-w-0">
                <span className="block text-sm text-gray-500 mb-0.5">จังหวัด</span>
                <select
                  value={provinceFilter}
                  onChange={(e) => setProvinceFilter(e.target.value)}
                  className="w-full text-sm text-accent bg-white border border-gray-300 rounded-lg px-2 py-1"
                >
                  <option value="">ทั้งหมด</option>
                  {provinces.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </label>
              <label className="flex-1 min-w-0">
                <span className="block text-sm text-gray-500 mb-0.5">ดาวเทียม</span>
                <select
                  value={satelliteFilter}
                  onChange={(e) => setSatelliteFilter(e.target.value)}
                  className="w-full text-sm text-accent bg-white border border-gray-300 rounded-lg px-2 py-1"
                >
                  <option value="">ทั้งหมด</option>
                  {satellites.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>
          <div
            id="controller"
            className="flex-1 min-h-0 cursor-pointer"
          >
            {/* Virtualized list: only visible rows are mounted, keeping large fire counts performant */}
            <List
              className="minimal-scrollbar"
              rowComponent={FireRow}
              rowCount={listFires.length}
              rowHeight={CARD_HEIGHT}
              rowProps={{ fires: listFires }}
            />
          </div>
        </div>
        {/* Detail overlay: replaces the list panel entirely while a fire is focused */}
        {focused && (
          <div className="absolute inset-0 z-10 bg-white py-2 overflow-hidden flex flex-col rounded-t-2xl md:rounded-none">
            <button
              className="bg-white p-1 w-fit"
              onClick={clearSelection}
            >
              <svg className="w-8 h-8" xmlns="http://www.w3.org/2000/svg" fill="primary" viewBox="0 0 16 16">
                <path fillRule="evenodd"
                  d="M11.354 1.646a.5.5 0 0 1 0 .708L5.707 8l5.647 5.646a.5.5 0 0 1-.708.708l-6-6a.5.5 0 0 1 0-.708l6-6a.5.5 0 0 1 .708 0z" />
              </svg>
            </button>
            <ExpandedCard fire={focused} officers={officers} />
          </div>
        )}
      </div>
    </div>
  )
}
