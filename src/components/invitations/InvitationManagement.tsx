import { useEffect, useRef, useState } from 'react'
import { buildInvitationLink, invitationApi, invitationErrorMessage, INVITATION_RESEND_COOLDOWN_MS, INVITATION_RESEND_LIMIT } from '../../lib/invitationApi'
import type { InvitationListItem, InvitationRole } from '../../lib/invitationApi'

interface Props { companyId: string; sessionUid: string }
const roles: Record<InvitationRole, string> = { admin: 'Администратор', accountant: 'Бухгалтер', viewer: 'Наблюдатель' }
const buttonClass = 'rounded-lg border border-slate-200 px-3 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed'
type Dialog = { kind: 'create' } | { kind: 'cancel' | 'resend'; item: InvitationListItem } | { kind: 'link'; url: string; expiresAt: string }

// A new instance discards every old company/session value before painting.
export default function InvitationManagement(props: Props) {
  return <InvitationContext key={JSON.stringify([props.sessionUid, props.companyId])} {...props} />
}

function InvitationContext({ companyId }: Props) {
  const [items, setItems] = useState<InvitationListItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<InvitationRole>('accountant')
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const alive = useRef(false)
  const request = useRef(0)
  const operation = useRef(false)
  const dialogVersion = useRef(0)
  const dialogElement = useRef<HTMLDivElement>(null)
  const dialogKind = dialog?.kind

  useEffect(() => {
    if (!dialogKind) return
    const previous = document.activeElement
    dialogElement.current?.querySelector<HTMLElement>('input, select, button')?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [dialogKind])

  useEffect(() => {
    alive.current = true
    const version = ++request.current
    invitationApi.list({ companyId, pageSize: 20 }).then(page => {
      if (!alive.current || version !== request.current) return
      setItems(page.items); setCursor(page.nextCursor); setConfirmed(true); setLoading(false)
    }).catch(reason => {
      if (!alive.current || version !== request.current) return
      setError(invitationErrorMessage(reason)); setLoading(false)
    })
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    // Unmount rejects every completion through alive. StrictMode's next
    // setup increments the request generation before any promise can settle.
    return () => { alive.current = false; window.clearInterval(timer) }
  }, [companyId])

  async function load(next?: string) {
    if (operation.current) return
    operation.current = true
    const version = ++request.current
    setLoading(true); setError(''); setConfirmed(false)
    try {
      const page = await invitationApi.list({ companyId, pageSize: 20, ...(next ? { cursor: next } : {}) })
      if (!alive.current || version !== request.current) return
      setItems(previous => next ? [...previous, ...page.items.filter(item => !previous.some(old => old.inviteId === item.inviteId))] : page.items)
      setCursor(page.nextCursor); setConfirmed(true)
    } catch (reason) {
      if (alive.current && version === request.current) { setItems([]); setCursor(null); setError(invitationErrorMessage(reason)); closeDialog() }
    } finally {
      if (alive.current && version === request.current) { operation.current = false; setLoading(false) }
    }
  }
  function closeDialog() { dialogVersion.current++; setDialog(null); setCopied(false); setEmail('') }
  function openDialog(value: Dialog) { dialogVersion.current++; setCopied(false); setError(''); setDialog(value) }
  async function mutate() {
    if (operation.current || !confirmed || loading || !dialog || dialog.kind === 'link') return
    operation.current = true
    const version = dialogVersion.current
    setBusy(true); setError('')
    try {
      if (dialog.kind === 'cancel') {
        await invitationApi.cancel({ companyId, inviteId: dialog.item.inviteId })
        if (!alive.current) return
        if (version === dialogVersion.current) closeDialog()
      } else {
        const result = dialog.kind === 'create'
          ? await invitationApi.create({ companyId, email: email.trim().toLowerCase(), role })
          : await invitationApi.resend({ companyId, inviteId: dialog.item.inviteId })
        if (!alive.current) return
        if (version === dialogVersion.current) {
          openDialog({ kind: 'link', url: buildInvitationLink(result, window.location.origin), expiresAt: result.expiresAtUtc })
          setEmail('')
        }
      }
      operation.current = false
      await load()
    } catch (reason) {
      if (alive.current) { setError(invitationErrorMessage(reason)); setConfirmed(false); closeDialog() }
    } finally {
      if (alive.current) { operation.current = false; setBusy(false) }
    }
  }
  async function copyLink() {
    if (dialog?.kind !== 'link') return
    const version = dialogVersion.current
    try {
      await navigator.clipboard.writeText(dialog.url)
      if (alive.current && version === dialogVersion.current) setCopied(true)
    } catch {
      if (alive.current && version === dialogVersion.current) setError('Не удалось скопировать. Выделите ссылку и скопируйте её вручную.')
    }
  }
  const locked = busy || loading || !confirmed
  return <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-4" aria-label="Приглашения">
    <div className="flex flex-wrap justify-between items-center gap-3">
      <h2 className="text-lg font-semibold">Приглашения</h2>
      <div className="flex gap-2">
        <button className={buttonClass} disabled={busy || loading} onClick={() => { closeDialog(); void load() }}>Обновить список</button>
        <button className={buttonClass} disabled={locked} onClick={() => { setEmail(''); setRole('accountant'); openDialog({ kind: 'create' }) }}>Пригласить по email</button>
      </div>
    </div>
    <p className="text-sm text-slate-500">Срок ссылки — 7 дней. Ссылку передаёт администратор вручную. Для принятия нужен подтверждённый email приглашённого пользователя.</p>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {loading && <p role="status">Загрузка приглашений…</p>}
    {!loading && confirmed && items.length === 0 && <p className="text-slate-500">Приглашений пока нет.</p>}
    <ul className="space-y-3">{items.map(item => {
      const expired = item.status === 'pending' && now >= Date.parse(item.expiresAtUtc)
      const remaining = Math.max(0, Math.ceil((Date.parse(item.lastSentAtUtc ?? item.createdAtUtc) + INVITATION_RESEND_COOLDOWN_MS - now) / 1000))
      const limit = item.resendCount >= INVITATION_RESEND_LIMIT
      return <li key={item.inviteId} className="border border-slate-200 rounded-xl p-3 flex flex-wrap gap-3 justify-between">
        <div className="min-w-0 break-words">
          <p className="font-medium">{item.emailNormalized} · {roles[item.role]}</p>
          <p className="text-sm text-slate-500">{expired ? 'Срок истёк' : item.status === 'pending' ? 'Ожидает принятия' : item.status === 'accepted' ? 'Принято' : 'Отменено'} · Срок: {new Date(item.expiresAtUtc).toLocaleString('ru-RU')}</p>
          <p className="text-sm text-slate-500">Обновлений ссылки: {item.resendCount}/{INVITATION_RESEND_LIMIT}{limit ? ' · Лимит исчерпан' : item.status === 'pending' && remaining > 0 ? ` · Новая ссылка через ${remaining} с` : ''}</p>
        </div>
        {item.status === 'pending' && <div className="flex items-center gap-2">
          <button className={buttonClass} disabled={locked || limit || remaining > 0} onClick={() => openDialog({ kind: 'resend', item })}>Новая ссылка</button>
          <button className={buttonClass} disabled={locked} onClick={() => openDialog({ kind: 'cancel', item })}>Отменить приглашение</button>
        </div>}
      </li>
    })}</ul>
    {cursor && <button className={buttonClass} disabled={busy || loading || !confirmed} onClick={() => void load(cursor)}>Показать ещё</button>}
    {dialog && <div className="fixed inset-0 z-50 bg-slate-900/30 flex items-center justify-center p-4">
      <div ref={dialogElement} role="dialog" aria-modal="true" aria-labelledby="invitation-dialog-title" className="bg-white rounded-2xl p-6 max-w-lg w-full space-y-4" onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); closeDialog() }
        if (event.key !== 'Tab') return
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled), select:not(:disabled), button:not(:disabled)')]
        const first = controls[0], last = controls.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }}>
        <h3 id="invitation-dialog-title" className="font-semibold">{dialog.kind === 'create' ? 'Новое приглашение' : dialog.kind === 'cancel' ? 'Отменить приглашение?' : dialog.kind === 'resend' ? 'Заменить ссылку?' : 'Ссылка приглашения'}</h3>
        {dialog.kind === 'create' ? <form onSubmit={event => { event.preventDefault(); void mutate() }} className="space-y-4">
          <label className="block">Email<input required type="email" autoComplete="off" value={email} disabled={busy} onChange={event => setEmail(event.target.value)} className="block w-full border rounded-lg p-2" /></label>
          <label className="block">Роль<select value={role} disabled={busy} onChange={event => setRole(event.target.value as InvitationRole)} className="block w-full border rounded-lg p-2">{Object.entries(roles).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <button className={buttonClass} disabled={locked || !email.trim()} type="submit">{busy ? 'Создание…' : 'Создать приглашение'}</button>
        </form> : dialog.kind === 'link' ? <>
          <p className="text-sm">Сохраните ссылку сейчас: после закрытия получить её снова нельзя. «Новая ссылка» заменит потерянную, прежняя перестанет работать.</p>
          <label className="block">Ссылка<input readOnly value={dialog.url} className="block w-full border rounded-lg p-2" onFocus={event => event.target.select()} /></label>
          <p className="text-sm">Действует до {new Date(dialog.expiresAt).toLocaleString('ru-RU')}</p>
          <button className={buttonClass} onClick={() => void copyLink()}>{copied ? 'Скопировано' : 'Копировать ссылку'}</button>
        </> : <>
          <p>{dialog.item.emailNormalized}</p>
          <p>{dialog.kind === 'cancel' ? 'Ссылка перестанет давать доступ к компании.' : 'Прежняя ссылка перестанет работать. Новая будет действовать 7 дней; отправьте её вручную.'}</p>
          <button className={buttonClass} disabled={locked} onClick={() => void mutate()}>{busy ? 'Выполнение…' : dialog.kind === 'cancel' ? 'Подтвердить отмену' : 'Создать новую ссылку'}</button>
        </>}
        <button className={buttonClass} onClick={closeDialog}>Закрыть</button>
      </div>
    </div>}
  </section>
}
