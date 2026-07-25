import { useState, useMemo } from 'react'
import { Scale, Wallet, TrendingUp, TrendingDown, Landmark, ChevronDown, ChevronRight } from 'lucide-react'
import { useStore } from '../store/useStore'
import { formatCurrency } from '../utils/format'
import { toBase, accountToBase, sumAccountsBase } from '../utils/currency'
import CategoryIcon from '../utils/categoryIcons'
import type { Transaction } from '../types'

// ── Mini bar (визуализация доли) ──────────────────────────────────────────────
function ShareBar({ value, total, color }: { value: number; total: number; color: string }) {
  const pct = total > 0 ? Math.min(Math.abs(value / total) * 100, 100) : 0
  return (
    <div className="w-full h-1 bg-slate-100 rounded-full mt-1.5 overflow-hidden">
      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
    </div>
  )
}

// ── Collapsible section ───────────────────────────────────────────────────────
function Section({
  title, total, totalLabel, children, color, icon: Icon, defaultOpen = true,
}: {
  title: string
  total: number
  totalLabel?: string
  children: React.ReactNode
  color: string
  icon: React.ElementType
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-xl border border-slate-200 overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-slate-50 transition-colors group"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: color + '22' }}>
            <Icon size={15} style={{ color }} />
          </div>
          <span className="text-sm font-semibold text-slate-700">{title}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-base font-bold text-slate-800">{formatCurrency(total)}</span>
          {open ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}
        </div>
      </button>
      {open && <div className="border-t border-slate-100 divide-y divide-slate-50">{children}</div>}
      {totalLabel && open && (
        <div className="px-5 py-2.5 bg-slate-50 border-t border-slate-100 flex justify-between items-center">
          <span className="text-xs text-slate-400">{totalLabel}</span>
          <span className="text-sm font-bold text-slate-700">{formatCurrency(total)}</span>
        </div>
      )}
    </div>
  )
}

function Row({ label, value, sub, color, icon }: {
  label: string
  value: number
  sub?: string
  color?: string
  icon?: { name: string; color: string }
}) {
  return (
    <div className="flex items-center gap-3 px-5 py-3">
      {icon && (
        <div className="w-7 h-7 flex items-center justify-center rounded-lg shrink-0"
          style={{ background: icon.color + '22' }}>
          <CategoryIcon name={icon.name} size={13} color={icon.color} />
        </div>
      )}
      {!icon && <div className="w-7 shrink-0" />}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-slate-600 truncate">{label}</p>
        {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
      </div>
      <span className="text-sm font-semibold" style={{ color: color ?? '#334155' }}>
        {formatCurrency(value)}
      </span>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function Balance() {
  const store = useStore()
  const { accounts, transactions, categories } = store

  // ── Assets: денежные средства по счетам (в базовой валюте) ─────────────────
  const totalCash = sumAccountsBase(accounts)

  // ── Equity: нераспределённая прибыль (операционная + инвестиционная)
  // kind=1,2 — operational & investment transactions. Все суммы — в базовой валюте (toBase)
  //
  // Раньше членство проверялось через Set категорий с kind!=3 — операции без
  // категории (categoryId не задан, "Без статьи") или с категорией, которая
  // была позже удалена, молча выпадали из расчёта: Set.has(undefined/orphan)
  // → false. При этом initialCapital ниже реверсирует ВСЕ операции без
  // исключений — из-за рассинхрона "Активы" и "Капитал" расходились ровно на
  // сумму таких операций. Используем ту же логику по умолчанию kind=1, что
  // и financialIncome/financialExpense ниже — категория не найдена → как
  // операционная, а не как выпавшая из расчёта.
  function isFinancialKind(t: Transaction): boolean {
    const cat = categories.find(c => c.id === t.categoryId)
    return (cat?.kind ?? 1) === 3
  }

  const cumulativeProfit = useMemo(() => {
    let profit = 0
    for (const t of transactions) {
      if (t.type === 'transfer') continue
      if (isFinancialKind(t)) continue
      profit += t.type === 'income' ? toBase(t) : -toBase(t)
    }
    return profit
  }, [transactions, categories])

  // ── Financial flows (kind=3): займы, кредиты, взносы владельца
  const financialIncome = useMemo(() => {
    let sum = 0
    for (const t of transactions) {
      if (t.type !== 'income') continue
      const cat = categories.find(c => c.id === t.categoryId)
      if ((cat?.kind ?? 1) === 3) sum += toBase(t)
    }
    return sum
  }, [transactions, categories])

  const financialExpense = useMemo(() => {
    let sum = 0
    for (const t of transactions) {
      if (t.type !== 'expense') continue
      const cat = categories.find(c => c.id === t.categoryId)
      if ((cat?.kind ?? 1) === 3) sum += toBase(t)
    }
    return sum
  }, [transactions, categories])

  const netFinancial = financialIncome - financialExpense

  // ── Начальный капитал — рассчитывается НЕЗАВИСИМО (не выводится из равенства).
  // Для каждого счёта восстанавливаем остаток на момент до первой операции
  // (в родной валюте счёта), затем конвертируем в базовую. Так уравнение баланса
  // перестаёт быть тавтологией: курсовые разницы по кросс-валютным переводам
  // проявятся как реальное расхождение. (БАГ № 3)
  const initialCapital = useMemo(() => {
    let sum = 0
    for (const acc of accounts) {
      let openingNative = acc.balance
      for (const t of transactions) {
        if (t.type === 'income'  && t.accountId === acc.id) openingNative -= t.amount
        else if (t.type === 'expense' && t.accountId === acc.id) openingNative += t.amount
        else if (t.type === 'transfer') {
          if (t.accountId === acc.id)   openingNative += t.amount
          if (t.toAccountId === acc.id) openingNative -= (t.toAmount ?? t.amount)
        }
      }
      sum += accountToBase({ ...acc, balance: openingNative })
    }
    return sum
  }, [accounts, transactions])

  // ── Капитал и обязательства = нач. капитал + прибыль + финансовые потоки
  const totalEquity = cumulativeProfit + netFinancial + initialCapital

  // Category breakdowns for financial section
  const financialIncCats = useMemo(() => {
    const map = new Map<string, number>()
    for (const t of transactions) {
      if (t.type !== 'income') continue
      const cat = categories.find(c => c.id === t.categoryId)
      if ((cat?.kind ?? 1) === 3 && cat) map.set(cat.id, (map.get(cat.id) ?? 0) + toBase(t))
    }
    return map
  }, [transactions, categories])

  const financialExpCats = useMemo(() => {
    const map = new Map<string, number>()
    for (const t of transactions) {
      if (t.type !== 'expense') continue
      const cat = categories.find(c => c.id === t.categoryId)
      if ((cat?.kind ?? 1) === 3 && cat) map.set(cat.id, (map.get(cat.id) ?? 0) + toBase(t))
    }
    return map
  }, [transactions, categories])

  const balanced = Math.abs(totalCash - totalEquity) < 1

  return (
    <div className="space-y-4 max-w-5xl">
      {/* Balance equation check */}
      <div className={`flex items-center gap-3 px-5 py-3.5 rounded-xl border text-sm font-medium ${
        balanced
          ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
          : 'bg-amber-50 border-amber-200 text-amber-800'
      }`}>
        <Scale size={16} className={balanced ? 'text-emerald-500' : 'text-amber-500'} />
        {balanced
          ? `Баланс сходится: Активы = Капитал + Обязательства = ${formatCurrency(totalCash)}`
          : `Расхождение: Активы ${formatCurrency(totalCash)} ≠ Капитал ${formatCurrency(totalEquity)}`
        }
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* ── Left: АКТИВЫ ─────────────────────────────────────────────────── */}
        <div className="space-y-3">
          <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest px-1">Активы</h3>

          <Section title="Денежные средства" total={totalCash} color="#6366f1" icon={Wallet}>
            {accounts.map(acc => (
              <Row
                key={acc.id}
                label={acc.name}
                sub={`${acc.type === 'bank' ? 'Банковский счёт' : acc.type === 'card' ? 'Карта' : acc.type === 'cash' ? 'Наличные' : 'Крипто'} · ${acc.currency}`}
                value={acc.balance}
                color={acc.balance >= 0 ? '#4f46e5' : '#ef4444'}
              />
            ))}
          </Section>

          {/* Total assets */}
          <div className="bg-indigo-600 text-white rounded-xl px-5 py-4 flex items-center justify-between">
            <span className="text-sm font-semibold opacity-80">Итого активы</span>
            <span className="text-xl font-bold">{formatCurrency(totalCash)}</span>
          </div>
        </div>

        {/* ── Right: КАПИТАЛ И ОБЯЗАТЕЛЬСТВА ───────────────────────────────── */}
        <div className="space-y-3">
          <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest px-1">Капитал и обязательства</h3>

          {/* Нераспределённая прибыль */}
          <Section
            title="Нераспределённая прибыль"
            total={cumulativeProfit}
            color={cumulativeProfit >= 0 ? '#22c55e' : '#ef4444'}
            icon={cumulativeProfit >= 0 ? TrendingUp : TrendingDown}
          >
            <Row
              label="Совокупные доходы (опер. + инвест.)"
              value={(() => {
                let s = 0
                for (const t of transactions) {
                  if (t.type === 'income' && !isFinancialKind(t)) s += toBase(t)
                }
                return s
              })()}
              color="#22c55e"
            />
            <Row
              label="Совокупные расходы (опер. + инвест.)"
              value={-(() => {
                let s = 0
                for (const t of transactions) {
                  if (t.type === 'expense' && !isFinancialKind(t)) s += toBase(t)
                }
                return s
              })()}
              color="#ef4444"
            />
          </Section>

          {/* Финансовые операции */}
          {(financialIncome > 0 || financialExpense > 0) && (
            <Section
              title="Финансовые операции (займы, кредиты)"
              total={netFinancial}
              color="#f59e0b"
              icon={Landmark}
            >
              {financialIncCats.size > 0 && (
                <div className="px-5 py-2 text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Получено</div>
              )}
              {[...financialIncCats.entries()].map(([catId, amount]) => {
                const cat = categories.find(c => c.id === catId)
                return cat ? (
                  <Row key={catId} label={cat.name} value={amount} color="#22c55e"
                    icon={{ name: cat.icon, color: cat.color }} />
                ) : null
              })}
              {financialExpCats.size > 0 && (
                <div className="px-5 py-2 text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Выплачено</div>
              )}
              {[...financialExpCats.entries()].map(([catId, amount]) => {
                const cat = categories.find(c => c.id === catId)
                return cat ? (
                  <Row key={catId} label={cat.name} value={-amount} color="#ef4444"
                    icon={{ name: cat.icon, color: cat.color }} />
                ) : null
              })}
            </Section>
          )}

          {/* Начальный капитал */}
          <div className="rounded-xl border border-slate-200 px-5 py-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center">
                  <Scale size={14} className="text-slate-500" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-700">Начальный капитал</p>
                  <p className="text-xs text-slate-400 mt-0.5">Активы − Прибыль − Финансовые потоки</p>
                </div>
              </div>
              <span className={`text-base font-bold ${initialCapital >= 0 ? 'text-slate-700' : 'text-red-500'}`}>
                {formatCurrency(initialCapital)}
              </span>
            </div>
            <ShareBar value={initialCapital} total={totalCash} color="#64748b" />
          </div>

          {/* Total equity */}
          <div className="bg-emerald-600 text-white rounded-xl px-5 py-4 flex items-center justify-between">
            <span className="text-sm font-semibold opacity-80">Итого капитал и обязательства</span>
            <span className="text-xl font-bold">{formatCurrency(totalEquity)}</span>
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
        {[
          { label: 'Счёта и касса',   value: totalCash,        color: 'text-indigo-700',  bg: 'bg-indigo-50' },
          { label: 'Нераспред. прибыль', value: cumulativeProfit, color: cumulativeProfit >= 0 ? 'text-emerald-700' : 'text-red-600', bg: cumulativeProfit >= 0 ? 'bg-emerald-50' : 'bg-red-50' },
          { label: 'Фин. обязательства', value: netFinancial,   color: netFinancial >= 0 ? 'text-amber-700' : 'text-red-600', bg: 'bg-amber-50' },
          { label: 'Нач. капитал',    value: initialCapital,   color: 'text-slate-700',  bg: 'bg-slate-50' },
        ].map(({ label, value, color, bg }) => (
          <div key={label} className={`${bg} rounded-xl border border-slate-200 px-4 py-3`}>
            <p className="text-xs text-slate-500 mb-1">{label}</p>
            <p className={`text-base font-bold ${color}`}>{formatCurrency(value)}</p>
          </div>
        ))}
      </div>

      <p className="text-xs text-slate-400 text-center pb-2">
        Баланс рассчитывается из текущих остатков на счетах и истории всех операций.
        Финансовые операции — статьи с видом деятельности «Финансовая» (kind=3).
      </p>
    </div>
  )
}
