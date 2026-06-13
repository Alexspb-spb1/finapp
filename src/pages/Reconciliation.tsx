import { useState, useRef } from 'react'
import {
  Upload, CheckCircle2, XCircle, AlertCircle, FileText,
  GitCompare, RefreshCw, ChevronDown, ChevronUp,
} from 'lucide-react'
import { useStore } from '../store/useStore'
import { parseBankStatement } from '../utils/bankStatementParser'
import type { ParsedTransaction } from '../utils/bankStatementParser'
import { formatCurrency } from '../utils/format'
import type { Transaction } from '../types'

// ── Types ─────────────────────────────────────────────────────────────────────
type MatchStatus = 'matched' | 'date-diff' | 'bank-only' | 'app-only'

interface MatchRow {
  status: MatchStatus
  bankTx?: ParsedTransaction
  appTx?: Transaction
  dateDiff?: number
}

// ── Matching algorithm ────────────────────────────────────────────────────────
function daysBetween(a: string, b: string): number {
  return Math.abs(
    Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000)
  )
}

function matchTransactions(
  bankTxs: ParsedTransaction[],
  allTxs: Transaction[],
  accountId: string,
): MatchRow[] {
  // Only non-transfer transactions for the selected account
  const appTxs = allTxs.filter(
    t => t.accountId === accountId && (t.type === 'income' || t.type === 'expense'),
  )

  const usedBank = new Set<number>()
  const usedApp  = new Set<string>()
  const rows: MatchRow[] = []

  // Pass 1 — exact date + amount + type
  for (let bi = 0; bi < bankTxs.length; bi++) {
    const b = bankTxs[bi]
    for (const a of appTxs) {
      if (usedApp.has(a.id)) continue
      if (a.amount !== b.amount || a.type !== b.type) continue
      if (a.date === b.date) {
        rows.push({ status: 'matched', bankTx: b, appTx: a })
        usedBank.add(bi); usedApp.add(a.id)
        break
      }
    }
  }

  // Pass 2 — ±3 days, same amount + type
  for (let bi = 0; bi < bankTxs.length; bi++) {
    if (usedBank.has(bi)) continue
    const b = bankTxs[bi]
    let best: Transaction | null = null; let bestDiff = 4
    for (const a of appTxs) {
      if (usedApp.has(a.id)) continue
      if (a.amount !== b.amount || a.type !== b.type) continue
      const diff = daysBetween(a.date, b.date)
      if (diff < bestDiff) { bestDiff = diff; best = a }
    }
    if (best) {
      rows.push({ status: 'date-diff', bankTx: b, appTx: best, dateDiff: bestDiff })
      usedBank.add(bi); usedApp.add(best.id)
    }
  }

  // Remaining bank → bank-only
  bankTxs.forEach((b, i) => { if (!usedBank.has(i)) rows.push({ status: 'bank-only', bankTx: b }) })

  // Remaining app → app-only
  appTxs.forEach(a => { if (!usedApp.has(a.id)) rows.push({ status: 'app-only', appTx: a }) })

  // Sort by date
  rows.sort((a, b) => {
    const da = a.bankTx?.date ?? a.appTx?.date ?? ''
    const db = b.bankTx?.date ?? b.appTx?.date ?? ''
    return da < db ? -1 : da > db ? 1 : 0
  })

  return rows
}

function fmtDate(iso: string) {
  return iso ? iso.split('-').reverse().join('.') : '—'
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function Reconciliation() {
  const store = useStore()

  const [accountId,        setAccountId]        = useState(store.accounts[0]?.id ?? '')
  const [dateFrom,         setDateFrom]         = useState('')
  const [dateTo,           setDateTo]           = useState('')
  const [rows,             setRows]             = useState<MatchRow[] | null>(null)
  const [bankTxs,          setBankTxs]          = useState<ParsedTransaction[]>([])
  const [filter,           setFilter]           = useState<'all' | MatchStatus>('all')
  const [fileName,         setFileName]         = useState('')
  const [bankName,         setBankName]         = useState('')
  const [bankOpeningBal,   setBankOpeningBal]   = useState<number | undefined>(undefined)
  const [bankClosingBal,   setBankClosingBal]   = useState<number | undefined>(undefined)
  const [error,            setError]            = useState('')
  const [showAll,          setShowAll]          = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const account = store.accounts.find(a => a.id === accountId)

  // ── File upload ──────────────────────────────────────────────────────────────
  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    setError('')

    const tryParse = (text: string) => {
      const result = parseBankStatement(text)
      if (!result.ok || result.transactions.length === 0) {
        setError('Не удалось распознать формат файла. Поддерживаются: 1С (1CClientBankExchange), CSV, TXT.')
        return
      }
      setBankName(result.bankName)
      setBankTxs(result.transactions)
      setBankOpeningBal(result.openingBalance)
      setBankClosingBal(result.closingBalance)
      runMatch(result.transactions)
    }

    // Try windows-1251 first (common for 1C files), then UTF-8
    const r1 = new FileReader()
    r1.onload = ev => {
      const text = ev.target?.result as string
      if (text.includes('1CClientBankExchange') || text.includes('СекцияДокумент')) {
        tryParse(text)
      } else {
        // Try UTF-8
        const r2 = new FileReader()
        r2.onload = ev2 => tryParse(ev2.target?.result as string)
        r2.readAsText(file, 'utf-8')
      }
    }
    r1.readAsText(file, 'windows-1251')

    // Reset file input so same file can be re-selected
    e.target.value = ''
  }

  // ── Run match ────────────────────────────────────────────────────────────────
  function runMatch(btxs: ParsedTransaction[] = bankTxs) {
    if (!btxs.length) return
    const filtered = btxs.filter(t => {
      if (dateFrom && t.date < dateFrom) return false
      if (dateTo   && t.date > dateTo)   return false
      return true
    })
    setRows(matchTransactions(filtered, store.transactions, accountId))
    setFilter('all')
    setShowAll(false)
  }

  // ── Derived stats ────────────────────────────────────────────────────────────
  const stats = rows ? {
    matched:  rows.filter(r => r.status === 'matched').length,
    dateDiff: rows.filter(r => r.status === 'date-diff').length,
    bankOnly: rows.filter(r => r.status === 'bank-only').length,
    appOnly:  rows.filter(r => r.status === 'app-only').length,
    total:    rows.length,
  } : null

  const visibleRows = (
    filter === 'all'
      ? rows ?? []
      : (rows ?? []).filter(r => r.status === filter)
  )
  const displayRows = showAll ? visibleRows : visibleRows.slice(0, 100)

  // ── Status config ─────────────────────────────────────────────────────────────
  const statusCfg: Record<MatchStatus, { label: string; bg: string; text: string; dot: string }> = {
    'matched':   { label: 'Совпадает',       bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
    'date-diff': { label: 'Дата ±',          bg: 'bg-amber-50',   text: 'text-amber-700',   dot: 'bg-amber-400'   },
    'bank-only': { label: 'Только в выписке', bg: 'bg-red-50',    text: 'text-red-600',     dot: 'bg-red-500'     },
    'app-only':  { label: 'Только в учёте',  bg: 'bg-blue-50',   text: 'text-blue-700',    dot: 'bg-blue-500'    },
  }

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-5">

      {/* Title */}
      <div>
        <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
          <GitCompare size={20} className="text-indigo-600" />
          Сверка остатков
        </h1>
        <p className="text-sm text-slate-400 mt-1">
          Сравнение операций ФинУчёта с банковской выпиской
        </p>
      </div>

      {/* Setup panel */}
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="flex flex-wrap gap-4 items-end">

          {/* Account */}
          <div className="flex-1 min-w-[160px]">
            <label className="text-xs font-medium text-slate-500 mb-1.5 block">Счёт</label>
            <select
              value={accountId}
              onChange={e => setAccountId(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {store.accounts.length === 0 && (
                <option value="">Нет счетов</option>
              )}
              {store.accounts.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>

          {/* Date from */}
          <div>
            <label className="text-xs font-medium text-slate-500 mb-1.5 block">С</label>
            <input
              type="date"
              value={dateFrom}
              onChange={e => setDateFrom(e.target.value)}
              className="border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          {/* Date to */}
          <div>
            <label className="text-xs font-medium text-slate-500 mb-1.5 block">По</label>
            <input
              type="date"
              value={dateTo}
              onChange={e => setDateTo(e.target.value)}
              className="border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          {/* File upload */}
          <div>
            <label className="text-xs font-medium text-slate-500 mb-1.5 block">Выписка банка</label>
            <button
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-2 border border-dashed border-indigo-300 hover:border-indigo-500 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-sm font-medium px-4 py-2 rounded-lg transition"
            >
              <Upload size={14} />
              {fileName || 'Загрузить файл (CSV / 1C / TXT)'}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.csv,.1c,.xls,.xlsx"
              onChange={handleFile}
              className="hidden"
            />
          </div>

          {/* Re-run button if bank data loaded */}
          {bankTxs.length > 0 && (
            <button
              onClick={() => runMatch()}
              className="flex items-center gap-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium px-4 py-2 rounded-lg transition"
            >
              <RefreshCw size={14} />
              Пересчитать
            </button>
          )}
        </div>

        {/* Loaded file info */}
        {bankTxs.length > 0 && (
          <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
            <FileText size={12} className="shrink-0" />
            <span className="font-medium text-slate-700">{fileName}</span>
            {bankName && <span className="text-slate-400">· {bankName}</span>}
            <span className="text-slate-400">· {bankTxs.length} операций загружено</span>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-600 rounded-xl px-4 py-3 text-sm flex items-center gap-2">
          <XCircle size={16} className="shrink-0" />
          {error}
        </div>
      )}

      {/* Empty state */}
      {!rows && !error && (
        <div className="bg-white border border-slate-200 rounded-xl py-16 text-center">
          <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <GitCompare size={24} className="text-slate-400" />
          </div>
          <p className="font-medium text-slate-700">Загрузите выписку банка</p>
          <p className="text-sm text-slate-400 mt-1">
            Поддерживаются файлы 1С (1CClientBankExchange) и CSV/TXT
          </p>
        </div>
      )}

      {/* Results */}
      {rows && stats && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {(
              [
                { key: 'matched',   label: 'Совпадают',        count: stats.matched,  icon: CheckCircle2, color: 'text-emerald-600 bg-emerald-50 border-emerald-200' },
                { key: 'date-diff', label: 'Дата отличается',  count: stats.dateDiff, icon: AlertCircle,  color: 'text-amber-600 bg-amber-50 border-amber-200' },
                { key: 'bank-only', label: 'Только в выписке', count: stats.bankOnly, icon: XCircle,      color: 'text-red-600 bg-red-50 border-red-200' },
                { key: 'app-only',  label: 'Только в учёте',   count: stats.appOnly,  icon: AlertCircle,  color: 'text-blue-600 bg-blue-50 border-blue-200' },
              ] as const
            ).map(({ key, label, count, icon: Icon, color }) => (
              <button
                key={key}
                onClick={() => setFilter(filter === key ? 'all' : key)}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all ${color} ${filter === key ? 'ring-2 ring-offset-1 ring-current' : 'opacity-80 hover:opacity-100'}`}
              >
                <Icon size={20} className="shrink-0" />
                <div>
                  <div className="text-2xl font-bold leading-none">{count}</div>
                  <div className="text-xs mt-0.5 opacity-75">{label}</div>
                </div>
              </button>
            ))}
          </div>

          {/* Account balance summary */}
          {account && (() => {
            const allAccTxs = store.transactions.filter(
              t => t.accountId === accountId && (t.type === 'income' || t.type === 'expense')
            )

            // Определяем начало периода (для расчёта начального остатка)
            const periodStart = dateFrom
              || (bankTxs.length > 0
                ? bankTxs.reduce((mn, t) => t.date < mn ? t.date : mn, bankTxs[0].date)
                : '')

            // Начальный остаток по программе = текущий баланс − операции начиная с periodStart
            const appOpeningBal = periodStart
              ? (() => {
                  const txsFrom = allAccTxs.filter(t => t.date >= periodStart)
                  const incFrom = txsFrom.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0)
                  const expFrom = txsFrom.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0)
                  return account.balance - incFrom + expFrom
                })()
              : undefined

            const appFiltered = allAccTxs.filter(t => {
              if (dateFrom && t.date < dateFrom) return false
              if (dateTo   && t.date > dateTo)   return false
              return true
            })
            const appInc = appFiltered.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0)
            const appExp = appFiltered.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0)

            const filteredBankTxs = bankTxs.filter(t => {
              if (dateFrom && t.date < dateFrom) return false
              if (dateTo   && t.date > dateTo)   return false
              return true
            })
            const bankInc = filteredBankTxs.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0)
            const bankExp = filteredBankTxs.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0)

            const diffInc = bankInc - appInc
            const diffExp = bankExp - appExp

            const showBalances = bankOpeningBal !== undefined || appOpeningBal !== undefined

            return (
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100 bg-slate-50">
                  <h3 className="text-sm font-semibold text-slate-700">Сводка по периоду — {account.name}</h3>
                </div>

                {/* Начальный остаток */}
                {showBalances && (
                  <div className="grid grid-cols-2 divide-x divide-slate-100 border-b border-slate-100 bg-indigo-50/40">
                    <div className="px-4 py-3 space-y-1.5">
                      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Начальный остаток</p>
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-slate-400">ФинУчёт</span>
                        <span className="font-bold text-slate-700">
                          {appOpeningBal !== undefined ? formatCurrency(appOpeningBal) : '—'}
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-slate-400">Выписка</span>
                        <span className="font-bold text-slate-700">
                          {bankOpeningBal !== undefined ? formatCurrency(bankOpeningBal) : '—'}
                        </span>
                      </div>
                      {appOpeningBal !== undefined && bankOpeningBal !== undefined && (() => {
                        const d = bankOpeningBal - appOpeningBal
                        return (
                          <div className={`flex justify-between border-t border-slate-100 pt-1.5 ${Math.abs(d) < 1 ? 'text-emerald-600' : 'text-red-500'}`}>
                            <span className="text-xs font-medium">Расхождение</span>
                            <span className="font-bold text-sm">
                              {Math.abs(d) < 1 ? '✓ 0' : (d > 0 ? '+' : '') + formatCurrency(d)}
                            </span>
                          </div>
                        )
                      })()}
                    </div>
                    <div className="px-4 py-3 space-y-1.5">
                      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Конечный остаток</p>
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-slate-400">ФинУчёт</span>
                        <span className="font-bold text-slate-700">
                          {appOpeningBal !== undefined ? formatCurrency(appOpeningBal + appInc - appExp) : '—'}
                        </span>
                      </div>
                      {/* Конечный по выписке считается из транзакций (согласованно с ФинУчётом) */}
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-slate-400">Выписка (расчёт)</span>
                        <span className="font-bold text-slate-700">
                          {bankOpeningBal !== undefined ? formatCurrency(bankOpeningBal + bankInc - bankExp) : '—'}
                        </span>
                      </div>
                      {appOpeningBal !== undefined && bankOpeningBal !== undefined && (() => {
                        const appClose  = appOpeningBal  + appInc  - appExp
                        const bankClose = bankOpeningBal + bankInc - bankExp
                        const d = bankClose - appClose
                        return (
                          <div className={`flex justify-between border-t border-slate-100 pt-1.5 ${Math.abs(d) < 1 ? 'text-emerald-600' : 'text-red-500'}`}>
                            <span className="text-xs font-medium">Расхождение</span>
                            <span className="font-bold text-sm">
                              {Math.abs(d) < 1 ? '✓ 0' : (d > 0 ? '+' : '') + formatCurrency(d)}
                            </span>
                          </div>
                        )
                      })()}
                      {/* Фактический остаток из файла (КонечныйОстаток) — может отличаться из-за банковских комиссий, процентов и др. */}
                      {bankClosingBal !== undefined && (() => {
                        const bankCalc = bankOpeningBal !== undefined ? bankOpeningBal + bankInc - bankExp : undefined
                        const hidden = bankCalc !== undefined && Math.abs(bankClosingBal - bankCalc) < 1
                        if (hidden) return null
                        const delta = bankCalc !== undefined ? bankClosingBal - bankCalc : undefined
                        return (
                          <div className="mt-1 pt-1.5 border-t border-dashed border-slate-200 space-y-1">
                            <div className="flex justify-between items-center">
                              <span className="text-xs text-slate-400">Файл банка (факт)</span>
                              <span className="font-semibold text-slate-600">{formatCurrency(bankClosingBal)}</span>
                            </div>
                            {delta !== undefined && Math.abs(delta) >= 1 && (
                              <div className="flex justify-between items-center text-amber-600">
                                <span className="text-xs">Вне выписки</span>
                                <span className="text-xs font-semibold" title="Комиссии, проценты, прочие банковские проводки не вошедшие в список операций">
                                  {delta > 0 ? '+' : ''}{formatCurrency(delta)} ⚠
                                </span>
                              </div>
                            )}
                          </div>
                        )
                      })()}
                    </div>
                  </div>
                )}

                {/* Обороты */}
                <div className="grid grid-cols-3 divide-x divide-slate-100 text-sm">
                  {[
                    { label: 'Поступления', app: appInc, bank: bankInc, diff: diffInc },
                    { label: 'Расходы',     app: appExp, bank: bankExp, diff: diffExp },
                    { label: 'Итого (нетто)', app: appInc - appExp, bank: bankInc - bankExp, diff: (bankInc - bankExp) - (appInc - appExp) },
                  ].map(({ label, app, bank, diff }) => (
                    <div key={label} className="px-4 py-3 space-y-1.5">
                      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</p>
                      <div className="flex justify-between">
                        <span className="text-slate-400 text-xs">ФинУчёт</span>
                        <span className="font-semibold text-slate-700">{formatCurrency(app)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400 text-xs">Выписка</span>
                        <span className="font-semibold text-slate-700">{formatCurrency(bank)}</span>
                      </div>
                      <div className={`flex justify-between border-t border-slate-100 pt-1.5 ${Math.abs(diff) < 1 ? 'text-emerald-600' : 'text-red-500'}`}>
                        <span className="text-xs font-medium">Расхождение</span>
                        <span className="font-bold text-sm">
                          {Math.abs(diff) < 1 ? '✓ 0' : (diff > 0 ? '+' : '') + formatCurrency(diff)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}

          {/* Results table */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-700">
                Детализация{filter !== 'all' && ` — ${statusCfg[filter as MatchStatus].label}`}
                <span className="ml-2 text-xs font-normal text-slate-400">{visibleRows.length} строк</span>
              </h3>
              {filter !== 'all' && (
                <button onClick={() => setFilter('all')} className="text-xs text-indigo-600 hover:underline">
                  Показать все
                </button>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50/50">
                    <th className="text-left text-xs font-semibold text-slate-400 uppercase tracking-wide px-4 py-2.5 w-32">Статус</th>
                    <th className="text-left text-xs font-semibold text-slate-400 uppercase tracking-wide px-3 py-2.5 w-24">Дата выписки</th>
                    <th className="text-left text-xs font-semibold text-slate-400 uppercase tracking-wide px-3 py-2.5 w-24">Дата учёта</th>
                    <th className="text-left text-xs font-semibold text-slate-400 uppercase tracking-wide px-3 py-2.5 w-40">Контрагент</th>
                    <th className="text-left text-xs font-semibold text-slate-400 uppercase tracking-wide px-3 py-2.5">Назначение платежа</th>
                    <th className="text-right text-xs font-semibold text-slate-400 uppercase tracking-wide px-4 py-2.5 w-36">Сумма (выписка)</th>
                    <th className="text-right text-xs font-semibold text-slate-400 uppercase tracking-wide px-4 py-2.5 w-36">Сумма (учёт)</th>
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((row, i) => {
                    const cfg      = statusCfg[row.status]
                    const bankAmt  = row.bankTx?.amount
                    const appAmt   = row.appTx?.amount
                    const bankType = row.bankTx?.type
                    const appType  = row.appTx?.type

                    // Контрагент: из выписки или из справочника учёта
                    const bankCp   = row.bankTx?.counterpart || ''
                    const appCp    = row.appTx?.counterpartyId
                      ? (store.counterparties.find(c => c.id === row.appTx!.counterpartyId)?.name ?? '')
                      : ''
                    const showBothCp = bankCp && appCp && bankCp.toLowerCase() !== appCp.toLowerCase()

                    // Назначение: из выписки (purpose) или из учёта (comment)
                    const bankPurpose = row.bankTx?.purpose || ''
                    const appComment  = row.appTx?.comment  || ''

                    return (
                      <tr key={i} className="border-b border-slate-50 hover:bg-slate-50/50 transition-colors">
                        <td className="px-4 py-2.5">
                          <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.bg} ${cfg.text}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} shrink-0`} />
                            {cfg.label}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs text-slate-500 whitespace-nowrap">
                          {row.bankTx ? fmtDate(row.bankTx.date) : '—'}
                        </td>
                        <td className={`px-3 py-2.5 font-mono text-xs whitespace-nowrap ${row.status === 'date-diff' ? 'text-amber-600 font-semibold' : 'text-slate-500'}`}>
                          {row.appTx ? fmtDate(row.appTx.date) : '—'}
                          {row.dateDiff ? <span className="ml-1 text-amber-500">(±{row.dateDiff}д)</span> : null}
                        </td>

                        {/* Контрагент */}
                        <td className="px-3 py-2.5 max-w-[160px]">
                          {bankCp ? (
                            <p className="text-xs text-slate-700 truncate" title={bankCp}>{bankCp}</p>
                          ) : null}
                          {showBothCp ? (
                            <p className="text-xs text-slate-400 truncate mt-0.5" title={appCp}>
                              <span className="text-slate-300">учёт: </span>{appCp}
                            </p>
                          ) : (!bankCp && appCp) ? (
                            <p className="text-xs text-slate-600 truncate" title={appCp}>{appCp}</p>
                          ) : null}
                          {!bankCp && !appCp && <span className="text-slate-300 text-xs">—</span>}
                        </td>

                        {/* Назначение платежа */}
                        <td className="px-3 py-2.5 max-w-xs">
                          {bankPurpose ? (
                            <p className="text-xs text-slate-600 truncate" title={bankPurpose}>{bankPurpose}</p>
                          ) : appComment ? (
                            <p className="text-xs text-slate-500 truncate" title={appComment}>{appComment}</p>
                          ) : (
                            <span className="text-slate-300 text-xs">—</span>
                          )}
                        </td>

                        <td className={`px-4 py-2.5 font-semibold text-right whitespace-nowrap ${bankType === 'income' ? 'text-emerald-600' : bankType === 'expense' ? 'text-red-500' : 'text-slate-400'}`}>
                          {bankAmt != null
                            ? (bankType === 'income' ? '+' : '−') + formatCurrency(bankAmt)
                            : '—'}
                        </td>
                        <td className={`px-4 py-2.5 font-semibold text-right whitespace-nowrap ${appType === 'income' ? 'text-emerald-600' : appType === 'expense' ? 'text-red-500' : 'text-slate-400'}`}>
                          {appAmt != null
                            ? (appType === 'income' ? '+' : '−') + formatCurrency(appAmt)
                            : '—'}
                        </td>
                      </tr>
                    )
                  })}

                  {visibleRows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="text-center py-10 text-slate-400 text-sm">
                        Нет строк с выбранным статусом
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {visibleRows.length > 100 && (
              <button
                onClick={() => setShowAll(v => !v)}
                className="w-full py-3 text-sm text-indigo-600 hover:bg-indigo-50 transition-colors flex items-center justify-center gap-1.5 border-t border-slate-100"
              >
                {showAll
                  ? <><ChevronUp size={14} /> Свернуть</>
                  : <><ChevronDown size={14} /> Показать все ({visibleRows.length})</>
                }
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
