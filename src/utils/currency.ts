import type { Transaction, Account } from '../types'

export const CURRENCIES = [
  { code: 'RUB', symbol: '₽', name: 'Российский рубль' },
  { code: 'USD', symbol: '$', name: 'Доллар США' },
  { code: 'EUR', symbol: '€', name: 'Евро' },
  { code: 'CNY', symbol: '¥', name: 'Китайский юань' },
  { code: 'GBP', symbol: '£', name: 'Фунт стерлингов' },
  { code: 'CHF', symbol: '₣', name: 'Швейцарский франк' },
  { code: 'TRY', symbol: '₺', name: 'Турецкая лира' },
  { code: 'KZT', symbol: '₸', name: 'Казахстанский тенге' },
  { code: 'BYN', symbol: 'Br', name: 'Белорусский рубль' },
  { code: 'AMD', symbol: '֏', name: 'Армянский драм' },
  { code: 'GEL', symbol: '₾', name: 'Грузинский лари' },
  { code: 'BTC', symbol: '₿', name: 'Bitcoin' },
  { code: 'USDT', symbol: '₮', name: 'Tether USDT' },
]

export function currencySymbol(code: string): string {
  return CURRENCIES.find(c => c.code === code)?.symbol ?? code
}

/** Округление денежной суммы до копеек — защита от дрейфа float (БАГ № 1) */
export function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100
}

/** Верхний предел суммы операции — 1 трлн (БАГ №9) */
export const MAX_MONEY = 1e12

/**
 * Строгий парсинг денежного ввода (БАГ №8).
 * Принимает только корректное неотрицательное число: "1 200,50" → 1200.5.
 * Возвращает null для "abc", "12abc", "-500", пустой строки.
 */
export function parseMoney(input: string): number | null {
  const clean = input.replace(/\s/g, '').replace(',', '.')
  if (!/^\d*\.?\d+$/.test(clean)) return null
  const n = parseFloat(clean)
  return isFinite(n) ? n : null
}

/** Convert transaction amount to base currency amount */
export function toBase(tx: Transaction): number {
  return round2(tx.amount * (tx.exchangeRate ?? 1))
}

/**
 * Остаток счёта в базовой валюте (RUB).
 * account.rate = сколько базовой валюты стоит 1 единица валюты счёта.
 * Для рублёвого счёта rate отсутствует → 1:1. (БАГ № 2)
 */
export function accountToBase(account: Account, baseCurrency = 'RUB'): number {
  if (account.currency === baseCurrency) return round2(account.balance)
  return round2(account.balance * (account.rate ?? 1))
}

/** Сумма остатков всех счетов в базовой валюте */
export function sumAccountsBase(accounts: Account[], baseCurrency = 'RUB'): number {
  return round2(accounts.reduce((s, a) => s + accountToBase(a, baseCurrency), 0))
}

/** Format amount with currency symbol */
export function formatWithCurrency(amount: number, currency: string): string {
  const sym = currencySymbol(currency)
  const formatted = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(Math.abs(amount))
  // Put symbol before for $, €, £; after for ₽, ₸, etc.
  const before = ['$', '€', '£', '₣', '₿', '₮']
  return before.includes(sym) ? `${sym}${formatted}` : `${formatted} ${sym}`
}

/** Check if account uses non-base currency */
export function isForeign(account: Account | undefined, baseCurrency = 'RUB'): boolean {
  return !!account && account.currency !== baseCurrency
}

/** Fetch current exchange rate from CBR-compatible free API */
export async function fetchRate(from: string, to = 'RUB'): Promise<number | null> {
  if (from === to) return 1
  try {
    const res = await fetch(`https://api.exchangerate-api.com/v4/latest/${from}`)
    if (!res.ok) return null
    const data = await res.json()
    return data.rates?.[to] ?? null
  } catch {
    return null
  }
}
