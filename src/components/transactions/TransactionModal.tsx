import { useState, useCallback } from 'react'
import { X, Zap } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { TransactionType } from '../../types'
import { useStore } from '../../store/useStore'

interface Props {
  open: boolean
  onClose: () => void
}

export default function TransactionModal({ open, onClose }: Props) {
  const store = useStore()
  const navigate = useNavigate()
  const { accounts, categories, counterparties, projects, rules } = store

  const [type, setType] = useState<TransactionType>('income')
  const [amount, setAmount] = useState('')
  const [accountId, setAccountId] = useState('')
  const [toAccountId, setToAccountId] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [counterpartyId, setCounterpartyId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [comment, setComment] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [appliedRule, setAppliedRule] = useState<string | null>(null)

  // Apply matching enabled rules to current form state
  const applyRules = useCallback((fields: {
    type: TransactionType, accountId: string, counterpartyId: string, categoryId: string, projectId: string
  }) => {
    const enabledRules = rules.filter(r => r.enabled)
    for (const rule of enabledRules) {
      const allMatch = rule.conditions.every(cond => {
        const val = fields[cond.field as keyof typeof fields] ?? ''
        return val === cond.value
      })
      if (allMatch && rule.actions.length > 0) {
        const updates: Record<string, string> = {}
        rule.actions.forEach(a => { updates[a.field] = a.value })
        if (updates.categoryId !== undefined) setCategoryId(updates.categoryId)
        if (updates.projectId !== undefined) setProjectId(updates.projectId)
        if (updates.counterpartyId !== undefined) setCounterpartyId(updates.counterpartyId)
        if (updates.accountId !== undefined) setAccountId(updates.accountId)
        if (updates.comment !== undefined) setComment(updates.comment)
        setAppliedRule(rule.name)
        return
      }
    }
    setAppliedRule(null)
  }, [rules])

  if (!open) return null

  const curAccountId = accountId || (accounts[0]?.id ?? '')
  const filteredCats = categories.filter(c => c.type === type)
  const firstAcc = accounts[0]?.id ?? ''
  const secondAcc = accounts.find(a => a.id !== (accountId || firstAcc))?.id ?? ''

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const num = parseFloat(amount.replace(/\s/g, '').replace(',', '.'))
    if (!num || num <= 0) return
    const acc = accountId || firstAcc
    store.addTransaction({
      id: 't' + Date.now(),
      date,
      type,
      amount: num,
      accountId: acc,
      toAccountId: type === 'transfer' ? (toAccountId || secondAcc) : undefined,
      categoryId: categoryId || (filteredCats[0]?.id ?? ''),
      counterpartyId: counterpartyId || undefined,
      projectId: projectId || undefined,
      comment,
      tags: [],
    })
    onClose()
    setType('income')
    setAmount('')
    setAccountId('')
    setToAccountId('')
    setCategoryId('')
    setCounterpartyId('')
    setProjectId('')
    setComment('')
    setDate(new Date().toISOString().slice(0, 10))
    setAppliedRule(null)
  }

  const tabs: { t: TransactionType; label: string }[] = [
    { t: 'income', label: 'Доход' },
    { t: 'expense', label: 'Расход' },
    { t: 'transfer', label: 'Перевод' },
  ]

  // Need at least one account to add a transaction
  if (accounts.length === 0) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-8 text-center">
          <div className="text-4xl mb-3">🏦</div>
          <h2 className="font-semibold text-slate-800 mb-2">Сначала добавьте счёт</h2>
          <p className="text-sm text-slate-500 mb-5">Чтобы добавить операцию, нужен хотя бы один счёт</p>
          <div className="flex gap-3">
            <button onClick={onClose} className="flex-1 py-2.5 border border-slate-200 text-sm text-slate-600 rounded-lg hover:bg-slate-50 transition">
              Отмена
            </button>
            <button
              onClick={() => { onClose(); navigate('/accounts') }}
              className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition"
            >
              Добавить счёт
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <h2 className="font-semibold text-slate-800">Новая операция</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
            <X size={18} />
          </button>
        </div>

        {/* Type tabs */}
        <div className="flex gap-2 px-6 pt-4">
          {tabs.map(({ t, label }) => (
            <button
              key={t}
              onClick={() => {
                setType(t); setCategoryId('')
                applyRules({ type: t, accountId: curAccountId, counterpartyId, categoryId: '', projectId })
              }}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${
                type === t
                  ? t === 'income' ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                  : t === 'expense' ? 'bg-red-50 text-red-700 ring-1 ring-red-200'
                  : 'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200'
                  : 'text-slate-500 hover:bg-slate-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">Сумма, ₽</label>
            <input
              type="text" value={amount} onChange={e => setAmount(e.target.value)}
              placeholder="0" required
              className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-2xl font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-400 transition"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Дата</label>
              <input type="date" value={date} onChange={e => setDate(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">
                {type === 'transfer' ? 'Откуда' : 'Счёт'}
              </label>
              <select value={accountId || firstAcc} onChange={e => {
                  setAccountId(e.target.value)
                  applyRules({ type, accountId: e.target.value, counterpartyId, categoryId, projectId })
                }}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300">
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
          </div>

          {type === 'transfer' && accounts.length >= 2 && (
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Куда</label>
              <select value={toAccountId || secondAcc} onChange={e => setToAccountId(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300">
                {accounts.filter(a => a.id !== (accountId || firstAcc)).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">Статья</label>
            <select value={categoryId} onChange={e => setCategoryId(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300">
              <option value="">— Выберите статью —</option>
              {filteredCats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          {type !== 'transfer' && (
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Контрагент</label>
              <select value={counterpartyId} onChange={e => {
                  setCounterpartyId(e.target.value)
                  applyRules({ type, accountId: curAccountId, counterpartyId: e.target.value, categoryId, projectId })
                }}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300">
                <option value="">— Не указан —</option>
                {counterparties.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}

          {type !== 'transfer' && (
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Проект</label>
              <select value={projectId} onChange={e => setProjectId(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300">
                <option value="">— Без проекта —</option>
                {projects.filter(p => p.status === 'active').map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">Комментарий</label>
            <input type="text" value={comment} onChange={e => setComment(e.target.value)}
              placeholder="Необязательно"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300" />
          </div>

          {appliedRule && (
            <div className="flex items-center gap-2 bg-indigo-50 text-indigo-700 text-xs px-3 py-2 rounded-lg">
              <Zap size={13} className="shrink-0" />
              <span>Применено правило: <strong>{appliedRule}</strong></span>
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-600 font-medium hover:bg-slate-50 transition">
              Отмена
            </button>
            <button type="submit"
              className={`flex-1 py-2.5 rounded-lg text-white text-sm font-medium transition ${
                type === 'income' ? 'bg-emerald-500 hover:bg-emerald-600'
                : type === 'expense' ? 'bg-red-500 hover:bg-red-600'
                : 'bg-indigo-500 hover:bg-indigo-600'
              }`}>
              Сохранить
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
