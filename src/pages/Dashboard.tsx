import { useState, useCallback } from 'react'
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import {
  TrendingUp, TrendingDown, Wallet, BarChart2, AlertCircle,
  Settings2, GripVertical, X, Clock, Calendar, List,
} from 'lucide-react'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove, SortableContext, useSortable,
  rectSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Link } from 'react-router-dom'
import { useStore } from '../store/useStore'
import { formatCurrency, formatDateShort, monthKey } from '../utils/format'
import { toBase, sumAccountsBase } from '../utils/currency'
import CategoryIcon from '../utils/categoryIcons'
import MatchmakerModal from '../components/transactions/MatchmakerModal'

// ── Widget definitions ────────────────────────────────────────────────────────
interface WidgetDef { id: string; label: string; icon: React.ElementType; wide: boolean }

const METRIC_IDS = ['balance', 'income', 'expense', 'profit']

const SORTABLE_WIDGETS: WidgetDef[] = [
  { id: 'chart_bar',  label: 'График дох/расх',     icon: BarChart2,   wide: true  },
  { id: 'chart_pie',  label: 'Структура расходов',   icon: PieChart,    wide: false },
  { id: 'chart_area', label: 'Динамика прибыли',     icon: TrendingUp,  wide: true  },
  { id: 'recent',     label: 'Последние операции',   icon: Clock,       wide: false },
  { id: 'accounts',   label: 'Счета',                icon: Wallet,      wide: false },
  { id: 'calendar',   label: 'Ближайшие платежи',   icon: Calendar,    wide: false },
  { id: 'top_cats',   label: 'Топ расходных статей', icon: List,        wide: false },
]

// ── localStorage persistence ──────────────────────────────────────────────────
const LS_METRICS = 'finapp_dash_metrics'
const LS_WIDGETS = 'finapp_dash_widgets'
const DEFAULT_METRICS = ['balance', 'income', 'expense', 'profit']
const DEFAULT_WIDGETS = ['chart_bar', 'chart_pie', 'chart_area', 'recent', 'accounts']

function readLS<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback } catch { return fallback }
}
function writeLS(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)) } catch {}
}

// ── SortableWidget wrapper ────────────────────────────────────────────────────
function SortableWidget({ id, wide, configMode, children }: {
  id: string; wide: boolean; configMode: boolean; children: React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        gridColumn: wide ? '1 / -1' : undefined,
        opacity: isDragging ? 0.4 : 1,
        zIndex: isDragging ? 10 : undefined,
      }}
      className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 relative group"
    >
      {configMode && (
        <div {...attributes} {...listeners}
          className="absolute top-2 right-2 p-1 rounded cursor-grab text-slate-300 hover:text-slate-500 transition-colors"
          title="Перетащить">
          <GripVertical size={16} />
        </div>
      )}
      {children}
    </div>
  )
}

// ── Tooltip ───────────────────────────────────────────────────────────────────
function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3 shadow-lg text-sm">
      <p className="font-semibold text-slate-700 mb-1">{label}</p>
      {payload.map((p: any) => (
        <p key={p.name} style={{ color: p.color }} className="flex justify-between gap-6">
          <span>{p.name}:</span>
          <span className="font-medium">{formatCurrency(p.value)}</span>
        </p>
      ))}
    </div>
  )
}

// ── Month labels ──────────────────────────────────────────────────────────────
const ML: Record<string, string> = {
  '01':'Янв','02':'Фев','03':'Мар','04':'Апр','05':'Май','06':'Июн',
  '07':'Июл','08':'Авг','09':'Сен','10':'Окт','11':'Ноя','12':'Дек',
}

// ── Main component ────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [matchmakerOpen, setMatchmakerOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const { transactions, accounts, categories, paymentCalendar } = useStore()

  // Widget visibility state
  const [enabledMetrics, setEnabledMetrics] = useState<string[]>(() => readLS(LS_METRICS, DEFAULT_METRICS))
  const [widgetOrder, setWidgetOrder] = useState<string[]>(() => {
    const saved = readLS<string[]>(LS_WIDGETS, DEFAULT_WIDGETS)
    // Ensure all sortable widget IDs are present (migrations)
    const all = SORTABLE_WIDGETS.map(w => w.id)
    const merged = [...saved.filter(id => all.includes(id))]
    all.forEach(id => { if (!merged.includes(id)) merged.push(id) })
    return merged
  })
  const [disabledWidgets, setDisabledWidgets] = useState<Set<string>>(() => {
    const saved = readLS<string[]>(LS_WIDGETS, DEFAULT_WIDGETS)
    const disabled = new Set<string>()
    SORTABLE_WIDGETS.forEach(w => { if (!saved.includes(w.id)) disabled.add(w.id) })
    return disabled
  })

  function toggleMetric(id: string) {
    setEnabledMetrics(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
      writeLS(LS_METRICS, next)
      return next
    })
  }

  function toggleWidget(id: string) {
    setDisabledWidgets(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      // Persist: enabled = widgetOrder minus disabled
      const enabled = widgetOrder.filter(wid => !next.has(wid))
      writeLS(LS_WIDGETS, enabled)
      return next
    })
  }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setWidgetOrder(prev => {
      const next = arrayMove(prev, prev.indexOf(String(active.id)), prev.indexOf(String(over.id)))
      const enabled = next.filter(id => !disabledWidgets.has(id))
      writeLS(LS_WIDGETS, enabled)
      return next
    })
  }, [disabledWidgets])

  // ── Data calculations ───────────────────────────────────────────────────────
  const totalBalance = sumAccountsBase(accounts)
  const curMonthLabel = new Intl.DateTimeFormat('ru-RU', { month: 'long' })
    .format(new Date()).replace(/^./, c => c.toUpperCase())

  const monthData: Record<string, { income: number; expense: number }> = {}
  transactions.forEach(t => {
    if (t.type === 'transfer') return
    const m = monthKey(t.date)
    if (!monthData[m]) monthData[m] = { income: 0, expense: 0 }
    if (t.type === 'income') monthData[m].income += toBase(t)
    else monthData[m].expense += toBase(t)
  })
  const months = Object.keys(monthData).sort()
  const chartData = months.map(m => ({
    name: ML[m.slice(5)] ?? m.slice(5),
    Доходы: monthData[m].income,
    Расходы: monthData[m].expense,
    Прибыль: monthData[m].income - monthData[m].expense,
  }))

  const curMonth  = monthKey(new Date().toISOString())
  const prevMonth = monthKey(new Date(new Date().setMonth(new Date().getMonth() - 1)).toISOString())
  const cur  = monthData[curMonth]  ?? { income: 0, expense: 0 }
  const prev = monthData[prevMonth] ?? { income: 0, expense: 0 }

  function trendPct(a: number, b: number) {
    if (!b) return a > 0 ? 100 : 0
    return ((a - b) / b) * 100
  }

  function sectionSum(type: 'income' | 'expense', section: string, month: string) {
    const ids = categories.filter(c => !c.isGroup && c.type === type && (c.pnlSection ?? (type === 'income' ? 'direct' : 'indirect')) === section).map(c => c.id)
    return transactions.filter(t => ids.includes(t.categoryId) && monthKey(t.date) === month).reduce((s, t) => s + toBase(t), 0)
  }
  const curGrossProfit  = sectionSum('income', 'direct', curMonth) - sectionSum('expense', 'direct', curMonth)
  const prevGrossProfit = sectionSum('income', 'direct', prevMonth) - sectionSum('expense', 'direct', prevMonth)

  const uncategorizedCount = transactions.filter(t => !t.categoryId && t.type !== 'transfer').length

  const expByCat: Record<string, number> = {}
  transactions.filter(t => t.type === 'expense' && monthKey(t.date) === curMonth).forEach(t => {
    expByCat[t.categoryId] = (expByCat[t.categoryId] ?? 0) + toBase(t)
  })
  const pieData = Object.entries(expByCat).map(([catId, val]) => {
    const cat = categories.find(c => c.id === catId)
    return { name: cat?.name ?? catId, value: val, color: cat?.color ?? '#94a3b8' }
  }).sort((a, b) => b.value - a.value).slice(0, 6)

  const recent = transactions.slice(0, 5)

  const upcomingPayments = [...(paymentCalendar ?? [])]
    .filter(i => i.status !== 'paid')
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 5)

  const topCats = Object.entries(expByCat)
    .map(([catId, val]) => ({ cat: categories.find(c => c.id === catId), val }))
    .filter(x => x.cat)
    .sort((a, b) => b.val - a.val)
    .slice(0, 5)

  // ── Empty state ─────────────────────────────────────────────────────────────
  if (accounts.length === 0 && transactions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-96 text-center">
        <div className="text-6xl mb-5">📊</div>
        <h2 className="text-xl font-bold text-slate-700 mb-2">Добро пожаловать в ФинУчёт!</h2>
        <p className="text-slate-400 max-w-sm mb-8">Начните с добавления счёта — банковского, кассы или карты.</p>
        <Link to="/accounts"
          className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium px-6 py-3 rounded-xl transition-colors">
          🏦 Добавить первый счёт
        </Link>
      </div>
    )
  }

  // ── Widget renderers ────────────────────────────────────────────────────────
  function renderMetricCard(id: string) {
    const t = (a: number, b: number) => trendPct(a, b)
    const configs: Record<string, { label: string; value: number; color: string; trend: number; sub?: string }> = {
      balance: { label: 'Общий баланс', value: totalBalance, color: 'bg-indigo-500', trend: 0,
        sub: `${accounts.length} ${accounts.length < 2 ? 'счёт' : accounts.length < 5 ? 'счёта' : 'счётов'}` },
      income:  { label: `Доходы · ${curMonthLabel}`, value: cur.income, color: 'bg-emerald-500', trend: t(cur.income, prev.income) },
      expense: { label: `Расходы · ${curMonthLabel}`, value: cur.expense, color: 'bg-red-400', trend: -t(cur.expense, prev.expense) },
      profit:  { label: `Валовая прибыль · ${curMonthLabel}`, value: curGrossProfit, color: 'bg-violet-500', trend: t(curGrossProfit, prevGrossProfit) },
    }
    const cfg = configs[id]
    if (!cfg) return null
    const trend = id !== 'balance' ? cfg.trend : undefined
    return (
      <div key={id} className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm">
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{cfg.label}</p>
        <p className="text-2xl font-bold text-slate-800 mt-1">{formatCurrency(cfg.value)}</p>
        {cfg.sub && <p className="text-xs text-slate-400 mt-0.5">{cfg.sub}</p>}
        {trend !== undefined && (
          <div className={`flex items-center gap-1 mt-3 text-xs font-medium ${trend >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
            {trend >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            {trend >= 0 ? '+' : ''}{trend.toFixed(1)}% к прошлому месяцу
          </div>
        )}
      </div>
    )
  }

  function renderWidget(id: string): React.ReactNode {
    switch (id) {
      case 'chart_bar': return (
        <>
          <h3 className="text-sm font-semibold text-slate-700 mb-4">Доходы и расходы по месяцам</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData} barGap={4}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={v => (v / 1000) + 'к'} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="Доходы" fill="#22c55e" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Расходы" fill="#f87171" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </>
      )
      case 'chart_pie': return (
        <>
          <h3 className="text-sm font-semibold text-slate-700 mb-4">{`Расходы · ${curMonthLabel}`}</h3>
          {pieData.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={160}>
                <PieChart>
                  <Pie data={pieData} dataKey="value" cx="50%" cy="50%" innerRadius={45} outerRadius={72} paddingAngle={3}>
                    {pieData.map((e, i) => <Cell key={i} fill={e.color} />)}
                  </Pie>
                  <Tooltip formatter={v => formatCurrency(Number(v))} />
                </PieChart>
              </ResponsiveContainer>
              <ul className="mt-3 space-y-1.5">
                {pieData.map((d, i) => (
                  <li key={i} className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: d.color }} />
                      <span className="text-slate-600 truncate max-w-28">{d.name}</span>
                    </span>
                    <span className="font-medium text-slate-700">{formatCurrency(d.value)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : <p className="text-slate-400 text-sm text-center mt-8">Нет данных</p>}
        </>
      )
      case 'chart_area': return (
        <>
          <h3 className="text-sm font-semibold text-slate-700 mb-4">Динамика прибыли</h3>
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#6366f1" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={v => (v / 1000) + 'к'} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="Прибыль" stroke="#6366f1" strokeWidth={2.5} fill="url(#pg)" dot={{ r: 4, fill: '#6366f1' }} />
            </AreaChart>
          </ResponsiveContainer>
        </>
      )
      case 'recent': return (
        <>
          <h3 className="text-sm font-semibold text-slate-700 mb-4">Последние операции</h3>
          <ul className="space-y-3">
            {recent.map(t => {
              const cat = categories.find(c => c.id === t.categoryId)
              const noCat = !t.categoryId && t.type !== 'transfer'
              return (
                <li key={t.id} className="flex items-center gap-3">
                  <div className="w-9 h-9 icon-circle flex items-center justify-center shrink-0" style={{ background: (cat?.color ?? '#94a3b8') + '22' }}>
                    {noCat ? <AlertCircle size={15} className="text-amber-400" />
                      : <CategoryIcon name={cat?.icon ?? 'DollarSign'} size={15} color={cat?.color ?? '#94a3b8'} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium truncate ${noCat ? 'text-amber-600 italic' : 'text-slate-700'}`}>
                      {cat?.name ?? (noCat ? 'Без статьи' : '—')}
                    </p>
                    <p className="text-xs text-slate-400">{formatDateShort(t.date)}</p>
                  </div>
                  <span className={`text-sm font-semibold ${t.type === 'income' ? 'text-emerald-600' : t.type === 'expense' ? 'text-red-500' : 'text-indigo-500'}`}>
                    {t.type === 'income' ? '+' : t.type === 'expense' ? '−' : '⇄'}{formatCurrency(t.amount)}
                  </span>
                </li>
              )
            })}
          </ul>
        </>
      )
      case 'accounts': return (
        <>
          <h3 className="text-sm font-semibold text-slate-700 mb-4">Счета</h3>
          <ul className="space-y-3">
            {accounts.map(a => (
              <li key={a.id} className="flex items-center gap-3">
                <div className="w-9 h-9 icon-circle flex items-center justify-center shrink-0" style={{ background: a.color + '22' }}>
                  <div className="w-3 h-3 rounded-full" style={{ background: a.color }} />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-slate-700">{a.name}</p>
                  <p className="text-xs text-slate-400">{a.currency}</p>
                </div>
                <span className="text-sm font-bold text-slate-800">{formatCurrency(a.balance)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-4 pt-4 border-t border-slate-100 flex justify-between">
            <span className="text-sm text-slate-500">Итого</span>
            <span className="text-sm font-bold text-slate-800">{formatCurrency(totalBalance)}</span>
          </div>
        </>
      )
      case 'calendar': return (
        <>
          <h3 className="text-sm font-semibold text-slate-700 mb-4">Ближайшие платежи</h3>
          {upcomingPayments.length === 0
            ? <p className="text-slate-400 text-sm text-center mt-4">Нет плановых платежей</p>
            : <ul className="space-y-2.5">
                {upcomingPayments.map(item => {
                  const cat = categories.find(c => c.id === item.categoryId)
                  const overdue = item.date < new Date().toISOString().slice(0, 10)
                  return (
                    <li key={item.id} className="flex items-center gap-3">
                      <div className="w-9 h-9 icon-circle flex items-center justify-center shrink-0" style={{ background: (cat?.color ?? '#94a3b8') + '22' }}>
                        <CategoryIcon name={cat?.icon ?? 'DollarSign'} size={14} color={cat?.color ?? '#94a3b8'} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-700 truncate">{item.description}</p>
                        <p className={`text-xs ${overdue ? 'text-red-500 font-medium' : 'text-slate-400'}`}>
                          {overdue ? 'Просрочено · ' : ''}{new Date(item.date + 'T00:00:00').toLocaleDateString('ru')}
                        </p>
                      </div>
                      <span className={`text-sm font-bold ${item.type === 'income' ? 'text-emerald-600' : 'text-red-500'}`}>
                        {item.type === 'income' ? '+' : '−'}{formatCurrency(item.amount)}
                      </span>
                    </li>
                  )
                })}
              </ul>
          }
          <Link to="/calendar" className="block mt-4 text-xs text-indigo-500 hover:text-indigo-700 text-center transition-colors">
            Открыть календарь →
          </Link>
        </>
      )
      case 'top_cats': return (
        <>
          <h3 className="text-sm font-semibold text-slate-700 mb-4">{`Топ расходов · ${curMonthLabel}`}</h3>
          {topCats.length === 0
            ? <p className="text-slate-400 text-sm text-center mt-4">Нет данных</p>
            : <ul className="space-y-2.5">
                {topCats.map(({ cat, val }) => (
                  <li key={cat!.id} className="flex items-center gap-3">
                    <div className="w-8 h-8 icon-circle flex items-center justify-center shrink-0" style={{ background: (cat!.color) + '22' }}>
                      <CategoryIcon name={cat!.icon} size={13} color={cat!.color} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-slate-700 truncate">{cat!.name}</p>
                      <div className="mt-1 h-1 bg-slate-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${Math.min(100, (val / (topCats[0]?.val || 1)) * 100)}%`, background: cat!.color }} />
                      </div>
                    </div>
                    <span className="text-sm font-medium text-slate-700">{formatCurrency(val)}</span>
                  </li>
                ))}
              </ul>
          }
        </>
      )
      default: return null
    }
  }

  const enabledSortable = widgetOrder.filter(id => !disabledWidgets.has(id))

  return (
    <div className="space-y-4">
      {/* Banner */}
      {uncategorizedCount > 0 && (
        <button onClick={() => setMatchmakerOpen(true)}
          className="w-full flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-xl px-5 py-3.5 text-left hover:bg-amber-100 transition-colors group">
          <AlertCircle size={18} className="text-amber-500 shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-sm font-semibold text-amber-800">
              {uncategorizedCount} {uncategorizedCount === 1 ? 'операция' : uncategorizedCount < 5 ? 'операции' : 'операций'} без статьи
            </span>
            <span className="text-xs text-amber-600 ml-2">— нажмите чтобы назначить</span>
          </div>
          <span className="text-xs font-medium text-amber-700 border border-amber-300 px-2.5 py-1 rounded-lg group-hover:bg-amber-200 transition-colors shrink-0">
            Категоризировать →
          </span>
        </button>
      )}

      {/* Toolbar */}
      <div className="sticky top-0 z-10 -mx-3 -mt-3 sm:-mx-6 sm:-mt-6 px-3 sm:px-6 pt-3 sm:pt-6 pb-3 bg-slate-50 flex justify-end">
        <button onClick={() => setConfigOpen(v => !v)}
          className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
            configOpen
              ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
              : 'border-slate-200 text-slate-500 hover:bg-slate-50'
          }`}>
          <Settings2 size={15} />
          {configOpen ? 'Готово' : 'Настроить'}
        </button>
      </div>

      {/* Metric cards row */}
      {enabledMetrics.length > 0 && (
        <div className={`grid gap-4 grid-cols-2 lg:grid-cols-${Math.min(4, enabledMetrics.length)}`}>
          {METRIC_IDS.filter(id => enabledMetrics.includes(id)).map(id => renderMetricCard(id))}
        </div>
      )}

      {/* Sortable widgets grid */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={widgetOrder} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
            {enabledSortable.map(id => {
              const def = SORTABLE_WIDGETS.find(w => w.id === id)
              if (!def) return null
              return (
                <SortableWidget key={id} id={id} wide={def.wide} configMode={configOpen}>
                  {renderWidget(id)}
                </SortableWidget>
              )
            })}
          </div>
        </SortableContext>
      </DndContext>

      {/* Config panel */}
      {configOpen && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <h3 className="text-sm font-semibold text-slate-700 mb-4 flex items-center gap-2">
            <Settings2 size={15} className="text-slate-400" />
            Виджеты дашборда
          </h3>

          {/* Metrics section */}
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-2">Метрики</p>
          <div className="flex flex-wrap gap-2 mb-5">
            {[
              { id: 'balance', label: 'Общий баланс' },
              { id: 'income',  label: 'Доходы месяца' },
              { id: 'expense', label: 'Расходы месяца' },
              { id: 'profit',  label: 'Валовая прибыль' },
            ].map(({ id, label }) => (
              <button key={id} onClick={() => toggleMetric(id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${
                  enabledMetrics.includes(id)
                    ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                    : 'border-slate-200 text-slate-400 hover:border-slate-300'
                }`}>
                {enabledMetrics.includes(id) && <span className="text-indigo-500">✓</span>}
                {label}
              </button>
            ))}
          </div>

          {/* Sortable widgets section */}
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-2">Виджеты</p>
          <p className="text-xs text-slate-400 mb-3">Перетащите карточки выше чтобы изменить порядок</p>
          <div className="flex flex-wrap gap-2">
            {SORTABLE_WIDGETS.map(w => (
              <button key={w.id} onClick={() => toggleWidget(w.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${
                  !disabledWidgets.has(w.id)
                    ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                    : 'border-slate-200 text-slate-400 hover:border-slate-300'
                }`}>
                {!disabledWidgets.has(w.id)
                  ? <span className="text-indigo-500">✓</span>
                  : <X size={12} className="text-slate-300" />}
                {w.label}
                {w.wide && <span className="text-[10px] text-slate-400 ml-0.5">широкий</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      <MatchmakerModal open={matchmakerOpen} onClose={() => setMatchmakerOpen(false)} />
    </div>
  )
}
