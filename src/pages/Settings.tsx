import { useState } from 'react'
import { UserPlus, Trash2, X, AlertCircle, KeyRound, User as UserIcon, Plus, Pencil, Tag } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { authStore } from '../store/authStore'
import { useStore } from '../store/useStore'
import CategoryIcon from '../utils/categoryIcons'
import type { User } from '../types/auth'
import type { Category, TransactionType } from '../types'

// ── Палитра цветов и иконок для категорий ─────────────────────────────────────
const CAT_COLORS = [
  '#6366f1','#22c55e','#f59e0b','#ef4444','#3b82f6','#8b5cf6',
  '#ec4899','#14b8a6','#f97316','#06b6d4','#64748b','#10b981',
]
const CAT_ICONS = [
  'TrendingUp','TrendingDown','Banknote','Users','Building2','Megaphone',
  'Package','Landmark','Wifi','Plane','ShoppingCart','Car',
  'Coffee','Heart','Utensils','BookOpen','Wrench','Briefcase',
  'Home','Zap','DollarSign','CreditCard','Receipt','BarChart2',
  'Gift','Globe','Shield','PiggyBank','ArrowLeftRight',
]

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
  const store = useStore()

  const [companyName, setCompanyName] = useState(company?.name ?? '')
  const [legalType, setLegalType] = useState<'ooo' | 'ip'>(company?.legalType ?? 'ooo')
  const [inn, setInn] = useState(company?.inn ?? '')
  const [currency, setCurrency] = useState(company?.currency ?? 'RUB')
  const [saved, setSaved] = useState(false)

  // Profile editing
  const [profileName,     setProfileName]     = useState(user?.name  ?? '')
  const [profileEmail,    setProfileEmail]    = useState(user?.email ?? '')
  const [profilePassword, setProfilePassword] = useState('')
  const [profileSaved,    setProfileSaved]    = useState(false)
  const [profileError,    setProfileError]    = useState('')

  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteName, setInviteName] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [invitePassword, setInvitePassword] = useState('')
  const [inviteRole, setInviteRole] = useState<User['role']>('accountant')
  const [inviteError, setInviteError] = useState('')

  // Categories
  const [catTab,      setCatTab]      = useState<TransactionType>('income')
  const [catModal,    setCatModal]    = useState(false)
  const [editingCat,  setEditingCat]  = useState<Category | null>(null)
  const [catName,     setCatName]     = useState('')
  const [catType,     setCatType]     = useState<TransactionType>('income')
  const [catIcon,     setCatIcon]     = useState('TrendingUp')
  const [catColor,    setCatColor]    = useState(CAT_COLORS[0])
  const [deleteCatId, setDeleteCatId] = useState<string | null>(null)

  const users = company ? authStore.getCompanyUsers(company.id) : []

  // Категории по текущей вкладке
  const visibleCats = store.categories.filter(c => c.type === catTab)

  function openAddCat() {
    setEditingCat(null)
    setCatName(''); setCatIcon('TrendingUp'); setCatColor(CAT_COLORS[0]); setCatType(catTab)
    setCatModal(true)
  }

  function openEditCat(cat: Category) {
    setEditingCat(cat)
    setCatName(cat.name); setCatIcon(cat.icon); setCatColor(cat.color); setCatType(cat.type)
    setCatModal(true)
  }

  function saveCat() {
    if (!catName.trim()) return
    if (editingCat) {
      store.updateCategory(editingCat.id, { name: catName.trim(), icon: catIcon, color: catColor, type: catType })
    } else {
      store.addCategory({ id: 'cat_' + Date.now(), name: catName.trim(), type: catType, icon: catIcon, color: catColor })
    }
    setCatModal(false)
  }

  function confirmDeleteCat() {
    if (!deleteCatId) return
    // Если статья используется в операциях — запрещаем удаление
    const inUse = store.transactions.some(t => t.categoryId === deleteCatId)
    if (!inUse) store.deleteCategory(deleteCatId)
    setDeleteCatId(null)
  }

  const deleteCatInUse = deleteCatId
    ? store.transactions.some(t => t.categoryId === deleteCatId)
    : false

  async function handleProfileSave(e: React.FormEvent) {
    e.preventDefault()
    setProfileError('')
    if (!user) return
    const payload: Parameters<typeof authStore.updateUser>[1] = {}
    if (profileName  !== user.name)  payload.name  = profileName
    if (profileEmail !== user.email) payload.email = profileEmail
    if (profilePassword)             payload.password = profilePassword
    const res = await authStore.updateUser(user.id, payload)
    if (!res.ok) { setProfileError('Этот email уже занят другим пользователем'); return }
    setProfilePassword('')
    setProfileSaved(true)
    setTimeout(() => setProfileSaved(false), 2000)
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!company) return
    authStore.updateCompany(company.id, { name: companyName, legalType, inn, currency })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    setInviteError('')
    if (!company) return
    const result = await authStore.inviteUser({
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
      {/* Profile */}
      <form onSubmit={handleProfileSave} className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <UserIcon size={15} className="text-slate-400" />
          <h3 className="text-sm font-semibold text-slate-700">Мой профиль</h3>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">Имя</label>
            <input
              value={profileName}
              onChange={e => setProfileName(e.target.value)}
              required
              className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">Email</label>
            <input
              type="email"
              value={profileEmail}
              onChange={e => setProfileEmail(e.target.value)}
              required
              className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">
              <span className="flex items-center gap-1.5"><KeyRound size={12} /> Новый пароль</span>
            </label>
            <input
              type="password"
              value={profilePassword}
              onChange={e => setProfilePassword(e.target.value)}
              placeholder="Оставьте пустым, чтобы не менять"
              minLength={profilePassword ? 6 : undefined}
              className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300"
            />
          </div>
        </div>
        {profileError && (
          <div className="flex items-center gap-2 mt-3 bg-red-50 border border-red-200 text-red-600 rounded-xl px-4 py-3 text-sm">
            <AlertCircle size={15} /> {profileError}
          </div>
        )}
        <div className="flex items-center gap-3 mt-5">
          <button type="submit"
            className="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors">
            Сохранить профиль
          </button>
          {profileSaved && <span className="text-sm text-emerald-600 font-medium">✓ Сохранено</span>}
        </div>
      </form>

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

      {/* ── Categories ──────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Tag size={15} className="text-slate-400" />
            <h3 className="text-sm font-semibold text-slate-700">Статьи доходов и расходов</h3>
          </div>
          <button onClick={openAddCat}
            className="flex items-center gap-2 text-sm font-medium text-indigo-600 border border-indigo-200 hover:bg-indigo-50 px-3 py-2 rounded-lg transition-colors">
            <Plus size={15} /> Добавить
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-slate-100 rounded-lg p-1 mb-4">
          {([
            { value: 'income',   label: 'Доходы'   },
            { value: 'expense',  label: 'Расходы'  },
            { value: 'transfer', label: 'Переводы' },
          ] as const).map(({ value, label }) => (
            <button key={value} type="button"
              onClick={() => setCatTab(value)}
              className={`flex-1 py-1.5 rounded-md text-sm font-medium transition-all ${
                catTab === value ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}>
              {label}
            </button>
          ))}
        </div>

        {/* Category list */}
        {visibleCats.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-6">Нет статей. Нажмите «Добавить»</p>
        ) : (
          <ul className="space-y-1.5">
            {visibleCats.map(cat => {
              const inUse = store.transactions.some(t => t.categoryId === cat.id)
              return (
                <li key={cat.id}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-slate-50 transition-colors group">
                  <div className="w-8 h-8 icon-circle flex items-center justify-center shrink-0"
                    style={{ background: cat.color + '22' }}>
                    <CategoryIcon name={cat.icon} size={14} color={cat.color} />
                  </div>
                  <span className="flex-1 text-sm font-medium text-slate-700">{cat.name}</span>
                  {inUse && (
                    <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full shrink-0">
                      {store.transactions.filter(t => t.categoryId === cat.id).length} оп.
                    </span>
                  )}
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => openEditCat(cat)}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors">
                      <Pencil size={13} />
                    </button>
                    <button onClick={() => setDeleteCatId(cat.id)}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* ── Category add/edit modal ─────────────────────────────────────────── */}
      {catModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) setCatModal(false) }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h2 className="font-semibold text-slate-800">
                {editingCat ? 'Редактировать статью' : 'Новая статья'}
              </h2>
              <button onClick={() => setCatModal(false)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
                <X size={18} />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">

              {/* Type */}
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Тип</label>
                <div className="flex gap-2">
                  {([
                    { v: 'income',   l: 'Доход',   cls: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200' },
                    { v: 'expense',  l: 'Расход',  cls: 'bg-red-50 text-red-700 ring-1 ring-red-200' },
                    { v: 'transfer', l: 'Перевод', cls: 'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200' },
                  ] as const).map(({ v, l, cls }) => (
                    <button key={v} type="button" onClick={() => setCatType(v)}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${
                        catType === v ? cls : 'text-slate-500 hover:bg-slate-50 border border-slate-200'
                      }`}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>

              {/* Name */}
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Название</label>
                <input value={catName} onChange={e => setCatName(e.target.value)} required
                  placeholder="Например: Зарплата"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300" />
              </div>

              {/* Icon picker */}
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Иконка</label>
                <div className="grid grid-cols-10 gap-1.5">
                  {CAT_ICONS.map(ico => (
                    <button key={ico} type="button" onClick={() => setCatIcon(ico)}
                      title={ico}
                      className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all ${
                        catIcon === ico
                          ? 'ring-2 ring-offset-1 ring-indigo-400 bg-indigo-50'
                          : 'hover:bg-slate-100'
                      }`}>
                      <CategoryIcon name={ico} size={14} color={catIcon === ico ? catColor : '#94a3b8'} />
                    </button>
                  ))}
                </div>
              </div>

              {/* Color picker */}
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Цвет</label>
                <div className="flex gap-2 flex-wrap">
                  {CAT_COLORS.map(c => (
                    <button key={c} type="button" onClick={() => setCatColor(c)}
                      className={`w-7 h-7 rounded-full transition-all ${catColor === c ? 'ring-2 ring-offset-2 ring-slate-400 scale-110' : 'hover:scale-105'}`}
                      style={{ background: c }} />
                  ))}
                </div>
              </div>

              {/* Preview */}
              <div className="flex items-center gap-3 bg-slate-50 rounded-xl px-4 py-3">
                <div className="w-9 h-9 icon-circle flex items-center justify-center shrink-0"
                  style={{ background: catColor + '22' }}>
                  <CategoryIcon name={catIcon} size={16} color={catColor} />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-700">{catName || 'Название статьи'}</p>
                  <p className="text-xs text-slate-400">
                    {catType === 'income' ? 'Доход' : catType === 'expense' ? 'Расход' : 'Перевод'}
                  </p>
                </div>
              </div>

              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setCatModal(false)}
                  className="flex-1 py-2.5 border border-slate-200 text-sm text-slate-600 font-medium rounded-lg hover:bg-slate-50 transition">
                  Отмена
                </button>
                <button type="button" onClick={saveCat}
                  className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition">
                  {editingCat ? 'Сохранить' : 'Добавить'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Category delete confirm ─────────────────────────────────────────── */}
      {deleteCatId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 text-center">
            {deleteCatInUse ? (
              <>
                <div className="w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-3">
                  <AlertCircle size={22} className="text-amber-500" />
                </div>
                <h3 className="text-base font-semibold text-slate-800 mb-1">Статья используется</h3>
                <p className="text-sm text-slate-500 mb-5">
                  Эта статья привязана к {store.transactions.filter(t => t.categoryId === deleteCatId).length} операциям.
                  Сначала измените категорию в этих операциях.
                </p>
                <button onClick={() => setDeleteCatId(null)}
                  className="w-full py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium rounded-lg transition">
                  Понятно
                </button>
              </>
            ) : (
              <>
                <div className="text-3xl mb-3">🗑️</div>
                <h3 className="text-base font-semibold text-slate-800 mb-1">Удалить статью?</h3>
                <p className="text-sm text-slate-500 mb-5">
                  «{store.categories.find(c => c.id === deleteCatId)?.name}» будет удалена безвозвратно.
                </p>
                <div className="flex gap-3">
                  <button onClick={() => setDeleteCatId(null)}
                    className="flex-1 py-2.5 border border-slate-200 text-sm text-slate-600 font-medium rounded-lg hover:bg-slate-50 transition">
                    Отмена
                  </button>
                  <button onClick={confirmDeleteCat}
                    className="flex-1 py-2.5 bg-red-500 hover:bg-red-600 text-white text-sm font-medium rounded-lg transition">
                    Удалить
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

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
