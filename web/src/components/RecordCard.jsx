/**
 * RecordCard
 * Mobile presentation of a single data-table row. Below the `md` breakpoint the
 * app's admin tables (users, officers, dispatchers, history, audit) are hidden and
 * their rows re-rendered as these stacked cards, since fixed-column tables are
 * unreadable on a phone. Desktop keeps the real <table>; this is the `md:hidden`
 * counterpart, so the two must show the same fields.
 *
 * @param {object} props
 * @param {React.ReactNode} [props.title] - primary line (e.g. name); ignored if `titleSlot` is given
 * @param {React.ReactNode} [props.titleSlot] - full custom title area (e.g. a clickable name); overrides `title`/`subtitle`
 * @param {React.ReactNode} [props.subtitle] - secondary line under the title (e.g. username)
 * @param {React.ReactNode} [props.badge] - status pill shown top-right
 * @param {Array<{label: string, value: React.ReactNode}|false|null|undefined>} [props.rows] -
 *   label/value pairs; falsy entries are skipped so callers can inline conditionals
 * @param {React.ReactNode} [props.children] - free-form body (e.g. long/multi-line text, media),
 *   rendered full-width below the rows; use instead of `rows` for content that shouldn't be right-aligned
 * @param {React.ReactNode} [props.actions] - action buttons, right-aligned at the foot of the card
 * @returns {JSX.Element}
 */
export default function RecordCard({ title, titleSlot, subtitle, badge, rows = [], children, actions }) {
  return (
    <div className="rounded-xl border border-background bg-foreground p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {titleSlot ?? (
            <>
              <p className="truncate font-semibold text-primary">{title}</p>
              {subtitle != null && (
                <p className="truncate text-sm font-light text-gray-500">{subtitle}</p>
              )}
            </>
          )}
        </div>
        {badge && <div className="shrink-0">{badge}</div>}
      </div>

      {rows.filter(Boolean).length > 0 && (
        <dl className="mt-2 space-y-1 text-sm">
          {rows.filter(Boolean).map((r) => (
            <div key={r.label} className="flex justify-between gap-3">
              <dt className="shrink-0 text-gray-500">{r.label}</dt>
              <dd className="min-w-0 text-right text-gray-800">{r.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {children && <div className="mt-2 text-sm text-gray-600">{children}</div>}

      {actions && <div className="mt-3 flex flex-wrap justify-end gap-2">{actions}</div>}
    </div>
  )
}
