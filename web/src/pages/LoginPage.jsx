import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '../lib/useAuthStore'
import { toast } from '../lib/toastStore'
import forestPlaceholder from '../assets/forest_placeholder.jpg'
import appIcon from '../assets/icon.png'

// Maps backend auth error codes to Thai-language user-facing messages.
// Any code not listed here falls through to err.message (see handleSubmit's catch block).
const LOGIN_ERRORS = {
  LOGIN_BAD_CREDENTIALS: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
}

/**
 * LoginPage
 * Route-level component (no props) rendering the admin/officer login screen.
 * Purpose: collect username + password, authenticate via useAuthStore, then
 * redirect back to whatever protected route the user originally tried to visit.
 *
 * Returns: JSX.Element — a two-column layout (form + decorative forest image).
 */
export default function LoginPage() {

  // Controlled-input state for the form fields.
  const [identifier, setIdentifier] = useState('') // string: username entered by the user
  const [password, setPassword] = useState('')     // string: password entered by the user
  const [loading, setLoading] = useState(false)    // boolean: disables the submit button mid-request

  const login = useAuthStore((s) => s.login) // async (username, password) => void; throws on failure
  const navigate = useNavigate()
  const location = useLocation()
  // Dependency: react-router's ProtectedRoute (elsewhere) sets location.state.from
  // when redirecting an unauthenticated user here. Falls back to '/' if absent.
  const from = location.state?.from?.pathname || '/'

  /**
   * handleSubmit
   * @param {React.FormEvent<HTMLFormElement>} e - the form submit event
   * @returns {Promise<void>}
   * Validates input client-side, calls the auth store's login, and navigates
   * on success. Assumes `login` throws an Error whose `message` may match a
   * key in LOGIN_ERRORS (server-defined error code) or be a plain message.
   */
  const handleSubmit = async (e) => {
    e.preventDefault()

    const username = identifier.trim()
    // Edge case: empty/whitespace-only username or missing password.
    if (!username || !password) {
      toast.error('กรุณากรอกชื่อผู้ใช้และรหัสผ่าน')
      return
    }
    // Edge case: username shorter than the minimum enforced length.
    if (username.length < 3) {
      toast.error('ชื่อผู้ใช้ต้องมีอย่างน้อย 3 ตัวอักษร')
      return
    }

    setLoading(true)

    try {
      await login(username, password)
      toast.success('เข้าสู่ระบบสำเร็จ')
      // Slight delay so the success toast is visible before the route change.
      setTimeout(() => navigate(from, { replace: true }), 800)
    } catch (err) {
      // Prefer a mapped Thai message; otherwise show the raw error, otherwise a generic fallback.
      toast.error(LOGIN_ERRORS[err.message] || err.message || 'เข้าสู่ระบบไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-background flex justify-start overflow-hidden">
      {/* Left panel: branding + login form, rendered above the background image (z-10) */}
      <div id='login' className="relative z-10 bg-foreground w-full max-w-md flex flex-col justify-center py-8 px-6 sm:px-10 shadow-2xl">
        <div className='flex flex-col'>
          <div className="w-full flex items-center gap-4 mb-8">
            <img
              src={appIcon}
              alt="FireNET"
              className="w-16 h-16 sm:w-24 sm:h-24 shrink-0 rounded-[28%] object-cover"
            />
            <div>
              <h1 className="text-3xl sm:text-4xl font-bold text-primary">FireNET</h1>
              <h1 className="text-2xl sm:text-3xl font-medium text-gray-500">ระบบจัดการไฟป่า</h1>
              <p className="text-lg text-gray-400 font-medium font-head">สำหรับผู้ดูแล</p>
            </div>
          </div>

          {/* noValidate: disables native browser validation UI so our own toast-based
              validation in handleSubmit is the single source of feedback */}
          <form onSubmit={handleSubmit} className="w-full space-y-4" noValidate>
            <div>
              <label htmlFor="login-identifier" className="block text-base font-title text-gray-700 mb-1.5">
                ชื่อผู้ใช้
              </label>
              <input
                id="login-identifier"
                name="username"
                type="text"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                required
                minLength={3}
                autoFocus
                autoComplete="off"
                placeholder="ไม่ต่ำกว่า3ตัวอักษร"
                className="w-full px-4 py-2 text-base font-title text-gray-700 border border-gray-300 rounded-lg focus:ring-2 focus:ring-secondary outline-none"
              />
            </div>

            <div>
              <label htmlFor="login-password" className="block text-base font-title text-gray-700 mb-1.5">
                รหัสผ่าน
              </label>
              <input
                id="login-password"
                name="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                placeholder="••••••••"
                className="w-full px-4 py-2 text-base font-title text-gray-700 border border-gray-300 rounded-lg focus:ring-2 focus:ring-secondary outline-none"
              />
            </div>

            {/* aria-busy communicates the pending request state to assistive tech;
                disabled prevents duplicate submissions while a request is in flight */}
            <button
              type="submit"
              disabled={loading}
              aria-busy={loading || undefined}
              className="w-full bg-primary hover:bg-brand text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50 min-h-11"
            >
              {loading ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}
            </button>
          </form>

          <div className="w-full mt-6 pt-2 border-t border-gray-300 text-center">
            <p className="text-md text-gray-500">
              สำนักป้องกันรักษาป่าและควบคุมไฟป่า
            </p>
          </div>
        </div>
      </div>
      {/* Right panel: purely decorative background image; hidden on phones where the form takes the full width */}
      <div className='hidden md:block flex-1 overflow-hidden'>
        <img
          src={forestPlaceholder}
          alt="ป่าไม้"
          className="w-full h-full object-fill"
        />
      </div>
    </div>
  )
}
