import { useState, useRef, useEffect } from 'react'
import { Plus, X, Trash2, Pencil, Phone, Mail, FileText, Hash, ArrowUpRight, ArrowDownRight, Landmark } from 'lucide-react'
import { useStore } from '../store/useStore'
import { formatCurrency, formatDate } from '../utils/format'
import type { Counterparty } from '../types'

const TYPE_LABEL: Record<Counterparty['type'], string> = {
  client: 'Клиент', supplier: 'Поставщик', employee: 'Сотрудник', other: 'Прочее',
}
const TYPE_COLOR: Record<Counterparty['type'], string> = {
  client:   'bg-emerald-100 text-emerald-700',
  supplier: 'bg-orange-100  text-orange-700',
  employee: 'bg-blue-100    text-blue-700',
  other:    'bg-slate-100   text-slate-600',
}
const TYPE_BG: Record<Counterparty['type'], string> = {
  client:   'from-emerald-500 to-teal-600',
  supplier: 'from-orange-400  to-amber-500',
  employee: 'from-blue-500    to-indigo-600',
  other:    'from-slate-400   to-slate-500',
}

// ─── Empty form state ─────────────────────────────────────────────────────────
const emptyForm = () => ({
  name: '', type: 'client' as Counterparty['type'],
  inn: '', phone: '', email: '', notes: '',
  bankAccount: '', bankName: '', bik: '',
})

export default function Counterparties() {
  const store = useStore()
  const { transactions, counterparties, categories } = store

  // Add modal
  const [addOpen, setAddOpen]   = useState(false)
  const [addForm, setAddForm]   = useState(emptyForm)

  // Card / edit modal
  const [cardId,    setCardId]    = useState<string | null>(null)
  const [editMode,  setEditMode]  = useState(false)
  const [editForm,  setEditForm]  = useState(emptyForm)

  // Delete confirm
  const [deleteId,    setDeleteId]    = useState<string | null>(null)

  // Bulk selection
  const [selected,    setSelected]    = useState<Set<string>>(new Set())
  const [bulkConfirm, setBulkConfirm] = useState(false)
  const checkAllRef = useRef<HTMLInputElement>(null)

  // ── Computed stats ──────────────────────────────────────────────────────────
  const stats = counterparties.map(cp => {
    const cpTx  = transactions.filter(t => t.counterpartyId === cp.id)
    const income  = cpTx.filter(t => t.type === 'income').reduce((s, t)  => s + t.amount, 0)
    const expense = cpTx.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0)
    return { ...cp, income, expense, count: cpTx.length }
  }).sort((a, b) => (b.income + b.expense) - (a.income + a.expense))

  // ── Bulk helpers (must be after stats) ────────────────────────────────────
  const allSelected = stats.length > 0 && stats.every(cp => selected.has(cp.id))

  useEffect(() => {
    if (!checkAllRef.current) return
    checkAllRef.current.indeterminate = selected.size > 0 && selected.size < stats.length
  })

  function toggleOne(id: string) {
    setSelected(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })
  }
  function toggleAll() {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(stats.map(c => c.id)))
  }
  function handleBulkDelete() {
    store.deleteCounterparties([...selected])
    setSelected(new Set())
    setBulkConfirm(false)
  }

  const cardCp   = cardId ? counterparties.find(c => c.id === cardId) : null
  const cardStat = cardId ? stats.find(s => s.id === cardId) : null
  const cardTx   = cardId
    ? transactions.filter(t => t.counterpartyId === cardId)
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 8)
    : []

  // ── Add handlers ────────────────────────────────────────────────────────────
  function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    store.addCounterparty({ id: 'cp_' + Date.now(), ...addForm })
    setAddOpen(false)
    setAddForm(emptyForm())
  }

  // ── Card / edit handlers ─────────────────────────────────────────────────
  function openCard(id: string) {
    setCardId(id)
    setEditMode(false)
  }

  function openEdit() {
    if (!cardCp) return
    setEditForm({
      name:        cardCp.name,
      type:        cardCp.type,
      inn:         cardCp.inn         ?? '',
      phone:       cardCp.phone       ?? '',
      email:       cardCp.email       ?? '',
      notes:       cardCp.notes       ?? '',
      bankAccount: cardCp.bankAccount ?? '',
      bankName:    cardCp.bankName    ?? '',
      bik:         cardCp.bik         ?? '',
    })
    setEditMode(true)
  }

  // Открыть карточку сразу в режиме редактирования (из строки таблицы).
  // Нельзя звать openCard + openEdit последовательно — setState асинхронен,
  // поэтому cardCp будет null в момент вызова openEdit.
  function openCardInEditMode(id: string) {
    const cp = counterparties.find(c => c.id === id)
    if (!cp) return
    setCardId(id)
    setEditForm({
      name:        cp.name,
      type:        cp.type,
      inn:         cp.inn         ?? '',
      phone:       cp.phone       ?? '',
      email:       cp.email       ?? '',
      notes:       cp.notes       ?? '',
      bankAccount: cp.bankAccount ?? '',
      bankName:    cp.bankName    ?? '',
      bik:         cp.bik         ?? '',
    })
    setEditMode(true)
  }

  function handleEditSave(e: React.FormEvent) {
    e.preventDefault()
    if (!cardId) return
    store.updateCounterparty(cardId, editForm)
    setEditMode(false)
  }

  function closeCard() { setCardId(null); setEditMode(false) }

  function confirmDelete() {
    if (deleteId) { store.deleteCounterparty(deleteId); setDeleteId(null); closeCard() }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        {selected.size > 0 ? (
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-indigo-700">
              Выбрано: <span className="font-bold">{selected.size}</span>
            </span>
            <button onClick={() => setSelected(new Set())}
              className="flex items-center gap-1.5 text-xs text-indigo-500 hover:text-indigo-700 px-3 py-1.5 rounded-lg hover:bg-indigo-100 border border-indigo-200 transition">
              <X size={12} /> Снять выделение
            </button>
            <button onClick={() => setBulkConfirm(true)}
              className="flex items-center gap-1.5 text-xs text-white bg-red-500 hover:bg-red-600 px-3 py-1.5 rounded-lg transition font-medium">
              <Trash2 size={12} /> Удалить {selected.size}
            </button>
          </div>
        ) : <div />}
        <button onClick={() => setAddOpen(true)}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-4 py-2.5 rounded-xl transition-colors">
          <Plus size={16} /> Добавить
        </button>
      </div>

      {/* Empty state */}
      {counterparties.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-16 text-center">
          <div className="text-5xl mb-4">🤝</div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">Нет контрагентов</h3>
          <p className="text-sm text-slate-400 mb-6">Добавьте клиентов, поставщиков и сотрудников</p>
          <button onClick={() => setAddOpen(true)}
            className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-5 py-2.5 rounded-xl transition-colors">
            <Plus size={16} /> Добавить контрагента
          </button>
        </div>
      ) : (

        /* Table */
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100">
            <h3 className="text-sm font-semibold text-slate-700">Контрагенты</h3>
            <p className="text-xs text-slate-400 mt-0.5">{counterparties.length} записей</p>
          </div>
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="w-10 px-3 py-3 text-center">
                  <input
                    ref={checkAllRef}
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="w-4 h-4 accent-indigo-600 cursor-pointer rounded"
                    title="Выбрать всех"
                  />
                </th>
                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-5 py-3">Наименование</th>
                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3">Тип</th>
                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3">ИНН</th>
                <th className="text-right text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3">Доходы</th>
                <th className="text-right text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3">Расходы</th>
                <th className="text-right text-xs font-semibold text-slate-500 uppercase tracking-wide px-5 py-3">Операций</th>
                <th className="px-4 py-3 w-20" />
              </tr>
            </thead>
            <tbody>
              {stats.map(cp => (
                <tr key={cp.id}
                  onClick={() => openCard(cp.id)}
                  className={`border-b border-slate-50 transition-colors cursor-pointer group ${
                    selected.has(cp.id) ? 'bg-indigo-50/60' : 'hover:bg-slate-50'
                  }`}>
                  <td className="px-3 py-3.5 text-center" onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(cp.id)}
                      onChange={() => toggleOne(cp.id)}
                      className="w-4 h-4 accent-indigo-600 cursor-pointer rounded"
                    />
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-full bg-gradient-to-br ${TYPE_BG[cp.type]} flex items-center justify-center text-white text-xs font-bold shrink-0`}>
                        {cp.name.slice(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-slate-700">{cp.name}</p>
                        {cp.email && <p className="text-xs text-slate-400">{cp.email}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3.5">
                    <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-medium ${TYPE_COLOR[cp.type]}`}>
                      {TYPE_LABEL[cp.type]}
                    </span>
                  </td>
                  <td className="px-4 py-3.5 text-sm text-slate-500 font-mono">{cp.inn || '—'}</td>
                  <td className="px-4 py-3.5 text-sm font-semibold text-emerald-600 text-right">
                    {cp.income > 0 ? formatCurrency(cp.income) : '—'}
                  </td>
                  <td className="px-4 py-3.5 text-sm font-semibold text-red-500 text-right">
                    {cp.expense > 0 ? formatCurrency(cp.expense) : '—'}
                  </td>
                  <td className="px-5 py-3.5 text-sm text-slate-500 text-right">{cp.count}</td>
                  <td className="px-4 py-3.5">
                    <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={e => { e.stopPropagation(); openCardInEditMode(cp.id) }}
                        className="p-1.5 rounded-lg text-slate-300 hover:text-indigo-500 hover:bg-indigo-50 transition-colors">
                        <Pencil size={14} />
                      </button>
                      <button onClick={e => { e.stopPropagation(); setDeleteId(cp.id) }}
                        className="p-1.5 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Counterparty card modal ─────────────────────────────────────────── */}
      {cardCp && cardStat && (
        <div className="fixed inset-0 z-50 flex items-center justify-end bg-black/40 backdrop-blur-sm"
          onClick={closeCard}>
          <div
            className="bg-white h-full w-full max-w-md flex flex-col overflow-hidden shadow-2xl"
            onClick={e => e.stopPropagation()}>

            {/* Gradient header */}
            <div className={`bg-gradient-to-br ${TYPE_BG[cardCp.type]} px-6 pt-6 pb-8 shrink-0`}>
              <div className="flex items-start justify-between mb-4">
                <div className="w-14 h-14 rounded-2xl bg-white/20 flex items-center justify-center text-white text-xl font-bold">
                  {cardCp.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="flex gap-2">
                  {!editMode && (
                    <button onClick={openEdit}
                      className="p-2 rounded-lg bg-white/20 hover:bg-white/30 text-white transition-colors">
                      <Pencil size={15} />
                    </button>
                  )}
                  <button onClick={closeCard}
                    className="p-2 rounded-lg bg-white/20 hover:bg-white/30 text-white transition-colors">
                    <X size={15} />
                  </button>
                </div>
              </div>
              <h2 className="text-lg font-bold text-white leading-tight">{cardCp.name}</h2>
              <span className="inline-flex mt-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-white/25 text-white">
                {TYPE_LABEL[cardCp.type]}
              </span>
            </div>

            {/* Stats strip */}
            <div className="grid grid-cols-3 border-b border-slate-100 shrink-0">
              <div className="px-4 py-3 text-center border-r border-slate-100">
                <p className="text-xs text-slate-400 mb-0.5">Доходы</p>
                <p className="text-sm font-bold text-emerald-600">{cardStat.income > 0 ? formatCurrency(cardStat.income) : '—'}</p>
              </div>
              <div className="px-4 py-3 text-center border-r border-slate-100">
                <p className="text-xs text-slate-400 mb-0.5">Расходы</p>
                <p className="text-sm font-bold text-red-500">{cardStat.expense > 0 ? formatCurrency(cardStat.expense) : '—'}</p>
              </div>
              <div className="px-4 py-3 text-center">
                <p className="text-xs text-slate-400 mb-0.5">Операций</p>
                <p className="text-sm font-bold text-slate-700">{cardStat.count}</p>
              </div>
            </div>

            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto">
              {editMode ? (
                /* ── Edit form ──────────────────────────────────────────── */
                <form onSubmit={handleEditSave} className="px-6 py-5 space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1.5">Наименование</label>
                    <input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} required
                      className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300" />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1.5">Тип</label>
                    <div className="grid grid-cols-2 gap-2">
                      {(['client','supplier','employee','other'] as const).map(t => (
                        <button key={t} type="button" onClick={() => setEditForm(f => ({ ...f, type: t }))}
                          className={`py-2 rounded-lg text-sm font-medium border transition-all ${
                            editForm.type === t ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                          }`}>
                          {TYPE_LABEL[t]}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1.5">ИНН</label>
                    <input value={editForm.inn} onChange={e => setEditForm(f => ({ ...f, inn: e.target.value }))}
                      placeholder="1234567890" maxLength={12}
                      className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 font-mono outline-none focus:ring-2 focus:ring-indigo-300" />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1.5">Телефон</label>
                      <input value={editForm.phone} onChange={e => setEditForm(f => ({ ...f, phone: e.target.value }))}
                        placeholder="+7 999 123-45-67" type="tel"
                        className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1.5">Email</label>
                      <input value={editForm.email} onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))}
                        placeholder="mail@example.com" type="email"
                        className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300" />
                    </div>
                  </div>

                  {/* Bank details */}
                  <div className="pt-1">
                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Банковские реквизиты</p>
                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1.5">Расчётный счёт</label>
                        <input value={editForm.bankAccount} onChange={e => setEditForm(f => ({ ...f, bankAccount: e.target.value }))}
                          placeholder="40802810000000000000" maxLength={20}
                          className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 font-mono outline-none focus:ring-2 focus:ring-indigo-300" />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs font-medium text-slate-500 mb-1.5">БИК</label>
                          <input value={editForm.bik} onChange={e => setEditForm(f => ({ ...f, bik: e.target.value }))}
                            placeholder="044525593" maxLength={9}
                            className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 font-mono outline-none focus:ring-2 focus:ring-indigo-300" />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-slate-500 mb-1.5">Банк</label>
                          <input value={editForm.bankName} onChange={e => setEditForm(f => ({ ...f, bankName: e.target.value }))}
                            placeholder="Сбербанк"
                            className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300" />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1.5">Заметки</label>
                    <textarea value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
                      rows={3} placeholder="Любая дополнительная информация..."
                      className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300 resize-none" />
                  </div>

                  <div className="flex gap-3 pt-1">
                    <button type="button" onClick={() => setEditMode(false)}
                      className="flex-1 py-2.5 border border-slate-200 text-sm text-slate-600 font-medium rounded-lg hover:bg-slate-50 transition">
                      Отмена
                    </button>
                    <button type="submit"
                      className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition">
                      Сохранить
                    </button>
                  </div>
                </form>
              ) : (
                /* ── View mode ──────────────────────────────────────────── */
                <div className="px-6 py-5 space-y-5">

                  {/* Requisites */}
                  {(cardCp.inn || cardCp.phone || cardCp.email || cardCp.notes || cardCp.bankAccount || cardCp.bankName || cardCp.bik) ? (
                    <div className="space-y-2.5">
                      <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Реквизиты</h3>
                      {cardCp.inn && (
                        <div className="flex items-center gap-3 text-sm">
                          <Hash size={15} className="text-slate-300 shrink-0" />
                          <span className="text-slate-500 w-14 shrink-0">ИНН</span>
                          <span className="font-mono text-slate-700">{cardCp.inn}</span>
                        </div>
                      )}
                      {cardCp.phone && (
                        <div className="flex items-center gap-3 text-sm">
                          <Phone size={15} className="text-slate-300 shrink-0" />
                          <span className="text-slate-500 w-14 shrink-0">Тел</span>
                          <a href={`tel:${cardCp.phone}`} className="text-indigo-600 hover:underline">{cardCp.phone}</a>
                        </div>
                      )}
                      {cardCp.email && (
                        <div className="flex items-center gap-3 text-sm">
                          <Mail size={15} className="text-slate-300 shrink-0" />
                          <span className="text-slate-500 w-14 shrink-0">Email</span>
                          <a href={`mailto:${cardCp.email}`} className="text-indigo-600 hover:underline truncate">{cardCp.email}</a>
                        </div>
                      )}
                      {cardCp.notes && (
                        <div className="flex items-start gap-3 text-sm">
                          <FileText size={15} className="text-slate-300 shrink-0 mt-0.5" />
                          <span className="text-slate-500 w-14 shrink-0">Заметки</span>
                          <span className="text-slate-600 whitespace-pre-wrap">{cardCp.notes}</span>
                        </div>
                      )}

                      {/* Bank details */}
                      {(cardCp.bankAccount || cardCp.bankName || cardCp.bik) && (
                        <>
                          <div className="pt-1 pb-0.5">
                            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Банковские реквизиты</h3>
                          </div>
                          {cardCp.bankAccount && (
                            <div className="flex items-center gap-3 text-sm">
                              <Landmark size={15} className="text-slate-300 shrink-0" />
                              <span className="text-slate-500 w-14 shrink-0">Р/с</span>
                              <span className="font-mono text-slate-700 text-xs tracking-wide">
                                {cardCp.bankAccount.replace(/(.{4})/g, '$1 ').trim()}
                              </span>
                            </div>
                          )}
                          {cardCp.bik && (
                            <div className="flex items-center gap-3 text-sm">
                              <Landmark size={15} className="text-slate-300 shrink-0 opacity-0" />
                              <span className="text-slate-500 w-14 shrink-0">БИК</span>
                              <span className="font-mono text-slate-700">{cardCp.bik}</span>
                            </div>
                          )}
                          {cardCp.bankName && (
                            <div className="flex items-center gap-3 text-sm">
                              <Landmark size={15} className="text-slate-300 shrink-0 opacity-0" />
                              <span className="text-slate-500 w-14 shrink-0">Банк</span>
                              <span className="text-slate-700 text-xs">{cardCp.bankName}</span>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  ) : (
                    <button onClick={openEdit}
                      className="w-full py-3 border-2 border-dashed border-slate-200 rounded-xl text-sm text-slate-400 hover:border-indigo-300 hover:text-indigo-500 transition-colors">
                      + Добавить реквизиты
                    </button>
                  )}

                  {/* Recent transactions */}
                  {cardTx.length > 0 && (
                    <div className="space-y-2">
                      <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Последние операции</h3>
                      <div className="space-y-1">
                        {cardTx.map(t => {
                          const cat = categories.find(c => c.id === t.categoryId)
                          return (
                            <div key={t.id} className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-slate-50 transition-colors">
                              <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                                t.type === 'income' ? 'bg-emerald-50' : 'bg-red-50'
                              }`}>
                                {t.type === 'income'
                                  ? <ArrowDownRight size={13} className="text-emerald-500" />
                                  : <ArrowUpRight   size={13} className="text-red-500" />}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-medium text-slate-600 truncate">{(cat?.name ?? t.comment) || '—'}</p>
                                <p className="text-xs text-slate-400">{formatDate(t.date)}</p>
                              </div>
                              <span className={`text-sm font-semibold whitespace-nowrap ${
                                t.type === 'income' ? 'text-emerald-600' : 'text-red-500'
                              }`}>
                                {t.type === 'income' ? '+' : '−'}{formatCurrency(t.amount)}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            {!editMode && (
              <div className="px-6 py-4 border-t border-slate-100 shrink-0">
                <button onClick={() => setDeleteId(cardCp.id)}
                  className="w-full py-2.5 border border-red-200 text-sm text-red-500 font-medium rounded-lg hover:bg-red-50 transition flex items-center justify-center gap-2">
                  <Trash2 size={14} /> Удалить контрагента
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Add modal ─────────────────────────────────────────────────────────── */}
      {addOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h2 className="font-semibold text-slate-800">Новый контрагент</h2>
              <button onClick={() => { setAddOpen(false); setAddForm(emptyForm()) }}
                className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><X size={18} /></button>
            </div>
            <form onSubmit={handleAdd} className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Наименование</label>
                <input value={addForm.name} onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))} required
                  placeholder="ООО Ромашка"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Тип</label>
                <div className="grid grid-cols-2 gap-2">
                  {(['client','supplier','employee','other'] as const).map(t => (
                    <button key={t} type="button" onClick={() => setAddForm(f => ({ ...f, type: t }))}
                      className={`py-2 rounded-lg text-sm font-medium border transition-all ${
                        addForm.type === t ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                      }`}>
                      {TYPE_LABEL[t]}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">ИНН <span className="text-slate-400 font-normal">(необязательно)</span></label>
                <input value={addForm.inn} onChange={e => setAddForm(f => ({ ...f, inn: e.target.value }))}
                  placeholder="1234567890" maxLength={12}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 font-mono outline-none focus:ring-2 focus:ring-indigo-300" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1.5">Телефон</label>
                  <input value={addForm.phone} onChange={e => setAddForm(f => ({ ...f, phone: e.target.value }))}
                    placeholder="+7 999 …" type="tel"
                    className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1.5">Email</label>
                  <input value={addForm.email} onChange={e => setAddForm(f => ({ ...f, email: e.target.value }))}
                    placeholder="mail@…" type="email"
                    className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300" />
                </div>
              </div>
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => { setAddOpen(false); setAddForm(emptyForm()) }}
                  className="flex-1 py-2.5 border border-slate-200 text-sm text-slate-600 font-medium rounded-lg hover:bg-slate-50 transition">
                  Отмена
                </button>
                <button type="submit"
                  className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition">
                  Добавить
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Bulk delete confirm ───────────────────────────────────────────────── */}
      {bulkConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 text-center">
            <div className="text-3xl mb-3">🗑️</div>
            <h3 className="text-base font-semibold text-slate-800 mb-1">Удалить контрагентов?</h3>
            <p className="text-sm text-slate-500 mb-5">
              Будет удалено <span className="font-semibold text-slate-700">{selected.size}</span> контрагентов.
              Операции с ними останутся.
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

      {/* ── Delete confirm ─────────────────────────────────────────────────────── */}
      {deleteId && (() => {
        const cp = counterparties.find(c => c.id === deleteId)
        return (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 text-center">
              <div className="text-3xl mb-3">🗑️</div>
              <h3 className="text-base font-semibold text-slate-800 mb-1">Удалить контрагента?</h3>
              <p className="text-sm text-slate-500 mb-5">
                «{cp?.name}» будет удалён. Операции с ним останутся.
              </p>
              <div className="flex gap-3">
                <button onClick={() => setDeleteId(null)}
                  className="flex-1 py-2.5 border border-slate-200 text-sm text-slate-600 font-medium rounded-lg hover:bg-slate-50 transition">
                  Отмена
                </button>
                <button onClick={confirmDelete}
                  className="flex-1 py-2.5 bg-red-500 hover:bg-red-600 text-white text-sm font-medium rounded-lg transition">
                  Удалить
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
