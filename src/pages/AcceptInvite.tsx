import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  createUserWithEmailAndPassword, getIdToken, onAuthStateChanged, reload,
  sendEmailVerification, signInWithEmailAndPassword, signOut, type User,
} from 'firebase/auth'
import { auth } from '../lib/firebase'
import { clearInviteToken, getInviteContext } from '../bootstrap/inviteTokenBootstrap'
import { accept, inviteAcceptanceError, preview } from '../lib/inviteAcceptanceApi'

interface Props {
  inviteId: string
  onAccepted: (companyId: string, user: User) => Promise<void>
}
type Preview = Awaited<ReturnType<typeof preview>>
const primary = 'w-full rounded-xl bg-indigo-600 px-4 py-3 text-white font-medium hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed'
const secondary = 'w-full rounded-xl border border-white/20 px-4 py-3 text-slate-200 hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed'
const inputClass = 'mt-1 w-full rounded-xl border border-white/20 bg-white/10 px-4 py-3 text-white outline-none focus:ring-2 focus:ring-indigo-400'

// This public boundary deliberately does not initialize the legacy auth/company
// stores. An Auth account is not evidence of company membership.
export default function AcceptInvite({ inviteId, onAccepted }: Props) {
  const [user, setUser] = useState<User | null>(auth.currentUser)
  const [authReady, setAuthReady] = useState(false)
  const [details, setDetails] = useState<Preview | null>(null)
  const [previewPending, setPreviewPending] = useState(true)
  const [previewError, setPreviewError] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [register, setRegister] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [closed, setClosed] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const mounted = useRef(false)
  const active = useRef(false)
  const session = useRef(0)
  const observedUser = useRef<User | null>(auth.currentUser)
  const resendAt = useRef(0)

  function requestInput() {
    const context = getInviteContext()
    return context?.inviteId === inviteId && context.token ? { inviteId, token: context.token } : null
  }
  const available = !closed && !!requestInput()

  useEffect(() => {
    mounted.current = true
    const unsubscribe = onAuthStateChanged(auth, next => {
      if (!mounted.current) return
      if (observedUser.current && observedUser.current !== next) {
        session.current++
        clearInviteToken()
        setClosed(true)
        setDetails(null)
        setError('')
        setNotice('')
      }
      observedUser.current = next
      setUser(next)
      setAuthReady(true)
      setPassword('')
    })
    return () => { mounted.current = false; unsubscribe() }
  }, [])

  useEffect(() => {
    let current = true
    const context = getInviteContext()
    if (context?.inviteId === inviteId && context.token) {
      preview({ inviteId, token: context.token }).then(value => {
        if (current && getInviteContext()?.token) setDetails(value)
      }).catch(reason => {
        if (current && getInviteContext()?.token) setPreviewError(inviteAcceptanceError(reason))
      }).finally(() => { if (current) setPreviewPending(false) })
    }
    return () => { current = false }
  }, [inviteId])

  useEffect(() => {
    if (!cooldown) return
    const timer = window.setInterval(() => setCooldown(Math.max(0, Math.ceil((resendAt.current - Date.now()) / 1000))), 1000)
    return () => window.clearInterval(timer)
  }, [cooldown])

  function begin() {
    if (active.current || !mounted.current || !requestInput()) return false
    active.current = true
    setBusy(true); setError(''); setNotice('')
    return true
  }
  function finish() {
    active.current = false
    if (mounted.current) setBusy(false)
  }
  function sameSession(expected: User, generation: number) {
    return mounted.current && session.current === generation && auth.currentUser === expected && !!requestInput()
  }

  async function authenticate(event: FormEvent) {
    event.preventDefault()
    if (!begin()) return
    const generation = session.current
    try {
      const credential = await (register ? createUserWithEmailAndPassword : signInWithEmailAndPassword)(auth, email.trim(), password)
      if (!sameSession(credential.user, generation)) return
      setUser(credential.user)
      setPassword('')
    } catch (reason) {
      if (mounted.current && session.current === generation && requestInput()) setError(inviteAcceptanceError(reason))
    } finally { finish() }
  }

  async function sendVerification() {
    const current = auth.currentUser
    if (!current || Date.now() < resendAt.current || !begin()) return
    const generation = session.current
    try {
      await sendEmailVerification(current)
      if (!sameSession(current, generation)) return
      resendAt.current = Date.now() + 60_000
      setCooldown(60)
      setNotice('Письмо отправлено. Откройте его, подтвердите email и вернитесь в эту вкладку. Не обновляйте вкладку с приглашением.')
    } catch (reason) {
      if (sameSession(current, generation)) setError(inviteAcceptanceError(reason))
    } finally { finish() }
  }

  async function acceptInvitation() {
    const current = auth.currentUser
    if (!current || !begin()) return
    const generation = session.current
    try {
      await reload(current)
      if (!sameSession(current, generation)) return
      await getIdToken(current, true)
      if (!sameSession(current, generation)) return
      if (!current.emailVerified) {
        setError('Email ещё не подтверждён. Откройте письмо и повторите проверку.')
        return
      }
      const input = requestInput()
      if (!input) return
      const result = await accept(input)
      if (!sameSession(current, generation)) return
      await onAccepted(result.companyId, current)
      // Opening the protected app may unmount this page. Clear the capability
      // only after access confirmation succeeds, with the same Auth identity.
      if (session.current === generation && auth.currentUser === current && requestInput()) {
        clearInviteToken()
        if (mounted.current) setAccepted(true)
      }
    } catch (reason) {
      if (sameSession(current, generation)) setError(inviteAcceptanceError(reason))
    } finally { finish() }
  }

  async function logout() {
    if (active.current) return
    session.current++
    observedUser.current = null
    clearInviteToken()
    setClosed(true); setDetails(null); setError(''); setNotice(''); setPassword('')
    try { await signOut(auth) } catch {
      if (mounted.current) setError('Не удалось выйти из аккаунта. Повторите выход после восстановления соединения.')
    }
  }

  return (
    <main className="w-full min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 px-4 py-10 text-slate-200 flex items-center justify-center">
      <section className="w-full max-w-md rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 shadow-2xl">
        <p className="mb-2 text-sm font-medium text-indigo-300">ФинУчёт</p>
        <h1 className="text-2xl font-bold text-white">Приглашение в компанию</h1>
        {accepted ? <p role="status" className="mt-5">Приглашение принято. Доступ подтверждён.</p> : !available ? (
          <div className="mt-5 space-y-4">
            <p>Откройте исходную ссылку приглашения из сообщения в новой вкладке. После обновления вкладки или выхода из аккаунта ссылка нужна снова.</p>
            {user && <button type="button" onClick={() => void logout()} className={secondary}>Выйти</button>}
          </div>
        ) : <>
          {previewPending ? <p role="status" className="mt-4">Загрузка приглашения…</p> : details ? (
            <dl className="my-5 space-y-2 rounded-xl bg-white/5 p-4 text-sm break-words">
              <div><dt className="text-slate-400">Компания</dt><dd className="font-semibold text-white">{details.companyDisplayName}</dd></div>
              <div><dt className="text-slate-400">Приглашённый email</dt><dd>{details.maskedEmail}</dd></div>
              <div><dt className="text-slate-400">Роль</dt><dd>{details.roleLabel}</dd></div>
              <div><dt className="text-slate-400">Срок действия</dt><dd>{new Date(details.expiresAt).toLocaleString('ru-RU')}</dd></div>
            </dl>
          ) : <p className="my-4 text-sm">{previewError} Если вы уже принимали это приглашение, войдите в тот же аккаунт и повторите принятие.</p>}
          {!authReady ? <p role="status">Проверка входа…</p> : !user ? (
            <form onSubmit={authenticate} className="mt-5 space-y-4">
              <h2 className="font-semibold text-white">{register ? 'Регистрация приглашённого участника' : 'Войдите с приглашённым email'}</h2>
              <label className="block text-sm">Email<input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} disabled={busy} className={inputClass} /></label>
              <label className="block text-sm">Пароль<input type="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={register ? 6 : undefined} required value={password} onChange={event => setPassword(event.target.value)} disabled={busy} className={inputClass} /></label>
              {register && <p className="text-sm text-slate-400">Придумайте свой пароль. Затем подтвердите email, чтобы принять приглашение.</p>}
              <button type="submit" disabled={busy} className={primary}>{busy ? 'Подождите…' : register ? 'Зарегистрироваться' : 'Войти'}</button>
              <button type="button" disabled={busy} onClick={() => { setRegister(!register); setError(''); setPassword('') }} className={secondary}>{register ? 'У меня есть аккаунт' : 'Создать аккаунт'}</button>
            </form>
          ) : <div className="mt-5 space-y-4">
            <p className="text-sm break-words">Вы вошли как <strong>{user.email}</strong>.</p>
            {!user.emailVerified && <>
              <p className="text-sm">Подтвердите email. Откройте письмо в другой вкладке, затем вернитесь сюда и нажмите «Я подтвердил email».</p>
              <button type="button" data-verification-send disabled={busy || cooldown > 0} onClick={() => void sendVerification()} className={secondary}>{cooldown ? `Повторная отправка через ${cooldown} с` : 'Отправить письмо подтверждения'}</button>
            </>}
            <button type="button" disabled={busy} onClick={() => void acceptInvitation()} className={primary}>{busy ? 'Подождите…' : user.emailVerified ? 'Принять приглашение' : 'Я подтвердил email'}</button>
            <p className="text-xs text-slate-400">Данные компании откроются после проверки доступа. Для другого аккаунта выйдите и откройте исходную ссылку в новой вкладке.</p>
            <button type="button" disabled={busy} onClick={() => void logout()} className={secondary}>Выйти</button>
          </div>}
        </>}
        {notice && <p role="status" className="mt-4 rounded-xl bg-emerald-500/10 p-3 text-sm text-emerald-200">{notice}</p>}
        {error && <p role="alert" className="mt-4 rounded-xl bg-red-500/10 p-3 text-sm text-red-200">{error}</p>}
      </section>
    </main>
  )
}
