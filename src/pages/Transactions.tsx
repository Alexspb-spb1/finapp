import { useState, useRef, useEffect, Fragment } from 'react'
import { Trash2, Filter, Plus, Maximize2, Minimize2, Pencil, X, Zap } from 'lucide-react'
import { useStore } from '../store/useStore'
import { formatCurrency, formatDate } from '../utils/format'
import type { Transaction, TransactionType } from '../types'
import TransactionModal from '../components/transactions/TransactionModal'
import TransactionEditModal from '../components/transactions/TransactionEditModal'
import TransactionRulesModal from '../components/transactions/TransactionRulesModal'
import CategoryIcon from '../utils/categoryIcons'

// ─── Inline edit cell ─────────────────────────────────────────────────────────
interface InlineEdit { id: string; field: 'amount' | 'comment'; value: string }

function stripCounterpart(s: string): string {
  const pipe = s.indexOf(' | ')
  return pipe !== -1 ? s.slice(pipe + 3) : s
}

function InlineAmountCell({
  tx, onStart, active, editVal, onChange, onSave, onCancel,
}: {
  tx: Transaction
  onStart: () => void
  active: boolean
  editVal: string
  onChange: (v: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (active) inputRef.current?.select() }, [active])

  if (active) {
    return (
      <td className="px-2 py-2" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-1">
          <input
            ref={inputRef}
            value={editVal}
            onChange={e => onChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') onCancel() }}
            onBlur={onSave}
            className="w-full border border-indigo-400 rounded px-2 py-1 text-sm font-semibold text-right outline-none focus:ring-2 focus:ring-indigo-300"
          />
        </div>
      </td>
    )
  }
  return (
    <td
      className={`px-4 py-3.5 text-sm font-semibold text-right whitespace-nowrap overflow-hidden cursor-text group/cell ${
        tx.type === 'income' ? 'text-emerald-600' : tx.type === 'expense' ? 'text-red-500' : 'text-indigo-500'
      }`}
      onClick={e => { e.stopPropagation(); onStart() }}
      title="Нажмите для редактирования"
    >
      {tx.type === 'income' ? '+' : tx.type === 'expense' ? '−' : '⇄'}{formatCurrency(tx.amount)}
      <span className="ml-1 opacity-0 group-hover/cell:opacity-40 text-xs">✏</span>
    </td>
  )
}

function InlineCommentCell({
  tx, onStart, active, editVal, onChange, onSave, onCancel,
}: {
  tx: Transaction
  onStart: () => void
  active: boolean
  editVal: string
  onChange: (v: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (active) inputRef.current?.focus() }, [active])

  if (active) {
    return (
      <td className="px-2 py-2" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-1">
          <input
            ref={inputRef}
            value={editVal}
            onChange={e => onChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') onCancel() }}
            onBlur={onSave}
            placeholder="Назначение платежа..."
            className="w-full border border-indigo-400 rounded px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-indigo-300"
          />
        </div>
      </td>
    )
  }
  return (
    <td
      className="px-4 py-3.5 text-sm text-slate-500 overflow-hidden cursor-text group/cell"
      onClick={e => { e.stopPropagation(); onStart() }}
      title="Нажмите для редактирования"
    >
      <span className="block truncate">
        {tx.comment ? stripCounterpart(tx.comment) : <span className="text-slate-300 italic">— нажмите для ввода</span>}
        <span className="ml-1 opacity-0 group-hover/cell:opacity-40 text-xs">✏</span>
      </span>
    </td>
  )
}

// ─── Column definitions ───────────────────────────────────────────────────────

const COLS = [
  { key: 'date',         label: 'Дата',            defaultW: 110, minW: 80  },
  { key: 'type',         label: 'Тип',              defaultW: 100, minW: 70  },
  { key: 'category',     label: 'Статья',           defaultW: 155, minW: 80  },
  { key: 'account',      label: 'Счёт',             defaultW: 120, minW: 80  },
  { key: 'counterparty', label: 'Контрагент',       defaultW: 130, minW: 80  },
  { key: 'cp_account',   label: 'Банк контрагента', defaultW: 155, minW: 100 },
  { key: 'project',      label: 'Проект',           defaultW: 110, minW: 80  },
  { key: 'comment',      label: 'Назначение платежа', defaultW: 190, minW: 80  },
  { key: 'amount',       label: 'Сумма',            defaultW: 130, minW: 80  },
] as const

type ColKey = typeof COLS[number]['key']
type ColWidths = Record<ColKey, number>

const DEFAULT_WIDTHS = Object.fromEntries(COLS.map(c => [c.key, c.defaultW])) as ColWidths
const MIN_WIDTHS     = Object.fromEntries(COLS.map(c => [c.key, c.minW]))     as Record<ColKey, number>

// ─── Component ────────────────────────────────────────────────────────────────

export default function Transactions() {
  const store = useStore()
  const { transactions, accounts, categories, counterparties, projects } = store

  const [typeFilter,   setTypeFilter]   = useState<TransactionType | 'all'>('all')
  const [search,       setSearch]       = useState('')
  const [addOpen,      setAddOpen]      = useState(false)
  const [rulesOpen,    setRulesOpen]    = useState(false)
  const [editTx,       setEditTx]       = useState<Transaction | null>(null)
  const [fullscreen,   setFullscreen]   = useState(false)
  const [colWidths,    setColWidths]    = useState<ColWidths>(DEFAULT_WIDTHS)
  const [selected,     setSelected]     = useState<Set<string>>(new Set())
  const [bulkConfirm,  setBulkConfirm]  = useState(false)
  const [inlineEdit,   setInlineEdit]   = useState<InlineEdit | null>(null)

  // ── Inline edit helpers ────────────────────────────────────────────────────
  function startInline(id: string, field: 'amount' | 'comment', current: string) {
    setInlineEdit({ id, field, value: current })
  }

  function saveInline() {
    if (!inlineEdit) return
    const { id, field, value } = inlineEdit
    if (field === 'amount') {
      const num = parseFloat(value.replace(/\s/g, '').replace(',', '.'))
      if (num > 0) store.updateTransaction(id, { amount: num })
    } else {
      store.updateTransaction(id, { comment: value })
    }
    setInlineEdit(null)
  }

  function cancelInline() { setInlineEdit(null) }

  const checkAllRef = useRef<HTMLInputElement>(null)

  // ── Select-all indeterminate state ─────────────────────────────────────────
  useEffect(() => {
    if (!checkAllRef.current) return
    const n = filtered.length
    checkAllRef.current.indeterminate = selected.size > 0 && selected.size < n
  })

  // ── Column resize ──────────────────────────────────────────────────────────
  const colResizeKey    = useRef<ColKey | null>(null)
  const colResizeStartX = useRef(0)
  const colResizeStartW = useRef(0)

  function startColResize(e: React.MouseEvent, key: ColKey) {
    e.preventDefault()
    colResizeKey.current    = key
    colResizeStartX.current = e.clientX
    colResizeStartW.current = colWidths[key]
    function onMove(ev: MouseEvent) {
      if (!colResizeKey.current) return
      const k = colResizeKey.current
      setColWidths(prev => ({ ...prev, [k]: Math.max(MIN_WIDTHS[k], colResizeStartW.current + ev.clientX - colResizeStartX.current) }))
    }
    function onUp() { colResizeKey.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
  }

  // ── Filtering ──────────────────────────────────────────────────────────────
  const filtered = transactions.filter(t => {
    if (typeFilter !== 'all' && t.type !== typeFilter) return false
    if (search) {
      const cat  = categories.find(c => c.id === t.categoryId)
      const cp   = counterparties.find(c => c.id === t.counterpartyId)
      const proj = projects.find(p => p.id === t.projectId)
      const q    = search.toLowerCase()
      if (
        !(t.comment ?? '').toLowerCase().includes(q) &&
        !cat?.name.toLowerCase().includes(q) &&
        !cp?.name.toLowerCase().includes(q) &&
        !proj?.name.toLowerCase().includes(q)
      ) return false
    }
    return true
  })

  // ── Selection helpers ──────────────────────────────────────────────────────
  const allSelected  = filtered.length > 0 && filtered.every(t => selected.has(t.id))

  function toggleOne(id: string) {
    setSelected(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })
  }

  function toggleAll() {
    if (allSelected) {
      setSelected(prev => { const s = new Set(prev); filtered.forEach(t => s.delete(t.id)); return s })
    } else {
      setSelected(prev => { const s = new Set(prev); filtered.forEach(t => s.add(t.id)); return s })
    }
  }

  function handleBulkDelete() {
    store.deleteTransactions([...selected])
    setSelected(new Set())
    setBulkConfirm(false)
  }

  const typeTabs: { value: TransactionType | 'all'; label: string }[] = [
    { value: 'all',      label: 'Все'      },
    { value: 'income',   label: 'Доходы'   },
    { value: 'expense',  label: 'Расходы'  },
    { value: 'transfer', label: 'Переводы' },
  ]

  // checkbox(32) + cols + edit(40) + delete(48)
  const totalW = 32 + COLS.reduce((s, c) => s + colWidths[c.key], 0) + 40 + 48

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className={fullscreen ? 'fixed inset-0 z-40 bg-white flex flex-col p-4 gap-3 overflow-hidden' : 'flex flex-col gap-4 md:h-full'}>

      {/* Toolbar */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm flex flex-wrap gap-3 items-center shrink-0">
        <div className="flex gap-1 bg-slate-100 rounded-lg p-1">
          {typeTabs.map(({ value, label }) => (
            <button key={value} onClick={() => setTypeFilter(value)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                typeFilter === value ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}>
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 flex-1 min-w-40">
          <Filter size={14} className="text-slate-400" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Поиск по статье, контрагенту, проекту..."
            className="bg-transparent text-sm outline-none w-full text-slate-600 placeholder:text-slate-400" />
        </div>

        <button onClick={() => setFullscreen(v => !v)}
          title={fullscreen ? 'Свернуть' : 'На весь экран'}
          className="p-2 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-indigo-600 transition-colors">
          {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>

        <button onClick={() => setRulesOpen(true)}
          className="flex items-center gap-2 border border-slate-200 text-slate-600 hover:bg-slate-50 text-sm font-medium px-3 py-2 rounded-lg transition-colors"
          title="Правила автозаполнения">
          <Zap size={16} className="text-indigo-500" />
          <span className="hidden sm:inline">Правила</span>
          {store.rules.filter(r => r.enabled).length > 0 && (
            <span className="bg-indigo-100 text-indigo-700 text-xs font-bold px-1.5 py-0.5 rounded-full">
              {store.rules.filter(r => r.enabled).length}
            </span>
          )}
        </button>

        <button onClick={() => setAddOpen(true)}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
          <Plus size={16} /> Добавить
        </button>
      </div>

      {/* ── Mobile card list (hidden on md+) ─────────────────────────── */}
      <div className="md:hidden bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {selected.size > 0 && (
          <div className="flex items-center justify-between px-4 py-2.5 bg-indigo-50 border-b border-indigo-100">
            <span className="text-sm font-medium text-indigo-700">Выбрано: <b>{selected.size}</b></span>
            <div className="flex gap-2">
              <button onClick={() => setSelected(new Set())}
                className="text-xs text-indigo-500 px-3 py-1.5 rounded-lg hover:bg-indigo-100">
                Снять
              </button>
              <button onClick={() => setBulkConfirm(true)}
                className="text-xs text-white bg-red-500 px-3 py-1.5 rounded-lg font-medium">
                Удалить {selected.size}
              </button>
            </div>
          </div>
        )}

        {filtered.length === 0 ? (
          <p className="py-12 text-center text-slate-400 text-sm">Нет операций</p>
        ) : (
          <ul className="divide-y divide-slate-50">
            {filtered.map(t => {
              const cat  = categories.find(c => c.id === t.categoryId)
              const acc  = accounts.find(a => a.id === t.accountId)
              const cp   = counterparties.find(c => c.id === t.counterpartyId)
              const isSel = selected.has(t.id)
              return (
                <li
                  key={t.id}
                  onClick={() => setEditTx(t)}
                  className={`flex items-center gap-3 px-4 py-3.5 cursor-pointer active:bg-slate-50 ${isSel ? 'bg-indigo-50/60' : ''}`}
                >
                  {/* Checkbox */}
                  <input
                    type="checkbox"
                    checked={isSel}
                    onChange={e => { e.stopPropagation(); toggleOne(t.id) }}
                    onClick={e => e.stopPropagation()}
                    className="w-4 h-4 accent-indigo-600 cursor-pointer shrink-0"
                  />

                  {/* Category icon */}
                  <div className="w-9 h-9 icon-circle flex items-center justify-center shrink-0"
                    style={{ background: (cat?.color ?? '#94a3b8') + '20' }}>
                    <CategoryIcon name={cat?.icon ?? 'DollarSign'} size={15} color={cat?.color ?? '#94a3b8'} />
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="text-sm font-medium text-slate-700 truncate">{cat?.name ?? '—'}</span>
                      <span className={`shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                        t.type === 'income'   ? 'bg-emerald-50 text-emerald-700'
                        : t.type === 'expense' ? 'bg-red-50 text-red-700'
                        : 'bg-indigo-50 text-indigo-700'
                      }`}>
                        {t.type === 'income' ? 'Доход' : t.type === 'expense' ? 'Расход' : 'Перевод'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 truncate">
                      {formatDate(t.date)}
                      {acc && <span> · {acc.name}</span>}
                      {cp  && <span> · {cp.name}</span>}
                      {t.comment && <span> · {t.comment}</span>}
                    </p>
                  </div>

                  {/* Amount */}
                  <span className={`text-sm font-bold whitespace-nowrap shrink-0 ${
                    t.type === 'income'   ? 'text-emerald-600'
                    : t.type === 'expense' ? 'text-red-500'
                    : 'text-indigo-500'
                  }`}>
                    {t.type === 'income' ? '+' : t.type === 'expense' ? '−' : '⇄'}{formatCurrency(t.amount)}
                  </span>
                </li>
              )
            })}
          </ul>
        )}

        <div className="px-4 py-2.5 border-t border-slate-100 bg-slate-50/50">
          <p className="text-xs text-slate-400">Показано {filtered.length} из {transactions.length}</p>
        </div>
      </div>

      {/* ── Desktop table (hidden below md) ───────────────────────────── */}
      {/* Table card */}
      <div className={`hidden md:flex flex-1 min-h-0 bg-white rounded-xl border border-slate-200 shadow-sm flex-col overflow-hidden ${fullscreen ? '!flex' : ''}`}>

        {/* Bulk action bar */}
        {selected.size > 0 && (
          <div className="flex items-center justify-between px-5 py-2.5 bg-indigo-50 border-b border-indigo-100 shrink-0">
            <span className="text-sm font-medium text-indigo-700">
              Выбрано: <span className="font-bold">{selected.size}</span>
            </span>
            <div className="flex items-center gap-2">
              <button onClick={() => setSelected(new Set())}
                className="flex items-center gap-1.5 text-xs text-indigo-500 hover:text-indigo-700 px-3 py-1.5 rounded-lg hover:bg-indigo-100 transition">
                <X size={12} /> Снять выделение
              </button>
              <button onClick={() => setBulkConfirm(true)}
                className="flex items-center gap-1.5 text-xs text-white bg-red-500 hover:bg-red-600 px-3 py-1.5 rounded-lg transition font-medium">
                <Trash2 size={12} /> Удалить {selected.size}
              </button>
            </div>
          </div>
        )}

        {/* Scroll area */}
        <div className="overflow-auto flex-1 min-h-0">
          <table style={{ tableLayout: 'fixed', minWidth: totalW, width: '100%' }}>
            <colgroup>
              <col style={{ width: 32 }} />
              {COLS.map(c => <col key={c.key} style={{ width: colWidths[c.key] }} />)}
              <col style={{ width: 40 }} />
              <col style={{ width: 48 }} />
            </colgroup>

            <thead>
              <tr className="border-b border-slate-100 bg-slate-50 sticky top-0 z-10">
                {/* Checkbox col */}
                <th className="w-8 px-2 py-3 text-center">
                  <input
                    ref={checkAllRef}
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="w-4 h-4 accent-indigo-600 cursor-pointer rounded"
                    title="Выбрать все"
                  />
                </th>

                {COLS.map(col => (
                  <th key={col.key}
                    className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3 relative group/th select-none overflow-hidden"
                    style={{ width: colWidths[col.key] }}>
                    <span className={col.key === 'amount' ? 'block text-right pr-1' : 'block truncate'}>
                      {col.label}
                    </span>
                    <div
                      onMouseDown={e => startColResize(e, col.key)}
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize opacity-0 group-hover/th:opacity-100 hover:!opacity-100 bg-indigo-300 rounded-r transition-opacity z-20"
                    />
                  </th>
                ))}

                <th className="w-10 px-2 py-3" />
                <th className="w-12 px-2 py-3" />
              </tr>
            </thead>

            <tbody>
              {filtered.map((t, i) => {
                const cat  = categories.find(c => c.id === t.categoryId)
                const acc  = accounts.find(a => a.id === t.accountId)
                const cp   = counterparties.find(c => c.id === t.counterpartyId)
                const proj = projects.find(p => p.id === t.projectId)
                const isSel = selected.has(t.id)

                return (
                  <Fragment key={t.id}>
                    <tr
                      onClick={() => setEditTx(t)}
                      className={`border-b border-slate-50 cursor-pointer transition-colors group/row ${
                        isSel
                          ? 'bg-indigo-50/60'
                          : i % 2 === 0 ? 'hover:bg-indigo-50/30' : 'bg-slate-50/30 hover:bg-indigo-50/40'
                      }`}
                    >
                      {/* Checkbox */}
                      <td className="px-2 py-3 text-center" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSel}
                          onChange={() => toggleOne(t.id)}
                          className="w-4 h-4 accent-indigo-600 cursor-pointer rounded"
                        />
                      </td>

                      {/* Date */}
                      <td className="px-4 py-3.5 text-sm text-slate-500 overflow-hidden whitespace-nowrap text-ellipsis">
                        {formatDate(t.date)}
                      </td>

                      {/* Type */}
                      <td className="px-4 py-3.5 overflow-hidden">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${
                          t.type === 'income'   ? 'bg-emerald-50 text-emerald-700'
                          : t.type === 'expense' ? 'bg-red-50 text-red-700'
                          : 'bg-indigo-50 text-indigo-700'
                        }`}>
                          {t.type === 'income' ? 'Доход' : t.type === 'expense' ? 'Расход' : 'Перевод'}
                        </span>
                      </td>

                      {/* Category */}
                      <td className="px-4 py-3.5 overflow-hidden">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-6 h-6 icon-circle flex items-center justify-center shrink-0" style={{ background: (cat?.color ?? '#94a3b8') + '20' }}>
                            <CategoryIcon name={cat?.icon ?? 'DollarSign'} size={13} color={cat?.color ?? '#94a3b8'} />
                          </div>
                          <span className="text-sm text-slate-700 truncate">{cat?.name ?? '—'}</span>
                        </div>
                      </td>

                      {/* Account */}
                      <td className="px-4 py-3.5 text-sm text-slate-600 overflow-hidden whitespace-nowrap text-ellipsis">
                        {acc?.name ?? '—'}
                      </td>

                      {/* Counterparty */}
                      <td className="px-4 py-3.5 text-sm text-slate-600 overflow-hidden whitespace-nowrap text-ellipsis">
                        {cp?.name ?? '—'}
                      </td>

                      {/* Bank */}
                      <td className="px-4 py-3.5 text-sm text-slate-600 overflow-hidden whitespace-nowrap text-ellipsis">
                        {cp?.bankName || <span className="text-slate-300">—</span>}
                      </td>

                      {/* Project */}
                      <td className="px-4 py-3.5 overflow-hidden">
                        {proj
                          ? <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap"
                              style={{ background: proj.color + '20', color: proj.color }}>
                              {proj.name}
                            </span>
                          : <span className="text-sm text-slate-300">—</span>
                        }
                      </td>

                      {/* Comment — inline editable */}
                      <InlineCommentCell
                        tx={t}
                        onStart={() => startInline(t.id, 'comment', stripCounterpart(t.comment ?? ''))}
                        active={inlineEdit?.id === t.id && inlineEdit?.field === 'comment'}
                        editVal={inlineEdit?.id === t.id && inlineEdit?.field === 'comment' ? inlineEdit.value : ''}
                        onChange={v => setInlineEdit(prev => prev ? { ...prev, value: v } : null)}
                        onSave={saveInline}
                        onCancel={cancelInline}
                      />

                      {/* Amount — inline editable */}
                      <InlineAmountCell
                        tx={t}
                        onStart={() => startInline(t.id, 'amount', String(t.amount))}
                        active={inlineEdit?.id === t.id && inlineEdit?.field === 'amount'}
                        editVal={inlineEdit?.id === t.id && inlineEdit?.field === 'amount' ? inlineEdit.value : ''}
                        onChange={v => setInlineEdit(prev => prev ? { ...prev, value: v } : null)}
                        onSave={saveInline}
                        onCancel={cancelInline}
                      />

                      {/* Edit */}
                      <td className="px-2 py-3.5 text-center">
                        <button
                          onClick={e => { e.stopPropagation(); setEditTx(t) }}
                          className="p-1.5 rounded-lg text-slate-200 group-hover/row:text-slate-400 hover:!text-indigo-500 hover:bg-indigo-50 transition-colors">
                          <Pencil size={13} />
                        </button>
                      </td>

                      {/* Delete */}
                      <td className="px-2 py-3.5 text-center">
                        <button
                          onClick={e => { e.stopPropagation(); store.deleteTransaction(t.id) }}
                          className="p-1.5 rounded-lg text-slate-200 group-hover/row:text-slate-400 hover:!text-red-500 hover:bg-red-50 transition-colors">
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  </Fragment>
                )
              })}

              {filtered.length === 0 && (
                <tr>
                  <td colSpan={12} className="px-5 py-12 text-center text-slate-400 text-sm">
                    Нет операций
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Status bar */}
        <div className="px-5 py-2 border-t border-slate-100 flex items-center shrink-0 bg-slate-50/50">
          <p className="text-xs text-slate-400">
            Показано {filtered.length} из {transactions.length}
            {selected.size > 0 && <span className="text-indigo-500 font-medium"> · выбрано {selected.size}</span>}
          </p>
        </div>
      </div>

      {/* Bulk delete confirm */}
      {bulkConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 text-center">
            <div className="text-3xl mb-3">🗑️</div>
            <h3 className="text-base font-semibold text-slate-800 mb-1">Удалить операции?</h3>
            <p className="text-sm text-slate-500 mb-5">
              Будет удалено <span className="font-semibold text-slate-700">{selected.size}</span> операций без возможности восстановления.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setBulkConfirm(false)}
                className="flex-1 py-2.5 border border-slate-200 text-sm text-slate-600 font-medium rounded-lg hover:bg-slate-50 transition">
                Отмена
              </button>
              <button onClick={handleBulkDelete}
                className="flex-1 py-2.5 bg-red-500 hover:bg-red-600 text-white text-sm font-medium rounded-lg transition">
                Удалить
              </button>
            </div>
          </div>
        </div>
      )}

      <TransactionModal open={addOpen} onClose={() => setAddOpen(false)} />
      <TransactionEditModal transaction={editTx} onClose={() => setEditTx(null)} />
      <TransactionRulesModal open={rulesOpen} onClose={() => setRulesOpen(false)} />
    </div>
  )
}
