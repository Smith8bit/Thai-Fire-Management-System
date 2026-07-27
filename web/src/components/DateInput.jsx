import { INPUT_CLS } from '../lib/shared'

/**
 * DateInput
 * A native `<input type="date">` with a guaranteed placeholder. Mobile browsers
 * (notably iOS Safari) render NO placeholder text for an empty date field —
 * unlike desktop Chrome/Firefox which draw a "dd/mm/yyyy" hint — leaving the
 * control looking like an unlabeled blank box on phones. We overlay our own
 * placeholder while the value is empty; it sits on the field's background so it
 * also masks any native hint underneath (e.g. Android Chrome), keeping the
 * appearance identical across devices. The overlay is `pointer-events-none`, so
 * taps fall through to the input beneath and still open the date picker, and the
 * calendar icon stays visible in the reserved gap on the right.
 *
 * @param {object} props
 * @param {string} props.value - controlled 'YYYY-MM-DD' value ('' when unset)
 * @param {(e: Event) => void} props.onChange - change handler for the input
 * @param {string} [props.placeholder='วว/ดด/ปปปป'] - text shown while empty
 * @param {string} [props.className=''] - classes for the wrapper (sizing lives here)
 * @param {object} [rest] - forwarded to the input (e.g. min/max for range clamping)
 * @returns {JSX.Element}
 */
export default function DateInput({ value, onChange, placeholder = 'วว/ดด/ปปปป', className = '', ...rest }) {
  return (
    <span className={`relative flex items-center${className ? ` ${className}` : ''}`}>
      <input
        type="date"
        value={value}
        onChange={onChange}
        className={`${INPUT_CLS} w-full text-accent`}
        {...rest}
      />
      {!value && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-px left-px right-9 flex items-center rounded-lg bg-foreground px-3 text-base md:text-sm text-gray-400"
        >
          {placeholder}
        </span>
      )}
    </span>
  )
}
