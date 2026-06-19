import { NavLink, useNavigate } from 'react-router-dom'
import { useState, useRef, useEffect } from 'react'
import {
  LayoutDashboard,
  ArrowLeftRight,
  TrendingUp,
  Calendar,
  PieChart,
  Target,
  Scale,
  Users,
  CreditCard,
  FolderKanban,
  Settings,
  LogOut,
  UserCog,
  X,
  GitCompare,
  ChevronDown,
  Check,
  Plus,
  Upload,
  Building2,
  Sparkles,
} from 'lucide-react'
import { authStore } from '../../store/authStore'
import { useAuth } from '../../hooks/useAuth'

const nav = [
  { to: '/',                  icon: LayoutDashboard, label: 'Дашборд',           adminOnly: false },
  { to: '/transactions',      icon: ArrowLeftRight,  label: 'Операции',          adminOnly: false },
  { to: '/reports/cashflow',  icon: TrendingUp,      label: 'ДДС',               adminOnly: false },
  { to: '/reports/pnl',       icon: PieChart,        label: 'P&L',               adminOnly: false },
  { to: '/reports/budget',    icon: Target,          label: 'Бюджет',            adminOnly: false },
  { to: '/reports/balance',   icon: Scale,           label: 'Баланс',            adminOnly: false },
  { to: '/reports/forecast',  icon: Sparkles,        label: 'Прогнозы',          adminOnly: false },
  { to: '/calendar',          icon: Calendar,        label: 'Платёж. календарь', adminOnly: false },
  { to: '/accounts',          icon: CreditCard,      label: 'Счета',             adminOnly: false },
  { to: '/counterparties',    icon: Users,           label: 'Контрагенты',       adminOnly: false },
  { to: '/projects',          icon: FolderKanban,    label: 'Проекты',           adminOnly: false },
  { to: '/reconciliation',    icon: GitCompare,      label: 'Сверка остатков',   adminOnly: false },
  { to: '/import',            icon: Upload,          label: 'Импорт',            adminOnly: false },
  { to: '/users',             icon: UserCog,         label: 'Пользователи',      adminOnly: true  },
  { to: '/settings',          icon: Settings,        label: 'Настройки',         adminOnly: false },
]

interface Props {
  open: boolean
  onClose: () => void
}

// ── Company switcher ──────────────────────────────────────────────────────────
function CompanySwitcher({ currentCompany }: { currentCompany: { id: string; name: string } | null }) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<'ooo' | 'ip'>('ip')
  const [saving, setSaving] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const companies = authStore.getAllCompanies()
  const activeId  = authStore.getActiveCompanyId()

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  async function handleSwitch(id: string) {
    if (id === activeId) { setOpen(false); return }
    await authStore.switchCompany(id)
    setOpen(false)
    window.location.reload() // reload to reinitialize companyStore cleanly
  }

  async function handleCreate() {
    if (!newName.trim()) return
    setSaving(true)
    await authStore.createCompany({ name: newName.trim(), legalType: newType })
    setSaving(false)
    setCreating(false)
    setNewName('')
    setOpen(false)
    window.location.reload()
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/8 transition-colors text-left"
      >
        <Building2 size={13} className="text-indigo-400 shrink-0" />
        <span className="flex-1 text-xs font-medium text-white/75 truncate">
          {currentCompany?.name ?? 'Компания'}
        </span>
        <ChevronDown size={12} className={`text-white/30 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 right-0 mb-1 bg-[#1a2d5a] border border-white/10 rounded-xl shadow-xl overflow-hidden z-50">
          {/* Company list */}
          <div className="max-h-48 overflow-y-auto py-1">
            {companies.length === 0 && (
              <p className="px-3 py-2 text-xs text-white/40">Нет компаний</p>
            )}
            {companies.map(c => (
              <button
                key={c.id}
                onClick={() => handleSwitch(c.id)}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-white/8 transition-colors text-left"
              >
                <div className="w-6 h-6 rounded bg-indigo-500/20 flex items-center justify-center shrink-0">
                  <span className="text-[10px] font-bold text-indigo-300">
                    {c.name.slice(0, 2).toUpperCase()}
                  </span>
                </div>
                <span className="flex-1 text-white/80 truncate text-xs">{c.name}</span>
                {c.id === activeId && <Check size={12} className="text-indigo-400 shrink-0" />}
              </button>
            ))}
          </div>

          {/* Create new company */}
          {creating ? (
            <div className="border-t border-white/10 p-3 space-y-2">
              <input
                autoFocus
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
                placeholder="Название компании"
                className="w-full bg-white/10 text-white text-xs rounded px-2 py-1.5 outline-none placeholder:text-white/30 border border-white/15 focus:border-indigo-400"
              />
              <div className="flex gap-1">
                <select
                  value={newType}
                  onChange={e => setNewType(e.target.value as 'ooo' | 'ip')}
                  className="flex-1 bg-white/10 text-white text-xs rounded px-2 py-1.5 outline-none border border-white/15"
                >
                  <option value="ip">ИП</option>
                  <option value="ooo">ООО</option>
                </select>
                <button
                  onClick={handleCreate}
                  disabled={saving || !newName.trim()}
                  className="px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 text-white text-xs rounded transition-colors"
                >
                  {saving ? '…' : 'Создать'}
                </button>
                <button
                  onClick={() => { setCreating(false); setNewName('') }}
                  className="px-2 py-1.5 text-white/40 hover:text-white text-xs transition-colors"
                >
                  ✕
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-indigo-300 hover:bg-white/8 border-t border-white/10 transition-colors"
            >
              <Plus size={12} />
              Создать компанию
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
export default function Sidebar({ open, onClose }: Props) {
  const { user, company } = useAuth()
  const navigate = useNavigate()

  function handleLogout() {
    authStore.logout()
    navigate('/login', { replace: true })
  }

  const visibleNav = nav.filter(item => !item.adminOnly || user?.role === 'admin')

  return (
    <>
      {/* Mobile backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed md:static inset-y-0 left-0 z-50 w-60 flex flex-col md:h-full h-screen shrink-0
          transition-transform duration-200 ease-in-out
          ${open ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
        `}
        style={{ background: '#0f1c3f' }}
      >
        {/* Mobile close — логотип теперь в верхней шапке */}
        <div className="md:hidden flex justify-end px-3 pt-3">
          <button
            onClick={onClose}
            className="p-1.5 text-white/40 hover:text-white transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-2 py-3 overflow-y-auto">
          <ul className="space-y-px">
            {visibleNav.map(({ to, icon: Icon, label }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  end={to === '/'}
                  className={({ isActive }) =>
                    `relative flex items-center gap-3 px-3 py-2.5 text-sm font-medium transition-colors group ${
                      isActive
                        ? 'bg-white/10 text-white'
                        : 'text-white/55 hover:bg-white/5 hover:text-white/85'
                    }`
                  }
                >
                  {({ isActive }) => (
                    <>
                      {isActive && (
                        <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-indigo-400" />
                      )}
                      <Icon
                        size={16}
                        className={isActive ? 'text-indigo-400' : 'text-white/35 group-hover:text-white/60 transition-colors'}
                      />
                      <span className="flex-1 truncate">{label}</span>
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        {/* User / Company */}
        <div className="px-3 py-3 border-t border-white/10 space-y-2" style={{ background: 'rgba(0,0,0,0.2)' }}>
          {/* Company switcher */}
          <CompanySwitcher currentCompany={company} />

          {/* User row */}
          <div className="flex items-center gap-3 px-1">
            <div className="w-8 h-8 rounded-full bg-indigo-500/25 flex items-center justify-center text-indigo-300 text-xs font-bold shrink-0">
              {user?.name.slice(0, 2).toUpperCase() ?? 'ФУ'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white/90 truncate">{user?.name ?? '—'}</p>
              <p className="text-xs text-white/35 truncate">{user?.email ?? ''}</p>
            </div>
            <button
              onClick={handleLogout}
              title="Выйти"
              className="p-1.5 text-white/25 hover:text-red-400 transition-colors shrink-0"
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </aside>
    </>
  )
}
