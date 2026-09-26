import { BankIdSchema, parseBankData } from '../contracts'
import { BankError } from '../errors'
import type { ApiBankAdapter } from '../ports'

/** Explicit opt-in only. The research bank catalog never registers adapters. */
export function createApiRegistry(adapters: readonly ApiBankAdapter[] = []) {
  const registered = new Map<string, ApiBankAdapter>()
  for (const adapter of adapters) {
    const id = parseBankData(BankIdSchema, adapter.bankId)
    if (registered.has(id) || adapter.capabilities.channel !== 'api'
      || adapter.capabilities.readOnly !== true) throw new BankError('invalid_bank_data')
    registered.set(id, adapter)
  }
  return {
    get(bankId: string): ApiBankAdapter {
      const adapter = registered.get(bankId)
      if (!adapter) throw new BankError('bank_not_supported')
      return adapter
    },
    bankIds(): readonly string[] { return [...registered.keys()] },
  }
}
