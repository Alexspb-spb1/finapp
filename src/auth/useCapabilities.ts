// SEC-010 — capability access for components, bound to the ACTIVE company.
import { useAuth } from '../hooks/useAuth'
import { can, capabilitiesOf, type Capability } from './capabilities'

export interface Capabilities {
  /** Role of the active company, or null when there is no usable membership. */
  role: ReturnType<typeof useAuth>['role']
  can: (capability: Capability) => boolean
  all: readonly Capability[]
}

/**
 * The role comes from the canonical membership of the active company (see
 * authStore.getEffectiveRole), so switching companies switches capabilities.
 * A data error or a missing/disabled membership yields no capabilities at all.
 */
export function useCapabilities(): Capabilities {
  const { role } = useAuth()
  return {
    role,
    can: (capability: Capability) => can(role, capability),
    all: capabilitiesOf(role),
  }
}
