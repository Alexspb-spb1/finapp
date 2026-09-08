// Static, reviewable composition points only. No module path, generic page
// evaluation hook, credential loader or network client is accepted here.
import { createLiveBrowserRequestBinder } from './liveAcceptanceBrowserCore.mjs'
import { createLiveStagingExecutor, createVisibleOwnerHandoff } from './liveAcceptanceExecutorCore.mjs'

export const LIVE_ADAPTER_ALLOWLIST = Object.freeze({
  fixtureSlots: Object.freeze([
    'createOwnerAAuth', 'createCompanyA', 'createOwnerBAuth', 'createCompanyB',
    'createMailboxCancelledInvite', 'cancelMailboxInvite', 'createMailboxFinalInvite',
    'denyMailboxResendCooldown', 'resendMailboxFinalInvite', 'createOwnerMailboxAuth',
    'denyWrongIdentityAccept', 'denyUnverifiedMailboxAccept', 'acceptMailboxFinalInvite',
    'replayMailboxFinalInvite', 'createOwnerBInvite', 'acceptOwnerBInvite',
  ]),
  readOnlyCallables: Object.freeze(['listInvitations', 'previewInvite', 'getCompanyAccess']),
  ownerActions: Object.freeze(['OWNER_ENTER_CREDENTIAL', 'OWNER_COMPLETE_PROVIDER_VERIFICATION']),
})

export const LIVE_EXECUTOR_MISSING_ADAPTERS = Object.freeze([
  'guarded-firebase-cli-session-and-fresh-preflight-composition',
  'sanitized-auth-template-and-signup-metadata-reader',
  'exact-admin-auth-and-callable-dispatch-readback-driver',
  'visible-playwright-selector-driver-with-in-page-credential-submit',
  'complete-six-scenario-schedule-and-safe-stop-teardown',
])

export function createStaticLiveAdapterBindings({ executorOptions, browserBinderOptions, openOwnerSession, pauseOwner }) {
  if (!executorOptions || !browserBinderOptions || typeof openOwnerSession !== 'function' || typeof pauseOwner !== 'function') {
    throw new Error('live_executor_adapters_blocked')
  }
  return Object.freeze({
    executor: createLiveStagingExecutor(executorOptions),
    browserBinder: createLiveBrowserRequestBinder(browserBinderOptions),
    ownerHandoff: createVisibleOwnerHandoff({ openSession: openOwnerSession, pause: pauseOwner }),
  })
}
