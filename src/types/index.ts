export type TransactionType = 'income' | 'expense' | 'transfer'

export interface Account {
  id: string
  name: string
  type: 'cash' | 'bank' | 'card' | 'crypto'
  currency: string
  balance: number
  color: string
}

export interface Category {
  id: string
  name: string
  type: TransactionType
  icon: string
  color: string
  parentId?: string
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
  date: string
  type: TransactionType
  amount: number
  accountId: string
  toAccountId?: string
  categoryId: string
  counterpartyId?: string
  projectId?: string
  comment: string
  tags: string[]
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

export type RuleConditionField = 'type' | 'accountId' | 'counterpartyId' | 'categoryId' | 'projectId'
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

export interface PaymentCalendarItem {
  id: string
  date: string
  type: TransactionType
  amount: number
  description: string
  counterpartyId?: string
  categoryId: string
  status: 'planned' | 'paid' | 'overdue'
}
