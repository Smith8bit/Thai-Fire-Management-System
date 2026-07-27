/**
 * PaginationBar
 * Stateless pagination control: renders "first/prev/next/last" buttons and an
 * "X–Y of total" range label. Page state itself is owned by the caller
 * (via `onPage`) so this component can sit above any paginated list/table.
 *
 * @param {object} props
 * @param {number} props.page - current zero-based page index
 * @param {number} props.pageSize - number of items per page
 * @param {number} props.total - total item count across all pages
 * @param {(nextPage: number) => void} props.onPage - callback invoked with the target page index
 * @param {string} [props.className=''] - extra classes appended to the root container
 * @returns {JSX.Element} the pagination controls
 *
 * Assumes `pageSize > 0`; when `total === 0`, lastPage clamps to 0 so buttons
 * disable correctly instead of going negative.
 */
export default function PaginationBar({ page, pageSize, total, onPage, className = '' }) {
  // Clamp to 0 so an empty result set doesn't produce a negative last page.
  const lastPage = Math.max(Math.ceil(total / pageSize) - 1, 0)
  const start = page * pageSize + 1
  const end = Math.min((page + 1) * pageSize, total)
  const btnCls = 'px-3.5 py-2 text-sm md:text-base md:px-4 rounded-lg border border-gray-300 disabled:opacity-40 hover:bg-gray-50'

  return (
    <div className={`flex items-center justify-between pt-3 text-xs md:text-sm text-gray-600${className ? ` ${className}` : ''}`}>
      <div className="flex gap-1">
        {/* First/last collapse to a compact « / » glyph on the narrowest screens (full text at sm+) to keep the row from wrapping. */}
        <button type="button" onClick={() => onPage(0)} disabled={page === 0} className={btnCls} aria-label="หน้าแรก">
          <span className="sm:hidden" aria-hidden="true">«</span>
          <span className="hidden sm:inline">หน้าแรก</span>
        </button>
        <button type="button" onClick={() => onPage(page - 1)} disabled={page === 0} className={btnCls}>
          ก่อนหน้า
        </button>
      </div>
      <span>
        {start}–{end} จาก {total}
      </span>
      <div className="flex gap-1">
        <button type="button" onClick={() => onPage(page + 1)} disabled={page >= lastPage} className={btnCls}>
          ถัดไป
        </button>
        <button type="button" onClick={() => onPage(lastPage)} disabled={page >= lastPage} className={btnCls} aria-label="หน้าสุดท้าย">
          <span className="sm:hidden" aria-hidden="true">»</span>
          <span className="hidden sm:inline">หน้าสุดท้าย</span>
        </button>
      </div>
    </div>
  )
}
