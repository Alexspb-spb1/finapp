import { NavLink, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  ArrowLeftRight,
  TrendingUp,
  Calendar,
  PieChart,
  Users,
  CreditCard,
  FolderKanban,
  Settings,
  ChevronRight,
  LogOut,
} from 'lucide-react'
import { authStore } from '../../store/authStore'
import { useAuth } from '../../hooks/useAuth'

const nav = [
  { to: '/', icon: LayoutDashboard, label: 'Дашборд' },
  { to: '/transactions', icon: ArrowLeftRight, label: 'Операции' },
  { to: '/reports/cashflow', icon: TrendingUp, label: 'ДДС' },
  { to: '/reports/pnl', icon: PieChart, label: 'P&L' },
  { to: '/calendar', icon: Calendar, label: 'Платёж. календарь' },
  { to: '/accounts', icon: CreditCard, label: 'Счета' },
  { to: '/counterparties', icon: Users, label: 'Контрагенты' },
  { to: '/projects', icon: FolderKanban, label: 'Проекты' },
  { to: '/settings', icon: Settings, label: 'Настройки' },
]

export default function Sidebar() {
  const { user, company } = useAuth()
  const navigate = useNavigate()

  function handleLogout() {
    authStore.logout()
    navigate('/login', { replace: true })
  }

  return (
    <aside className="w-60 bg-white border-r border-slate-200 flex flex-col h-screen sticky top-0 shrink-0">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center">
            <TrendingUp size={16} className="text-white" />
          </div>
          <span className="font-bold text-slate-800 text-lg tracking-tight">ФинУчёт</span>
        </div>
        <p className="text-xs text-slate-400 mt-1 ml-10">управленческий учёт</p>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 overflow-y-auto">
        <ul className="space-y-0.5">
          {nav.map(({ to, icon: Icon, label }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={to === '/'}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all group ${
                    isActive
                      ? 'bg-indigo-50 text-indigo-700'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon size={18} className={isActive ? 'text-indigo-600' : 'text-slate-400 group-hover:text-slate-600'} />
                    <span className="flex-1">{label}</span>
                    {isActive && <ChevronRight size={14} className="text-indigo-400" />}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      {/* User / Company */}
      <div className="px-4 py-4 border-t border-slate-100">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
            {user?.name.slice(0, 2).toUpperCase() ?? 'ФУ'}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-700 truncate">{user?.name ?? '—'}</p>
            <p className="text-xs text-slate-400 truncate">{company?.name ?? ''}</p>
          </div>
          <button
            onClick={handleLogout}
            title="Выйти"
            className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors shrink-0"
          >
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </aside>
  )
}
