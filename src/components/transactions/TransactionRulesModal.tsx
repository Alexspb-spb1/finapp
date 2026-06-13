import { useState } from 'react'
import { X, Plus, Trash2, Zap, ToggleLeft, ToggleRight, ChevronRight, PlayCircle, CheckCircle2 } from 'lucide-react'
import { useStore } from '../../store/useStore'
import type { TransactionRule, RuleCondition, RuleAction, RuleConditionField, RuleActionField, Transaction } from '../../types'
import { formatCurrency, formatDate } from '../../utils/format'
import CategoryIcon from '../../utils/categoryIcons'

interface Props {
  open: boolean
  onClose: () => void
}

const CONDITION_FIELD_LABELS: Record<RuleConditionField, string> = {
  type: 'Тип операции',
  accountId: 'Счёт',
  counterpartyId: 'Контрагент',
  categoryId: 'Статья',
  projectId: 'Проект',
}

const ACTION_FIELD_LABELS: Record<RuleActionField, string> = {
  categoryId: 'Статья',
  projectId: 'Проект',
  counterpartyId: 'Контрагент',
  accountId: 'Счёт',
  comment: 'Комментарий',
}

const TYPE_LABELS: Record<string, string> = {
  income: 'Доход',
  expense: 'Расход',
  transfer: 'Перевод',
}

function emptyCondition(): RuleCondition {
  return { id: 'c' + Date.now() + Math.random(), field: 'type', value: 'income' }
}
function emptyAction(): RuleAction {
  return { id: 'a' + Date.now() + Math.random(), field: 'projectId', value: '' }
}
function emptyRule(): Omit<TransactionRule, 'id'> {
  return { name: '', enabled: true, conditions: [emptyCondition()], actions: [emptyAction()] }
}

// Check if a transaction matches all conditions of a rule
function matchesRule(rule: TransactionRule, tx: Transaction): boolean {
  return rule.conditions.every(cond => {
    const val: string = (tx as any)[cond.field] ?? ''
    return val === cond.value
  })
}

// Build the changes that a rule's actions would apply to a transaction
function buildChanges(rule: TransactionRule): Partial<Transaction> {
  const changes: Partial<Transaction> = {}
  rule.actions.forEach(a => {
    if (a.field === 'categoryId')     changes.categoryId = a.value
    if (a.field === 'projectId')      changes.projectId = a.value || undefined
    if (a.field === 'counterpartyId') changes.counterpartyId = a.value || undefined
    if (a.field === 'accountId')      changes.accountId = a.value
    if (a.field === 'comment')        changes.comment = a.value
  })
  return changes
}

type StoreSlice = {
  accounts: import('../../types').Account[]
  categories: import('../../types').Category[]
  counterparties: import('../../types').Counterparty[]
  projects: import('../../types').Project[]
}

export default function TransactionRulesModal({ open, onClose }: Props) {
  const store = useStore()
  const { rules, accounts, categories, counterparties, projects, transactions } = store

  const [editing, setEditing] = useState<(TransactionRule & { isNew?: boolean }) | null>(null)
  // Preview: apply rule to existing transactions
  const [applyPreview, setApplyPreview] = useState<{
    rule: TransactionRule
    matches: Transaction[]
    changes: Partial<Transaction>
    applied: boolean
  } | null>(null)

  if (!open) return null

  function labelFor(field: RuleConditionField | RuleActionField, value: string): string {
    if (!value) return '—'
    if (field === 'type') return TYPE_LABELS[value] ?? value
    if (field === 'accountId') return accounts.find(a => a.id === value)?.name ?? value
    if (field === 'counterpartyId') return counterparties.find(c => c.id === value)?.name ?? value
    if (field === 'categoryId') {
      const cat = categories.find(c => c.id === value)
      return cat ? `${cat.icon} ${cat.name}` : value
    }
    if (field === 'projectId') return projects.find(p => p.id === value)?.name ?? (value ? value : '— Без проекта —')
    if (field === 'comment') return `"${value}"`
    return value
  }

  function startApplyPreview(rule: TransactionRule) {
    const matches = transactions.filter(tx => matchesRule(rule, tx))
    const changes = buildChanges(rule)
    setApplyPreview({ rule, matches, changes, applied: false })
  }

  function confirmApply() {
    if (!applyPreview) return
    const updates = applyPreview.matches.map(tx => ({
      id: tx.id,
      changes: applyPreview.changes,
    }))
    store.batchUpdateTransactions(updates)
    setApplyPreview(prev => prev ? { ...prev, applied: true } : null)
  }

  function startNew() {
    setEditing({ id: 'r' + Date.now(), isNew: true, ...emptyRule() })
  }

  function saveRule() {
    if (!editing) return
    const { isNew, ...rule } = editing
    if (!rule.name.trim()) return
    if (isNew) store.addRule(rule)
    else store.updateRule(rule.id, rule)
    setEditing(null)
  }

  // ── Apply preview modal ──────────────────────────────────────────────────────
  if (applyPreview) {
    const { rule, matches, changes, applied } = applyPreview
    const changeLabels = Object.entries(changes)
      .map(([field, val]) => `${ACTION_FIELD_LABELS[field as RuleActionField]}: ${labelFor(field as RuleActionField, String(val ?? ''))}`)
      .join(', ')

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[85vh] overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 shrink-0">
            <div>
              <h2 className="font-semibold text-slate-800">Применить правило</h2>
              <p className="text-xs text-slate-400 mt-0.5">{rule.name}</p>
            </div>
            <button onClick={() => setApplyPreview(null)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><X size={18} /></button>
          </div>

          {applied ? (
            <div className="flex flex-col items-center justify-center py-14 text-center px-8">
              <CheckCircle2 size={44} className="text-emerald-500 mb-3" />
              <p className="font-semibold text-slate-800 mb-1">Готово!</p>
              <p className="text-sm text-slate-400">
                {matches.length > 0
                  ? `Изменено ${matches.length} операций`
                  : 'Не найдено операций для изменения'}
              </p>
              <button onClick={() => setApplyPreview(null)}
                className="mt-6 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition">
                Закрыть
              </button>
            </div>
          ) : matches.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 text-center px-8">
              <div className="text-4xl mb-3">🔍</div>
              <p className="font-semibold text-slate-700 mb-1">Нет подходящих операций</p>
              <p className="text-sm text-slate-400">Ни одна существующая операция не соответствует условиям правила</p>
              <button onClick={() => setApplyPreview(null)}
                className="mt-6 px-6 py-2.5 border border-slate-200 text-slate-600 text-sm font-medium rounded-lg hover:bg-slate-50 transition">
                Закрыть
              </button>
            </div>
          ) : (
            <>
              {/* What will change */}
              <div className="px-6 py-3 bg-indigo-50 border-b border-indigo-100 shrink-0">
                <p className="text-xs text-indigo-700">
                  <span className="font-semibold">Будет изменено {matches.length} операций:</span> {changeLabels}
                </p>
              </div>

              {/* List of matching transactions */}
              <div className="overflow-y-auto flex-1">
                <ul className="divide-y divide-slate-100">
                  {matches.map(tx => {
                    const cat = categories.find(c => c.id === tx.categoryId)
                    const cp = counterparties.find(c => c.id === tx.counterpartyId)
                    const proj = projects.find(p => p.id === tx.projectId)
                    const acc = accounts.find(a => a.id === tx.accountId)
                    return (
                      <li key={tx.id} className="flex items-center gap-3 px-5 py-3">
                        <div
                          className="w-8 h-8 icon-circle flex items-center justify-center shrink-0"
                          style={{ background: (cat?.color ?? '#94a3b8') + '22' }}
                        >
                          <CategoryIcon name={cat?.icon ?? 'DollarSign'} size={14} color={cat?.color ?? '#94a3b8'} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-slate-700 truncate">{cat?.name ?? '—'}</p>
                          <p className="text-xs text-slate-400 truncate">
                            {formatDate(tx.date)}
                            {acc && <span> · {acc.name}</span>}
                            {cp && <span> · {cp.name}</span>}
                            {proj && <span> · {proj.name}</span>}
                          </p>
                        </div>
                        <span className={`text-sm font-semibold shrink-0 ${
                          tx.type === 'income' ? 'text-emerald-600'
                          : tx.type === 'expense' ? 'text-red-500'
                          : 'text-indigo-500'
                        }`}>
                          {tx.type === 'income' ? '+' : tx.type === 'expense' ? '−' : '⇄'}{formatCurrency(tx.amount)}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </div>

              <div className="px-6 py-4 border-t border-slate-100 flex gap-3 shrink-0">
                <button onClick={() => setApplyPreview(null)}
                  className="flex-1 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-600 font-medium hover:bg-slate-50 transition">
                  Отмена
                </button>
                <button onClick={confirmApply}
                  className="flex-1 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium transition">
                  Изменить {matches.length} операций
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    )
  }

  // ── Rule editor ──────────────────────────────────────────────────────────────
  if (editing) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden flex flex-col max-h-[90vh]">
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 shrink-0">
            <h2 className="font-semibold text-slate-800">{editing.isNew ? 'Новое правило' : 'Редактировать правило'}</h2>
            <button onClick={() => setEditing(null)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><X size={18} /></button>
          </div>

          <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">
            {/* Name */}
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Название правила</label>
              <input
                value={editing.name}
                onChange={e => setEditing(r => r && { ...r, name: e.target.value })}
                placeholder="Например: Шабалин → Проект Слава"
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300"
              />
            </div>

            {/* Conditions */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Если (все условия)</span>
                <button
                  onClick={() => setEditing(r => r && { ...r, conditions: [...r.conditions, emptyCondition()] })}
                  className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 font-medium"
                >
                  <Plus size={13} /> Добавить
                </button>
              </div>
              <div className="space-y-2">
                {editing.conditions.map((cond, i) => (
                  <ConditionRow
                    key={cond.id}
                    cond={cond}
                    accounts={accounts} categories={categories} counterparties={counterparties} projects={projects}
                    onChange={updated => setEditing(r => r && { ...r, conditions: r.conditions.map((c, j) => j === i ? updated : c) })}
                    onRemove={() => setEditing(r => r && { ...r, conditions: r.conditions.filter((_, j) => j !== i) })}
                    canRemove={editing.conditions.length > 1}
                  />
                ))}
              </div>
            </div>

            {/* Actions */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">То (действия)</span>
                <button
                  onClick={() => setEditing(r => r && { ...r, actions: [...r.actions, emptyAction()] })}
                  className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 font-medium"
                >
                  <Plus size={13} /> Добавить
                </button>
              </div>
              <div className="space-y-2">
                {editing.actions.map((act, i) => (
                  <ActionRow
                    key={act.id}
                    act={act}
                    accounts={accounts} categories={categories} counterparties={counterparties} projects={projects}
                    onChange={updated => setEditing(r => r && { ...r, actions: r.actions.map((a, j) => j === i ? updated : a) })}
                    onRemove={() => setEditing(r => r && { ...r, actions: r.actions.filter((_, j) => j !== i) })}
                    canRemove={editing.actions.length > 1}
                  />
                ))}
              </div>
            </div>

            {/* Apply to all existing — only for saved rules */}
            {!editing.isNew && (
              <div className="pt-1 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => { setEditing(null); startApplyPreview(editing) }}
                  className="w-full flex items-center justify-center gap-2 border border-indigo-200 text-indigo-600 hover:bg-indigo-50 text-sm font-medium py-2.5 rounded-lg transition"
                >
                  <PlayCircle size={16} />
                  Применить ко всем существующим операциям
                </button>
              </div>
            )}
          </div>

          <div className="px-6 py-4 border-t border-slate-100 flex gap-3 shrink-0">
            <button onClick={() => setEditing(null)}
              className="flex-1 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-600 font-medium hover:bg-slate-50 transition">
              Отмена
            </button>
            <button
              onClick={saveRule}
              disabled={!editing.name.trim()}
              className="flex-1 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-sm font-medium transition">
              Сохранить
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Rules list ───────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 shrink-0">
          <div className="flex items-center gap-2">
            <Zap size={18} className="text-indigo-500" />
            <h2 className="font-semibold text-slate-800">Правила автозаполнения</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><X size={18} /></button>
        </div>

        <div className="overflow-y-auto flex-1">
          {rules.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center px-8">
              <div className="text-4xl mb-3">⚡</div>
              <p className="text-sm font-medium text-slate-700 mb-1">Нет правил</p>
              <p className="text-xs text-slate-400">Правила автоматически заполняют поля при создании операции</p>
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {rules.map(rule => (
                <li key={rule.id} className="px-5 py-3.5 hover:bg-slate-50 transition group">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => store.updateRule(rule.id, { enabled: !rule.enabled })}
                      className="shrink-0 text-slate-300 hover:text-indigo-500 transition"
                      title={rule.enabled ? 'Отключить' : 'Включить'}
                    >
                      {rule.enabled
                        ? <ToggleRight size={22} className="text-indigo-500" />
                        : <ToggleLeft size={22} />}
                    </button>
                    <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setEditing(rule)}>
                      <p className={`text-sm font-medium truncate ${rule.enabled ? 'text-slate-800' : 'text-slate-400'}`}>{rule.name}</p>
                      <p className="text-xs text-slate-400 truncate mt-0.5">
                        {rule.conditions.map(c => `${CONDITION_FIELD_LABELS[c.field]}: ${labelFor(c.field, c.value)}`).join(' · ')}
                        {' → '}
                        {rule.actions.map(a => `${ACTION_FIELD_LABELS[a.field]}: ${labelFor(a.field, a.value)}`).join(' · ')}
                      </p>
                    </div>
                    {/* Apply to all button */}
                    <button
                      onClick={() => startApplyPreview(rule)}
                      className="p-1.5 rounded-lg text-slate-300 group-hover:text-indigo-500 hover:bg-indigo-50 transition shrink-0"
                      title="Применить ко всем операциям"
                    >
                      <PlayCircle size={16} />
                    </button>
                    <button onClick={() => setEditing(rule)} className="p-1.5 rounded-lg text-slate-300 group-hover:text-slate-500 hover:bg-slate-100 transition shrink-0">
                      <ChevronRight size={15} />
                    </button>
                    <button onClick={() => store.deleteRule(rule.id)} className="p-1.5 rounded-lg text-slate-300 group-hover:text-red-400 hover:bg-red-50 transition shrink-0">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 shrink-0">
          <button
            onClick={startNew}
            className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium py-2.5 rounded-lg transition"
          >
            <Plus size={16} /> Добавить правило
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Condition row ────────────────────────────────────────────────────────────

function ConditionRow({ cond, onChange, onRemove, canRemove, accounts, categories, counterparties, projects }: {
  cond: RuleCondition
  onChange: (c: RuleCondition) => void
  onRemove: () => void
  canRemove: boolean
} & StoreSlice) {
  function setField(field: RuleConditionField) {
    const defaultValue: Record<RuleConditionField, string> = {
      type: 'income',
      accountId: accounts[0]?.id ?? '',
      counterpartyId: counterparties[0]?.id ?? '',
      categoryId: categories[0]?.id ?? '',
      projectId: projects[0]?.id ?? '',
    }
    onChange({ ...cond, field, value: defaultValue[field] })
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={cond.field}
        onChange={e => setField(e.target.value as RuleConditionField)}
        className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300 bg-white"
      >
        {(Object.keys(CONDITION_FIELD_LABELS) as RuleConditionField[]).map(f => (
          <option key={f} value={f}>{CONDITION_FIELD_LABELS[f]}</option>
        ))}
      </select>

      <span className="text-xs text-slate-400 shrink-0">=</span>

      <select
        value={cond.value}
        onChange={e => onChange({ ...cond, value: e.target.value })}
        className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300 bg-white"
      >
        {cond.field === 'type' && (
          <>
            <option value="income">Доход</option>
            <option value="expense">Расход</option>
            <option value="transfer">Перевод</option>
          </>
        )}
        {cond.field === 'accountId' && accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        {cond.field === 'counterpartyId' && counterparties.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        {cond.field === 'categoryId' && categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        {cond.field === 'projectId' && projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>

      {canRemove && (
        <button onClick={onRemove} className="p-1.5 text-slate-300 hover:text-red-400 hover:bg-red-50 rounded-lg transition shrink-0">
          <Trash2 size={14} />
        </button>
      )}
    </div>
  )
}

// ── Action row ───────────────────────────────────────────────────────────────

function ActionRow({ act, onChange, onRemove, canRemove, accounts, categories, counterparties, projects }: {
  act: RuleAction
  onChange: (a: RuleAction) => void
  onRemove: () => void
  canRemove: boolean
} & StoreSlice) {
  function setField(field: RuleActionField) {
    const defaultValue: Record<RuleActionField, string> = {
      categoryId: categories[0]?.id ?? '',
      projectId: projects[0]?.id ?? '',
      counterpartyId: counterparties[0]?.id ?? '',
      accountId: accounts[0]?.id ?? '',
      comment: '',
    }
    onChange({ ...act, field, value: defaultValue[field] })
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={act.field}
        onChange={e => setField(e.target.value as RuleActionField)}
        className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300 bg-white"
      >
        {(Object.keys(ACTION_FIELD_LABELS) as RuleActionField[]).map(f => (
          <option key={f} value={f}>{ACTION_FIELD_LABELS[f]}</option>
        ))}
      </select>

      <span className="text-xs text-slate-400 shrink-0">→</span>

      {act.field === 'comment' ? (
        <input
          value={act.value}
          onChange={e => onChange({ ...act, value: e.target.value })}
          placeholder="Текст комментария"
          className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300"
        />
      ) : (
        <select
          value={act.value}
          onChange={e => onChange({ ...act, value: e.target.value })}
          className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300 bg-white"
        >
          {act.field === 'categoryId' && categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          {act.field === 'projectId' && (
            <>
              <option value="">— Без проекта —</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </>
          )}
          {act.field === 'counterpartyId' && (
            <>
              <option value="">— Не указан —</option>
              {counterparties.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </>
          )}
          {act.field === 'accountId' && accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      )}

      {canRemove && (
        <button onClick={onRemove} className="p-1.5 text-slate-300 hover:text-red-400 hover:bg-red-50 rounded-lg transition shrink-0">
          <Trash2 size={14} />
        </button>
      )}
    </div>
  )
}
