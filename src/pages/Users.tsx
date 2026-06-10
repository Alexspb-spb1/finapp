import { useState } from 'react'
import { UserPlus, Pencil, Trash2, X, AlertCircle, ShieldCheck, BookOpen, Eye, Search } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { authStore } from '../store/authStore'
import type { User } from '../types/auth'

const ROLES: User['role'][] = ['admin', 'accountant', 'viewer']

const roleLabel: Record<User['role'], string> = {
  admin:      'Администратор',
  accountant: 'Бухгалтер',
  viewer:     'Наблюдатель',
}
const roleColor: Record<User['role'], string> = {
  admin:      'bg-indigo-100 text-indigo-700',
  accountant: 'bg-emerald-100 text-emerald-700',
  viewer:     'bg-slate-100 text-slate-600',
}
const RoleIcon: Record<User['role'], typeof ShieldCheck> = {
  admin:      ShieldCheck,
  accountant: BookOpen,
  viewer:     Eye,
}

type ModalMode = 'add' | 'edit'

interface FormState {
  name: string
  email: string
  password: string
  role: User['role']
}

const emptyForm = (): FormState => ({ name: '', email: '', password: '', role: 'accountant' })

export default function Users() {
  const { user: me, company } = useAuth()

  const [search,    setSearch]    = useState('')
  const [modal,     setModal]     = useState<{ mode: ModalMode; target?: User } | null>(null)
  const [deleteId,  setDeleteId]  = useState<string | null>(null)
  const [form,      setForm]      = useState<FormState>(emptyForm())
  const [formError, setFormError] = useState('')
  const [saved,     setSaved]     = useState(false)

  const allUsers = company ? authStore.getCompanyUsers(company.id) : []
  const users = allUsers.filter(u =>
    u.name.toLowerCase().includes(search.toLowerCase()) ||
    u.email.toLowerCase().includes(search.toLowerCase()),
  )

  // ── Open add modal ──────────────────────────────────────────────
  function openAdd() {
    setForm(emptyForm())
    setFormError('')
    setModal({ mode: 'add' })
  }

  // ── Open edit modal ─────────────────────────────────────────────
  function openEdit(u: User) {
    setForm({ name: u.name, email: u.email, password: '', role: u.role })
    setFormError('')
    setModal({ mode: 'edit', target: u })
  }

  // ── Submit form ─────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFormError('')

    if (modal?.mode === 'add') {
      if (!company) return
      const res = await authStore.inviteUser({
        name:      form.name,
        email:     form.email,
        password:  form.password,
        role:      form.role,
        companyId: company.id,
      })
      if (!res.ok) { setFormError('Пользователь с таким email уже существует'); return }
    } else if (modal?.mode === 'edit' && modal.target) {
      const payload: Parameters<typeof authStore.updateUser>[1] = {}
      if (form.name  !== modal.target.name)  payload.name  = form.name
      if (form.email !== modal.target.email) payload.email = form.email
      if (form.role  !== modal.target.role)  payload.role  = form.role
      if (form.password)                     payload.password = form.password

      const res = await authStore.updateUser(modal.target.id, payload)
      if (!res.ok) { setFormError('Этот email уже занят другим пользователем'); return }
    }

    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
    setModal(null)
  }

  // ── Confirm delete ──────────────────────────────────────────────
  function confirmDelete() {
    if (deleteId) { authStore.removeUser(deleteId); setDeleteId(null) }
  }

  const delTarget = allUsers.find(u => u.id === deleteId)

  // Guard — non-admins see nothing
  if (me?.role !== 'admin') {
    return (
      <div className="flex flex-col items-center justify-center py-32 text-slate-400">
        <ShieldCheck size={40} className="mb-3 text-slate-300" />
        <p className="text-base font-medium">Только администратор имеет доступ к этому разделу</p>
      </div>
    )
  }

  return (
    <div className="space-y-4 max-w-3xl">

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Поиск по имени или email…"
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-indigo-300 bg-white"
          />
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
        >
          <UserPlus size={15} /> Добавить
        </button>
      </div>

      {/* User cards */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-700">Учётные записи</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              {allUsers.length} {allUsers.length === 1 ? 'пользователь' : allUsers.length < 5 ? 'пользователя' : 'пользователей'} в компании
            </p>
          </div>
          {saved && <span className="text-sm text-emerald-600 font-medium">✓ Сохранено</span>}
        </div>

        {users.length === 0 ? (
          <div className="py-12 text-center text-slate-400">
            <p className="text-sm">{search ? 'Ничего не найдено' : 'Нет пользователей'}</p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-50">
            {users.map(u => {
              const RIcon = RoleIcon[u.role]
              const isMe = u.id === me?.id
              return (
                <li key={u.id} className="flex items-center gap-4 px-5 py-4 hover:bg-slate-50 transition-colors">
                  {/* Avatar */}
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
                    {u.name.slice(0, 2).toUpperCase()}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-slate-800">{u.name}</p>
                      {isMe && (
                        <span className="text-[10px] bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded font-medium">вы</span>
                      )}
                    </div>
                    <p className="text-xs text-slate-400 truncate">{u.email}</p>
                    <p className="text-[10px] text-slate-300 mt-0.5">
                      Добавлен {new Date(u.createdAt).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })}
                    </p>
                  </div>

                  {/* Role badge */}
                  <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${roleColor[u.role]}`}>
                    <RIcon size={11} />
                    {roleLabel[u.role]}
                  </span>

                  {/* Actions */}
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => openEdit(u)}
                      className="p-1.5 rounded-lg text-slate-300 hover:text-indigo-500 hover:bg-indigo-50 transition-colors"
                      title="Редактировать"
                    >
                      <Pencil size={14} />
                    </button>
                    {!isMe && (
                      <button
                        onClick={() => setDeleteId(u.id)}
                        className="p-1.5 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                        title="Удалить"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* Role legend */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Уровни доступа</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {ROLES.map(r => {
            const Ic = RoleIcon[r]
            return (
              <div key={r} className="flex items-start gap-2.5 p-3 rounded-lg bg-slate-50 border border-slate-100">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${roleColor[r]}`}>
                  <Ic size={13} />
                </div>
                <div>
                  <p className="text-xs font-semibold text-slate-700">{roleLabel[r]}</p>
                  <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">
                    {r === 'admin'      && 'Полный доступ, управление пользователями'}
                    {r === 'accountant' && 'Создание и редактирование операций'}
                    {r === 'viewer'     && 'Только просмотр данных'}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Add / Edit modal ── */}
      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h2 className="font-semibold text-slate-800">
                {modal.mode === 'add' ? 'Новый пользователь' : 'Редактировать пользователя'}
              </h2>
              <button onClick={() => setModal(null)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
              {/* Name */}
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Имя</label>
                <input
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  required
                  placeholder="Иванова Мария"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300"
                />
              </div>

              {/* Email */}
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Email</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  required
                  placeholder="maria@company.ru"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300"
                />
              </div>

              {/* Password */}
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">
                  Пароль
                  {modal.mode === 'edit' && (
                    <span className="font-normal text-slate-400 ml-1">(оставьте пустым, чтобы не менять)</span>
                  )}
                </label>
                <input
                  type="password"
                  value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  required={modal.mode === 'add'}
                  placeholder={modal.mode === 'add' ? 'Минимум 6 символов' : '••••••••'}
                  minLength={modal.mode === 'add' || form.password ? 6 : undefined}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300"
                />
              </div>

              {/* Role */}
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Роль</label>
                <div className="grid grid-cols-3 sm:grid-cols-3 gap-2">
                  {ROLES.map(r => {
                    const Ic = RoleIcon[r]
                    return (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setForm(f => ({ ...f, role: r }))}
                        className={`flex flex-col items-center gap-1.5 py-3 rounded-lg border text-xs font-medium transition-all ${
                          form.role === r
                            ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
                            : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                        }`}
                      >
                        <Ic size={16} />
                        {roleLabel[r]}
                      </button>
                    )
                  })}
                </div>
              </div>

              {formError && (
                <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-600 rounded-xl px-4 py-3 text-sm">
                  <AlertCircle size={15} /> {formError}
                </div>
              )}

              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setModal(null)}
                  className="flex-1 py-2.5 border border-slate-200 text-sm text-slate-600 font-medium rounded-lg hover:bg-slate-50 transition"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition"
                >
                  {modal.mode === 'add' ? 'Добавить' : 'Сохранить'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Delete confirm ── */}
      {deleteId && delTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 text-center">
            <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-3">
              <Trash2 size={20} className="text-red-500" />
            </div>
            <h3 className="text-base font-semibold text-slate-800 mb-1">Удалить пользователя?</h3>
            <p className="text-sm text-slate-500 mb-5">
              «{delTarget.name}» будет удалён. Это действие нельзя отменить.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteId(null)}
                className="flex-1 py-2.5 border border-slate-200 text-sm text-slate-600 font-medium rounded-lg hover:bg-slate-50 transition"
              >
                Отмена
              </button>
              <button
                onClick={confirmDelete}
                className="flex-1 py-2.5 bg-red-500 hover:bg-red-600 text-white text-sm font-medium rounded-lg transition"
              >
                Удалить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
