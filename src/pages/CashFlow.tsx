import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, LineChart, Line,
} from 'recharts'
import { useStore } from '../store/useStore'
import { formatCurrency, monthKey } from '../utils/format'

const MONTH_LABELS: Record<string, string> = {
  '01': 'Янв', '02': 'Фев', '03': 'Мар', '04': 'Апр',
  '05': 'Май', '06': 'Июн', '07': 'Июл', '08': 'Авг',
  '09': 'Сен', '10': 'Окт', '11': 'Ноя', '12': 'Дек',
}

export default function CashFlow() {
  const { transactions } = useStore()

  const monthData: Record<string, { income: number; expense: number; net: number }> = {}
  transactions.filter(t => t.type !== 'transfer').forEach(t => {
    const m = monthKey(t.date)
    if (!monthData[m]) monthData[m] = { income: 0, expense: 0, net: 0 }
    if (t.type === 'income') monthData[m].income += t.amount
    else monthData[m].expense += t.amount
  })
  Object.values(monthData).forEach(d => { d.net = d.income - d.expense })

  const sorted = Object.entries(monthData).sort(([a], [b]) => a.localeCompare(b))
  const chartData = sorted.map(([m, d]) => ({
    name: MONTH_LABELS[m.slice(5)] ?? m.slice(5),
    month: m,
    Поступления: d.income,
    Списания: d.expense,
    'Чистый поток': d.net,
  }))

  // By category for latest month
  const latestMonth = sorted[sorted.length - 1]?.[0]
  const expByCat: Record<string, number> = {}
  const incByCat: Record<string, number> = {}
  transactions.filter(t => t.type !== 'transfer' && monthKey(t.date) === latestMonth).forEach(t => {
    if (t.type === 'expense') expByCat[t.categoryId] = (expByCat[t.categoryId] ?? 0) + t.amount
    else incByCat[t.categoryId] = (incByCat[t.categoryId] ?? 0) + t.amount
  })

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
      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {['Поступления', 'Списания', 'Чистый поток'].map((key) => {
          const total = sorted.reduce((s, [, d]) => {
            if (key === 'Поступления') return s + d.income
            if (key === 'Списания') return s + d.expense
            return s + d.net
          }, 0)
          const color = key === 'Поступления' ? 'text-emerald-600 bg-emerald-50' : key === 'Списания' ? 'text-red-600 bg-red-50' : 'text-indigo-600 bg-indigo-50'
          return (
            <div key={key} className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
              <p className="text-xs text-slate-500 uppercase tracking-wide">{key}</p>
              <p className={`text-2xl font-bold mt-1 ${color.split(' ')[0]}`}>{formatCurrency(total)}</p>
              <p className="text-xs text-slate-400 mt-1">за всё время</p>
            </div>
          )
        })}
      </div>

      {/* Bar chart */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-700 mb-4">Поступления и списания</h3>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={chartData} barGap={4}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={v => (v / 1000) + 'к'} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
            <Tooltip content={<CustomTooltip />} />
            <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
            <Bar dataKey="Поступления" fill="#4ade80" radius={[4, 4, 0, 0]} />
            <Bar dataKey="Списания" fill="#f87171" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Net cash flow */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-700 mb-4">Чистый денежный поток</h3>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={v => (v / 1000) + 'к'} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
            <Tooltip content={<CustomTooltip />} />
            <Line
              type="monotone"
              dataKey="Чистый поток"
              stroke="#6366f1"
              strokeWidth={2.5}
              dot={{ r: 5, fill: '#6366f1', strokeWidth: 2, stroke: '#fff' }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100">
          <h3 className="text-sm font-semibold text-slate-700">Детализация по месяцам</h3>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50">
              <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-5 py-3">Месяц</th>
              <th className="text-right text-xs font-semibold text-slate-500 uppercase tracking-wide px-5 py-3">Поступления</th>
              <th className="text-right text-xs font-semibold text-slate-500 uppercase tracking-wide px-5 py-3">Списания</th>
              <th className="text-right text-xs font-semibold text-slate-500 uppercase tracking-wide px-5 py-3">Чистый поток</th>
            </tr>
          </thead>
          <tbody>
            {[...sorted].reverse().map(([m, d]) => (
              <tr key={m} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                <td className="px-5 py-3.5 text-sm text-slate-700 font-medium">
                  {MONTH_LABELS[m.slice(5)]} {m.slice(0, 4)}
                </td>
                <td className="px-5 py-3.5 text-sm text-emerald-600 font-semibold text-right">{formatCurrency(d.income)}</td>
                <td className="px-5 py-3.5 text-sm text-red-500 font-semibold text-right">{formatCurrency(d.expense)}</td>
                <td className={`px-5 py-3.5 text-sm font-bold text-right ${d.net >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                  {d.net >= 0 ? '+' : ''}{formatCurrency(d.net)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
