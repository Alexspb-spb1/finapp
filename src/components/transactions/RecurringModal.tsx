import { useState } from 'react'
import { X, Plus, Trash2, RefreshCw, Play, Pencil, ToggleLeft, ToggleRight, AlertCircle } from 'lucide-react'
import { useStore } from '../../store/useStore'
import { formatCurrency, formatDate } from '../../utils/format'
import CategoryIcon from '../../utils/categoryIcons'
import type { RecurringTemplate, RecurringPeriod } from '../../types'

interface Props {
  open: boolean
  onClose: () => void
}

const PERIOD_LABELS: Record<RecurringPeriod, string> = {
  weekly:    'Еженедельно',
  monthly:   'Ежемесячно',
  quarterly: 'Ежеквартально',
  yearly:    'Ежегодно',
}

const PERIOD_SHORT: Record<RecurringPeriod, string> = {
  weekly: 'нед.', monthly: 'мес.', quarterly: 'кв.', yearly: 'год',
}

function emptyTemplate(): Omit<RecurringTemplate, 'id'> {
  return {
    name: '',
    type: 'expense',
    amount: 0,
    accountId: '',
    categoryId: '',
    counterpartyId: '',
    projectId: '',
    comment: '',
    period: 'monthly',
    nextDate: new Date().toISOString().slice(0, 10),
    endDate: '',
    enabled: true,
  }
}

export default function RecurringModal({ open, onClose }: Props) {
  const store = useStore()
  const { recurring, categories, accounts, counterparties, projects } = store

  const [editing, setEditing] = useState<(RecurringTemplate & { isNew?: boolean }) | null>(null)
  const [executeConfirm, setExecuteConfirm] = useState<RecurringTemplate | null>(null)

  if (!open) return null

  const today = new Date().toISOString().slice(0, 10)
  const overdueList = recurring.filter(r => r.enabled && r.nextDate <= today)

  function startNew() {
    const tmpl = emptyTemplate()
    setEditing({
      id: 'rec' + Date.now(),
      isNew: true,
      ...tmpl,
      accountId: accounts[0]?.id ?? '',
      categoryId: categories.filter(c => c.type === 'expense' && !c.isGroup)[0]?.id ?? '',
    })
  }

  function save() {
    if (!editing) return
    const { isNew, ...tmpl } = editing
    if (!tmpl.name.trim() || !tmpl.accountId || !tmpl.categoryId || !tmpl.amount) return
    setEditing(null)
    if (isNew) store.addRecurring(tmpl)
    else store.updateRecurring(tmpl.id, tmpl)
  }

  function execute(tmpl: RecurringTemplate) {
    store.executeRecurring(tmpl.id)
    setExecuteConfirm(null)
  }

  // ── Execute confirm ───────────────────────────────────────────────────────
  if (executeConfirm) {
    const cat = categories.find(c => c.id === executeConfirm.categoryId)
    const acc = accounts.find(a => a.id === executeConfirm.accountId)
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 text-center">
          <div className="w-12 h-12 rounded-2xl bg-indigo-100 flex items-center justify-center mx-auto mb-4">
            <Play size={20} className="text-indigo-600" />
          </div>
          <h3 className="font-semibold text-slate-800 mb-1">Создать операцию?</h3>
          <p className="text-sm text-slate-500 mb-1">{executeConfirm.name}</p>
          <p className={`text-lg font-bold mb-1 ${executeConfirm.type === 'income' ? 'text-emerald-600' : 'text-red-500'}`}>
            {executeConfirm.type === 'income' ? '+' : '−'}{formatCurrency(executeConfirm.amount)}
          </p>
          <p className="text-xs text-slate-400 mb-5">
            {formatDate(executeConfirm.nextDate)} · {acc?.name} · {cat?.name}
          </p>
          <div className="flex gap-3">
            <button onClick={() => setExecuteConfirm(null)}
              className="flex-1 py-2.5 border border-slate-200 text-sm text-slate-600 font-medium rounded-lg hover:bg-slate-50 transition">
              Отмена
            </button>
            <button onClick={() => execute(executeConfirm)}
              className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-lg transition">
              Создать
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Template editor ───────────────────────────────────────────────────────
  if (editing) {
    const filteredCats = categories.filter(c => c.type === editing.type && !c.isGroup)
    const catGroups    = categories.filter(c => c.type === editing.type && c.isGroup)
    const standalone   = filteredCats.filter(c => !c.parentId)
    const children     = filteredCats.filter(c => !!c.parentId)
    const canSave = !!(editing.name.trim() && editing.accountId && editing.categoryId && editing.amount > 0)

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 flex flex-col max-h-[92vh] overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 shrink-0">
            <h2 className="font-semibold text-slate-800">{editing.isNew ? 'Новый шаблон' : 'Редактировать шаблон'}</h2>
            <button onClick={() => setEditing(null)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><X size={18} /></button>
          </div>

          <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">
            {/* Name */}
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Название *</label>
              <input value={editing.name} onChange={e => setEditing(r => r && { ...r, name: e.target.value })}
                placeholder="Аренда офиса, Зарплата, Подписка…"
                className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-indigo-300" />
            </div>

            {/* Type tabs */}
            <div className="flex gap-2">
              {(['income', 'expense'] as const).map(t => (
                <button key={t} type="button"
                  onClick={() => setEditing(r => r && { ...r, type: t, categoryId: '' })}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${
                    editing.type === t
                      ? t === 'income' ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                                       : 'bg-red-50 text-red-700 ring-1 ring-red-200'
                      : 'text-slate-500 hover:bg-slate-50'
                  }`}>
                  {t === 'income' ? 'Доход' : 'Расход'}
                </button>
              ))}
            </div>

            {/* Amount + Period */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Сумма, ₽ *</label>
                <input type="number" min="0.01" step="0.01"
                  value={editing.amount || ''}
                  onChange={e => setEditing(r => r && { ...r, amount: parseFloat(e.target.value) || 0 })}
                  placeholder="0"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-xl font-semibold outline-none focus:ring-2 focus:ring-indigo-300" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Период *</label>
                <select value={editing.period}
                  onChange={e => setEditing(r => r && { ...r, period: e.target.value as RecurringPeriod })}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-indigo-300">
                  {(Object.keys(PERIOD_LABELS) as RecurringPeriod[]).map(p =>
                    <option key={p} value={p}>{PERIOD_LABELS[p]}</option>
                  )}
                </select>
              </div>
            </div>

            {/* Next date + End date */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Следующая дата *</label>
                <input type="date" value={editing.nextDate}
                  onChange={e => setEditing(r => r && { ...r, nextDate: e.target.value })}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Дата окончания</label>
                <input type="date" value={editing.endDate ?? ''}
                  onChange={e => setEditing(r => r && { ...r, endDate: e.target.value || undefined })}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300" />
              </div>
            </div>

            {/* Account */}
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Счёт *</label>
              <select value={editing.accountId}
                onChange={e => setEditing(r => r && { ...r, accountId: e.target.value })}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300">
                <option value="">— Выберите счёт —</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>

            {/* Category */}
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Статья *</label>
              <select value={editing.categoryId}
                onChange={e => setEditing(r => r && { ...r, categoryId: e.target.value })}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300">
                <option value="">— Выберите статью —</option>
                {catGroups.map(g => (
                  <optgroup key={g.id} label={g.name}>
                    {children.filter(c => c.parentId === g.id).map(c =>
                      <option key={c.id} value={c.id}>{c.name}</option>
                    )}
                  </optgroup>
                ))}
                {standalone.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>

            {/* Counterparty */}
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Контрагент</label>
              <select value={editing.counterpartyId ?? ''}
                onChange={e => setEditing(r => r && { ...r, counterpartyId: e.target.value || undefined })}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300">
                <option value="">— Не указан —</option>
                {counterparties.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>

            {/* Project */}
            {projects.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Проект</label>
                <select value={editing.projectId ?? ''}
                  onChange={e => setEditing(r => r && { ...r, projectId: e.target.value || undefined })}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300">
                  <option value="">— Без проекта —</option>
                  {projects.filter(p => p.status === 'active').map(p =>
                    <option key={p.id} value={p.id}>{p.name}</option>
                  )}
                </select>
              </div>
            )}

            {/* Comment */}
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Назначение платежа</label>
              <input value={editing.comment}
                onChange={e => setEditing(r => r && { ...r, comment: e.target.value })}
                placeholder="Необязательно"
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300" />
            </div>
          </div>

          <div className="px-6 py-4 border-t border-slate-100 flex gap-3 shrink-0">
            <button onClick={() => setEditing(null)}
              className="flex-1 py-2.5 border border-slate-200 text-sm text-slate-600 font-medium rounded-lg hover:bg-slate-50 transition">
              Отмена
            </button>
            <button onClick={save} disabled={!canSave}
              className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-sm font-semibold rounded-lg transition">
              Сохранить
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── List ──────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[85vh] overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 shrink-0">
          <div className="flex items-center gap-2">
            <RefreshCw size={17} className="text-indigo-500" />
            <h2 className="font-semibold text-slate-800">Регулярные операции</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><X size={18} /></button>
        </div>

        {/* Overdue banner */}
        {overdueList.length > 0 && (
          <div className="mx-4 mt-3 flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 shrink-0">
            <AlertCircle size={14} className="text-amber-500 shrink-0" />
            <p className="text-xs text-amber-700">
              <span className="font-semibold">{overdueList.length}</span> шаблон{overdueList.length > 1 ? 'а' : ''} требуют создания операции
            </p>
          </div>
        )}

        <div className="overflow-y-auto flex-1 py-2">
          {recurring.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center px-8">
              <RefreshCw size={36} className="text-slate-200 mb-3" />
              <p className="text-sm font-medium text-slate-700 mb-1">Нет шаблонов</p>
              <p className="text-xs text-slate-400">Регулярные операции позволяют быстро создавать повторяющиеся платежи</p>
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {recurring.map(tmpl => {
                const cat  = categories.find(c => c.id === tmpl.categoryId)
                const acc  = accounts.find(a => a.id === tmpl.accountId)
                const cp   = counterparties.find(c => c.id === tmpl.counterpartyId)
                const overdue = tmpl.enabled && tmpl.nextDate <= today
                return (
                  <li key={tmpl.id} className={`px-5 py-3.5 group hover:bg-slate-50 transition ${!tmpl.enabled ? 'opacity-50' : ''}`}>
                    <div className="flex items-center gap-3">
                      {/* Toggle */}
                      <button onClick={() => store.updateRecurring(tmpl.id, { enabled: !tmpl.enabled })}
                        className="shrink-0 text-slate-300 hover:text-indigo-500 transition"
                        title={tmpl.enabled ? 'Отключить' : 'Включить'}>
                        {tmpl.enabled
                          ? <ToggleRight size={22} className="text-indigo-500" />
                          : <ToggleLeft size={22} />}
                      </button>

                      {/* Icon */}
                      <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                        style={{ background: (cat?.color ?? '#94a3b8') + '22' }}>
                        <CategoryIcon name={cat?.icon ?? 'RefreshCw'} size={15} color={cat?.color ?? '#94a3b8'} />
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setEditing(tmpl)}>
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-slate-800 truncate">{tmpl.name}</p>
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 shrink-0">
                            {PERIOD_SHORT[tmpl.period]}
                          </span>
                        </div>
                        <p className="text-xs text-slate-400 truncate mt-0.5">
                          {acc?.name}{cp ? ` · ${cp.name}` : ''}
                          {' · '}
                          <span className={overdue ? 'text-amber-600 font-medium' : ''}>
                            {overdue ? '⚠ ' : ''}следующая {formatDate(tmpl.nextDate)}
                          </span>
                          {tmpl.endDate && <span> · до {formatDate(tmpl.endDate)}</span>}
                        </p>
                      </div>

                      {/* Amount */}
                      <span className={`text-sm font-bold shrink-0 ${tmpl.type === 'income' ? 'text-emerald-600' : 'text-red-500'}`}>
                        {tmpl.type === 'income' ? '+' : '−'}{formatCurrency(tmpl.amount)}
                      </span>

                      {/* Execute */}
                      {tmpl.enabled && (
                        <button onClick={() => setExecuteConfirm(tmpl)}
                          className={`p-1.5 rounded-lg transition shrink-0 ${
                            overdue
                              ? 'text-amber-500 bg-amber-50 hover:bg-amber-100'
                              : 'text-slate-300 group-hover:text-indigo-500 hover:bg-indigo-50'
                          }`}
                          title="Создать операцию сейчас">
                          <Play size={14} />
                        </button>
                      )}

                      <button onClick={() => setEditing(tmpl)}
                        className="p-1.5 rounded-lg text-slate-300 group-hover:text-slate-500 hover:bg-slate-100 transition shrink-0">
                        <Pencil size={13} />
                      </button>
                      <button onClick={() => store.deleteRecurring(tmpl.id)}
                        className="p-1.5 rounded-lg text-slate-300 group-hover:text-red-400 hover:bg-red-50 transition shrink-0">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 shrink-0">
          <button onClick={startNew}
            className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium py-2.5 rounded-lg transition">
            <Plus size={15} /> Добавить шаблон
          </button>
        </div>
      </div>
    </div>
  )
}
