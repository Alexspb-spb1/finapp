import { useState } from 'react'
import { Plus, CheckCircle2, Clock, AlertCircle, ChevronLeft, ChevronRight, Trash2, Pencil, X, CreditCard } from 'lucide-react'
import { formatCurrency } from '../utils/format'
import { useStore } from '../store/useStore'
import CategoryIcon from '../utils/categoryIcons'
import type { PaymentCalendarItem } from '../types'

const statusConfig = {
  planned: { label: 'Запланировано', icon: Clock,         color: 'text-amber-600 bg-amber-50',   dot: 'bg-amber-400' },
  paid:    { label: 'Оплачено',      icon: CheckCircle2,  color: 'text-emerald-600 bg-emerald-50', dot: 'bg-emerald-500' },
  overdue: { label: 'Просрочено',    icon: AlertCircle,   color: 'text-red-600 bg-red-50',        dot: 'bg-red-500' },
}

const today = new Date().toISOString().slice(0, 10)

function effectiveStatus(item: PaymentCalendarItem): PaymentCalendarItem['status'] {
  if (item.status === 'paid') return 'paid'
  if (item.date < today) return 'overdue'
  return 'planned'
}

interface ModalState {
  open: boolean
  editing: PaymentCalendarItem | null
}

const EMPTY_FORM = {
  date: today,
  type: 'expense' as 'income' | 'expense',
  amount: '',
  description: '',
  categoryId: '',
  counterpartyId: '',
  accountId: '',
}

export default function Calendar() {
  const store = useStore()
  const { categories, counterparties, paymentCalendar, accounts } = store

  // Month navigation
  const now = new Date()
  const [viewYear,  setViewYear]  = useState(now.getFullYear())
  const [viewMonth, setViewMonth] = useState(now.getMonth()) // 0-based

  function prevMonth() {
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11) }
    else setViewMonth(m => m - 1)
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0) }
    else setViewMonth(m => m + 1)
  }

  const monthKey = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}`
  const monthLabel = new Date(viewYear, viewMonth, 1).toLocaleString('ru', { month: 'long', year: 'numeric' })

  // Filter to current month
  const [typeFilter, setTypeFilter] = useState<'all' | 'income' | 'expense'>('all')
  const monthItems = paymentCalendar.filter(i => i.date.startsWith(monthKey))
  const filtered = monthItems
    .filter(i => typeFilter === 'all' || i.type === typeFilter)
    .sort((a, b) => a.date.localeCompare(b.date))

  // Summary — planned only (not paid)
  const unpaid = monthItems.filter(i => i.status !== 'paid')
  const plannedIncome  = unpaid.filter(i => i.type === 'income').reduce((s, i) => s + i.amount, 0)
  const plannedExpense = unpaid.filter(i => i.type === 'expense').reduce((s, i) => s + i.amount, 0)
  const overdueCount   = monthItems.filter(i => effectiveStatus(i) === 'overdue').length

  // Modal
  const [modal, setModal] = useState<ModalState>({ open: false, editing: null })
  const [form,  setForm]  = useState(EMPTY_FORM)
  const [deleteId, setDeleteId] = useState<string | null>(null)

  function openAdd() {
    setForm({ ...EMPTY_FORM, date: monthKey + '-' + String(now.getDate()).padStart(2, '0'), accountId: accounts[0]?.id ?? '' })
    setModal({ open: true, editing: null })
  }

  function openEdit(item: PaymentCalendarItem) {
    setForm({
      date: item.date,
      type: item.type as 'income' | 'expense',
      amount: String(item.amount),
      description: item.description,
      categoryId: item.categoryId,
      counterpartyId: item.counterpartyId ?? '',
      accountId: item.accountId ?? accounts[0]?.id ?? '',
    })
    setModal({ open: true, editing: item })
  }

  function saveForm() {
    const num = parseFloat(form.amount.replace(/\s/g, '').replace(',', '.'))
    if (!num || num <= 0 || !form.description) return
    const filteredCats = categories.filter(c => c.type === form.type && !c.isGroup)
    const catId = form.categoryId || filteredCats[0]?.id || ''
    if (modal.editing) {
      store.updateCalendarItem(modal.editing.id, {
        date: form.date,
        type: form.type,
        amount: num,
        description: form.description,
        categoryId: catId,
        counterpartyId: form.counterpartyId || undefined,
        accountId: form.accountId || accounts[0]?.id || undefined,
      })
    } else {
      store.addCalendarItem({
        id: 'cal_' + Date.now(),
        date: form.date,
        type: form.type,
        amount: num,
        description: form.description,
        categoryId: catId,
        counterpartyId: form.counterpartyId || undefined,
        accountId: form.accountId || accounts[0]?.id || undefined,
        status: 'planned',
      })
    }
    setModal({ open: false, editing: null })
  }

  const formCats = categories.filter(c => c.type === form.type && !c.isGroup)
  const formGroups = categories.filter(c => c.type === form.type && c.isGroup)
  const formStandalone = formCats.filter(c => !c.parentId)
  const formChild      = formCats.filter(c => !!c.parentId)

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
          <p className="text-xs text-slate-500 mb-1">Ожидаемые поступления</p>
          <p className="text-lg font-bold text-emerald-600">{formatCurrency(plannedIncome)}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
          <p className="text-xs text-slate-500 mb-1">Плановые списания</p>
          <p className="text-lg font-bold text-red-500">{formatCurrency(plannedExpense)}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
          <p className="text-xs text-slate-500 mb-1">Прогноз баланса</p>
          <p className={`text-lg font-bold ${plannedIncome - plannedExpense >= 0 ? 'text-indigo-600' : 'text-red-600'}`}>
            {plannedIncome - plannedExpense >= 0 ? '+' : ''}{formatCurrency(plannedIncome - plannedExpense)}
          </p>
        </div>
        <div className={`rounded-xl border p-4 shadow-sm ${overdueCount > 0 ? 'bg-red-50 border-red-200' : 'bg-white border-slate-200'}`}>
          <p className="text-xs text-slate-500 mb-1">Просрочено</p>
          <p className={`text-lg font-bold ${overdueCount > 0 ? 'text-red-600' : 'text-slate-400'}`}>{overdueCount}</p>
        </div>
      </div>

      {/* List */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {/* Toolbar */}
        <div className="px-5 py-4 border-b border-slate-100 flex flex-wrap items-center gap-3">
          {/* Month nav */}
          <div className="flex items-center gap-1">
            <button onClick={prevMonth} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors">
              <ChevronLeft size={16} />
            </button>
            <span className="text-sm font-semibold text-slate-700 w-40 text-center capitalize">{monthLabel}</span>
            <button onClick={nextMonth} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors">
              <ChevronRight size={16} />
            </button>
          </div>

          {/* Type filter */}
          <div className="flex gap-1 bg-slate-100 rounded-lg p-1 ml-auto">
            {(['all', 'income', 'expense'] as const).map(v => (
              <button key={v} onClick={() => setTypeFilter(v)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                  typeFilter === v ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}>
                {v === 'all' ? 'Все' : v === 'income' ? 'Доходы' : 'Расходы'}
              </button>
            ))}
          </div>

          <button onClick={openAdd}
            className="flex items-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors">
            <Plus size={15} /> Добавить
          </button>
        </div>

        {/* Items */}
        {filtered.length === 0 ? (
          <div className="py-16 text-center text-slate-400">
            <Clock size={32} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm font-medium">Нет платежей в этом месяце</p>
            <p className="text-xs mt-1">Нажмите «Добавить» чтобы создать плановый платёж</p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-50">
            {filtered.map(item => {
              const cat = categories.find(c => c.id === item.categoryId)
              const status = effectiveStatus(item)
              const sc = statusConfig[status]
              const StatusIcon = sc.icon
              const d = new Date(item.date + 'T00:00:00')
              const isToday = item.date === today

              return (
                <li key={item.id} className={`flex items-center gap-3 px-4 sm:px-5 py-3.5 hover:bg-slate-50 transition-colors group ${isToday ? 'bg-indigo-50/40' : ''}`}>
                  {/* Date block */}
                  <div className={`hidden sm:flex w-12 h-12 rounded-xl flex-col items-center justify-center shrink-0 ${
                    isToday ? 'bg-indigo-600 text-white' : status === 'overdue' ? 'bg-red-50 text-red-600' : 'bg-slate-100 text-slate-600'
                  }`}>
                    <span className="text-lg font-bold leading-none">{d.getDate()}</span>
                    <span className="text-[10px]">{d.toLocaleString('ru', { month: 'short' })}</span>
                  </div>

                  {/* Category icon */}
                  <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                    style={{ background: (cat?.color ?? '#94a3b8') + '22' }}>
                    <CategoryIcon name={cat?.icon ?? 'DollarSign'} size={14} color={cat?.color ?? '#94a3b8'} />
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-700 truncate">{item.description}</p>
                    <p className="text-xs text-slate-400">{cat?.name}</p>
                  </div>

                  {/* Status badge — desktop */}
                  <span className={`hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium shrink-0 ${sc.color}`}>
                    <StatusIcon size={11} />
                    {sc.label}
                  </span>

                  {/* Amount */}
                  <span className={`text-sm font-bold whitespace-nowrap shrink-0 ${item.type === 'income' ? 'text-emerald-600' : 'text-red-500'}`}>
                    {item.type === 'income' ? '+' : '−'}{formatCurrency(item.amount)}
                  </span>

                  {/* Actions */}
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    {status !== 'paid' && (
                      <button
                        onClick={() => store.payCalendarItem(item.id)}
                        title="Оплатить и создать операцию"
                        className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 transition-colors">
                        <CreditCard size={14} />
                      </button>
                    )}
                    <button onClick={() => openEdit(item)}
                      className="p-1.5 rounded-lg hover:bg-indigo-50 text-slate-400 hover:text-indigo-600 transition-colors">
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => setDeleteId(item.id)}
                      className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-500 transition-colors">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* Add/Edit modal */}
      {modal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) setModal({ open: false, editing: null }) }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h2 className="font-semibold text-slate-800">
                {modal.editing ? 'Редактировать платёж' : 'Новый плановый платёж'}
              </h2>
              <button onClick={() => setModal({ open: false, editing: null })}
                className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
                <X size={18} />
              </button>
            </div>

            <div className="px-6 py-5 space-y-4">
              {/* Type tabs */}
              <div className="flex gap-2">
                {(['income', 'expense'] as const).map(t => (
                  <button key={t} onClick={() => setForm(f => ({ ...f, type: t, categoryId: '' }))}
                    className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${
                      form.type === t
                        ? t === 'income' ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                          : 'bg-red-50 text-red-700 ring-1 ring-red-200'
                        : 'text-slate-500 hover:bg-slate-50'
                    }`}>
                    {t === 'income' ? 'Поступление' : 'Списание'}
                  </button>
                ))}
              </div>

              {/* Amount + Date */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1.5">Сумма, ₽</label>
                  <input type="text" value={form.amount}
                    onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                    placeholder="0"
                    className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-xl font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-indigo-300" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1.5">Дата</label>
                  <input type="date" value={form.date}
                    onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300" />
                </div>
              </div>

              {/* Account */}
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Счёт {form.type === 'income' ? 'зачисления' : 'списания'}</label>
                <select value={form.accountId}
                  onChange={e => setForm(f => ({ ...f, accountId: e.target.value }))}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300">
                  {accounts.length === 0 && <option value="">Нет счетов</option>}
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>

              {/* Description */}
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Описание</label>
                <input type="text" value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Например: Оплата аренды"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300" />
              </div>

              {/* Category */}
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Статья</label>
                <select value={form.categoryId}
                  onChange={e => setForm(f => ({ ...f, categoryId: e.target.value }))}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300">
                  <option value="">— Выберите статью —</option>
                  {formGroups.map(g => (
                    <optgroup key={g.id} label={g.name}>
                      {formChild.filter(c => c.parentId === g.id).map(c =>
                        <option key={c.id} value={c.id}>{c.name}</option>
                      )}
                    </optgroup>
                  ))}
                  {formStandalone.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>

              {/* Counterparty */}
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Контрагент</label>
                <select value={form.counterpartyId}
                  onChange={e => setForm(f => ({ ...f, counterpartyId: e.target.value }))}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300">
                  <option value="">— Не указан —</option>
                  {counterparties.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>

              {/* Buttons */}
              <div className="flex gap-3 pt-1">
                <button onClick={() => setModal({ open: false, editing: null })}
                  className="flex-1 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-600 font-medium hover:bg-slate-50 transition">
                  Отмена
                </button>
                <button onClick={saveForm}
                  className={`flex-1 py-2.5 rounded-lg text-white text-sm font-medium transition ${
                    form.type === 'income' ? 'bg-emerald-500 hover:bg-emerald-600' : 'bg-red-500 hover:bg-red-600'
                  }`}>
                  {modal.editing ? 'Сохранить' : 'Создать'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 text-center">
            <p className="font-semibold text-slate-800 mb-2">Удалить платёж?</p>
            <p className="text-sm text-slate-500 mb-5">Это действие нельзя отменить.</p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteId(null)}
                className="flex-1 py-2.5 border border-slate-200 text-sm text-slate-600 rounded-lg hover:bg-slate-50 transition">
                Отмена
              </button>
              <button onClick={() => { store.deleteCalendarItem(deleteId); setDeleteId(null) }}
                className="flex-1 py-2.5 bg-red-500 hover:bg-red-600 text-white text-sm font-medium rounded-lg transition">
                Удалить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
