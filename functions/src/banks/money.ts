import { CurrencySchema, MoneySchema, parseBankData, type Money } from './contracts'
import { BankError } from './errors'

const EXPONENT = { RUB: 2, USD: 2, EUR: 2, CNY: 2, JPY: 0, KWD: 3 } as const

/** Input must be decimal text from a lossless parser, never a parsed number. */
export function decimalToMoney(decimal: string, currency: string): Money {
  const code = parseBankData(CurrencySchema, currency)
  if (typeof decimal !== 'string' || decimal.length > 40 || !/^-?(0|[1-9]\d*)(\.\d+)?$/.test(decimal)) {
    throw new BankError('invalid_bank_data')
  }
  const negative = decimal.startsWith('-')
  const [whole, fraction = ''] = (negative ? decimal.slice(1) : decimal).split('.')
  const scale = EXPONENT[code]
  if (fraction.length > scale) throw new BankError('invalid_bank_data')
  const magnitude = BigInt(whole) * 10n ** BigInt(scale)
    + BigInt(fraction.padEnd(scale, '0') || '0')
  return parseBankData(MoneySchema, {
    currency: code, minorUnits: (negative ? -magnitude : magnitude).toString(),
  })
}
