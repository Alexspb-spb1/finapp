import { lazy, Suspense, useEffect, useState } from 'react'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { auth } from './lib/firebase'
import { clearInviteToken, getInviteContext } from './bootstrap/inviteTokenBootstrap'
import { isInvitationEntry } from './lib/invitationEntry'

// Financial modules remain unloaded until acceptance and current access confirmation.
const LegacyApp = lazy(() => import('./LegacyApp'))
const AcceptInvite = lazy(() => import('./pages/AcceptInvite'))

export default function App() {
  const [accepted, setAccepted] = useState<User | null>(null)
  useEffect(() => {
    if (!accepted) return
    return onAuthStateChanged(auth, user => {
      if (user !== accepted) {
        // End the isolated document after logout/account change. Re-login
        // starts the regular Auth lifecycle in a fresh document, with no token.
        window.history.replaceState(null, '', `${import.meta.env.BASE_URL}#/login`)
        window.location.reload()
      }
    })
  }, [accepted])
  async function openCompany(companyId: string, user: User) {
    const { authStore } = await import('./store/authStore')
    await authStore.activateAcceptedCompany(companyId, user)
    clearInviteToken()
    window.history.replaceState(null, '', `${import.meta.env.BASE_URL}#/`)
    setAccepted(user)
  }
  return <Suspense fallback={<p role="status">Загрузка…</p>}>
    {isInvitationEntry && !accepted
      ? <AcceptInvite inviteId={getInviteContext()?.inviteId ?? ''} onAccepted={openCompany} />
      : <LegacyApp />}
  </Suspense>
}
