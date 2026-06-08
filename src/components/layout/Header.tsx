import { Bell, Plus, Search } from 'lucide-react'
import { useState } from 'react'
import TransactionModal from '../transactions/TransactionModal'

interface Props {
  title: string
}

export default function Header({ title }: Props) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <header className="h-14 bg-white border-b border-slate-200 flex items-center px-6 gap-4 sticky top-0 z-10">
        <h1 className="text-base font-semibold text-slate-800 flex-1 tracking-tight">{title}</h1>

        {/* Search */}
        <div className="hidden md:flex items-center gap-2 bg-slate-50 border border-slate-200 px-3 py-1.5 w-56">
          <Search size={14} className="text-slate-400 shrink-0" />
          <input
            placeholder="Поиск..."
            className="bg-transparent text-sm outline-none w-full text-slate-600 placeholder:text-slate-400"
          />
        </div>

        <button className="relative p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition-colors">
          <Bell size={18} />
          <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full" />
        </button>

        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-4 py-2 transition-colors"
        >
          <Plus size={16} />
          Добавить
        </button>
      </header>

      <TransactionModal open={open} onClose={() => setOpen(false)} />
    </>
  )
}
