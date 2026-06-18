import { useState } from 'react'
import { ChevronDown, ChevronRight, TrendingUp, TrendingDown, Download } from 'lucide-react'
import { downloadSheet } from '../utils/exportExcel'
import { useStore } from '../store/useStore'
import { formatCurrency, monthKey } from '../utils/format'
import { toBase } from '../utils/currency'
import CategoryIcon from '../utils/categoryIcons'
import type { CategoryPnlSection } from '../types'

const MONTH_LABELS: Record<string, string> = {
  '01': 'Янв', '02': 'Фев', '03': 'Мар', '04': 'Апр',
  '05': 'Май', '06': 'Июн', '07': 'Июл', '08': 'Авг',
  '09': 'Сен', '10': 'Окт', '11': 'Ноя', '12': 'Дек',
}

function pct(value: number, base: number) {
  if (!base) return null
  return Math.round((value / base) * 100)
}

function PctBadge({ value }: { value: number | null }) {
  if (value === null) return <span className="text-slate-300">—</span>
  const cls = value >= 0 ? 'text-emerald-600' : 'text-red-500'
  return <span className={`text-xs ${cls}`}>{value}%</span>
}

export default function PnL() {
  const { transactions, categories } = useStore()

  const [method, setMethod] = useState<'cash' | 'accrual'>('cash')

  // date to use for month grouping: accrual mode uses relatedDate if set
  function txDate(t: typeof transactions[0]) {
    return method === 'accrual' ? (t.relatedDate ?? t.date) : t.date
  }

  // Period filter: list of available years
  const allMonths = [...new Set(transactions.map(t => monthKey(txDate(t))))].sort()
  const allYears  = [...new Set(allMonths.map(m => m.slice(0, 4)))].sort().reverse()
  const currentYear = new Date().getFullYear().toString()
  const [year, setYear] = useState(allYears[0] ?? currentYear)

  const months = allMonths.filter(m => m.startsWith(year))
  const reversedMonths = [...months].reverse()

  // Expand/collapse sections
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['direct-income', 'direct-expense', 'indirect-expense', 'other-income', 'other-expense']))
  function toggle(key: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  // Helpers
  function sumByCategory(catId: string, month: string) {
    return transactions
      .filter(t => t.categoryId === catId && monthKey(txDate(t)) === month)
      .reduce((s, t) => s + toBase(t), 0)
  }

  function sumBySection(type: 'income' | 'expense', section: CategoryPnlSection | null, month: string) {
    const catIds = categories
      .filter(c => !c.isGroup && c.type === type && (section === null ? !c.pnlSection : (c.pnlSection ?? (type === 'income' ? 'direct' : 'indirect')) === section))
      .map(c => c.id)
    return transactions
      .filter(t => catIds.includes(t.categoryId) && monthKey(txDate(t)) === month)
      .reduce((s, t) => s + toBase(t), 0)
  }

  function catsForSection(type: 'income' | 'expense', section: CategoryPnlSection) {
    return categories.filter(c =>
      !c.isGroup && c.type === type &&
      (c.pnlSection ?? (type === 'income' ? 'direct' : 'indirect')) === section
    )
  }

  // Section rows component
  function SectionRows({ type, section, sectionKey, label, accentClass, valueClass }: {
    type: 'income' | 'expense'
    section: CategoryPnlSection
    sectionKey: string
    label: string
    accentClass: string
    valueClass: string
  }) {
    const cats = catsForSection(type, section)
    const isOpen = expanded.has(sectionKey)
    const hasData = months.some(m => cats.some(c => sumByCategory(c.id, m) > 0))

    return (
      <>
        <tr className={`border-b border-slate-100 cursor-pointer hover:opacity-80 transition-opacity ${accentClass}`}
          onClick={() => toggle(sectionKey)}>
          <td className="px-5 py-2.5 text-xs font-bold uppercase tracking-wider">
            <span className="flex items-center gap-1.5">
              {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              {label}
            </span>
          </td>
          {reversedMonths.map(m => {
            const v = sumBySection(type, section, m)
            return (
              <td key={m} className={`px-4 py-2.5 text-sm font-semibold text-right ${valueClass}`}>
                {v > 0 ? formatCurrency(v) : '—'}
              </td>
            )
          })}
        </tr>
        {isOpen && hasData && cats.map(cat => {
          const vals = reversedMonths.map(m => sumByCategory(cat.id, m))
          if (vals.every(v => v === 0)) return null
          return (
            <tr key={cat.id} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
              <td className="px-5 py-2 pl-10 text-sm text-slate-500">
                <span className="flex items-center gap-2">
                  <CategoryIcon name={cat.icon} size={13} color={cat.color} />
                  {cat.name}
                </span>
              </td>
              {vals.map((v, i) => (
                <td key={i} className={`px-4 py-2 text-sm text-right ${v > 0 ? valueClass : 'text-slate-300'}`}>
                  {v > 0 ? formatCurrency(v) : '—'}
                </td>
              ))}
            </tr>
          )
        })}
      </>
    )
  }

  // Summary row (Итого / computed)
  function SummaryRow({ label, values, bold = false, highlight = false, showMargin = false, baseValues }: {
    label: string
    values: number[]
    bold?: boolean
    highlight?: boolean
    showMargin?: boolean
    baseValues?: number[]
  }) {
    return (
      <tr className={highlight ? 'bg-indigo-50 border-y-2 border-indigo-200' : 'bg-slate-50 border-b border-slate-200'}>
        <td className={`px-5 py-3 text-sm ${bold ? 'font-bold text-slate-800' : 'font-semibold text-slate-600'}`}>
          {label}
        </td>
        {values.map((v, i) => (
          <td key={i} className={`px-4 py-3 text-right ${bold ? 'text-sm' : 'text-sm'}`}>
            <div className={`font-bold ${v >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
              {v !== 0 ? (v > 0 ? '' : '') + formatCurrency(v) : '—'}
            </div>
            {showMargin && baseValues && (
              <div className="mt-0.5">
                <PctBadge value={pct(v, baseValues[i])} />
              </div>
            )}
          </td>
        ))}
      </tr>
    )
  }

  function handleExport() {
    const mh = reversedMonths.map(m => MONTH_LABELS[m.slice(5)] ?? m)
    const row = (label: string, vals: number[]) =>
      ({ 'Статья': label, ...Object.fromEntries(mh.map((h, i) => [h, vals[i] || null])) })

    const rows = [
      row('Выручка (Прямые доходы)', reversedMonths.map(m => sumBySection('income', 'direct', m))),
      ...catsForSection('income', 'direct').map(c => row(`  ${c.name}`, reversedMonths.map(m => sumByCategory(c.id, m)))),
      row('Прямые расходы', reversedMonths.map(m => -sumBySection('expense', 'direct', m))),
      ...catsForSection('expense', 'direct').map(c => row(`  ${c.name}`, reversedMonths.map(m => -sumByCategory(c.id, m)))),
      row('ВАЛОВАЯ ПРИБЫЛЬ', reversedMonths.map((_, i) => directIncomes[i] - directExpenses[i])),
      row('Косвенные расходы', reversedMonths.map(m => -sumBySection('expense', 'indirect', m))),
      ...catsForSection('expense', 'indirect').map(c => row(`  ${c.name}`, reversedMonths.map(m => -sumByCategory(c.id, m)))),
      row('ОПЕРАЦИОННАЯ ПРИБЫЛЬ (EBIT)', ebitValues),
      row('Прочие доходы', reversedMonths.map(m => sumBySection('income', 'default', m))),
      row('Прочие расходы', reversedMonths.map(m => -sumBySection('expense', 'default', m))),
      row('ЧИСТАЯ ПРИБЫЛЬ', netProfits),
    ]
    downloadSheet(rows, 'ОПиУ', `pnl_${year}_${method}.xlsx`)
  }

  if (months.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-12 text-center">
        <TrendingUp size={32} className="mx-auto text-slate-300 mb-3" />
        <p className="text-slate-500 font-medium">Нет данных для отчёта</p>
        <p className="text-slate-400 text-sm mt-1">Добавьте операции чтобы увидеть ОПиУ</p>
      </div>
    )
  }

  // Precompute all section totals per month
  const directIncomes    = reversedMonths.map(m => sumBySection('income',  'direct',   m))
  const directExpenses   = reversedMonths.map(m => sumBySection('expense', 'direct',   m))
  const grossProfits     = reversedMonths.map((_, i) => directIncomes[i] - directExpenses[i])
  const indirectExpenses = reversedMonths.map(m => sumBySection('expense', 'indirect', m))
  const ebitValues       = reversedMonths.map((_, i) => grossProfits[i] - indirectExpenses[i])
  const otherIncomes     = reversedMonths.map(m => sumBySection('income',  'default',  m))
  const otherExpenses    = reversedMonths.map(m => sumBySection('expense', 'default',  m))
  const netProfits       = reversedMonths.map((_, i) => ebitValues[i] + otherIncomes[i] - otherExpenses[i])

  return (
    <div className="space-y-4">
      {/* Header + filters */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-800">Отчёт о прибылях и убытках</h2>
          <p className="text-xs text-slate-400 mt-0.5">ОПиУ · {method === 'cash' ? 'кассовый метод' : 'метод начисления'}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Method toggle */}
          <div className="flex rounded-lg border border-slate-200 overflow-hidden text-sm">
            <button
              onClick={() => setMethod('cash')}
              className={`px-3 py-1.5 font-medium transition-colors ${method === 'cash' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:bg-slate-50'}`}>
              Кассовый
            </button>
            <button
              onClick={() => setMethod('accrual')}
              className={`px-3 py-1.5 font-medium transition-colors ${method === 'accrual' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:bg-slate-50'}`}>
              Начисления
            </button>
          </div>
          <select
            value={year}
            onChange={e => setYear(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300 bg-white"
          >
            {allYears.map(y => <option key={y} value={y}>{y}</option>)}
            {!allYears.includes(currentYear) && <option value={currentYear}>{currentYear}</option>}
          </select>
          <button onClick={handleExport} title="Экспорт в Excel"
            className="p-2 rounded-lg border border-slate-200 text-slate-500 hover:bg-emerald-50 hover:text-emerald-600 hover:border-emerald-300 transition-colors">
            <Download size={15} />
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-5 py-3 w-60">Статья</th>
                {reversedMonths.map(m => (
                  <th key={m} className="text-right text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3 whitespace-nowrap">
                    {MONTH_LABELS[m.slice(5)]} {m.slice(0, 4)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>

              {/* ── 1. Выручка ───────────────────────────────── */}
              <SectionRows
                type="income" section="direct" sectionKey="direct-income"
                label="Выручка"
                accentClass="bg-emerald-50/60 text-emerald-800"
                valueClass="text-emerald-700"
              />

              {/* ── 2. Прямые расходы ────────────────────────── */}
              <SectionRows
                type="expense" section="direct" sectionKey="direct-expense"
                label="Прямые расходы (себестоимость)"
                accentClass="bg-red-50/40 text-red-700"
                valueClass="text-red-500"
              />

              {/* ── Валовая прибыль ──────────────────────────── */}
              <SummaryRow
                label="Валовая прибыль"
                values={grossProfits}
                bold showMargin
                baseValues={directIncomes}
              />

              {/* ── 3. Косвенные расходы ─────────────────────── */}
              <SectionRows
                type="expense" section="indirect" sectionKey="indirect-expense"
                label="Косвенные расходы (накладные)"
                accentClass="bg-orange-50/40 text-orange-700"
                valueClass="text-orange-600"
              />

              {/* ── EBIT ─────────────────────────────────────── */}
              <SummaryRow
                label="Операционная прибыль (EBIT)"
                values={ebitValues}
                bold showMargin
                baseValues={directIncomes}
              />

              {/* ── 4. Прочие доходы ─────────────────────────── */}
              <SectionRows
                type="income" section="default" sectionKey="other-income"
                label="Прочие доходы"
                accentClass="bg-slate-50 text-slate-600"
                valueClass="text-emerald-600"
              />

              {/* ── 5. Прочие расходы ────────────────────────── */}
              <SectionRows
                type="expense" section="default" sectionKey="other-expense"
                label="Прочие расходы"
                accentClass="bg-slate-50 text-slate-600"
                valueClass="text-red-500"
              />

              {/* ── Чистая прибыль ───────────────────────────── */}
              <SummaryRow
                label="Чистая прибыль"
                values={netProfits}
                bold highlight showMargin
                baseValues={directIncomes.map((v, i) => v + otherIncomes[i])}
              />

            </tbody>
          </table>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 text-xs text-slate-400 px-1">
        <span className="flex items-center gap-1.5"><TrendingUp size={12} className="text-emerald-500" /> Выручка — статьи дохода с разделом «Выручка»</span>
        <span className="flex items-center gap-1.5"><TrendingDown size={12} className="text-orange-500" /> Косвенные — накладные расходы без привязки к продукту</span>
        <span className="text-slate-300">% — от выручки</span>
      </div>
    </div>
  )
}
