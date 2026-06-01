import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, FolderOpen, TrendingUp, TrendingDown, Minus } from 'lucide-react'
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

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { projects, transactions, categories } = useStore()

  const project = projects.find(p => p.id === id)
  if (!project) {
    return (
      <div className="text-center py-20 text-slate-400">
        <p className="text-lg font-medium">Проект не найден</p>
        <button onClick={() => navigate('/projects')} className="mt-4 text-indigo-600 text-sm hover:underline">
          ← Назад к проектам
        </button>
      </div>
    )
  }

  const tx = transactions.filter(t => t.projectId === id && t.type !== 'transfer')

  // Monthly aggregation
  const monthData: Record<string, { income: number; expense: number; net: number }> = {}
  tx.forEach(t => {
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

  const totalIncome  = tx.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0)
  const totalExpense = tx.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0)
  const totalNet     = totalIncome - totalExpense

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
      {/* Header */}
      <div className="flex items-start gap-4">
        <button onClick={() => navigate('/projects')}
          className="mt-1 p-2 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors shrink-0">
          <ArrowLeft size={18} />
        </button>
        <div className="flex items-center gap-4 flex-1">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: project.color + '20' }}>
            <FolderOpen size={24} style={{ color: project.color }} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-slate-800">{project.name}</h1>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                project.status === 'active'
                  ? 'bg-emerald-50 text-emerald-600'
                  : 'bg-slate-100 text-slate-500'
              }`}>
                {project.status === 'active' ? 'Активный' : 'Архивный'}
              </span>
            </div>
            {project.description && (
              <p className="text-sm text-slate-500 mt-0.5">{project.description}</p>
            )}
            {(project.startDate || project.endDate) && (
              <p className="text-xs text-slate-400 mt-0.5">
                {project.startDate ? project.startDate.split('-').reverse().join('.') : '…'}
                {' — '}
                {project.endDate ? project.endDate.split('-').reverse().join('.') : 'сейчас'}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
          <div className="flex items-center gap-2 text-emerald-500 mb-1">
            <TrendingUp size={16} />
            <p className="text-xs text-slate-500 uppercase tracking-wide">Поступления</p>
          </div>
          <p className="text-2xl font-bold text-emerald-600">{formatCurrency(totalIncome)}</p>
          <p className="text-xs text-slate-400 mt-1">за всё время</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
          <div className="flex items-center gap-2 text-red-400 mb-1">
            <TrendingDown size={16} />
            <p className="text-xs text-slate-500 uppercase tracking-wide">Списания</p>
          </div>
          <p className="text-2xl font-bold text-red-500">{formatCurrency(totalExpense)}</p>
          <p className="text-xs text-slate-400 mt-1">за всё время</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
          <div className="flex items-center gap-2 text-indigo-500 mb-1">
            <Minus size={16} />
            <p className="text-xs text-slate-500 uppercase tracking-wide">Чистый поток</p>
          </div>
          <p className={`text-2xl font-bold ${totalNet >= 0 ? 'text-indigo-600' : 'text-red-500'}`}>
            {totalNet >= 0 ? '+' : ''}{formatCurrency(totalNet)}
          </p>
          <p className="text-xs text-slate-400 mt-1">{tx.length} операций</p>
        </div>
      </div>

      {/* Empty state */}
      {tx.length === 0 && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-16 text-center">
          <div className="text-5xl mb-4">📊</div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">Нет операций</h3>
          <p className="text-sm text-slate-400 max-w-xs mx-auto">
            Привяжите операции к этому проекту, чтобы увидеть ДДС
          </p>
        </div>
      )}

      {tx.length > 0 && (
        <>
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

          {/* Net chart */}
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
            <h3 className="text-sm font-semibold text-slate-700 mb-4">Чистый денежный поток</h3>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={v => (v / 1000) + 'к'} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                <Tooltip content={<CustomTooltip />} />
                <Line type="monotone" dataKey="Чистый поток" stroke="#6366f1" strokeWidth={2.5}
                  dot={{ r: 5, fill: '#6366f1', strokeWidth: 2, stroke: '#fff' }} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Monthly table */}
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

          {/* Recent transactions */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100">
              <h3 className="text-sm font-semibold text-slate-700">Операции проекта</h3>
            </div>
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50">
                  <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-5 py-3">Дата</th>
                  <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-5 py-3">Статья</th>
                  <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-5 py-3">Комментарий</th>
                  <th className="text-right text-xs font-semibold text-slate-500 uppercase tracking-wide px-5 py-3">Сумма</th>
                </tr>
              </thead>
              <tbody>
                {[...tx].sort((a, b) => b.date.localeCompare(a.date)).map(t => {
                  const cat = categories.find(c => c.id === t.categoryId)
                  return (
                    <tr key={t.id} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                      <td className="px-5 py-3 text-sm text-slate-500">
                        {t.date.split('-').reverse().join('.')}
                      </td>
                      <td className="px-5 py-3 text-sm text-slate-700">
                        {cat ? `${cat.icon} ${cat.name}` : '—'}
                      </td>
                      <td className="px-5 py-3 text-sm text-slate-500 max-w-xs truncate">
                        {t.comment || '—'}
                      </td>
                      <td className={`px-5 py-3 text-sm font-semibold text-right ${t.type === 'income' ? 'text-emerald-600' : 'text-red-500'}`}>
                        {t.type === 'income' ? '+' : '−'}{formatCurrency(t.amount)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
