import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import { TrendingUp, TrendingDown, Wallet, ArrowLeftRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useStore } from '../store/useStore'
import { formatCurrency, formatDateShort, monthKey } from '../utils/format'

function MetricCard({
  label, value, sub, icon: Icon, color, trend,
}: {
  label: string; value: string; sub?: string; icon: React.ElementType; color: string; trend?: number
}) {
  return (
    <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</p>
          <p className="text-2xl font-bold text-slate-800 mt-1">{value}</p>
          {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
        </div>
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${color}`}>
          <Icon size={20} className="text-white" />
        </div>
      </div>
      {trend !== undefined && (
        <div className={`flex items-center gap-1 mt-3 text-xs font-medium ${trend >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
          {trend >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
          {trend >= 0 ? '+' : ''}{trend.toFixed(1)}% к прошлому месяцу
        </div>
      )}
    </div>
  )
}

const MONTH_LABELS: Record<string, string> = {
  '01': 'Янв', '02': 'Фев', '03': 'Мар', '04': 'Апр',
  '05': 'Май', '06': 'Июн', '07': 'Июл', '08': 'Авг',
  '09': 'Сен', '10': 'Окт', '11': 'Ноя', '12': 'Дек',
}

export default function Dashboard() {
  const { transactions, accounts, categories } = useStore()

  const totalBalance = accounts.reduce((s, a) => s + a.balance, 0)

  // Current month label for metric cards (e.g. "Май")
  const currentMonthLabel = new Intl.DateTimeFormat('ru-RU', { month: 'long' })
    .format(new Date())
    .replace(/^./, c => c.toUpperCase())

  // Empty state
  if (accounts.length === 0 && transactions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-96 text-center">
        <div className="text-6xl mb-5">📊</div>
        <h2 className="text-xl font-bold text-slate-700 mb-2">Добро пожаловать в ФинУчёт!</h2>
        <p className="text-slate-400 max-w-sm mb-8">
          Начните с добавления счёта — банковского, кассы или карты. После этого можно вносить операции и смотреть аналитику.
        </p>
        <Link to="/accounts"
          className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium px-6 py-3 rounded-xl transition-colors">
          🏦 Добавить первый счёт
        </Link>
      </div>
    )
  }

  // group by month
  const monthData: Record<string, { income: number; expense: number }> = {}
  transactions.forEach(t => {
    if (t.type === 'transfer') return
    const m = monthKey(t.date)
    if (!monthData[m]) monthData[m] = { income: 0, expense: 0 }
    if (t.type === 'income') monthData[m].income += t.amount
    else monthData[m].expense += t.amount
  })

  const months = Object.keys(monthData).sort()
  const chartData = months.map(m => ({
    name: MONTH_LABELS[m.slice(5)] ?? m.slice(5),
    Доходы: monthData[m].income,
    Расходы: monthData[m].expense,
    Прибыль: monthData[m].income - monthData[m].expense,
  }))

  // current & prev month
  const currentMonth = monthKey(new Date().toISOString())
  const prevMonth = monthKey(new Date(new Date().setMonth(new Date().getMonth() - 1)).toISOString())
  const cur = monthData[currentMonth] ?? { income: 0, expense: 0 }
  const prev = monthData[prevMonth] ?? { income: 0, expense: 0 }

  function trend(cur: number, prev: number) {
    if (!prev) return 0
    return ((cur - prev) / prev) * 100
  }

  // expenses by category (current month)
  const expByCat: Record<string, number> = {}
  transactions.filter(t => t.type === 'expense' && monthKey(t.date) === currentMonth).forEach(t => {
    expByCat[t.categoryId] = (expByCat[t.categoryId] ?? 0) + t.amount
  })
  const pieData = Object.entries(expByCat).map(([catId, val]) => {
    const cat = categories.find(c => c.id === catId)
    return { name: cat?.name ?? catId, value: val, color: cat?.color ?? '#94a3b8' }
  }).sort((a, b) => b.value - a.value).slice(0, 6)

  // last 5 transactions
  const recent = transactions.slice(0, 5)

  const CustomTooltip = ({ active, payload, label }: any) => {
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

  return (
    <div className="space-y-6">
      {/* Metric cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Общий баланс"
          value={formatCurrency(totalBalance)}
          sub={`${accounts.length} счёта`}
          icon={Wallet}
          color="bg-indigo-500"
        />
        <MetricCard
          label={`Доходы за ${currentMonthLabel}`}
          value={formatCurrency(cur.income)}
          icon={TrendingUp}
          color="bg-emerald-500"
          trend={trend(cur.income, prev.income)}
        />
        <MetricCard
          label={`Расходы за ${currentMonthLabel}`}
          value={formatCurrency(cur.expense)}
          icon={TrendingDown}
          color="bg-red-400"
          trend={-trend(cur.expense, prev.expense)}
        />
        <MetricCard
          label={`Прибыль за ${currentMonthLabel}`}
          value={formatCurrency(cur.income - cur.expense)}
          icon={ArrowLeftRight}
          color="bg-amber-500"
          trend={trend(cur.income - cur.expense, prev.income - prev.expense)}
        />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Area chart */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700 mb-4">Доходы и расходы по месяцам</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData} barGap={4}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={v => (v / 1000) + 'к'} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
              <Bar dataKey="Доходы" fill="#22c55e" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Расходы" fill="#f87171" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Pie chart */}
        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700 mb-4">{`Расходы за ${currentMonthLabel}`}</h3>
          {pieData.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={160}>
                <PieChart>
                  <Pie data={pieData} dataKey="value" cx="50%" cy="50%" innerRadius={45} outerRadius={72} paddingAngle={3}>
                    {pieData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Pie>
                  <Tooltip formatter={(v) => formatCurrency(Number(v))} />
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
          ) : (
            <p className="text-slate-400 text-sm text-center mt-8">Нет данных</p>
          )}
        </div>
      </div>

      {/* Profit line */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-700 mb-4">Динамика прибыли</h3>
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="profitGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.2} />
                <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={v => (v / 1000) + 'к'} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
            <Tooltip content={<CustomTooltip />} />
            <Area type="monotone" dataKey="Прибыль" stroke="#6366f1" strokeWidth={2.5} fill="url(#profitGrad)" dot={{ r: 4, fill: '#6366f1' }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Bottom row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recent transactions */}
        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700 mb-4">Последние операции</h3>
          <ul className="space-y-3">
            {recent.map(t => {
              const cat = categories.find(c => c.id === t.categoryId)
              return (
                <li key={t.id} className="flex items-center gap-3">
                  <div
                    className="w-9 h-9 rounded-xl flex items-center justify-center text-base shrink-0"
                    style={{ background: (cat?.color ?? '#94a3b8') + '22' }}
                  >
                    {cat?.icon ?? '💸'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-700 truncate">{cat?.name ?? '—'}</p>
                    <p className="text-xs text-slate-400">{formatDateShort(t.date)}</p>
                  </div>
                  <span className={`text-sm font-semibold ${t.type === 'income' ? 'text-emerald-600' : t.type === 'expense' ? 'text-red-500' : 'text-indigo-500'}`}>
                    {t.type === 'income' ? '+' : t.type === 'expense' ? '−' : '⇄'}{formatCurrency(t.amount)}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>

        {/* Accounts */}
        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700 mb-4">Счета</h3>
          <ul className="space-y-3">
            {accounts.map(a => (
              <li key={a.id} className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: a.color + '22' }}>
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
        </div>
      </div>
    </div>
  )
}
