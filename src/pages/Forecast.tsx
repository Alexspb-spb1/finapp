import { useState, useMemo } from 'react'
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts'
import { TrendingUp, TrendingDown, Lightbulb, AlertTriangle, Info, CheckCircle2 } from 'lucide-react'
import { useStore } from '../store/useStore'
import { formatCurrency, monthKey } from '../utils/format'
import { toBase, sumAccountsBase } from '../utils/currency'

// ── helpers ───────────────────────────────────────────────────────────────────
const ML: Record<string, string> = {
  '01':'Янв','02':'Фев','03':'Мар','04':'Апр','05':'Май','06':'Июн',
  '07':'Июл','08':'Авг','09':'Сен','10':'Окт','11':'Ноя','12':'Дек',
}

function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m - 1 + n, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function shortMonth(ym: string) {
  return (ML[ym.slice(5)] ?? ym.slice(5)) + ' ' + ym.slice(2, 4)
}

/** Simple linear regression forecast — returns next `steps` values */
function linForecast(values: number[], steps: number): number[] {
  const n = values.length
  if (n < 2) return Array(steps).fill(values[0] ?? 0)
  const xs = values.map((_, i) => i)
  const meanX = (n - 1) / 2
  const meanY = values.reduce((s, v) => s + v, 0) / n
  const slope = xs.reduce((s, x, i) => s + (x - meanX) * (values[i] - meanY), 0) /
                xs.reduce((s, x) => s + (x - meanX) ** 2, 0)
  const intercept = meanY - slope * meanX
  return Array.from({ length: steps }, (_, i) => Math.max(0, Math.round(intercept + slope * (n + i))))
}

/** 3-month moving average */
function movAvg3(values: number[]): (number | null)[] {
  return values.map((_, i) => i < 2 ? null : Math.round((values[i] + values[i - 1] + values[i - 2]) / 3))
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3 shadow-lg text-sm">
      <p className="font-semibold text-slate-700 mb-1">{label}</p>
      {payload.map((p: any, i: number) => p.value !== null && (
        <p key={i} style={{ color: p.color }} className="flex justify-between gap-6">
          <span>{p.name}:</span>
          <span className="font-medium">{formatCurrency(p.value)}</span>
        </p>
      ))}
    </div>
  )
}

// ── main component ────────────────────────────────────────────────────────────
export default function Forecast() {
  const { transactions, accounts, categories, paymentCalendar } = useStore()
  const [tab, setTab] = useState<'forecast' | 'trends' | 'insights'>('forecast')

  // ── aggregate monthly data ────────────────────────────────────────────────
  const monthData = useMemo(() => {
    const map: Record<string, { income: number; expense: number }> = {}
    transactions.forEach(t => {
      if (t.type === 'transfer') return
      const m = monthKey(t.date)
      if (!map[m]) map[m] = { income: 0, expense: 0 }
      if (t.type === 'income') map[m].income += toBase(t)
      else map[m].expense += toBase(t)
    })
    return map
  }, [transactions])

  const sortedMonths = useMemo(() => Object.keys(monthData).sort(), [monthData])
  const HISTORY = 6 // months for regression
  const histMonths = sortedMonths.slice(-HISTORY)

  const incValues  = histMonths.map(m => monthData[m].income)
  const expValues  = histMonths.map(m => monthData[m].expense)
  const profValues = histMonths.map(m => monthData[m].income - monthData[m].expense)

  const STEPS = 3
  const lastMonth   = sortedMonths[sortedMonths.length - 1] ?? monthKey(new Date().toISOString())
  const futureMonths = Array.from({ length: STEPS }, (_, i) => addMonths(lastMonth, i + 1))

  const incForecast  = linForecast(incValues, STEPS)
  const expForecast  = linForecast(expValues, STEPS)
  const profForecast = incForecast.map((v, i) => v - expForecast[i])

  // ── forecast chart data ───────────────────────────────────────────────────
  const forecastChart = [
    ...histMonths.map(m => ({
      name: shortMonth(m),
      'Факт доход':  monthData[m].income,
      'Факт расход': monthData[m].expense,
      'Прогноз доход':  null as number | null,
      'Прогноз расход': null as number | null,
      forecast: false,
    })),
    ...futureMonths.map((m, i) => ({
      name: shortMonth(m),
      'Факт доход':  null,
      'Факт расход': null,
      'Прогноз доход':  incForecast[i],
      'Прогноз расход': expForecast[i],
      forecast: true,
    })),
  ]

  // ── profit trend chart ────────────────────────────────────────────────────
  const trendChart = histMonths.map((m, i) => ({
    name: shortMonth(m),
    'Прибыль': profValues[i],
    'Среднее (3 мес)': movAvg3(profValues)[i],
  }))

  // ── runway ────────────────────────────────────────────────────────────────
  const totalBalance = sumAccountsBase(accounts)
  const avgExp = expValues.length ? expValues.reduce((s, v) => s + v, 0) / expValues.length : 1
  const runway = avgExp > 0 ? totalBalance / avgExp : null

  // ── next month summary ────────────────────────────────────────────────────
  const curMonth  = monthKey(new Date().toISOString())
  const cur       = monthData[curMonth]  ?? { income: 0, expense: 0 }
  const nextInc   = incForecast[0]  ?? 0
  const nextExp   = expForecast[0]  ?? 0
  const nextProfit = nextInc - nextExp
  const nextMonthLabel = shortMonth(futureMonths[0] ?? addMonths(curMonth, 1))

  function pct(a: number, b: number) {
    if (!b) return null
    return ((a - b) / b * 100).toFixed(1)
  }

  // ── category trends ───────────────────────────────────────────────────────
  const catTrends = useMemo(() => {
    const last2 = sortedMonths.slice(-2)
    if (last2.length < 2) return []
    const [mPrev, mCur] = last2
    const byType = (m: string, type: 'expense') => {
      const acc: Record<string, number> = {}
      transactions.filter(t => t.type === type && monthKey(t.date) === m).forEach(t => {
        acc[t.categoryId] = (acc[t.categoryId] ?? 0) + toBase(t)
      })
      return acc
    }
    const curExp  = byType(mCur,  'expense')
    const prevExp = byType(mPrev, 'expense')
    const allIds  = new Set([...Object.keys(curExp), ...Object.keys(prevExp)])
    return [...allIds].map(id => {
      const cat = categories.find(c => c.id === id)
      const c = curExp[id] ?? 0
      const p = prevExp[id] ?? 0
      const delta = p > 0 ? ((c - p) / p) * 100 : (c > 0 ? 100 : 0)
      return { id, name: cat?.name ?? id, color: cat?.color ?? '#94a3b8', cur: c, prev: p, delta }
    }).filter(x => x.cur > 0 || x.prev > 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 8)
  }, [transactions, categories, sortedMonths])

  // ── insights ──────────────────────────────────────────────────────────────
  const insights = useMemo(() => {
    const list: { type: 'success' | 'warn' | 'danger' | 'info'; title: string; desc: string; badge?: string }[] = []

    // 1. Consecutive income growth
    if (profValues.length >= 3) {
      let growthStreak = 0
      for (let i = profValues.length - 1; i > 0; i--) {
        if (monthData[histMonths[i]].income > monthData[histMonths[i - 1]].income) growthStreak++
        else break
      }
      if (growthStreak >= 2) {
        const avgGrowth = pct(incValues[incValues.length - 1], incValues[incValues.length - 2])
        list.push({ type: 'success', title: `Доходы растут ${growthStreak} мес. подряд`,
          desc: `Средний рост +${avgGrowth}% в месяц. Если тренд сохранится, в ${nextMonthLabel} доход составит ${formatCurrency(nextInc)}.`,
          badge: `+${avgGrowth}%/мес` })
      }
    }

    // 2. Category spike
    const spike = catTrends.find(c => c.delta > 30 && c.cur > 10000)
    if (spike) {
      list.push({ type: 'warn', title: `Расходы «${spike.name}» выросли на ${Math.round(spike.delta)}%`,
        desc: `${formatCurrency(spike.prev)} → ${formatCurrency(spike.cur)}. Проверьте причину роста.`,
        badge: `+${Math.round(spike.delta)}%` })
    }

    // 3. Runway warning
    if (runway !== null && runway < 4) {
      list.push({ type: 'danger', title: 'Низкий финансовый запас',
        desc: `При текущем темпе расходов (${formatCurrency(Math.round(avgExp))}/мес) баланса хватит на ${runway.toFixed(1)} мес.`,
        badge: `${runway.toFixed(1)} мес` })
    }

    // 4. Cash gap from payment calendar
    const today = new Date().toISOString().slice(0, 10)
    const nextM  = futureMonths[0]
    const upcoming = (paymentCalendar ?? []).filter(i => i.status !== 'paid' && i.date >= today && i.date < addMonths(nextM, 1) + '-01')
    const upInc = upcoming.filter(i => i.type === 'income').reduce((s, i) => s + i.amount, 0)
    const upExp = upcoming.filter(i => i.type === 'expense').reduce((s, i) => s + i.amount, 0)
    if (upExp > upInc + nextInc * 0.5) {
      list.push({ type: 'danger', title: 'Риск кассового разрыва',
        desc: `Плановые выплаты (${formatCurrency(upExp)}) превышают ожидаемые поступления. Проверьте платёжный календарь.`,
        badge: 'риск' })
    }

    // 5. Positive: expenses under control
    const expDelta = pct(expValues[expValues.length - 1], expValues[expValues.length - 2])
    if (expDelta !== null && parseFloat(expDelta) < 0) {
      list.push({ type: 'success', title: 'Расходы снизились',
        desc: `В ${shortMonth(histMonths[histMonths.length - 1])} расходы на ${Math.abs(parseFloat(expDelta)).toFixed(1)}% ниже предыдущего месяца.`,
        badge: `${expDelta}%` })
    }

    // 6. Forecast profit trend
    if (profForecast[0] > (cur.income - cur.expense) * 1.1) {
      list.push({ type: 'info', title: 'Прогноз: прибыль вырастет',
        desc: `В ${nextMonthLabel} ожидается ${formatCurrency(nextProfit)} — рост относительно текущего месяца.`,
        badge: formatCurrency(nextProfit) })
    }

    if (list.length === 0) {
      list.push({ type: 'info', title: 'Недостаточно данных',
        desc: 'Добавьте операции за несколько месяцев — инсайты появятся автоматически.' })
    }

    return list
  }, [catTrends, profValues, histMonths, monthData, runway, avgExp, paymentCalendar, futureMonths, incValues, expValues, nextInc, nextProfit, nextMonthLabel, cur, profForecast])

  const ICON = { success: CheckCircle2, warn: AlertTriangle, danger: AlertTriangle, info: Info }
  const ICON_COLOR = { success: 'text-emerald-600 bg-emerald-50', warn: 'text-amber-600 bg-amber-50', danger: 'text-red-600 bg-red-50', info: 'text-indigo-600 bg-indigo-50' }
  const BADGE_COLOR = { success: 'bg-emerald-50 text-emerald-700', warn: 'bg-amber-50 text-amber-700', danger: 'bg-red-50 text-red-700', info: 'bg-indigo-50 text-indigo-700' }

  const tabs = [
    { id: 'forecast', label: 'Прогноз' },
    { id: 'trends',   label: 'Тренды'  },
    { id: 'insights', label: 'Инсайты' },
  ] as const

  if (sortedMonths.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-12 text-center">
        <Lightbulb size={32} className="mx-auto text-slate-300 mb-3" />
        <p className="text-slate-500 font-medium">Нет данных для анализа</p>
        <p className="text-slate-400 text-sm mt-1">Добавьте операции чтобы увидеть прогнозы</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Tabs */}
      <div className="flex gap-1 bg-slate-100 rounded-xl p-1 w-fit">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-5 py-2 rounded-lg text-sm font-medium transition-all ${
              tab === t.id ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Прогноз ── */}
      {tab === 'forecast' && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              { label: `Прогноз дохода · ${nextMonthLabel}`,   value: nextInc,    ref: cur.income,   up: true  },
              { label: `Прогноз расходов · ${nextMonthLabel}`, value: nextExp,    ref: cur.expense,  up: false },
              { label: `Прогноз прибыли · ${nextMonthLabel}`,  value: nextProfit, ref: cur.income - cur.expense, up: true },
            ].map((card, i) => {
              const p = pct(card.value, card.ref)
              const growing = card.value > card.ref
              return (
                <div key={i} className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm">
                  <p className="text-xs font-medium text-slate-500 mb-1">{card.label}</p>
                  <p className="text-2xl font-bold text-slate-800">{formatCurrency(card.value)}</p>
                  {p !== null && (
                    <div className={`flex items-center gap-1 mt-2 text-xs font-medium ${
                      (growing && card.up) || (!growing && !card.up) ? 'text-emerald-600' : 'text-red-500'
                    }`}>
                      {growing ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                      {growing ? '+' : ''}{p}% к текущему месяцу
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Forecast chart */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-slate-700">Прогноз vs факт</h3>
              <div className="flex gap-4">
                {[
                  { color: '#22c55e', label: 'Факт доход' },
                  { color: '#22c55e', dash: true, label: 'Прогноз доход' },
                  { color: '#f87171', label: 'Факт расход' },
                  { color: '#f87171', dash: true, label: 'Прогноз расход' },
                ].map((l, i) => (
                  <span key={i} className="flex items-center gap-1.5 text-xs text-slate-500">
                    <span className={`inline-block w-6 h-0 border-t-2 ${l.dash ? 'border-dashed' : 'border-solid'}`} style={{ borderColor: l.color }} />
                    {l.label}
                  </span>
                ))}
              </div>
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={forecastChart}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={v => (v / 1000) + 'к'} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                <Tooltip content={<CustomTooltip />} />
                {forecastChart.findIndex(d => d.forecast) > 0 && (
                  <ReferenceLine x={forecastChart.find(d => d.forecast)?.name} stroke="#e2e8f0" strokeDasharray="4 4" label={{ value: 'прогноз →', position: 'insideTopRight', fontSize: 11, fill: '#94a3b8' }} />
                )}
                <Line dataKey="Факт доход"     stroke="#22c55e" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />
                <Line dataKey="Прогноз доход"  stroke="#22c55e" strokeWidth={1.5} strokeDasharray="5 4" dot={{ r: 3, fill: '#22c55e' }} connectNulls={false} />
                <Line dataKey="Факт расход"    stroke="#f87171" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />
                <Line dataKey="Прогноз расход" stroke="#f87171" strokeWidth={1.5} strokeDasharray="5 4" dot={{ r: 3, fill: '#f87171' }} connectNulls={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Runway */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
            <h3 className="text-sm font-semibold text-slate-700 mb-4">Финансовый запас (Runway)</h3>
            <div className="flex items-start gap-8">
              <div>
                <p className="text-5xl font-bold text-slate-800">{runway !== null ? runway.toFixed(1) : '—'}</p>
                <p className="text-sm text-slate-500 mt-1">месяцев при текущих расходах</p>
              </div>
              <div className="flex-1 space-y-3 pt-1">
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">Общий баланс</span>
                  <span className="font-medium text-slate-700">{formatCurrency(totalBalance)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">Средний расход/мес</span>
                  <span className="font-medium text-slate-700">{formatCurrency(Math.round(avgExp))}</span>
                </div>
                {runway !== null && (
                  <div>
                    <div className="flex justify-between text-xs text-slate-400 mb-1">
                      <span>0</span>
                      <span>6 мес</span>
                      <span>12 мес</span>
                    </div>
                    <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all ${runway < 3 ? 'bg-red-400' : runway < 6 ? 'bg-amber-400' : 'bg-emerald-400'}`}
                        style={{ width: `${Math.min(100, (runway / 12) * 100)}%` }} />
                    </div>
                  </div>
                )}
                {runway !== null && runway < 6 && (
                  <div className={`flex items-center gap-2 text-xs px-3 py-2 rounded-lg ${runway < 3 ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>
                    <AlertTriangle size={13} />
                    {runway < 3 ? 'Критически низкий запас — требует немедленного внимания' : 'Рекомендуется поддерживать запас от 6 месяцев'}
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Тренды ── */}
      {tab === 'trends' && (
        <>
          {/* Profit trend */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-slate-700">Динамика прибыли со скользящим средним</h3>
              <div className="flex gap-4">
                {[{ color: '#6366f1', label: 'Прибыль', dash: false }, { color: '#a5b4fc', label: 'Среднее (3 мес)', dash: true }].map((l, i) => (
                  <span key={i} className="flex items-center gap-1.5 text-xs text-slate-500">
                    <span className="inline-block w-6 h-0 border-t-2" style={{ borderColor: l.color, borderStyle: l.dash ? 'dashed' : 'solid' }} />
                    {l.label}
                  </span>
                ))}
              </div>
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={trendChart}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={v => (v / 1000) + 'к'} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                <Tooltip content={<CustomTooltip />} />
                <ReferenceLine y={0} stroke="#e2e8f0" />
                <Line dataKey="Прибыль" stroke="#6366f1" strokeWidth={2} dot={{ r: 4 }} />
                <Line dataKey="Среднее (3 мес)" stroke="#a5b4fc" strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Category trends */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
            <h3 className="text-sm font-semibold text-slate-700 mb-1">Изменение расходов по статьям</h3>
            <p className="text-xs text-slate-400 mb-4">Сравнение последних двух месяцев</p>
            {catTrends.length === 0
              ? <p className="text-slate-400 text-sm text-center py-6">Недостаточно данных</p>
              : (
                <div className="space-y-3">
                  {catTrends.map(c => {
                    const growing = c.delta > 0
                    return (
                      <div key={c.id} className="flex items-center gap-3">
                        <div className="w-2 h-2 rounded-full shrink-0" style={{ background: c.color }} />
                        <span className="text-sm text-slate-600 w-36 truncate shrink-0">{c.name}</span>
                        <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{
                            width: `${Math.min(100, Math.abs(c.delta))}%`,
                            background: growing ? '#f87171' : '#22c55e',
                          }} />
                        </div>
                        <span className="text-xs font-medium w-20 text-right shrink-0" style={{ color: growing ? '#ef4444' : '#16a34a' }}>
                          {growing ? '+' : ''}{c.delta.toFixed(1)}%
                        </span>
                        <span className="text-xs text-slate-400 w-24 text-right shrink-0">{formatCurrency(c.cur)}</span>
                      </div>
                    )
                  })}
                </div>
              )
            }
          </div>

          {/* Month-over-month bar */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
            <h3 className="text-sm font-semibold text-slate-700 mb-4">Доходы и расходы по месяцам</h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={histMonths.map(m => ({
                name: shortMonth(m),
                Доходы: monthData[m].income,
                Расходы: monthData[m].expense,
              }))} barGap={4}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={v => (v / 1000) + 'к'} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="Доходы"  fill="#22c55e" radius={[3, 3, 0, 0]} />
                <Bar dataKey="Расходы" fill="#f87171" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      {/* ── Инсайты ── */}
      {tab === 'insights' && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <div className="flex items-center gap-2 mb-5">
            <Lightbulb size={16} className="text-amber-500" />
            <h3 className="text-sm font-semibold text-slate-700">Автоматические инсайты</h3>
            <span className="ml-auto text-xs text-slate-400">На основе ваших данных</span>
          </div>
          <div className="space-y-1">
            {insights.map((ins, i) => {
              const Icon = ICON[ins.type]
              return (
                <div key={i} className="flex items-start gap-3 py-4 border-b border-slate-50 last:border-0">
                  <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${ICON_COLOR[ins.type]}`}>
                    <Icon size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-700">{ins.title}</p>
                    <p className="text-xs text-slate-500 mt-1 leading-relaxed">{ins.desc}</p>
                  </div>
                  {ins.badge && (
                    <span className={`text-xs font-medium px-2.5 py-1 rounded-full shrink-0 ${BADGE_COLOR[ins.type]}`}>
                      {ins.badge}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
