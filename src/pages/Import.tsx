import { useState, useCallback } from 'react'
import { companyStore } from '../store/companyStore'
import { Upload, FileText, ChevronRight, ChevronLeft, CheckCircle2, AlertTriangle } from 'lucide-react'
import { useStore } from '../store/useStore'
import { parseFile, applyMapping } from '../utils/parseImport'
import type { ParsedFile, ImportRow } from '../utils/parseImport'
import type { Transaction } from '../types'

type Step = 1 | 2 | 3

interface Mapping {
  dateCol: string
  amountCol: string
  commentCol: string
  typeMode: 'sign' | 'column'
  typeCol: string
  incomeValue: string
  accountId: string
  defaultCategoryId: string
}

const NONE = ''

export default function Import() {
  const { accounts, categories, transactions: existingTx } = useStore()

  const [step, setStep]         = useState<Step>(1)
  const [file, setFile]         = useState<File | null>(null)
  const [parsed, setParsed]     = useState<ParsedFile | null>(null)
  const [loading, setLoading]   = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError]       = useState('')

  const [mapping, setMapping] = useState<Mapping>({
    dateCol: NONE, amountCol: NONE, commentCol: NONE,
    typeMode: 'sign', typeCol: NONE, incomeValue: 'приход',
    accountId: accounts[0]?.id ?? NONE,
    defaultCategoryId: NONE,
  })

  const [preview, setPreview]     = useState<ImportRow[]>([])
  const [rowCats, setRowCats]     = useState<Record<number, string>>({})
  const [skipDups, setSkipDups]   = useState(true)
  const [importing, setImporting] = useState(false)
  const [done, setDone]           = useState(false)
  const [importedCount, setImportedCount] = useState(0)

  // income/expense categories only
  const incomeCats  = categories.filter(c => c.type === 'income'  && !c.isGroup)
  const expenseCats = categories.filter(c => c.type === 'expense' && !c.isGroup)

  // ── Step 1: file selection ─────────────────────────────────────────────────
  async function handleFile(f: File) {
    setError('')
    setFile(f)
    setLoading(true)
    try {
      const result = await parseFile(f)
      if (result.headers.length === 0) {
        setError('Файл пустой или не удалось прочитать колонки.')
        setLoading(false)
        return
      }
      setParsed(result)
      // Auto-guess columns by header name
      const h = result.headers
      const find = (kws: string[]) =>
        h.find(col => kws.some(kw => col.toLowerCase().includes(kw))) ?? NONE

      setMapping(m => ({
        ...m,
        dateCol:    find(['дата', 'date']),
        amountCol:  find(['сумма', 'amount', 'сумма операции']),
        commentCol: find(['назначение', 'описание', 'comment', 'description', 'наименование']),
        accountId:  accounts[0]?.id ?? NONE,
      }))
    } catch {
      setError('Не удалось прочитать файл. Убедитесь что это .xlsx или .csv')
    }
    setLoading(false)
  }

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f) handleFile(f)
  }, [accounts])

  // ── Step 2 → 3: apply mapping, build preview ──────────────────────────────
  function goToStep3() {
    if (!parsed) return
    const rows = applyMapping(parsed.rows, mapping)
    setPreview(rows)
    // Init per-row category map with default
    const initCats: Record<number, string> = {}
    rows.forEach((r, i) => {
      initCats[i] = mapping.defaultCategoryId
        || ((r.type === 'income' ? incomeCats[0]?.id : expenseCats[0]?.id) ?? NONE)
    })
    setRowCats(initCats)
    setStep(3)
  }

  // ── Duplicate detection ────────────────────────────────────────────────────
  function isDuplicate(row: ImportRow): boolean {
    return existingTx.some(t =>
      t.date === row.date &&
      t.amount === row.amount &&
      t.comment === row.comment &&
      t.accountId === mapping.accountId
    )
  }

  // ── Step 3: import ─────────────────────────────────────────────────────────
  async function handleImport() {
    setImporting(true)
    let count = 0
    for (let i = 0; i < preview.length; i++) {
      const row = preview[i]
      if (skipDups && isDuplicate(row)) continue
      const catId = rowCats[i] || NONE
      if (!catId) continue
      const tx: Transaction = {
        id: 'tx_' + Date.now() + '_' + i,
        date: row.date,
        type: row.type,
        amount: row.amount,
        accountId: mapping.accountId,
        categoryId: catId,
        comment: row.comment,
        tags: [],
      }
      companyStore.addTransaction(tx)
      count++
      // Tiny yield to keep UI responsive
      if (i % 20 === 0) await new Promise(r => setTimeout(r, 0))
    }
    setImportedCount(count)
    setImporting(false)
    setDone(true)
  }

  function reset() {
    setStep(1); setFile(null); setParsed(null); setPreview([])
    setRowCats({}); setDone(false); setError('')
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  const dupCount = preview.filter(r => isDuplicate(r)).length

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      {/* Step indicator */}
      <div className="flex items-center gap-2 text-sm">
        {(['1. Файл', '2. Маппинг', '3. Импорт'] as const).map((label, idx) => {
          const n = (idx + 1) as Step
          const active = step === n
          const done_  = step > n
          return (
            <div key={n} className="flex items-center gap-2">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold
                ${done_ ? 'bg-emerald-500 text-white' : active ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-500'}`}>
                {done_ ? '✓' : n}
              </div>
              <span className={active ? 'text-slate-800 font-medium' : done_ ? 'text-emerald-600' : 'text-slate-400'}>
                {label}
              </span>
              {idx < 2 && <ChevronRight size={14} className="text-slate-300" />}
            </div>
          )
        })}
      </div>

      {/* ── STEP 1 ─────────────────────────────────────────────────────────── */}
      {step === 1 && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-8">
          <h2 className="text-base font-semibold text-slate-800 mb-1">Загрузите файл выписки</h2>
          <p className="text-sm text-slate-400 mb-6">Поддерживаются форматы .xlsx, .xls, .csv</p>

          {/* Drop zone */}
          <label
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={`flex flex-col items-center justify-center gap-3 border-2 border-dashed rounded-xl p-12 cursor-pointer transition-colors
              ${dragOver ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200 hover:border-indigo-300 hover:bg-slate-50'}`}
          >
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
            />
            {loading ? (
              <div className="text-slate-400 text-sm">Читаем файл…</div>
            ) : file ? (
              <>
                <FileText size={32} className="text-indigo-400" />
                <div className="text-center">
                  <p className="font-medium text-slate-700">{file.name}</p>
                  <p className="text-sm text-slate-400 mt-1">{parsed?.rows.length ?? 0} строк · {parsed?.headers.length ?? 0} колонок</p>
                </div>
              </>
            ) : (
              <>
                <Upload size={32} className="text-slate-300" />
                <div className="text-center">
                  <p className="font-medium text-slate-600">Перетащите файл или нажмите для выбора</p>
                  <p className="text-sm text-slate-400 mt-1">.xlsx, .xls или .csv</p>
                </div>
              </>
            )}
          </label>

          {error && (
            <div className="mt-3 flex items-center gap-2 text-red-600 text-sm bg-red-50 rounded-lg px-3 py-2">
              <AlertTriangle size={14} /> {error}
            </div>
          )}

          {/* Preview of first rows */}
          {parsed && parsed.preview.length > 0 && (
            <div className="mt-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Превью (первые {parsed.preview.length} строк)</p>
              <div className="overflow-x-auto rounded-lg border border-slate-100">
                <table className="text-xs w-full">
                  <thead className="bg-slate-50">
                    <tr>
                      {parsed.headers.map(h => (
                        <th key={h} className="text-left px-3 py-2 text-slate-500 font-medium whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.preview.map((row, i) => (
                      <tr key={i} className="border-t border-slate-50">
                        {parsed.headers.map(h => (
                          <td key={h} className="px-3 py-1.5 text-slate-600 whitespace-nowrap max-w-[150px] truncate">
                            {String(row[h] ?? '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="flex justify-end mt-6">
            <button
              disabled={!parsed || loading}
              onClick={() => setStep(2)}
              className="flex items-center gap-2 px-5 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              Далее <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* ── STEP 2 ─────────────────────────────────────────────────────────── */}
      {step === 2 && parsed && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-8 space-y-6">
          <div>
            <h2 className="text-base font-semibold text-slate-800 mb-1">Настройте маппинг колонок</h2>
            <p className="text-sm text-slate-400">Укажите какие колонки файла соответствуют нашим полям</p>
          </div>

          <div className="grid grid-cols-2 gap-5">
            {/* Date */}
            <Field label="Колонка с датой *">
              <select value={mapping.dateCol} onChange={e => setMapping(m => ({ ...m, dateCol: e.target.value }))}
                className={selectCls}>
                <option value="">— выберите —</option>
                {parsed.headers.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </Field>

            {/* Amount */}
            <Field label="Колонка с суммой *">
              <select value={mapping.amountCol} onChange={e => setMapping(m => ({ ...m, amountCol: e.target.value }))}
                className={selectCls}>
                <option value="">— выберите —</option>
                {parsed.headers.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </Field>

            {/* Comment */}
            <Field label="Назначение платежа">
              <select value={mapping.commentCol} onChange={e => setMapping(m => ({ ...m, commentCol: e.target.value }))}
                className={selectCls}>
                <option value="">— не использовать —</option>
                {parsed.headers.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </Field>

            {/* Account */}
            <Field label="Счёт *">
              <select value={mapping.accountId} onChange={e => setMapping(m => ({ ...m, accountId: e.target.value }))}
                className={selectCls}>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>

            {/* Type mode */}
            <Field label="Определение типа операции">
              <select value={mapping.typeMode} onChange={e => setMapping(m => ({ ...m, typeMode: e.target.value as 'sign' | 'column' }))}
                className={selectCls}>
                <option value="sign">По знаку суммы (+ приход, − расход)</option>
                <option value="column">По отдельной колонке</option>
              </select>
            </Field>

            {/* Type column (conditional) */}
            {mapping.typeMode === 'column' && (
              <Field label="Колонка с типом">
                <select value={mapping.typeCol} onChange={e => setMapping(m => ({ ...m, typeCol: e.target.value }))}
                  className={selectCls}>
                  <option value="">— выберите —</option>
                  {parsed.headers.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </Field>
            )}
            {mapping.typeMode === 'column' && (
              <Field label="Значение = «приход»">
                <input value={mapping.incomeValue}
                  onChange={e => setMapping(m => ({ ...m, incomeValue: e.target.value }))}
                  className={inputCls} placeholder="напр. Приход" />
              </Field>
            )}

            {/* Default category */}
            <Field label="Статья по умолчанию">
              <select value={mapping.defaultCategoryId} onChange={e => setMapping(m => ({ ...m, defaultCategoryId: e.target.value }))}
                className={selectCls}>
                <option value="">— задать для каждой строки —</option>
                {incomeCats.map(c => <option key={c.id} value={c.id}>{c.name} (доход)</option>)}
                {expenseCats.map(c => <option key={c.id} value={c.id}>{c.name} (расход)</option>)}
              </select>
            </Field>
          </div>

          <div className="flex justify-between mt-4">
            <button onClick={() => setStep(1)}
              className="flex items-center gap-1.5 px-4 py-2 text-slate-500 text-sm hover:text-slate-700 transition-colors">
              <ChevronLeft size={16} /> Назад
            </button>
            <button
              disabled={!mapping.dateCol || !mapping.amountCol || !mapping.accountId}
              onClick={goToStep3}
              className="flex items-center gap-2 px-5 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors">
              Предпросмотр <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* ── STEP 3 ─────────────────────────────────────────────────────────── */}
      {step === 3 && !done && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-800">Предпросмотр импорта</h2>
              <p className="text-sm text-slate-400 mt-0.5">
                {preview.length} строк
                {dupCount > 0 && <span className="text-amber-600 ml-2">· {dupCount} возможных дубликатов</span>}
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
              <input type="checkbox" checked={skipDups} onChange={e => setSkipDups(e.target.checked)}
                className="accent-indigo-600" />
              Пропускать дубликаты
            </label>
          </div>

          <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 sticky top-0">
                <tr>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase">Дата</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase">Тип</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase">Сумма</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase">Назначение</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase w-44">Статья</th>
                  <th className="px-4 py-2.5 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {preview.map((row, i) => {
                  const dup = isDuplicate(row)
                  const skipped = dup && skipDups
                  return (
                    <tr key={i}
                      className={`border-t border-slate-50 ${skipped ? 'opacity-40' : ''} ${dup ? 'bg-amber-50/60' : ''}`}>
                      <td className="px-4 py-2 text-slate-600 whitespace-nowrap">{row.date}</td>
                      <td className="px-4 py-2">
                        <span className={`text-xs px-1.5 py-0.5 rounded font-medium
                          ${row.type === 'income' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-600'}`}>
                          {row.type === 'income' ? 'Доход' : 'Расход'}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right font-medium tabular-nums">
                        <span className={row.type === 'income' ? 'text-emerald-600' : 'text-red-500'}>
                          {row.type === 'expense' ? '−' : '+'}{row.amount.toLocaleString('ru-RU')} ₽
                        </span>
                      </td>
                      <td className="px-4 py-2 text-slate-500 max-w-[200px] truncate">{row.comment || '—'}</td>
                      <td className="px-4 py-2">
                        <select
                          value={rowCats[i] ?? ''}
                          onChange={e => setRowCats(m => ({ ...m, [i]: e.target.value }))}
                          className="w-full text-xs border border-slate-200 rounded px-2 py-1 outline-none focus:ring-1 focus:ring-indigo-300 bg-white"
                          disabled={skipped}
                        >
                          <option value="">— не импортировать —</option>
                          {(row.type === 'income' ? incomeCats : expenseCats).map(c => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-2">
                        {dup && (
                          <span title="Возможный дубликат">
                            <AlertTriangle size={14} className="text-amber-400" />
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between">
            <button onClick={() => setStep(2)}
              className="flex items-center gap-1.5 px-4 py-2 text-slate-500 text-sm hover:text-slate-700 transition-colors">
              <ChevronLeft size={16} /> Назад
            </button>
            <button
              disabled={importing || preview.filter((_, i) => !!(rowCats[i]) && !(skipDups && isDuplicate(preview[i]))).length === 0}
              onClick={handleImport}
              className="flex items-center gap-2 px-6 py-2.5 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors"
            >
              {importing ? 'Импортируем…' : `Импортировать ${preview.filter((r, i) => !!(rowCats[i]) && !(skipDups && isDuplicate(r))).length} операций`}
            </button>
          </div>
        </div>
      )}

      {/* ── DONE ───────────────────────────────────────────────────────────── */}
      {done && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-12 text-center">
          <CheckCircle2 size={48} className="mx-auto text-emerald-500 mb-4" />
          <h2 className="text-xl font-bold text-slate-800">Импорт завершён</h2>
          <p className="text-slate-500 mt-2">Добавлено <span className="font-semibold text-slate-700">{importedCount}</span> операций</p>
          <div className="flex items-center justify-center gap-3 mt-6">
            <button onClick={reset}
              className="px-5 py-2 border border-slate-200 rounded-lg text-sm text-slate-600 hover:bg-slate-50 transition-colors">
              Импортировать ещё
            </button>
            <a href="#/transactions"
              className="px-5 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors">
              Перейти к операциям
            </a>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const selectCls = 'w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300 bg-white'
const inputCls  = 'w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-500 mb-1.5">{label}</label>
      {children}
    </div>
  )
}
