import { useState, useRef, useEffect } from 'react'
import { ChevronLeft, ChevronRight, Target, TrendingUp, TrendingDown } from 'lucide-react'
import { useStore } from '../store/useStore'
import { formatCurrency, monthKey } from '../utils/format'
import { toBase } from '../utils/currency'
import CategoryIcon from '../utils/categoryIcons'

const MONTH_NAMES = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь']

function pad(n: number) { return String(n).padStart(2, '0') }

// Inline editable planned amount cell
function PlanCell({ value, onSave }: { value: number; onSave: (v: number) => void }) {
  const [editing, setEditing] = useState(false)
  const [raw, setRaw] = useState(String(value || ''))
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (editing) inputRef.current?.select() }, [editing])

  function commit() {
    const n = parseFloat(raw.replace(/\s/g, '').replace(',', '.'))
    if (!isNaN(n) && n >= 0) onSave(n)
    else setRaw(String(value || ''))
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={raw}
        onChange={e => setRaw(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setRaw(String(value || '')); setEditing(false) } }}
        className="w-28 border border-indigo-400 rounded px-2 py-1 text-sm font-semibold text-right outline-none focus:ring-2 focus:ring-indigo-300 bg-white"
      />
    )
  }

  return (
    <button
      onClick={() => { setRaw(String(value || '')); setEditing(true) }}
      className={`w-28 text-sm font-semibold text-right px-2 py-1 rounded hover:bg-indigo-50 transition-colors group ${value ? 'text-slate-700' : 'text-slate-300'}`}
    >
      {value ? formatCurrency(value) : <span className="text-slate-300 group-hover:text-indigo-400">+ план</span>}
    </button>
  )
}

// Progress bar
function ProgressBar({ actual, planned }: { actual: number; planned: number }) {
  if (!planned) return <div className="w-32 h-1.5 bg-slate-100 rounded-full" />
  const pct = Math.min((actual / planned) * 100, 100)
  const over = actual > planned
  return (
    <div className="w-32 h-1.5 bg-slate-100 rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-all ${over ? 'bg-red-500' : pct > 80 ? 'bg-amber-400' : 'bg-emerald-500'}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

export default function Budget() {
  const store = useStore()
  const { transactions, categories, budgets } = store

  // Current month as default
  const now = new Date()
  const [year,  setYear]  = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth()) // 0-based

  const monthStr = `${year}-${pad(month + 1)}` // YYYY-MM

  function prevMonth() {
    if (month === 0) { setYear(y => y - 1); setMonth(11) }
    else setMonth(m => m - 1)
  }
  function nextMonth() {
    if (month === 11) { setYear(y => y + 1); setMonth(0) }
    else setMonth(m => m + 1)
  }

  // Actual amounts from transactions for this month
  function actual(catId: string) {
    return transactions
      .filter(t => t.categoryId === catId && monthKey(t.date) === monthStr)
      .reduce((s, t) => s + toBase(t), 0)
  }

  function plannedFor(catId: string) {
    return budgets.find(b => b.categoryId === catId && b.month === monthStr)?.planned ?? 0
  }

  const incCats = categories.filter(c => !c.isGroup && c.type === 'income')
  const expCats = categories.filter(c => !c.isGroup && c.type === 'expense')

  // Totals
  const totalIncPlan   = incCats.reduce((s, c) => s + plannedFor(c.id), 0)
  const totalIncActual = incCats.reduce((s, c) => s + actual(c.id), 0)
  const totalExpPlan   = expCats.reduce((s, c) => s + plannedFor(c.id), 0)
  const totalExpActual = expCats.reduce((s, c) => s + actual(c.id), 0)
  const planProfit     = totalIncPlan - totalExpPlan
  const actualProfit   = totalIncActual - totalExpActual

  function CatSection({ cats, type }: { cats: typeof incCats; type: 'income' | 'expense' }) {
    const color = type === 'income' ? 'text-emerald-700' : 'text-red-600'
    const accentBg = type === 'income' ? 'bg-emerald-50/60' : 'bg-red-50/40'

    return (
      <>
        <tr className={`border-b border-slate-100 ${accentBg}`}>
          <td colSpan={5} className={`px-5 py-2 text-xs font-bold uppercase tracking-wider ${color}`}>
            {type === 'income' ? 'Доходы' : 'Расходы'}
          </td>
        </tr>
        {cats.map(cat => {
          const act = actual(cat.id)
          const plan = plannedFor(cat.id)
          const delta = act - plan
          const hasActivity = act > 0 || plan > 0
          if (!hasActivity) return null

          return (
            <tr key={cat.id} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
              <td className="px-5 py-3">
                <span className="flex items-center gap-2">
                  <div className="w-7 h-7 flex items-center justify-center shrink-0 rounded-lg"
                    style={{ background: cat.color + '22' }}>
                    <CategoryIcon name={cat.icon} size={13} color={cat.color} />
                  </div>
                  <span className="text-sm text-slate-700">{cat.name}</span>
                </span>
              </td>
              <td className="px-4 py-3 text-right">
                <PlanCell
                  value={plan}
                  onSave={v => v > 0
                    ? store.upsertBudget(cat.id, monthStr, v)
                    : store.deleteBudget(cat.id, monthStr)
                  }
                />
              </td>
              <td className={`px-4 py-3 text-sm font-semibold text-right ${type === 'income' ? 'text-emerald-600' : 'text-red-500'}`}>
                {act > 0 ? formatCurrency(act) : <span className="text-slate-300">—</span>}
              </td>
              <td className="px-4 py-3 text-right">
                {plan > 0 ? (
                  <span className={`text-sm font-medium ${
                    type === 'expense'
                      ? delta > 0 ? 'text-red-500' : 'text-emerald-600'
                      : delta >= 0 ? 'text-emerald-600' : 'text-red-500'
                  }`}>
                    {delta > 0 ? '+' : ''}{formatCurrency(delta)}
                  </span>
                ) : <span className="text-slate-300 text-sm">—</span>}
              </td>
              <td className="px-5 py-3">
                <div className="flex items-center gap-2">
                  <ProgressBar actual={act} planned={plan} />
                  {plan > 0 && (
                    <span className="text-xs text-slate-400 w-8 text-right">
                      {Math.round((act / plan) * 100)}%
                    </span>
                  )}
                </div>
              </td>
            </tr>
          )
        })}
        {/* Row for categories without activity — allow setting plan */}
        {cats.filter(cat => actual(cat.id) === 0 && plannedFor(cat.id) === 0).map(cat => (
          <tr key={cat.id} className="border-b border-slate-50 hover:bg-slate-50 transition-colors opacity-50 hover:opacity-100">
            <td className="px-5 py-2.5">
              <span className="flex items-center gap-2">
                <div className="w-6 h-6 flex items-center justify-center shrink-0 rounded"
                  style={{ background: cat.color + '11' }}>
                  <CategoryIcon name={cat.icon} size={12} color={cat.color} />
                </div>
                <span className="text-sm text-slate-400">{cat.name}</span>
              </span>
            </td>
            <td className="px-4 py-2.5 text-right">
              <PlanCell
                value={0}
                onSave={v => v > 0 && store.upsertBudget(cat.id, monthStr, v)}
              />
            </td>
            <td className="px-4 py-2.5 text-right"><span className="text-slate-200 text-sm">—</span></td>
            <td className="px-4 py-2.5 text-right"><span className="text-slate-200 text-sm">—</span></td>
            <td className="px-5 py-2.5">
              <div className="w-32 h-1.5 bg-slate-100 rounded-full" />
            </td>
          </tr>
        ))}
      </>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-800">Бюджет</h2>
          <p className="text-xs text-slate-400 mt-0.5">план vs факт по статьям</p>
        </div>

        {/* Month navigator */}
        <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-xl px-1 py-1 shadow-sm">
          <button onClick={prevMonth} className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 transition-colors">
            <ChevronLeft size={15} />
          </button>
          <span className="text-sm font-semibold text-slate-700 px-3 min-w-36 text-center">
            {MONTH_NAMES[month]} {year}
          </span>
          <button onClick={nextMonth} className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 transition-colors">
            <ChevronRight size={15} />
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Доходы',   plan: totalIncPlan,  actual: totalIncActual,  icon: TrendingUp,   color: 'text-emerald-600', ring: 'ring-emerald-200' },
          { label: 'Расходы',  plan: totalExpPlan,  actual: totalExpActual,  icon: TrendingDown, color: 'text-red-500',     ring: 'ring-red-200'     },
          { label: 'Прибыль',  plan: planProfit,    actual: actualProfit,    icon: Target,       color: actualProfit >= 0 ? 'text-indigo-600' : 'text-red-500', ring: 'ring-indigo-200' },
        ].map(({ label, plan, actual: act, icon: Icon, color, ring }) => (
          <div key={label} className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <div className={`w-7 h-7 rounded-lg flex items-center justify-center ring-1 ${ring}`}>
                <Icon size={14} className={color} />
              </div>
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{label}</span>
            </div>
            <div className="space-y-1">
              <div className="flex justify-between items-baseline">
                <span className="text-xs text-slate-400">Факт</span>
                <span className={`text-base font-bold ${color}`}>{formatCurrency(act)}</span>
              </div>
              <div className="flex justify-between items-baseline">
                <span className="text-xs text-slate-400">План</span>
                <span className="text-sm font-medium text-slate-500">{plan ? formatCurrency(plan) : '—'}</span>
              </div>
              {plan > 0 && (
                <div className="pt-1">
                  <ProgressBar actual={act} planned={plan} />
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-5 py-3 w-56">Статья</th>
                <th className="text-right text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3 w-36">
                  <span className="flex items-center justify-end gap-1">
                    <Target size={11} /> План
                  </span>
                </th>
                <th className="text-right text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3 w-32">Факт</th>
                <th className="text-right text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3 w-32">Отклонение</th>
                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-5 py-3">Выполнение</th>
              </tr>
            </thead>
            <tbody>
              <CatSection cats={incCats} type="income" />
              <CatSection cats={expCats} type="expense" />

              {/* Profit summary */}
              <tr className="bg-indigo-50 border-t-2 border-indigo-200">
                <td className="px-5 py-3 text-sm font-bold text-indigo-800">Прибыль</td>
                <td className="px-4 py-3 text-sm font-bold text-right text-slate-600">
                  {planProfit !== 0 ? formatCurrency(planProfit) : '—'}
                </td>
                <td className={`px-4 py-3 text-sm font-bold text-right ${actualProfit >= 0 ? 'text-indigo-700' : 'text-red-600'}`}>
                  {formatCurrency(actualProfit)}
                </td>
                <td className={`px-4 py-3 text-sm font-bold text-right ${actualProfit - planProfit >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                  {planProfit !== 0
                    ? (actualProfit - planProfit > 0 ? '+' : '') + formatCurrency(actualProfit - planProfit)
                    : '—'}
                </td>
                <td className="px-5 py-3">
                  <ProgressBar actual={actualProfit} planned={planProfit} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="px-5 py-3 border-t border-slate-100 text-xs text-slate-400">
          Нажмите на ячейку «+ план» чтобы задать плановую сумму · Enter для сохранения · Esc для отмены
        </div>
      </div>
    </div>
  )
}
