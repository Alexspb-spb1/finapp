import { useState } from 'react'
import { authStore } from '../../store/authStore'

// SEC-011 R3: shown when the user is signed in but has no ACTIVE canonical
// membership in any company — they were removed or disabled everywhere, or
// were never granted access. It replaces the whole application on purpose:
// there is no company to show, and rendering the app shell with a null
// company or role would invite stale data and half-working screens.
//
// Signing out needs no navigation here: once Auth reports the sign-out,
// ProtectedRoute re-renders unauthenticated and redirects to /login itself.
export default function NoCompanyAccess() {
  const [checking, setChecking] = useState(false)

  async function recheck() {
    setChecking(true)
    try {
      await authStore.refreshCompanyAccess()
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="flex items-center justify-center h-screen bg-slate-50 px-4">
      <div role="alert" className="max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <h1 className="text-base font-semibold text-slate-800">Нет доступа к компании</h1>
        <p className="mt-2 text-sm text-slate-500">
          У вас нет активного доступа ни к одной компании: доступ мог быть отключён или удалён.
          Обратитесь к администратору компании, чтобы вас снова добавили.
        </p>
        <div className="mt-5 flex justify-center gap-3">
          <button
            type="button"
            onClick={() => void recheck()}
            disabled={checking}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Проверить снова
          </button>
          <button
            type="button"
            onClick={() => void authStore.logout()}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700"
          >
            Выйти
          </button>
        </div>
      </div>
    </div>
  )
}
