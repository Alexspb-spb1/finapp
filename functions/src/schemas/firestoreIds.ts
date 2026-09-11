// Canonical Firestore document-ID validation — SEC-007.
//
// Any value that is interpolated into a Firestore path segment must pass
// this schema, never a bare non-empty string. Firestore rejects `.`, `..`,
// ids containing `/`, and the reserved `__…__` form; letting such a value
// through would turn a client-controlled field into a path-traversal or a
// runtime failure surfaced as `internal_error`.
//
// This lives in its own module because both `schemas/invitation.ts` and
// `schemas/auth.ts` need it while `invitation.ts` already imports from
// `auth.ts` — defining it in either one would create an import cycle.
// `invitation.ts` re-exports it so the existing import sites keep working.
import { z } from 'zod'

const RESERVED_FIRESTORE_DOCUMENT_ID_PATTERN = /^__.*__$/

export const FirestoreDocumentIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^/]+$/)
  .refine(
    value => value !== '.' && value !== '..' && !RESERVED_FIRESTORE_DOCUMENT_ID_PATTERN.test(value),
    { message: 'not a valid Firestore document ID' },
  )
