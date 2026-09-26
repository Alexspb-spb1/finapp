// Only stable allowlisted codes cross the bank boundary. Never include provider
// messages, URLs, response bodies, credentials, or request data in errors.
export const BANK_ERROR_CODES = [
  'bank_module_disabled', 'invalid_bank_data', 'bank_not_supported',
  'bank_access_denied', 'bank_unavailable', 'bank_pagination_invalid',
  'bank_preview_limit', 'bank_run_cancelled', 'publication_unavailable',
] as const
export type BankErrorCode = typeof BANK_ERROR_CODES[number]

export class BankError extends Error {
  constructor(readonly code: BankErrorCode) {
    super(code)
    this.name = 'BankError'
  }
}

export function safeBankError(error: unknown): BankError {
  // Reconstruct rather than forwarding an object that might have added fields.
  return new BankError(error instanceof BankError && BANK_ERROR_CODES.includes(error.code)
    ? error.code : 'bank_unavailable')
}
