import { Bell, Plus, Search, Menu, Wallet, TrendingUp } from 'lucide-react'
import { useState } from 'react'
import TransactionModal from '../transactions/TransactionModal'
import { useStore } from '../../store/useStore'
import { sumAccountsBase } from '../../utils/currency'

interface Props {
  title: string
  onMenuClick: () => void
}

function fmt(n: number, currency: string) {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency', currency, maximumFractionDigits: 0,
  }).format(n)
}

export default function Header({ title, onMenuClick }: Props) {
  const [open, setOpen] = useState(false)
  const store = useStore()

  const totalBalance = sumAccountsBase(store.accounts)

  return (
    <>
      <header className="h-14 bg-white border-b border-slate-200 flex items-center px-3 sm:px-6 gap-3 sticky top-0 z-10">

        {/* Hamburger — mobile only */}
        <button
          onClick={onMenuClick}
          className="md:hidden p-2 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors shrink-0"
        >
          <Menu size={20} />
        </button>

        {/* Brand logo */}
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="w-8 h-8 bg-indigo-600 flex items-center justify-center shrink-0">
            <TrendingUp size={16} className="text-white" />
          </div>
          <span className="font-bold text-slate-800 text-lg tracking-tight hidden sm:inline">ФинУчёт</span>
        </div>

        {/* Page title */}
        <div className="hidden md:block h-5 w-px bg-slate-200 shrink-0" />
        <h1 className="text-base font-semibold text-slate-700 flex-1 tracking-tight truncate">{title}</h1>

        {/* Search — desktop only */}
        <div className="hidden md:flex items-center gap-2 bg-slate-50 border border-slate-200 px-3 py-1.5 w-56">
          <Search size={14} className="text-slate-400 shrink-0" />
          <input
            placeholder="Поиск..."
            className="bg-transparent text-sm outline-none w-full text-slate-600 placeholder:text-slate-400"
          />
        </div>

        {/* Общая сумма по всем счетам */}
        {store.accounts.length > 0 && (
          <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 px-3 py-1.5 shrink-0">
            <Wallet size={14} className="text-slate-400 shrink-0" />
            <span className="text-sm font-semibold text-slate-700 whitespace-nowrap">
              {fmt(totalBalance, 'RUB')}
            </span>
          </div>
        )}

        <button className="relative p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition-colors">
          <Bell size={18} />
          <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full" />
        </button>

        {/* Add button: icon only on mobile, full on desktop */}
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-3 sm:px-4 py-2 transition-colors"
        >
          <Plus size={16} />
          <span className="hidden sm:inline">Добавить</span>
        </button>
      </header>

      <TransactionModal open={open} onClose={() => setOpen(false)} />
    </>
  )
}
