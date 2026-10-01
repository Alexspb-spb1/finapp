import { useEffect, useState } from 'react'
import { Pencil, Trash2, X, ShieldCheck, BookOpen, Eye, Search, UserX, UserCheck } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { authStore } from '../store/authStore'
import type { User } from '../types/auth'
import type { Role } from '../schemas/auth'
import { auth } from '../lib/firebase'
import { canOpenInvitationManagement } from '../lib/invitationAccess'
import InvitationManagement from '../components/invitations/InvitationManagement'
import { memberErrorMessage, type CompanyMemberEntry } from '../lib/memberApi'
import { RequireCapability } from '../components/auth/RequireCapability'

const ROLES: Role[] = ['admin', 'accountant', 'viewer']

const roleLabel: Record<Role, string> = {
  admin:      'Администратор',
  accountant: 'Бухгалтер',
  viewer:     'Наблюдатель',
}
const roleColor: Record<Role, string> = {
  admin:      'bg-indigo-100 text-indigo-700',
  accountant: 'bg-emerald-100 text-emerald-700',
  viewer:     'bg-slate-100 text-slate-600',
}
const RoleIcon: Record<Role, typeof ShieldCheck> = {
  admin:      ShieldCheck,
  accountant: BookOpen,
  viewer:     Eye,
}

export default function Users() {
  const { user: me, company, activeCompanyId, status, role } = useAuth()
  if (!canOpenInvitationManagement(me, company?.id ?? null, activeCompanyId, status, auth.currentUser?.uid ?? null, role)) {
    return <p className="py-12 text-slate-500">Управление пользователями доступно администратору активной компании после загрузки прав.</p>
  }
  return <CompanyUsers key={JSON.stringify([me!.id, company!.id])} me={me!} companyId={company!.id} />
}

function CompanyUsers({ me, companyId }: { me: User; companyId: string }) {
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<CompanyMemberEntry | null>(null)
  const [formRole, setFormRole] = useState<Role>('viewer')
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [resetSent, setResetSent] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<CompanyMemberEntry | null>(null)
  const [rowError, setRowError] = useState<{ uid: string; message: string } | null>(null)
  const [, forceRender] = useState(0)

  // SEC-007 R1: the member list is the canonical roster, loaded server-side.
  // It is NOT a `users where companyId == active` query: that query hid
  // members of a secondary company and kept showing people whose membership
  // had been revoked.
  useEffect(() => {
    void authStore.loadCompanyRoster(companyId).then(() => forceRender(n => n + 1))
  }, [companyId])

  const roster = authStore.getCompanyRoster()
  const rosterError = authStore.getCompanyRosterError()

  const term = search.trim().toLowerCase()
  const members = roster.filter(m =>
    !term ||
    (m.name ?? '').toLowerCase().includes(term) ||
    (m.email ?? '').toLowerCase().includes(term) ||
    m.uid.toLowerCase().includes(term),
  )

  // SEC-007 R2: the store already reloads the roster inside each mutation,
  // so this only re-renders. Calling reloadCompanyRoster here as well made
  // every action fetch the roster twice.
  function refresh() {
    forceRender(n => n + 1)
  }

  // The form starts from the CANONICAL role. Seeding it from the legacy
  // profile made "open and save without touching anything" look like a role
  // change and fire a needless callable.
  function openEdit(member: CompanyMemberEntry) {
    setFormRole(member.role)
    setFormError('')
    setResetSent(false)
    setEditing(member)
  }

  async function handleSendReset(email: string | null) {
    if (!email) { setFormError('У участника нет email для отправки письма.'); return }
    const res = await authStore.resetPassword(email)
    if (res.ok) { setResetSent(true); setTimeout(() => setResetSent(false), 4000) }
    else setFormError('Не удалось отправить письмо — пользователь не найден')
  }

  async function handleSubmitRole(e: React.FormEvent) {
    e.preventDefault()
    if (!editing) return
    setFormError('')

    // No-op save: the requested role already IS the canonical role, so there
    // is nothing to send. The server would treat it as idempotent anyway, but
    // a call that cannot change anything should not be made at all.
    if (formRole === editing.role) {
      setEditing(null)
      return
    }

    setBusy(true)
    try {
      await authStore.changeMemberRole(companyId, editing.uid, formRole)
      refresh()
      setEditing(null)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (error) {
      setFormError(memberErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function runRowAction(member: CompanyMemberEntry, action: () => Promise<unknown>) {
    setRowError(null)
    setBusy(true)
    try {
      await action()
      refresh()
    } catch (error) {
      setRowError({ uid: member.uid, message: memberErrorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  async function handleRemove() {
    if (!confirmRemove) return
    const target = confirmRemove
    setRowError(null)
    setBusy(true)
    try {
      await authStore.removeMember(companyId, target.uid)
      refresh()
      setConfirmRemove(null)
    } catch (error) {
      setRowError({ uid: target.uid, message: memberErrorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <InvitationManagement companyId={companyId} sessionUid={me.id} />

      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Поиск по имени или email"
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-indigo-300"
          />
        </div>
        {saved && <span className="text-xs text-emerald-600 font-medium">Сохранено</span>}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {rosterError ? (
          <p className="px-5 py-6 text-sm text-red-600" role="alert">{rosterError}</p>
        ) : members.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">Участники не найдены.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {members.map(member => {
              const RIcon = RoleIcon[member.role]
              const isMe = member.uid === me.id
              return (
                <li key={member.uid} className="px-5 py-4 hover:bg-slate-50 transition-colors">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
                      {(member.name ?? member.uid).slice(0, 2).toUpperCase()}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-slate-800">
                          {member.name ?? 'Без имени'}
                        </p>
                        {isMe && (
                          <span className="text-[10px] bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded font-medium">вы</span>
                        )}
                      </div>
                      <p className="text-xs text-slate-400 truncate">{member.email ?? member.uid}</p>
                    </div>

                    <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${roleColor[member.role]}`}>
                      <RIcon size={11} />
                      {roleLabel[member.role]}
                    </span>
                    {member.status === 'disabled' && (
                      <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-medium">
                        доступ отключён
                      </span>
                    )}
                    {member.status === 'invited' && (
                      <span className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded font-medium">
                        приглашение не принято
                      </span>
                    )}

                    <RequireCapability capability="member.manage">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => openEdit(member)}
                          disabled={busy}
                          className="p-1.5 rounded-lg text-slate-300 hover:text-indigo-500 hover:bg-indigo-50 disabled:opacity-40 transition-colors"
                          title="Изменить роль"
                        >
                          <Pencil size={14} />
                        </button>
                        {member.status === 'active' && (
                          <button
                            onClick={() => void runRowAction(member, () => authStore.disableMember(companyId, member.uid))}
                            disabled={busy}
                            className="p-1.5 rounded-lg text-slate-300 hover:text-amber-600 hover:bg-amber-50 disabled:opacity-40 transition-colors"
                            title="Отключить доступ"
                          >
                            <UserX size={14} />
                          </button>
                        )}
                        {member.status === 'disabled' && (
                          <button
                            onClick={() => void runRowAction(member, () => authStore.restoreMember(companyId, member.uid))}
                            disabled={busy}
                            className="p-1.5 rounded-lg text-slate-300 hover:text-emerald-600 hover:bg-emerald-50 disabled:opacity-40 transition-colors"
                            title="Восстановить доступ"
                          >
                            <UserCheck size={14} />
                          </button>
                        )}
                        <button
                          onClick={() => { setRowError(null); setConfirmRemove(member) }}
                          disabled={busy}
                          className="p-1.5 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 disabled:opacity-40 transition-colors"
                          title="Убрать из компании"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </RequireCapability>
                  </div>

                  {rowError?.uid === member.uid && (
                    <p className="mt-2 text-sm text-red-600" role="alert">{rowError.message}</p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* Role legend */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
        <p className="text-xs font-semibold text-slate-500 mb-3">Роли</p>
        <ul className="space-y-2 text-xs text-slate-500">
          <li><b className="text-slate-700">Администратор</b> — настройки компании, участники, закрытие периода.</li>
          <li><b className="text-slate-700">Бухгалтер</b> — операции, счета и бюджеты.</li>
          <li><b className="text-slate-700">Наблюдатель</b> — только просмотр.</li>
        </ul>
      </div>

      {/* Edit role modal */}
      {editing && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h2 className="font-semibold text-slate-800">
                {editing.name ?? editing.uid}
              </h2>
              <button onClick={() => setEditing(null)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSubmitRole} className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Роль в этой компании</label>
                <div className="grid grid-cols-3 gap-2">
                  {ROLES.map(r => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setFormRole(r)}
                      className={`px-2 py-2 text-xs font-medium rounded-lg border transition-colors ${
                        formRole === r
                          ? 'border-indigo-400 bg-indigo-50 text-indigo-700'
                          : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                      }`}
                    >
                      {roleLabel[r]}
                    </button>
                  ))}
                </div>
              </div>

              {/* Profile fields of ANOTHER person are not editable here: Rules
                  deny writing someone else's users/{uid} document, so offering
                  the inputs could only ever produce a silent failure. A reset
                  email is the one supported action. */}
              {editing.uid !== me.id && (
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1.5">Пароль</label>
                  <button
                    type="button"
                    onClick={() => void handleSendReset(editing.email)}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-indigo-600 hover:bg-indigo-50 transition-colors text-left"
                  >
                    {resetSent ? '✓ Письмо отправлено' : 'Отправить письмо для сброса пароля'}
                  </button>
                </div>
              )}

              {formError && <p className="text-sm text-red-600" role="alert">{formError}</p>}

              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setEditing(null)}
                  className="flex-1 py-2.5 border border-slate-200 text-sm text-slate-600 font-medium rounded-lg hover:bg-slate-50 transition"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="flex-1 py-2.5 bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition"
                >
                  {busy ? '…' : 'Сохранить'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Remove confirmation */}
      {confirmRemove && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 text-center">
            <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-3">
              <Trash2 size={20} className="text-red-500" />
            </div>
            <h3 className="text-base font-semibold text-slate-800 mb-1">Убрать из компании?</h3>
            <p className="text-sm text-slate-500 mb-2">
              «{confirmRemove.name ?? confirmRemove.uid}» потеряет доступ к этой компании.
              Аккаунт и доступ к другим компаниям сохранятся.
            </p>
            {rowError?.uid === confirmRemove.uid && (
              <p className="text-sm text-red-600 mb-3" role="alert">{rowError.message}</p>
            )}
            <div className="flex gap-3 mt-5">
              <button
                onClick={() => setConfirmRemove(null)}
                className="flex-1 py-2.5 border border-slate-200 text-sm text-slate-600 font-medium rounded-lg hover:bg-slate-50 transition"
              >
                Отмена
              </button>
              <button
                onClick={() => void handleRemove()}
                disabled={busy}
                className="flex-1 py-2.5 bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition"
              >
                {busy ? '…' : 'Удалить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
