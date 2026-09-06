import { describe, expect, it } from 'vitest'
import * as functions from '../../src/index'

// Inspect the real Firebase SDK's deployment descriptors, not an options mock.
// This catches missing/late global registration and any per-export override.
const deploymentCallables = [
  'createCompany', 'inviteMember', 'listInvitations', 'cancelInvite',
  'resendInvite', 'previewInvite', 'acceptInvite', 'getCompanyAccess',
] as const
const endpoints = Object.fromEntries(Object.entries(functions).flatMap(([name, value]) =>
  '__endpoint' in value ? [[name, value.__endpoint]] : [],
))

describe('callable deployment resource envelope', () => {
  it('discovers exactly the eight release callables and the undeployed authorization probe', () => {
    expect(Object.keys(endpoints).sort()).toEqual([...deploymentCallables, 'authzProbe'].sort())
  })

  it.each([...deploymentCallables, 'authzProbe'])('%s emits explicit bounded resources and preserves callable protocol', name => {
    expect(endpoints[name]).toMatchObject({
      platform: 'gcfv2',
      region: ['us-central1'],
      availableMemoryMb: 256,
      cpu: 1,
      concurrency: 1,
      minInstances: 0,
      maxInstances: 1,
      // Preserve Firebase's previous default rather than truncate transactions at 30s.
      timeoutSeconds: 60,
      callableTrigger: {},
    })
    expect(endpoints[name]).not.toHaveProperty('httpsTrigger')
    expect(endpoints[name]).not.toHaveProperty('eventTrigger')
  })
})
