// Fixed for this document's lifetime, including after successful navigation.
export const isInvitationEntry = typeof window !== 'undefined' &&
  window.location.pathname.startsWith(`${import.meta.env.BASE_URL}accept-invite/`)
