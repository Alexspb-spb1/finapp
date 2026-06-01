import { useState } from 'react'
import { CheckCircle2, Clock, AlertCircle } from 'lucide-react'
import { formatCurrency } from '../utils/format'
import { useStore } from '../store/useStore'

interface CalendarItem {
  id: string
  date: string
  type: 'income' | 'expense'
  amount: number
  description: string
  categoryId: string
  status: 'planned' | 'paid' | 'overdue'
}

const calendarItems: CalendarItem[] = [
  { id: 'c1', date: '2026-05-20', type: 'expense', amount: 80000, description: 'Аренда офиса', categoryId: 'cat_exp2', status: 'planned' },
  { id: 'c2', date: '2026-05-22', type: 'income', amount: 250000, description: 'Оплата ООО Ромашка', categoryId: 'cat_inc1', status: 'planned' },
  { id: 'c3', date: '2026-05-25', type: 'expense', amount: 90000, description: 'Зарплата (аванс)', categoryId: 'cat_exp1', status: 'planned' },
  { id: 'c4', date: '2026-05-28', type: 'expense', amount: 35000, description: 'Яндекс.Директ', categoryId: 'cat_exp3', status: 'planned' },
  { id: 'c5', date: '2026-05-30', type: 'income', amount: 180000, description: 'ИП Петров — финал', categoryId: 'cat_inc1', status: 'planned' },
  { id: 'c6', date: '2026-05-15', type: 'expense', amount: 52000, description: 'УСН авансовый', categoryId: 'cat_exp5', status: 'paid' },
  { id: 'c7', date: '2026-05-10', type: 'expense', amount: 12000, description: 'Связь и интернет', categoryId: 'cat_exp6', status: 'paid' },
  { id: 'c8', date: '2026-05-05', type: 'income', amount: 95000, description: 'Оплата ИП Сидорова', categoryId: 'cat_inc1', status: 'paid' },
  { id: 'c9', date: '2026-05-01', type: 'expense', amount: 45000, description: 'Страховые взносы', categoryId: 'cat_exp5', status: 'overdue' },
]

const statusConfig = {
  planned: { label: 'Запланировано', icon: Clock, color: 'text-amber-600 bg-amber-50' },
  paid: { label: 'Оплачено', icon: CheckCircle2, color: 'text-emerald-600 bg-emerald-50' },
  overdue: { label: 'Просрочено', icon: AlertCircle, color: 'text-red-600 bg-red-50' },
}

export default function Calendar() {
  const { categories } = useStore()
  const [filter, setFilter] = useState<'all' | 'income' | 'expense'>('all')

  const filtered = calendarItems.filter(i => filter === 'all' || i.type === filter)
  const sorted = [...filtered].sort((a, b) => a.date.localeCompare(b.date))

  const planned = calendarItems.filter(i => i.status === 'planned')
  const plannedIncome = planned.filter(i => i.type === 'income').reduce((s, i) => s + i.amount, 0)
  const plannedExpense = planned.filter(i => i.type === 'expense').reduce((s, i) => s + i.amount, 0)

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
          <p className="text-xs text-slate-500">Ожидаемые поступления</p>
          <p className="text-xl font-bold text-emerald-600 mt-1">{formatCurrency(plannedIncome)}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
          <p className="text-xs text-slate-500">Плановые списания</p>
          <p className="text-xl font-bold text-red-500 mt-1">{formatCurrency(plannedExpense)}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
          <p className="text-xs text-slate-500">Прогноз баланса</p>
          <p className={`text-xl font-bold mt-1 ${plannedIncome - plannedExpense >= 0 ? 'text-indigo-600' : 'text-red-600'}`}>
            {plannedIncome - plannedExpense >= 0 ? '+' : ''}{formatCurrency(plannedIncome - plannedExpense)}
          </p>
        </div>
      </div>

      {/* List */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-700">Платёжный календарь — Май 2026</h3>
          <div className="flex gap-1 bg-slate-100 rounded-lg p-1">
            {(['all', 'income', 'expense'] as const).map(v => (
              <button
                key={v}
                onClick={() => setFilter(v)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                  filter === v ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {v === 'all' ? 'Все' : v === 'income' ? 'Доходы' : 'Расходы'}
              </button>
            ))}
          </div>
        </div>

        <ul className="divide-y divide-slate-50">
          {sorted.map(item => {
            const cat = categories.find(c => c.id === item.categoryId)
            const sc = statusConfig[item.status]
            const StatusIcon = sc.icon
            const date = new Date(item.date)
            const isToday = item.date === new Date().toISOString().slice(0, 10)
            return (
              <li key={item.id} className={`flex items-center gap-4 px-5 py-4 hover:bg-slate-50 transition-colors ${isToday ? 'bg-indigo-50/30' : ''}`}>
                {/* Date block */}
                <div className={`w-12 h-12 rounded-xl flex flex-col items-center justify-center shrink-0 ${isToday ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'}`}>
                  <span className="text-lg font-bold leading-none">{date.getDate()}</span>
                  <span className="text-xs">{date.toLocaleString('ru', { month: 'short' })}</span>
                </div>

                {/* Category icon */}
                <div className="w-9 h-9 rounded-xl flex items-center justify-center text-base shrink-0" style={{ background: (cat?.color ?? '#94a3b8') + '22' }}>
                  {cat?.icon ?? '💸'}
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-700">{item.description}</p>
                  <p className="text-xs text-slate-400">{cat?.name}</p>
                </div>

                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${sc.color}`}>
                  <StatusIcon size={12} />
                  {sc.label}
                </span>

                <span className={`text-sm font-bold whitespace-nowrap ${item.type === 'income' ? 'text-emerald-600' : 'text-red-500'}`}>
                  {item.type === 'income' ? '+' : '−'}{formatCurrency(item.amount)}
                </span>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
