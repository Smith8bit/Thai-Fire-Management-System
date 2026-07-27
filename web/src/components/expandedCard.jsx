import { useState } from 'react'
import { useSocketStore } from '../lib/stateStore'
import { useAuthStore, can } from '../lib/useAuthStore'
import { toast } from '../lib/toastStore'
import { useMessageEffect } from '../lib/useMessageEffect'
import { formatDate, formatTime } from '../lib/datetime'

// Server error codes -> Thai user-facing messages for the "appoint officer" action.
// Keyed by the `code` field of a websocket `error` message.
const APPOINT_ERRORS = {
    out_of_scope: 'ไฟหรือเจ้าหน้าที่อยู่นอกพื้นที่ของคุณ',
    officer_busy: 'เจ้าหน้าที่มีไฟที่รับผิดชอบอยู่แล้ว',
    fire_already_booked: 'ไฟนี้ถูกจองโดยเจ้าหน้าที่ท่านอื่นแล้ว',
    fire_resolved: 'ไฟนี้ดับแล้ว',
    fire_not_found: 'ไม่พบข้อมูลไฟ',
    officer_not_found: 'ไม่พบข้อมูลเจ้าหน้าที่',
    forbidden: 'คุณไม่มีสิทธิ์มอบหมายงาน',
}

// Server error codes -> Thai user-facing messages for the "cancel booking" action.
const CANCEL_ERRORS = {
    forbidden: 'คุณไม่มีสิทธิ์ยกเลิกการจองนี้',
    not_booked: 'ไฟนี้ไม่ได้ถูกจอง',
}

// Server error codes -> Thai messages for the false-alarm mark / cancel actions.
const FALSE_ERRORS = {
    forbidden: 'คุณไม่มีสิทธิ์ดำเนินการนี้',
    fire_not_found: 'ไม่พบข้อมูลไฟ',
    fire_resolved: 'ไฟนี้ถูกปิดไปแล้ว',
    not_false_alarm: 'ไฟนี้ไม่ได้ถูกทำเครื่องหมายว่าไม่ใช่ไฟ',
    note_too_long: 'หมายเหตุยาวเกินไป',
}

/**
 * ExpandedCard
 * Detail panel for a single fire selected on the map/list. Shows fire
 * metadata and, for users with the `fire.appoint` permission, an officer
 * assignment workflow: pick an available officer, appoint them, or cancel
 * an existing booking. All actions are optimistic requests sent over the
 * shared websocket (`useSocketStore.send`); the outcome arrives asynchronously
 * as `officer_appointed` / `booking_cancelled` / `error` messages that this
 * component listens for via `useMessageEffect` and reconciles against its
 * own local `pending`/`cancelling` flags (so it ignores messages belonging
 * to a different fire or to an action it didn't initiate).
 *
 * @param {object} props
 * @param {object} props.fire - fire record (id, name, type, date, time, location fields,
 *   `status` [resolved], `booked`, `holder_name`)
 * @param {Array<{field_officer_id: string, name: string, division?: string,
 *   province_name_th: string, active: boolean, busy: boolean}>} props.officers -
 *   officers eligible for assignment to this fire
 * @returns {JSX.Element} the fire detail + assignment panel
 *
 * Assumes `officers` is already scoped to the fire's region by the caller;
 * this component only filters/disables by `busy`/`active` state, not location.
 */
export default function ExpandedCard({ fire, officers }) {
    const [selectedOfficer, setSelectedOfficer] = useState('')
    const [pending, setPending] = useState(false)
    const [cancelling, setCancelling] = useState(false)
    const [markingFalse, setMarkingFalse] = useState(false)
    const [cancellingFalse, setCancellingFalse] = useState(false)
    const user = useAuthStore((s) => s.user)
    const canAppoint = can(user, 'fire.appoint')
    const canFalse = can(user, 'fire.false')
    const send = useSocketStore((s) => s.send)
    const appointedMsg = useSocketStore((s) => s.byType?.officer_appointed)
    const cancelledMsg = useSocketStore((s) => s.byType?.booking_cancelled)
    const falseMarkedMsg = useSocketStore((s) => s.byType?.fire_false_marked)
    const falseCancelledMsg = useSocketStore((s) => s.byType?.fire_false_cancelled)
    const errorMsg = useSocketStore((s) => s.byType?.error)

    // A resolved or already-booked fire can't accept a new assignment.
    const locked = fire.status || fire.booked
    const canCancel = canAppoint && fire.booked && !fire.status
    // Mark-as-false applies to any still-open fire; cancelling applies only once
    // it's actually flagged as a false alarm (which always implies fire.status).
    const canMarkFalse = canFalse && !fire.status
    const canCancelFalse = canFalse && fire.false_alarm

    // Officer list can go stale between selection and submit (e.g. they picked
    // up another fire), so re-check busy status right before allowing appoint.
    const selectedBusy = officers.some((o) => o.field_officer_id === selectedOfficer && o.busy)

    // Success/error pairs below are split per-action (appoint vs cancel) because
    // both share the same `error` message stream; each handler gates on its own
    // in-flight flag so an error from one action doesn't clear the other's state.
    useMessageEffect(appointedMsg, (m) => {
        if (!pending || m.fire_id !== fire.id) return
        setPending(false)
        toast.success('มอบหมายเจ้าหน้าที่สำเร็จ')
    })

    useMessageEffect(errorMsg, (m) => {
        if (!pending) return
        setPending(false)
        toast.error(APPOINT_ERRORS[m.code] ?? 'มอบหมายไม่สำเร็จ')
    })

    useMessageEffect(cancelledMsg, (m) => {
        if (!cancelling || m.fire_id !== fire.id) return
        setCancelling(false)
        toast.success('ยกเลิกการจองแล้ว')
    })

    useMessageEffect(errorMsg, (m) => {
        if (!cancelling) return
        setCancelling(false)
        toast.error(CANCEL_ERRORS[m.code] ?? 'ยกเลิกไม่สำเร็จ')
    })

    useMessageEffect(falseMarkedMsg, (m) => {
        if (!markingFalse || m.fire_id !== fire.id) return
        setMarkingFalse(false)
        toast.success('ทำเครื่องหมายว่าไม่ใช่ไฟแล้ว')
    })

    useMessageEffect(errorMsg, (m) => {
        if (!markingFalse) return
        setMarkingFalse(false)
        toast.error(FALSE_ERRORS[m.code] ?? 'ดำเนินการไม่สำเร็จ')
    })

    useMessageEffect(falseCancelledMsg, (m) => {
        if (!cancellingFalse || m.fire_id !== fire.id) return
        setCancellingFalse(false)
        toast.success('ยกเลิกสถานะไม่ใช่ไฟแล้ว')
    })

    useMessageEffect(errorMsg, (m) => {
        if (!cancellingFalse) return
        setCancellingFalse(false)
        toast.error(FALSE_ERRORS[m.code] ?? 'ดำเนินการไม่สำเร็จ')
    })

    // Fire-and-wait: flips `pending`/`cancelling` immediately for optimistic UI,
    // then relies on the effects above to resolve it once the server responds.
    const appoint = () => {
        if (!selectedOfficer || selectedBusy) return
        setPending(true)
        send({ type: 'appoint_officer', fire_id: fire.id, officer_id: selectedOfficer })
    }

    const cancelBooking = () => {
        setCancelling(true)
        send({ type: 'cancel_booking', fire_id: fire.id })
    }

    // Marking false closes the fire and frees any assigned officer, so confirm
    // first (mirrors the destructive-action confirm used elsewhere in the app).
    const markFalse = () => {
        if (markingFalse) return
        if (!window.confirm(`ทำเครื่องหมายว่า "${fire.name}" ไม่ใช่ไฟ?\nไฟจะถูกปิดและปลดเจ้าหน้าที่ที่รับผิดชอบ (ถ้ามี)`)) return
        setMarkingFalse(true)
        send({ type: 'false_fire', fire_id: fire.id })
    }

    const cancelFalse = () => {
        if (cancellingFalse) return
        if (!window.confirm(`ยกเลิกสถานะไม่ใช่ไฟของ "${fire.name}"?\nไฟจะกลับมาเปิดอีกครั้ง`)) return
        setCancellingFalse(true)
        send({ type: 'cancel_false_fire', fire_id: fire.id })
    }

    return (
        <div id="container" className="bg-white w-full flex-1 min-h-0 flex flex-col px-4 overflow-y-auto md:overflow-hidden minimal-scrollbar">
            <div id="detail" className="no-scrollbar border-b-2 border-gray-300 pb-4 pt-2">
                <div className="flex items-start justify-between gap-2">
                    <h2 className="text-2xl text-primary font-bold leading-tight">{fire.name}</h2>
                    <span
                        className={`shrink-0 mt-0.5 px-2.5 py-1 rounded-full text-sm font-semibold ${
                            fire.false_alarm
                                ? 'bg-slate-200 text-slate-600'
                                : fire.status
                                ? 'bg-gray-200 text-gray-600'
                                : fire.booked
                                ? 'bg-amber-100 text-amber-700'
                                : 'bg-red-100 text-red-700'
                        }`}
                    >
                        {fire.false_alarm ? 'ไม่ใช่ไฟ' : fire.status ? 'ดับแล้ว' : fire.booked ? 'ถูกจอง' : 'ลุกไหม้'}
                    </span>
                </div>

                <dl className="mt-3 space-y-1.5 text-md">
                    <div className="flex justify-between gap-2">
                        <dt className="min-w-fit shrink-0 text-gray-500">ชนิดพื้นที่</dt>
                        <dd className="text-gray-900 font-medium text-right">{fire.type || '-'}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                        <dt className="min-w-fit shrink-0 text-gray-500">ตรวจพบเมื่อ</dt>
                        <dd className="text-gray-900 font-medium text-right">{formatDate(fire.date, fire.time)} {formatTime(fire.date, fire.time)}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                        <dt className="min-w-fit shrink-0 text-gray-500">ที่ตั้ง</dt>
                        <dd className="text-gray-900 font-medium text-right">
                            {[fire.tumboon, fire.aumper, fire.province].filter(Boolean).join(' · ') || '-'}
                        </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                        <dt className="min-w-fit shrink-0 text-gray-500">ดาวเทียม</dt>
                        <dd className="text-gray-900 font-medium text-right">{fire.satellite || '-'}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                        <dt className="min-w-fit shrink-0 text-gray-500">ผู้รับผิดชอบ</dt>
                        <dd className={`font-semibold text-right ${fire.holder_name ? 'text-amber-700' : 'text-gray-400'}`}>
                            {fire.holder_name || 'ยังไม่มีเจ้าหน้าที่'}
                        </dd>
                    </div>
                </dl>
                {canCancel && (
                    <button
                        type="button"
                        disabled={cancelling}
                        onClick={cancelBooking}
                        className="mt-3 w-full py-2 text-sm font-medium text-red-600 border-2 border-red-200 hover:bg-red-50 rounded-lg disabled:opacity-50 transition-colors"
                    >
                        {cancelling ? 'กำลังยกเลิก…' : 'ยกเลิกการจอง'}
                    </button>
                )}
                {canMarkFalse && (
                    <button
                        type="button"
                        disabled={markingFalse}
                        onClick={markFalse}
                        className="mt-3 w-full py-2 text-sm font-medium text-slate-600 border-2 border-slate-200 hover:bg-slate-50 rounded-lg disabled:opacity-50 transition-colors"
                    >
                        {markingFalse ? 'กำลังดำเนินการ…' : 'แจ้งว่าไม่ใช่ไฟ'}
                    </button>
                )}
                {canCancelFalse && (
                    <button
                        type="button"
                        disabled={cancellingFalse}
                        onClick={cancelFalse}
                        className="mt-3 w-full py-2 text-sm font-medium text-primary border-2 border-flame hover:bg-flame-light rounded-lg disabled:opacity-50 transition-colors"
                    >
                        {cancellingFalse ? 'กำลังดำเนินการ…' : 'ยกเลิกสถานะไม่ใช่ไฟ'}
                    </button>
                )}
            </div>

            {/* Assignment workflow is only rendered for users with `fire.appoint`; the
                whole block is dimmed/disabled (not unmounted) when `locked` so the
                panel doesn't jump when a fire resolves or gets booked elsewhere. */}
            {canAppoint && (<>
            <div className={`md:flex-1 md:min-h-0 md:overflow-y-auto minimal-scrollbar pb-2 border-b-2 border-gray-300 ${locked ? 'opacity-50 pointer-events-none select-none' : ''}`} id="available-officers">
                <p className="sticky top-0 z-10 bg-white py-2 text-md font-semibold text-gray-500">เจ้าหน้าที่ในพื้นที่</p>
                {officers.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-4">ไม่มีเจ้าหน้าที่</p>
                ) : (
                    officers.map((o) => (
                        <button
                            key={o.field_officer_id}
                            disabled={locked || o.busy}
                            onClick={() => setSelectedOfficer(o.field_officer_id)}
                            className={`w-full text-left px-3 py-2 mb-1 rounded-lg border transition-colors ${
                                o.busy
                                    ? 'bg-gray-50 border-gray-200 opacity-60 cursor-not-allowed'
                                    : selectedOfficer === o.field_officer_id
                                    ? 'bg-flame-light border-primary'
                                    : 'bg-white border-gray-200 hover:bg-gray-50'
                            }`}
                        >
                            <div className="flex items-center justify-between">
                                <span className="font-medium text-primary text-md">{o.name}</span>
                                <div className="flex items-center gap-1.5">
                                    {o.busy && (
                                        <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">มีงานอยู่</span>
                                    )}
                                    <span className={`text-xs px-2 py-0.5 rounded-full ${o.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                                        {o.active ? 'ออนไลน์' : 'ออฟไลน์'}
                                    </span>
                                </div>
                            </div>
                            <p className="text-sm text-gray-500 mt-0.5">{o.division ? `${o.division} · ${o.province_name_th}` : o.province_name_th}</p>
                        </button>
                    ))
                )}
            </div>

            <div id="actions" className="py-2 flex gap-2">
                <button
                    disabled={locked || !selectedOfficer || pending}
                    className="py-3 px-5 font-bold text-lg text-gray-700 border border-gray-300 rounded-lg bg-white hover:bg-gray-100 disabled:text-gray-300 disabled:cursor-not-allowed transition-colors"
                    onClick={() => setSelectedOfficer('')}
                >
                    ล้าง
                </button>
                <button
                    disabled={locked || !selectedOfficer || selectedBusy || pending}
                    className="flex-1 py-3 text-white font-bold text-lg border rounded-lg bg-primary hover:bg-brand disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
                    onClick={appoint}
                >
                    {fire.status ? 'ดับแล้ว' : fire.booked ? 'ถูกจองแล้ว' : pending ? 'กำลังมอบหมาย…' : 'มอบหมายเจ้าหน้าที่'}
                </button>
            </div>
            </>)}
        </div>
    )
}
