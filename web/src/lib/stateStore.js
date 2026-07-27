import { create } from 'zustand'

// Global store fed by the live WebSocket connection. It keeps the client's copy of
// server-pushed data (chiefly the fire list) in `byType`, keyed by message type, and
// exposes `handleMessage` as the single entry point for every inbound frame. The
// transport (the socket itself) is injected via setSend, keeping this store I/O-free.
export const useSocketStore = create((set, get) => ({
  byType: {},   // { fires: { fires: Fire[], v: number }, [otherType]: payload }
  ready: false, // whether the socket handshake has completed.
  // Placeholder until the real sender is injected; guards against pre-connect sends.
  send: () => console.warn('Socket not connected yet'),

  /**
   * Reducer for all inbound socket frames, dispatched on `data.type`.
   * @param {{type?: string, v?: number, fires?: object[], upserts?: object[], removes?: (string|number)[]}} data
   */
  handleMessage: (data) => {
    const type = data?.type

    // Full replacement: server sends the authoritative list plus its version `v`.
    if (type === 'fires_snapshot') {
      set((state) => ({
        byType: { ...state.byType, fires: { fires: data.fires ?? [], v: data.v ?? 0 } },
      }))
      return
    }

    // Incremental patch: only valid if it is exactly the next version (cur.v + 1).
    if (type === 'fires_delta') {
      const cur = get().byType.fires
      // Missing baseline or a version gap means we lost a frame -> request a fresh
      // snapshot rather than applying a delta onto stale/inconsistent state.
      if (!cur || data.v !== (cur.v ?? -1) + 1) {
        get().send({ type: 'resync_fires' })
        return
      }
      // Apply upserts/removes by id via a Map for O(1) merge, then re-materialize
      // the list. The Map also de-duplicates if the same id appears twice.
      const byId = new Map(cur.fires.map((f) => [f.id, f]))
      for (const f of data.upserts ?? []) byId.set(f.id, f)
      for (const id of data.removes ?? []) byId.delete(id)
      set((state) => ({
        byType: { ...state.byType, fires: { fires: [...byId.values()], v: data.v } },
      }))
      return
    }

    // Fallback: store any other message type verbatim (defaults to the 'fires' slot
    // when the frame omits a type).
    set((state) => ({
      byType: { ...state.byType, [type ?? 'fires']: data },
    }))
  },
  setSend: (fn) => set({ send: fn }),      // inject the socket's send function once connected.
  setReady: (ready) => set({ ready }),     // flag connection readiness for the UI.
}))

// App-chrome UI state shared between the mobile top bar (hamburger) and the
// sidebar drawer/backdrop, so either can open/close the off-canvas nav on
// phones/tablets. Irrelevant on desktop, where the sidebar is a static rail.
export const useUIStore = create((set) => ({
  drawerOpen: false,
  openDrawer:   () => set({ drawerOpen: true }),
  closeDrawer:  () => set({ drawerOpen: false }),
  toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
}))

// Lightweight UI store linking the map and the list/cards: which fire is hovered
// vs. clicked-open. Split from the data store so selection changes don't touch fire data.
export const useMapSelection = create((set) => ({
  hoveredId: null, // transient highlight (mouse-over).
  focusedId: null, // sticky selection (clicked/opened card).
  setHovered: (id) => set({ hoveredId: id }),
  // Focusing clears any hover so the two highlight states never fight.
  setFocused: (id) => set({ focusedId: id, hoveredId: null }),
  clear:      ()   => set({ hoveredId: null, focusedId: null }),
}))
