import { useState } from 'react'
import { UserPlus, Trash2, X, AlertCircle } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { authStore } from '../store/authStore'
import type { User } from '../types/auth'

const roleLabel: Record<User['role'], string> = {
  admin: 'Администратор',
  accountant: 'Бухгалтер',
  viewer: 'Наблюдатель',
}
const roleColor: Record<User['role'], string> = {
  admin: 'bg-indigo-100 text-indigo-700',
  accountant: 'bg-emerald-100 text-emerald-700',
  viewer: 'bg-slate-100 text-slate-600',
}

export default function Settings() {
  const { user, company } = useAuth()
  const [companyName, setCompanyName] = useState(company?.name ?? '')
  const [legalType, setLegalType] = useState<'ooo' | 'ip'>(company?.legalType ?? 'ooo')
  const [inn, setInn] = useState(company?.inn ?? '')
  const [currency, setCurrency] = useState(company?.currency ?? 'RUB')
  const [saved, setSaved] = useState(false)

  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteName, setInviteName] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [invitePassword, setInvitePassword] = useState('')
  const [inviteRole, setInviteRole] = useState<User['role']>('accountant')
  const [inviteError, setInviteError] = useState('')

  const users = company ? authStore.getCompanyUsers(company.id) : []

  function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!company) return
    authStore.updateCompany(company.id, { name: companyName, legalType, inn, currency })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    setInviteError('')
    if (!company) return
    const result = authStore.inviteUser({
      name: inviteName,
      email: inviteEmail,
      password: invitePassword,
      role: inviteRole,
      companyId: company.id,
    })
    if (result.ok) {
      setInviteOpen(false)
      setInviteName(''); setInviteEmail(''); setInvitePassword('')
    } else {
      setInviteError('Пользователь с таким email уже существует')
    }
  }

  return (
    <div className="space-y-4 max-w-2xl">
      {/* Company settings */}
      <form onSubmit={handleSave} className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-700 mb-4">Организация</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">Форма организации</label>
            <div className="flex rounded-lg overflow-hidden border border-slate-200">
              {(['ooo', 'ip'] as const).map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setLegalType(t)}
                  className={`flex-1 py-2.5 text-sm font-semibold transition-all ${
                    legalType === t
                      ? 'bg-indigo-600 text-white'
                      : 'bg-white text-slate-500 hover:bg-slate-50'
                  }`}
                >
                  {t === 'ooo' ? 'ООО' : 'ИП'}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">
              {legalType === 'ooo' ? 'Название компании' : 'ФИО предпринимателя'}
            </label>
            <input
              value={companyName} onChange={e => setCompanyName(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">
              ИНН <span className="text-slate-400">({legalType === 'ooo' ? '10 цифр' : '12 цифр'})</span>
            </label>
            <input
              value={inn} onChange={e => setInn(e.target.value)}
              placeholder={legalType === 'ooo' ? '7701234567' : '770112345678'}
              maxLength={legalType === 'ooo' ? 10 : 12}
              className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">Валюта по умолчанию</label>
            <select
              value={currency}
              onChange={e => setCurrency(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300"
            >
              <option value="RUB">RUB — Российский рубль</option>
              <option value="USD">USD — Доллар США</option>
              <option value="EUR">EUR — Евро</option>
            </select>
          </div>
        </div>
        <div className="flex items-center gap-3 mt-5">
          <button type="submit"
            className="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors">
            Сохранить
          </button>
          {saved && <span className="text-sm text-emerald-600 font-medium">✓ Сохранено</span>}
        </div>
      </form>

      {/* Users */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-700">Пользователи</h3>
            <p className="text-xs text-slate-400 mt-0.5">{users.length} в вашей компании</p>
          </div>
          {user?.role === 'admin' && (
            <button
              onClick={() => setInviteOpen(true)}
              className="flex items-center gap-2 text-sm font-medium text-indigo-600 border border-indigo-200 hover:bg-indigo-50 px-3 py-2 rounded-lg transition-colors"
            >
              <UserPlus size={15} />
              Добавить
            </button>
          )}
        </div>

        <ul className="space-y-2">
          {users.map(u => (
            <li key={u.id} className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl">
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
                {u.name.slice(0, 2).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-slate-700">{u.name}</p>
                  {u.id === user?.id && (
                    <span className="text-xs bg-slate-200 text-slate-500 px-1.5 py-0.5 rounded">вы</span>
                  )}
                </div>
                <p className="text-xs text-slate-400 truncate">{u.email}</p>
              </div>
              <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${roleColor[u.role]}`}>
                {roleLabel[u.role]}
              </span>
              {user?.role === 'admin' && u.id !== user?.id && (
                <button
                  onClick={() => authStore.removeUser(u.id)}
                  className="p-1.5 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/* Integrations */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-700 mb-1">Интеграции</h3>
        <p className="text-xs text-slate-400 mb-4">Подключите банки и сервисы</p>
        <div className="space-y-3">
          {['Сбербанк', 'Тинькофф / Т-Банк', 'ВТБ', '1С Бухгалтерия', 'amoCRM'].map(name => (
            <div key={name} className="flex items-center justify-between p-3 border border-slate-200 rounded-lg">
              <span className="text-sm font-medium text-slate-700">{name}</span>
              <button className="text-xs text-indigo-600 font-medium border border-indigo-200 px-3 py-1.5 rounded-lg hover:bg-indigo-50 transition-colors">
                Подключить
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Invite modal */}
      {inviteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h2 className="font-semibold text-slate-800">Добавить пользователя</h2>
              <button onClick={() => setInviteOpen(false)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleInvite} className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Имя</label>
                <input value={inviteName} onChange={e => setInviteName(e.target.value)} required
                  placeholder="Мария Иванова"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Email</label>
                <input type="email" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} required
                  placeholder="maria@company.ru"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Пароль</label>
                <input type="password" value={invitePassword} onChange={e => setInvitePassword(e.target.value)} required
                  placeholder="Минимум 6 символов" minLength={6}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Роль</label>
                <select value={inviteRole} onChange={e => setInviteRole(e.target.value as User['role'])}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300">
                  <option value="admin">Администратор</option>
                  <option value="accountant">Бухгалтер</option>
                  <option value="viewer">Наблюдатель (только просмотр)</option>
                </select>
              </div>
              {inviteError && (
                <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-600 rounded-xl px-4 py-3 text-sm">
                  <AlertCircle size={15} /> {inviteError}
                </div>
              )}
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setInviteOpen(false)}
                  className="flex-1 py-2.5 border border-slate-200 text-sm text-slate-600 font-medium rounded-lg hover:bg-slate-50 transition">
                  Отмена
                </button>
                <button type="submit"
                  className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition">
                  Добавить
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
