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
  LogOut,
  UserCog,
} from 'lucide-react'
import { authStore } from '../../store/authStore'
import { useAuth } from '../../hooks/useAuth'

const nav = [
  { to: '/',                  icon: LayoutDashboard, label: 'Дашборд',          adminOnly: false },
  { to: '/transactions',      icon: ArrowLeftRight,  label: 'Операции',         adminOnly: false },
  { to: '/reports/cashflow',  icon: TrendingUp,      label: 'ДДС',              adminOnly: false },
  { to: '/reports/pnl',       icon: PieChart,        label: 'P&L',              adminOnly: false },
  { to: '/calendar',          icon: Calendar,        label: 'Платёж. календарь',adminOnly: false },
  { to: '/accounts',          icon: CreditCard,      label: 'Счета',            adminOnly: false },
  { to: '/counterparties',    icon: Users,           label: 'Контрагенты',      adminOnly: false },
  { to: '/projects',          icon: FolderKanban,    label: 'Проекты',          adminOnly: false },
  { to: '/users',             icon: UserCog,         label: 'Пользователи',     adminOnly: true  },
  { to: '/settings',          icon: Settings,        label: 'Настройки',        adminOnly: false },
]

export default function Sidebar() {
  const { user, company } = useAuth()
  const navigate = useNavigate()

  function handleLogout() {
    authStore.logout()
    navigate('/login', { replace: true })
  }

  return (
    <aside className="w-60 flex flex-col h-screen sticky top-0 shrink-0" style={{ background: '#0f1c3f' }}>

      {/* Logo */}
      <div className="px-5 py-5 border-b border-white/10">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-indigo-500 flex items-center justify-center shrink-0">
            <TrendingUp size={16} className="text-white" />
          </div>
          <span className="font-bold text-white text-lg tracking-tight">ФинУчёт</span>
        </div>
        <p className="text-[11px] text-white/35 mt-1.5 ml-10 uppercase tracking-widest">управленческий учёт</p>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 overflow-y-auto">
        <ul className="space-y-px">
          {nav.filter(item => !item.adminOnly || user?.role === 'admin').map(({ to, icon: Icon, label }) => (
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
      <div className="px-4 py-4 border-t border-white/10" style={{ background: 'rgba(0,0,0,0.2)' }}>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-indigo-500/25 flex items-center justify-center text-indigo-300 text-xs font-bold shrink-0">
            {user?.name.slice(0, 2).toUpperCase() ?? 'ФУ'}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white/90 truncate">{user?.name ?? '—'}</p>
            <p className="text-xs text-white/35 truncate">{company?.name ?? ''}</p>
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
  )
}
