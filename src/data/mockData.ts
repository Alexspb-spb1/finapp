import type { Account, Category, Counterparty, Transaction } from '../types'

export const accounts: Account[] = [
  { id: 'acc1', name: 'Расчётный счёт', type: 'bank', currency: 'RUB', balance: 1_250_400, color: '#6366f1' },
  { id: 'acc2', name: 'Касса', type: 'cash', currency: 'RUB', balance: 85_000, color: '#22c55e' },
  { id: 'acc3', name: 'Корп. карта', type: 'card', currency: 'RUB', balance: 320_700, color: '#f59e0b' },
]

export const categories: Category[] = [
  { id: 'cat_inc1', name: 'Выручка от клиентов', type: 'income', icon: '💰', color: '#22c55e' },
  { id: 'cat_inc2', name: 'Прочие доходы', type: 'income', icon: '📈', color: '#10b981' },
  { id: 'cat_inc3', name: 'Займы полученные', type: 'income', icon: '🏦', color: '#6ee7b7' },
  { id: 'cat_exp1', name: 'Зарплата', type: 'expense', icon: '👥', color: '#ef4444' },
  { id: 'cat_exp2', name: 'Аренда', type: 'expense', icon: '🏢', color: '#f97316' },
  { id: 'cat_exp3', name: 'Реклама и маркетинг', type: 'expense', icon: '📣', color: '#a855f7' },
  { id: 'cat_exp4', name: 'Закупка товаров', type: 'expense', icon: '📦', color: '#3b82f6' },
  { id: 'cat_exp5', name: 'Налоги', type: 'expense', icon: '🏛️', color: '#64748b' },
  { id: 'cat_exp6', name: 'Связь и интернет', type: 'expense', icon: '📡', color: '#06b6d4' },
  { id: 'cat_exp7', name: 'Командировки', type: 'expense', icon: '✈️', color: '#8b5cf6' },
  { id: 'cat_tr1', name: 'Внутренний перевод', type: 'transfer', icon: '🔄', color: '#94a3b8' },
]

export const counterparties: Counterparty[] = [
  { id: 'cp1', name: 'ООО Ромашка', type: 'client' },
  { id: 'cp2', name: 'ИП Петров А.В.', type: 'client' },
  { id: 'cp3', name: 'ООО Поставщик Плюс', type: 'supplier' },
  { id: 'cp4', name: 'Яндекс Реклама', type: 'supplier' },
  { id: 'cp5', name: 'Иванов Сергей (ЗП)', type: 'employee' },
  { id: 'cp6', name: 'ИП Сидорова Анна', type: 'client' },
  { id: 'cp7', name: 'Бизнес-центр Заря', type: 'supplier' },
]

function dateStr(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export const transactions: Transaction[] = [
  // Май 2026
  { id: 't1', date: dateStr(2026,5,19), type: 'income', amount: 280000, accountId: 'acc1', categoryId: 'cat_inc1', counterpartyId: 'cp1', comment: 'Оплата по договору №125', tags: ['крупный'] },
  { id: 't2', date: dateStr(2026,5,18), type: 'expense', amount: 45000, accountId: 'acc1', categoryId: 'cat_exp1', counterpartyId: 'cp5', comment: 'Зарплата за первую половину мая', tags: [] },
  { id: 't3', date: dateStr(2026,5,17), type: 'expense', amount: 12000, accountId: 'acc3', categoryId: 'cat_exp6', comment: 'Тариф Яндекс.Облако', tags: [] },
  { id: 't4', date: dateStr(2026,5,15), type: 'income', amount: 150000, accountId: 'acc1', categoryId: 'cat_inc1', counterpartyId: 'cp2', comment: 'Предоплата за проект', tags: ['предоплата'] },
  { id: 't5', date: dateStr(2026,5,14), type: 'expense', amount: 90000, accountId: 'acc1', categoryId: 'cat_exp4', counterpartyId: 'cp3', comment: 'Закупка комплектующих', tags: [] },
  { id: 't6', date: dateStr(2026,5,12), type: 'expense', amount: 35000, accountId: 'acc3', categoryId: 'cat_exp3', counterpartyId: 'cp4', comment: 'Реклама в Яндекс.Директ', tags: ['маркетинг'] },
  { id: 't7', date: dateStr(2026,5,10), type: 'income', amount: 95000, accountId: 'acc1', categoryId: 'cat_inc1', counterpartyId: 'cp6', comment: 'Оплата услуг', tags: [] },
  { id: 't8', date: dateStr(2026,5,8), type: 'expense', amount: 80000, accountId: 'acc1', categoryId: 'cat_exp2', counterpartyId: 'cp7', comment: 'Аренда офиса — май', tags: ['аренда'] },
  { id: 't9', date: dateStr(2026,5,5), type: 'expense', amount: 52000, accountId: 'acc1', categoryId: 'cat_exp5', comment: 'УСН авансовый платёж', tags: ['налоги'] },
  { id: 't10', date: dateStr(2026,5,3), type: 'transfer', amount: 50000, accountId: 'acc1', toAccountId: 'acc2', categoryId: 'cat_tr1', comment: 'Пополнение кассы', tags: [] },
  // Апрель 2026
  { id: 't11', date: dateStr(2026,4,28), type: 'income', amount: 320000, accountId: 'acc1', categoryId: 'cat_inc1', counterpartyId: 'cp1', comment: 'Оплата апрель', tags: [] },
  { id: 't12', date: dateStr(2026,4,25), type: 'expense', amount: 90000, accountId: 'acc1', categoryId: 'cat_exp1', counterpartyId: 'cp5', comment: 'Зарплата апрель', tags: [] },
  { id: 't13', date: dateStr(2026,4,20), type: 'income', amount: 180000, accountId: 'acc1', categoryId: 'cat_inc1', counterpartyId: 'cp2', comment: 'Финальная оплата проекта', tags: ['крупный'] },
  { id: 't14', date: dateStr(2026,4,15), type: 'expense', amount: 80000, accountId: 'acc1', categoryId: 'cat_exp2', counterpartyId: 'cp7', comment: 'Аренда офиса — апрель', tags: [] },
  { id: 't15', date: dateStr(2026,4,12), type: 'expense', amount: 120000, accountId: 'acc1', categoryId: 'cat_exp4', counterpartyId: 'cp3', comment: 'Закупка материалов', tags: [] },
  { id: 't16', date: dateStr(2026,4,10), type: 'expense', amount: 40000, accountId: 'acc3', categoryId: 'cat_exp3', comment: 'SEO и контекст', tags: [] },
  { id: 't17', date: dateStr(2026,4,5), type: 'income', amount: 75000, accountId: 'acc1', categoryId: 'cat_inc2', comment: 'Возврат переплаты', tags: [] },
  // Март 2026
  { id: 't18', date: dateStr(2026,3,28), type: 'income', amount: 410000, accountId: 'acc1', categoryId: 'cat_inc1', counterpartyId: 'cp1', comment: 'Квартальная оплата', tags: ['крупный'] },
  { id: 't19', date: dateStr(2026,3,25), type: 'expense', amount: 90000, accountId: 'acc1', categoryId: 'cat_exp1', comment: 'Зарплата март', tags: [] },
  { id: 't20', date: dateStr(2026,3,20), type: 'expense', amount: 80000, accountId: 'acc1', categoryId: 'cat_exp2', comment: 'Аренда март', tags: [] },
  { id: 't21', date: dateStr(2026,3,15), type: 'income', amount: 130000, accountId: 'acc1', categoryId: 'cat_inc1', counterpartyId: 'cp6', comment: 'Оплата услуг', tags: [] },
  { id: 't22', date: dateStr(2026,3,10), type: 'expense', amount: 65000, accountId: 'acc1', categoryId: 'cat_exp4', comment: 'Закупка', tags: [] },
  { id: 't23', date: dateStr(2026,3,5), type: 'expense', amount: 55000, accountId: 'acc1', categoryId: 'cat_exp5', comment: 'Налоги Q1', tags: [] },
  // Февраль 2026
  { id: 't24', date: dateStr(2026,2,25), type: 'income', amount: 290000, accountId: 'acc1', categoryId: 'cat_inc1', counterpartyId: 'cp2', comment: 'Оплата февраль', tags: [] },
  { id: 't25', date: dateStr(2026,2,20), type: 'expense', amount: 90000, accountId: 'acc1', categoryId: 'cat_exp1', comment: 'Зарплата февраль', tags: [] },
  { id: 't26', date: dateStr(2026,2,15), type: 'expense', amount: 80000, accountId: 'acc1', categoryId: 'cat_exp2', comment: 'Аренда февраль', tags: [] },
  { id: 't27', date: dateStr(2026,2,10), type: 'income', amount: 95000, accountId: 'acc1', categoryId: 'cat_inc1', counterpartyId: 'cp6', comment: 'Новый клиент', tags: [] },
  // Январь 2026
  { id: 't28', date: dateStr(2026,1,28), type: 'income', amount: 260000, accountId: 'acc1', categoryId: 'cat_inc1', counterpartyId: 'cp1', comment: 'Оплата январь', tags: [] },
  { id: 't29', date: dateStr(2026,1,20), type: 'expense', amount: 90000, accountId: 'acc1', categoryId: 'cat_exp1', comment: 'Зарплата январь', tags: [] },
  { id: 't30', date: dateStr(2026,1,15), type: 'expense', amount: 80000, accountId: 'acc1', categoryId: 'cat_exp2', comment: 'Аренда январь', tags: [] },
]
