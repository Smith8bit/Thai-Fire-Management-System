import { useEffect, useRef, createElement, forwardRef, useImperativeHandle, memo } from 'react'
import { createRoot } from 'react-dom/client'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { UserCircleIcon } from '@heroicons/react/20/solid'
import { useMapSelection } from '../lib/stateStore'
import { formatLastSeen } from '../lib/datetime'
import { FIRE_COLORS } from '../lib/fireColors'

const FIRES_SOURCE = 'fires'
const FIRES_LAYER = 'fire-circles'

/**
 * Converts raw fire points into the GeoJSON FeatureCollection MapLibre needs
 * for a geojson source. Only the fields the paint expression reads
 * (`id`, `status`, `booked`) are carried into `properties`.
 *
 * @param {Array<{id: string|number, lng: number, lat: number, status: boolean, booked: boolean}>} points
 * @returns {GeoJSON.FeatureCollection} point features keyed for `firePaint`
 */
function firesToGeoJSON(points) {
    return {
        type: 'FeatureCollection',
        features: points.map((p) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
            properties: { id: p.id, status: p.status, booked: p.booked },
        })),
    }
}

/**
 * Builds a MapLibre `circle` paint spec for the fires layer, expressed as
 * data-driven expressions so a single `setPaintProperty` call can restyle
 * every point without re-fetching data. Precedence: the hovered/focused
 * point (`activeId`) always wins the highlight color/size, then resolved,
 * then booked, then falls back to "free" (unclaimed).
 *
 * @param {string|number|null|undefined} activeId - id of the hovered or focused fire, if any
 * @returns {maplibregl.CirclePaintSpecification} paint properties for the fire-circles layer
 */
function firePaint(activeId) {
    const isActive = ['==', ['get', 'id'], activeId ?? '']
    return {
        'circle-color': [
            'case',
            isActive,
            '#FFBF00',
            ['==', ['get', 'status'], true],
            FIRE_COLORS.resolved,
            ['==', ['get', 'booked'], true],
            FIRE_COLORS.booked,
            FIRE_COLORS.free,
        ],
        'circle-radius': ['case', isActive, 8, 4.5],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': ['case', isActive, 2.5, 1.5],
    }
}

/**
 * Builds the plain-DOM marker element for a field officer (name/last-seen
 * label over a status-colored avatar circle). Built with `document.createElement`
 * rather than JSX because MapLibre markers own their DOM node directly and
 * don't participate in the React tree; a small React root is mounted just for
 * the `UserCircleIcon` so we can reuse the icon component without hand-rolling SVG.
 *
 * @param {boolean} active - whether the officer is currently online (green) or offline (gray)
 * @param {string|undefined} name - officer display name; falls back to a generic Thai label
 * @param {string|number|Date} lastUpdated - last location ping, formatted via `formatLastSeen`
 * @returns {HTMLDivElement} marker element with a `_reactRoot` reference for later cleanup
 */
function makeOfficerEl(active, name, lastUpdated) {
    const wrapper = document.createElement('div')
    Object.assign(wrapper.style, {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '2px',
        cursor: 'pointer',
    })

    const label = document.createElement('div')
    Object.assign(label.style, {
        fontSize: '11px',
        fontWeight: '600',
        color: '#111',
        background: 'rgba(255,255,255,0.85)',
        borderRadius: '4px',
        padding: '1px 5px',
        whiteSpace: 'nowrap',
        boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
        lineHeight: '1.4',
        textAlign: 'center',
    })

    const nameLine = document.createElement('div')
    nameLine.textContent = name ?? 'เจ้าหน้าที่'
    label.appendChild(nameLine)

    const timeText = formatLastSeen(lastUpdated)
    if (timeText) {
        const timeLine = document.createElement('div')
        Object.assign(timeLine.style, {
            fontSize: '10px',
            fontWeight: '400',
            color: '#6b7280',
        })
        timeLine.textContent = timeText
        label.appendChild(timeLine)
    }

    const circle = document.createElement('div')
    Object.assign(circle.style, {
        width: '20px',
        height: '20px',
        borderRadius: '50%',
        border: `2.5px solid ${active ? '#22c55e' : '#9ca3af'}`,
        background: 'white',
        boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'border-color 120ms ease',
    })
    circle._reactRoot = createRoot(circle)
    circle._reactRoot.render(createElement(UserCircleIcon, {
        style: { color: active ? '#16a34a' : '#9ca3af', width: '20px', height: '20px' }
    }))

    wrapper.appendChild(label)
    wrapper.appendChild(circle)
    // Exposed on the wrapper too so the marker-cleanup effect can unmount this
    // root via `marker.getElement()` without needing to know the internal DOM shape.
    wrapper._reactRoot = circle._reactRoot
    return wrapper
}

/**
 * MapView
 * MapLibre GL map showing fire locations as a data-driven circle layer plus
 * field-officer avatar markers, wired to the shared `useMapSelection` store
 * so hovering/clicking a fire (here or in the sidebar list) stays in sync.
 * The MapLibre instance is imperative and long-lived, so it's created once in
 * an effect with an empty dependency array and mutated in place by the other
 * effects below rather than recreated on every prop change (recreating it
 * would be expensive and would reset the user's pan/zoom).
 *
 * @param {object} props
 * @param {string|object} props.layer - MapLibre style (URL or style spec) for the current base layer
 * @param {{lng: number, lat: number}} props.startPoint - initial map center
 * @param {number} [props.startZoom=10] - initial zoom level
 * @param {Array<{id: string|number, lng: number, lat: number, status: boolean, booked: boolean}>} props.points - fire locations
 * @param {Array<{location?: {latitude: number, longitude: number}, active: boolean, name?: string, last_updated?: string}>} [props.officers=[]] - field officer positions
 * @param {import('react').Ref<{resetView: () => void, zoomIn: () => void, zoomOut: () => void}>} ref - imperative handle for parent-driven map controls
 * @returns {JSX.Element} a full-size map container
 *
 * Wrapped in `memo` at export so parents that re-render frequently (e.g. on
 * websocket ticks) don't force MapLibre to reprocess unchanged props.
 */
const MapView = forwardRef(function MapView({ layer, startPoint, startZoom = 10, points, officers = [] }, ref) {
    const mapRef = useRef(null)
    // Mirrors the latest `points`/`activeId` in refs (rather than reading the
    // prop/state closures directly) so the MapLibre event handlers registered
    // once in the init effect below always see current data instead of the
    // stale values captured at mount time.
    const pointsRef = useRef(points)
    const activeIdRef = useRef(null)
    const officerMarkerInstancesRef = useRef([])

    const focusedId = useMapSelection((s) => s.focusedId)
    const hoveredId = useMapSelection((s) => s.hoveredId)
    const setFocused = useMapSelection((s) => s.setFocused)
    const clearSelection = useMapSelection((s) => s.clear)

    // Exposes a minimal imperative API to the parent (toolbar buttons for
    // reset/zoom) since MapLibre's own controls aren't React components.
    useImperativeHandle(ref, () => ({
        resetView: () => {
            mapRef.current?.flyTo({ center: [startPoint.lng, startPoint.lat], zoom: startZoom, duration: 800 })
        },
        zoomIn: () => mapRef.current?.zoomIn(),
        zoomOut: () => mapRef.current?.zoomOut(),
    }), [startPoint, startZoom])

    // One-time map construction. Runs only on mount ([] deps) — `layer`,
    // `points`, and selection changes are applied to the existing instance by
    // the effects below instead of tearing down and recreating the map.
    useEffect(() => {
        const map = new maplibregl.Map({
            container: 'map',
            style: layer,
            center: [startPoint.lng, startPoint.lat],
            zoom: startZoom,
            maxZoom: 20,
            preserveDrawingBuffer: true,
        })

        map.setRenderWorldCopies(false)
        map.dragRotate.disable()
        map.doubleClickZoom.disable()

        // Source/layer must be (re-)added on every style load because
        // `setStyle` (used when switching base layers) wipes custom
        // sources/layers; the `getSource` guard avoids double-adding if
        // `style.load` fires more than once for the same style.
        map.on('style.load', () => {
            if (map.getSource(FIRES_SOURCE)) return
            map.addSource(FIRES_SOURCE, { type: 'geojson', data: firesToGeoJSON(pointsRef.current) })
            map.addLayer({ id: FIRES_LAYER, type: 'circle', source: FIRES_SOURCE, paint: firePaint(activeIdRef.current) })
        })
        // Clicking a fire circle focuses it; clicking empty map area clears
        // the current selection (checked via a real hit-test, not just
        // "click missed the layer", so clicks on other overlapping layers
        // don't unintentionally clear selection).
        map.on('click', FIRES_LAYER, (e) => {
            const feature = e.features?.[0]
            if (feature) setFocused(feature.properties.id)
        })
        map.on('click', (e) => {
            const hit = map.getLayer(FIRES_LAYER)
                && map.queryRenderedFeatures(e.point, { layers: [FIRES_LAYER] }).length > 0
            if (!hit) clearSelection()
        })
        map.on('mouseenter', FIRES_LAYER, () => { map.getCanvas().style.cursor = 'pointer' })
        map.on('mouseleave', FIRES_LAYER, () => { map.getCanvas().style.cursor = '' })

        mapRef.current = map

        // MapLibre doesn't auto-resize with its container (e.g. sidebar
        // collapse/expand), so we watch it explicitly.
        const ro = new ResizeObserver(() => map.resize())
        ro.observe(map.getContainer())

        return () => {
            ro.disconnect()
            map.remove()
        }
    }, [])

    // Swaps the base layer (satellite/topo/etc.) in place. If the map is
    // mid-load, `setStyle` is deferred to the `load` event instead of being
    // called immediately, since MapLibre can drop a style change requested
    // before the initial style has finished loading.
    useEffect(() => {
        const map = mapRef.current
        if (!map) return
        if (map.isStyleLoaded()) {
            map.setStyle(layer)
        } else {
            const apply = () => map.setStyle(layer)
            map.once('load', apply)
            return () => map.off('load', apply)
        }
    }, [layer])

    // Pushes updated fire data into the existing geojson source (cheap) rather
    // than recreating the source/layer; also keeps `pointsRef` current for the
    // event handlers registered once above.
    useEffect(() => {
        pointsRef.current = points
        const source = mapRef.current?.getSource(FIRES_SOURCE)
        if (source) source.setData(firesToGeoJSON(points))
    }, [points])

    // Flies the camera to a fire when it becomes focused (from map click or
    // sidebar selection). No-op if the id isn't in the current point set.
    useEffect(() => {
        const map = mapRef.current
        if (!map || !focusedId) return
        const p = pointsRef.current?.find((x) => x.id === focusedId)
        if (!p) return
        // On phones the detail bottom sheet covers ~60% of the viewport, so nudge
        // the focused fire up into the visible strip above it rather than the
        // screen centre (where the sheet would hide it). No offset on wider screens
        // where the panel sits to the side.
        const offset = window.innerWidth < 768 ? [0, -window.innerHeight * 0.28] : [0, 0]
        map.flyTo({ center: [p.lng, p.lat], zoom: 14, offset, duration: 1000 })
    }, [focusedId])

    // Restyles only the highlighted circle (hover takes precedence over focus)
    // via `setPaintProperty`, which is far cheaper than touching source data
    // for a change that doesn't affect the underlying fire records.
    useEffect(() => {
        const activeId = hoveredId ?? focusedId ?? null
        activeIdRef.current = activeId
        const map = mapRef.current
        if (!map?.getLayer(FIRES_LAYER)) return
        const paint = firePaint(activeId)
        map.setPaintProperty(FIRES_LAYER, 'circle-color', paint['circle-color'])
        map.setPaintProperty(FIRES_LAYER, 'circle-radius', paint['circle-radius'])
        map.setPaintProperty(FIRES_LAYER, 'circle-stroke-width', paint['circle-stroke-width'])
    }, [hoveredId, focusedId])

    // Officer markers are rebuilt from scratch on every `officers` update
    // (rather than diffed/moved) since the list is typically small and
    // markers are cheap to recreate; each old marker's mounted React root
    // (from `makeOfficerEl`) is explicitly unmounted first to avoid leaking
    // React roots as officers move or go offline.
    useEffect(() => {
        if (!mapRef.current) return

        officerMarkerInstancesRef.current.forEach((m) => {
            m.getElement()._reactRoot?.unmount()
            m.remove()
        })
        officerMarkerInstancesRef.current = []

        officers
            .filter((o) => o.location?.latitude != null && o.location?.longitude != null)
            .forEach((o) => {
                const el = makeOfficerEl(o.active, o.name, o.last_updated)

                const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
                    .setLngLat([o.location.longitude, o.location.latitude])
                    .addTo(mapRef.current)

                officerMarkerInstancesRef.current.push(marker)
            })
    }, [officers])

    return (
        <div style={{ width: '100%', height: '100%' }}>
            <div id="map" style={{ width: '100%', height: '100%' }}></div>
        </div>
    )
})

export default memo(MapView)
