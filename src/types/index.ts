export type TransactionType = 'income' | 'expense' | 'transfer'

export interface Account {
  id: string
  name: string
  type: 'cash' | 'bank' | 'card' | 'crypto'
  currency: string
  balance: number
  color: string
  rate?: number   // курс: 1 единица валюты счёта = N базовой валюты (RUB). Для RUB не задаётся
}

export type CategoryKind = 1 | 2 | 3           // 1=операционная, 2=инвестиционная, 3=финансовая
export type CategoryPnlSection =
  | 'direct'    // Выручка / Прямые расходы
  | 'indirect'  // Косвенные расходы
  | 'default'   // Прочие доходы/расходы
  | 'exclude'   // Не в ОПиУ (кредиты, займы, дивиденды)

export interface Category {
  id: string
  name: string
  type: TransactionType
  icon: string
  color: string
  parentId?: string
  isGroup?: boolean
  kind?: CategoryKind
  pnlSection?: CategoryPnlSection
}

export interface Counterparty {
  id: string
  name: string
  type: 'client' | 'supplier' | 'employee' | 'other'
  inn?: string
  phone?: string
  email?: string
  notes?: string
  bankAccount?: string
  bankName?: string
  bik?: string
}

export interface Transaction {
  id: string
  date: string          // дата оплаты → ДДС
  relatedDate?: string  // дата начисления → ОПиУ (метод начисления)
  type: TransactionType
  amount: number
  currency?: string     // валюта операции (если не указана = валюта счёта)
  exchangeRate?: number // 1 единица валюты = N базовой валюты (RUB)
  toAmount?: number     // для кросс-валютных переводов: сумма в валюте счёта-получателя
  accountId: string
  toAccountId?: string
  // Раньше было обязательным полем, хотя приложение всегда поддерживало
  // некатегоризированные операции ("Без статьи" — см. uncategorizedCount в
  // Dashboard.tsx/Transactions.tsx, !t.categoryId уже проверялось по всему
  // коду). Несоответствие типа реальности маскировало баг в Balance.tsx,
  // где такие операции молча выпадали из расчёта капитала.
  categoryId?: string
  counterpartyId?: string
  projectId?: string
  comment: string
  tags: string[]
  splitId?: string      // общий ID для частей разделённой операции
}

export interface SplitPart {
  categoryId: string
  amount: number
  comment?: string
  projectId?: string
}

export interface Project {
  id: string
  name: string
  description?: string
  color: string
  status: 'active' | 'archived'
  startDate?: string
  endDate?: string
}

export interface BudgetItem {
  id: string
  categoryId: string
  month: string
  planned: number
  actual: number
}

export type RuleConditionField =
  | 'type' | 'accountId' | 'counterpartyId' | 'categoryId' | 'projectId'
  | 'commentContains' | 'counterpartyName' | 'amountGt' | 'amountLt' | 'amountEq'
export type RuleActionField = 'categoryId' | 'projectId' | 'counterpartyId' | 'accountId' | 'comment'

export interface RuleCondition {
  id: string
  field: RuleConditionField
  value: string
}

export interface RuleAction {
  id: string
  field: RuleActionField
  value: string
}

export interface TransactionRule {
  id: string
  name: string
  enabled: boolean
  conditions: RuleCondition[]
  actions: RuleAction[]
}

export type RecurringPeriod = 'weekly' | 'monthly' | 'quarterly' | 'yearly'

export interface RecurringTemplate {
  id: string
  name: string
  type: 'income' | 'expense'
  amount: number
  accountId: string
  categoryId: string
  counterpartyId?: string
  projectId?: string
  comment: string
  period: RecurringPeriod
  nextDate: string   // YYYY-MM-DD — когда создать следующую операцию
  endDate?: string   // не создавать после этой даты
  enabled: boolean
}

export interface PaymentCalendarItem {
  id: string
  date: string
  type: TransactionType
  amount: number
  description: string
  counterpartyId?: string
  categoryId: string
  accountId?: string    // счёт списания/зачисления при оплате (БАГ №3)
  status: 'planned' | 'paid' | 'overdue'
}

// Журнал изменений закрытия периода — кто и когда открывал/закрывал период.
// Раньше это действие не оставляло никакого следа (баг антифрод-аудита №4).
export interface AuditEntry {
  id: string
  at: string             // ISO timestamp
  userId: string
  userName: string
  action: 'closing_date_changed'
  from: string           // предыдущее значение closingDate ('' = не было закрыто)
  to: string              // новое значение closingDate
}
