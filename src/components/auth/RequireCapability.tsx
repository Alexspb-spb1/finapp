// SEC-010 — declarative capability guard for sections and routes.
import type { ReactNode } from 'react'
import { useCapabilities } from '../../auth/useCapabilities'
import type { Capability } from '../../auth/capabilities'

interface RequireCapabilityProps {
  capability: Capability
  children: ReactNode
  /** Shown instead of `children` when the capability is missing. Omit to
   * render nothing — use that for write buttons a viewer should not see at
   * all, and a real message for whole pages. */
  fallback?: ReactNode
}

/**
 * Renders `children` only when the active company's role grants `capability`.
 *
 * This hides UI; it does not protect data. The same action is independently
 * refused by Cloud Functions and Firestore Rules, so a user who reaches it by
 * any other means still cannot perform it.
 */
export function RequireCapability({ capability, children, fallback = null }: RequireCapabilityProps) {
  const { can } = useCapabilities()
  return <>{can(capability) ? children : fallback}</>
}
