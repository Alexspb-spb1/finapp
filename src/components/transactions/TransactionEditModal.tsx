import { useState, useEffect, useRef } from 'react'
import { X, Building2, AlertCircle, Scissors, RefreshCw } from 'lucide-react'
import type { Transaction, TransactionType } from '../../types'
import { useStore } from '../../store/useStore'
import SplitTransactionModal from './SplitTransactionModal'
import TagInput from '../ui/TagInput'
import { isForeign, fetchRate } from '../../utils/currency'
import { formatCurrency } from '../../utils/format'

interface Props {
  transaction: Transaction | null
  onClose: () => void
}

// Inner component — remounts each time via key={transaction.id}
// so useState initializers always get the right values
function EditForm({ transaction, onClose }: { transaction: Transaction; onClose: () => void }) {
  const store = useStore()
  const { accounts, categories, counterparties, projects } = store

  const [type,           setType]           = useState<TransactionType>(transaction.type)
  const [amount,         setAmount]         = useState(String(transaction.amount))
  const [amountError,    setAmountError]    = useState('')
  const [date,           setDate]           = useState(transaction.date)
  const [accountId,      setAccountId]      = useState(transaction.accountId)
  const [toAccountId,    setToAccountId]    = useState(transaction.toAccountId ?? '')
  const [categoryId,     setCategoryId]     = useState(transaction.categoryId)
  const [counterpartyId, setCounterpartyId] = useState(transaction.counterpartyId ?? '')
  const [projectId,      setProjectId]      = useState(transaction.projectId ?? '')
  const [comment,        setComment]        = useState(() => {
    const raw = transaction.comment ?? ''
    // Убираем префикс «Контрагент | » если он есть (формат импорта из банка)
    const pipe = raw.indexOf(' | ')
    return pipe !== -1 ? raw.slice(pipe + 3) : raw
  })
  const [hasRelatedDate, setHasRelatedDate] = useState(!!transaction.relatedDate)
  const [relatedDate,    setRelatedDate]    = useState(transaction.relatedDate ?? transaction.date)
  const [tags,           setTags]           = useState<string[]>(transaction.tags ?? [])
  const [exchangeRate,   setExchangeRate]   = useState(String(transaction.exchangeRate ?? ''))
  const [toAmount,       setToAmount]       = useState(String(transaction.toAmount ?? ''))
  const [fetchingRate,   setFetchingRate]   = useState(false)
  const [splitOpen,      setSplitOpen]      = useState(false)
  const [saving,         setSaving]         = useState(false)
  const submittingRef = useRef(false)
  const today = new Date().toISOString().slice(0, 10)

  useEffect(() => {
    const acc = accounts.find(a => a.id === accountId)
    if (!acc || !isForeign(acc)) { setExchangeRate(''); return }
    if (exchangeRate) return  // don't overwrite existing rate
    setFetchingRate(true)
    fetchRate(acc.currency, 'RUB').then(r => {
      if (r) setExchangeRate(String(r))
      setFetchingRate(false)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId])

  const filteredCats = categories.filter(c => c.type === type && !c.isGroup)
  const typeGroups = categories.filter(c => c.type === type && c.isGroup)
  const standaloneCats = filteredCats.filter(c => !c.parentId)
  const childCats = filteredCats.filter(c => !!c.parentId)
  const selectedCp   = counterparties.find(c => c.id === counterpartyId)
  const selectedAcc  = accounts.find(a => a.id === accountId)

  // Доступный остаток счёта с отменой эффекта редактируемой операции (БАГ №5)
  function availableBalance(accId: string): number {
    const a = accounts.find(x => x.id === accId)
    if (!a) return 0
    let bal = a.balance
    if (transaction.accountId === accId) {
      if (transaction.type === 'income') bal -= transaction.amount
      else bal += transaction.amount // expense / источник перевода — возвращаем
    }
    if (transaction.type === 'transfer' && transaction.toAccountId === accId) {
      bal -= (transaction.toAmount ?? transaction.amount)
    }
    return bal
  }
  const numAmount = parseFloat(amount.replace(/\s/g, '').replace(',', '.')) || 0
  const overspendWarn = (type === 'expense' || type === 'transfer') && !!selectedAcc && selectedAcc.type !== 'cash' && numAmount > availableBalance(accountId)

  function handleSave() {
    // Период закрыт — операцию менять нельзя (БАГ №6)
    if (store.isPeriodLocked(transaction.date)) {
      setAmountError('Период закрыт — эту операцию нельзя изменить')
      return
    }
    const num = parseFloat(amount.replace(/\s/g, '').replace(',', '.'))
    if (!num || num <= 0) {
      setAmountError('Введите сумму больше 0')
      return
    }
    // Операция — свершившийся факт. Будущие платежи → в Платёжный календарь (БАГ №2)
    if (date > today) {
      setAmountError('Дата в будущем — плановые платежи в Платёжном календаре')
      return
    }
    const accObj = accounts.find(a => a.id === accountId)
    const toAccObj = accounts.find(a => a.id === toAccountId)
    // Наличные не могут уйти в минус — жёсткий блок (БАГ №5)
    if ((type === 'expense' || type === 'transfer') && accObj?.type === 'cash' && num > availableBalance(accountId)) {
      setAmountError(`Недостаточно наличных: остаток ${formatCurrency(availableBalance(accountId), accObj.currency)}`)
      return
    }
    const rate = exchangeRate ? parseFloat(exchangeRate) : undefined
    // Валютная операция обязана иметь курс (БАГ № 4)
    if (accObj && isForeign(accObj) && (!rate || rate <= 0)) {
      setAmountError(`Укажите курс ${accObj.currency} → RUB`)
      return
    }
    const isCross = type === 'transfer' && accObj && toAccObj && accObj.currency !== toAccObj.currency
    const toAmt = isCross && toAmount ? parseFloat(toAmount) : undefined
    if (isCross && (!toAmt || toAmt <= 0)) {
      setAmountError(`Укажите сумму в ${toAccObj?.currency}`)
      return
    }
    setAmountError('')

    // Защита от двойного клика (БАГ №1)
    if (submittingRef.current) return
    submittingRef.current = true
    setSaving(true)

    store.updateTransaction(transaction.id, {
      type,
      amount: num,
      currency: accObj?.currency,
      exchangeRate: rate,
      toAmount: toAmt,
      date,
      relatedDate: (type !== 'transfer' && hasRelatedDate) ? relatedDate : undefined,
      accountId,
      toAccountId: type === 'transfer' ? (toAccountId || undefined) : undefined,
      categoryId:  categoryId || (filteredCats[0]?.id ?? ''),
      counterpartyId: (type !== 'transfer' && counterpartyId) ? counterpartyId : undefined,
      projectId:   (type !== 'transfer' && projectId) ? projectId : undefined,
      comment,
      tags,
    })
    onClose()
  }

  const tabs: { t: TransactionType; label: string }[] = [
    { t: 'income',   label: 'Доход'   },
    { t: 'expense',  label: 'Расход'  },
    { t: 'transfer', label: 'Перевод' },
  ]

  const fmtBankAcc = (s: string) => s.replace(/(.{4})/g, '$1 ').trim()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 flex flex-col max-h-[92vh] overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 shrink-0">
          <h2 className="font-semibold text-slate-800">Редактировать операцию</h2>
          <button type="button" onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4 overflow-y-auto">

          {/* Type tabs */}
          <div className="flex gap-2">
            {tabs.map(({ t, label }) => (
              <button key={t} type="button"
                onClick={() => { setType(t); setCategoryId('') }}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${
                  type === t
                    ? t === 'income'   ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                    : t === 'expense'  ? 'bg-red-50 text-red-700 ring-1 ring-red-200'
                    :                   'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200'
                    : 'text-slate-500 hover:bg-slate-50'
                }`}>
                {label}
              </button>
            ))}
          </div>

          {/* Amount + Date */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Сумма, ₽</label>

              <input
                type="text"
                value={amount}
                onChange={e => { setAmount(e.target.value); setAmountError('') }}
                placeholder="0"
                className={`w-full border rounded-lg px-3 py-2.5 text-xl font-semibold text-slate-800 outline-none focus:ring-2 transition ${
                  amountError ? 'border-red-400 focus:ring-red-300' : 'border-slate-200 focus:ring-indigo-300'
                }`}
              />
              {amountError && (
                <p className="mt-1 text-xs text-red-500 flex items-center gap-1">
                  <AlertCircle size={11} /> {amountError}
                </p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">
                {hasRelatedDate ? 'Дата оплаты (ДДС)' : 'Дата'}
              </label>
              <input
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300"
              />
              {type !== 'transfer' && (
                <button type="button"
                  onClick={() => { setHasRelatedDate(v => !v); if (!hasRelatedDate) setRelatedDate(date) }}
                  className={`mt-1.5 text-[11px] font-medium transition-colors ${hasRelatedDate ? 'text-indigo-500 hover:text-indigo-700' : 'text-slate-400 hover:text-slate-600'}`}>
                  {hasRelatedDate ? '✓ Дата начисления ≠' : '+ Дата начисления'}
                </button>
              )}
            </div>
          </div>

          {type !== 'transfer' && hasRelatedDate && (
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Дата начисления (ОПиУ)</label>
              <input type="date" value={relatedDate} onChange={e => setRelatedDate(e.target.value)}
                className="w-full border border-indigo-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300 bg-indigo-50/30" />
              <p className="text-[11px] text-slate-400 mt-1">Используется в ОПиУ вместо даты оплаты</p>
            </div>
          )}

          {/* My account */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">
              {type === 'transfer' ? 'Откуда (мой счёт)' : 'Мой счёт'}
            </label>
            <select
              value={accountId}
              onChange={e => setAccountId(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300"
            >
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            {selectedAcc && (
              <p className="text-xs text-slate-400 mt-1">
                {selectedAcc.type === 'bank'   ? 'Банковский счёт'
                  : selectedAcc.type === 'card' ? 'Карта'
                  : selectedAcc.type === 'cash' ? 'Наличные'
                  : 'Криптовалюта'} · {selectedAcc.currency}
              </p>
            )}
          </div>

          {/* Transfer: to account */}
          {type === 'transfer' && (
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Куда</label>
              <select
                value={toAccountId}
                onChange={e => setToAccountId(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300"
              >
                <option value="">— Выберите счёт —</option>
                {accounts.filter(a => a.id !== accountId).map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Exchange rate — shown when source account is foreign currency */}
          {(() => {
            const acc = accounts.find(a => a.id === accountId)
            if (!acc || !isForeign(acc)) return null
            const toAcc = type === 'transfer' ? accounts.find(a => a.id === toAccountId) : undefined
            const isCross = type === 'transfer' && toAcc && toAcc.currency !== acc.currency
            return (
              <div className="grid grid-cols-2 gap-3 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                <div>
                  <label className="block text-xs font-medium text-amber-700 mb-1.5">
                    Курс ({acc.currency} → RUB)
                    {fetchingRate && <span className="ml-1 animate-spin inline-block"><RefreshCw size={10} /></span>}
                  </label>
                  <input
                    type="number" step="0.0001" min="0"
                    value={exchangeRate}
                    onChange={e => setExchangeRate(e.target.value)}
                    placeholder="например 90.5"
                    className="w-full border border-amber-300 bg-white rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-amber-300"
                  />
                </div>
                {isCross ? (
                  <div>
                    <label className="block text-xs font-medium text-amber-700 mb-1.5">
                      Сумма в {toAcc?.currency ?? ''}
                    </label>
                    <input
                      type="number" step="0.01" min="0"
                      value={toAmount}
                      onChange={e => setToAmount(e.target.value)}
                      placeholder="0"
                      className="w-full border border-amber-300 bg-white rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-amber-300"
                    />
                  </div>
                ) : (
                  <div className="flex items-end pb-2">
                    <p className="text-xs text-amber-600">
                      ≈ {exchangeRate && amount
                        ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(
                            parseFloat(amount.replace(/\s/g, '').replace(',', '.') || '0') * parseFloat(exchangeRate)
                          ) + ' ₽'
                        : '— ₽'}
                    </p>
                  </div>
                )}
              </div>
            )
          })()}

          {/* Category */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">Статья</label>
            <select
              value={categoryId}
              onChange={e => setCategoryId(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300"
            >
              <option value="">— Выберите статью —</option>
              {typeGroups.map(g => (
                <optgroup key={g.id} label={g.name}>
                  {childCats.filter(c => c.parentId === g.id).map(c =>
                    <option key={c.id} value={c.id}>{c.name}</option>
                  )}
                </optgroup>
              ))}
              {standaloneCats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          {/* Counterparty */}
          {type !== 'transfer' && (
            <>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Контрагент</label>
                <select
                  value={counterpartyId}
                  onChange={e => setCounterpartyId(e.target.value)}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300"
                >
                  <option value="">— Не указан —</option>
                  {counterparties.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>

              {/* Counterparty bank details (read-only) */}
              {selectedCp && (selectedCp.bankAccount || selectedCp.inn) && (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 space-y-2.5">
                  <div className="flex items-center gap-2 text-slate-400">
                    <Building2 size={13} />
                    <span className="text-[11px] font-semibold uppercase tracking-wide">Реквизиты контрагента</span>
                  </div>
                  {selectedCp.bankAccount && (
                    <div>
                      <p className="text-[10px] text-slate-400 uppercase tracking-wide mb-0.5">Р/с контрагента</p>
                      <p className="text-sm font-mono text-slate-700 font-medium tracking-wide">
                        {fmtBankAcc(selectedCp.bankAccount)}
                      </p>
                    </div>
                  )}
                  {selectedCp.bankName && (
                    <div>
                      <p className="text-[10px] text-slate-400 uppercase tracking-wide mb-0.5">Банк</p>
                      <p className="text-sm text-slate-700">{selectedCp.bankName}</p>
                    </div>
                  )}
                  {selectedCp.inn && (
                    <div>
                      <p className="text-[10px] text-slate-400 uppercase tracking-wide mb-0.5">ИНН</p>
                      <p className="text-sm text-slate-700">{selectedCp.inn}</p>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Project */}
          {type !== 'transfer' && (
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Проект</label>
              <select
                value={projectId}
                onChange={e => setProjectId(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300"
              >
                <option value="">— Без проекта —</option>
                {projects.filter(p => p.status === 'active').map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Comment / Назначение платежа */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">Назначение платежа</label>
            <textarea
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder="Введите назначение платежа..."
              rows={2}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300 resize-none"
            />
          </div>

          {/* Tags */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">Теги</label>
            <TagInput
              value={tags}
              onChange={setTags}
              suggestions={store.allTags}
            />
          </div>

          {!amountError && overspendWarn && selectedAcc && (
            <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 text-amber-700 text-sm px-3 py-2.5 rounded-lg">
              <AlertCircle size={14} className="shrink-0" /> Сумма больше остатка ({formatCurrency(availableBalance(accountId), selectedAcc.currency)}) — баланс уйдёт в минус
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-1 pb-2">
            <button type="button" onClick={onClose}
              className="flex-1 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-600 font-medium hover:bg-slate-50 transition">
              Отмена
            </button>
            {type !== 'transfer' && !transaction.splitId && (
              <button type="button" onClick={() => setSplitOpen(true)}
                className="px-3 py-2.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-indigo-50 hover:border-indigo-300 hover:text-indigo-600 transition-colors"
                title="Разделить операцию на части">
                <Scissors size={15} />
              </button>
            )}
            <button type="button" onClick={handleSave} disabled={saving}
              className={`flex-1 py-2.5 rounded-lg text-white text-sm font-medium transition disabled:opacity-60 disabled:cursor-not-allowed ${
                type === 'income'   ? 'bg-emerald-500 hover:bg-emerald-600'
                : type === 'expense' ? 'bg-red-500 hover:bg-red-600'
                : 'bg-indigo-500 hover:bg-indigo-600'
              }`}>
              {saving ? 'Сохранение…' : 'Сохранить'}
            </button>
          </div>
        </div>
      </div>

      <SplitTransactionModal
        transaction={splitOpen ? transaction : null}
        onClose={() => { setSplitOpen(false); onClose() }}
      />
    </div>
  )
}

// Outer wrapper: renders nothing when transaction is null,
// remounts EditForm via key when transaction changes
export default function TransactionEditModal({ transaction, onClose }: Props) {
  if (!transaction) return null
  return <EditForm key={transaction.id} transaction={transaction} onClose={onClose} />
}
