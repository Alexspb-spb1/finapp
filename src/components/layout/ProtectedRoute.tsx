import { Navigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { resolveProtectedRouteRedirect } from './resolveProtectedRouteRedirect'
import NoCompanyAccess from './NoCompanyAccess'

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, loading, status } = useAuth()

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-50">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-slate-400">Загрузка…</p>
        </div>
      </div>
    )
  }

  const redirectTo = resolveProtectedRouteRedirect({ isAuthenticated, status })
  if (redirectTo) return <Navigate to={redirectTo} replace />
  // SEC-011 R3: signed in, but no company grants access any more. The app
  // shell is never rendered in this state — there is no company or role.
  if (status === 'no_access') return <NoCompanyAccess />
  return <>{children}</>
}
