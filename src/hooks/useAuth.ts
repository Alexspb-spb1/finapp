import { useState, useEffect } from 'react'
import { authStore, subscribeAuth, subscribeCompanySelection } from '../store/authStore'

export function useAuth() {
  const [user,      setUser]      = useState(() => authStore.getCurrentUser())
  const [company,   setCompany]   = useState(() => authStore.getCurrentCompany())
  const [activeCompanyId, setActiveCompanyId] = useState(() => authStore.getActiveCompanyId())
  const [loading,   setLoading]   = useState(true)
  const [status,    setStatus]    = useState(() => authStore.getAuthDataStatus())
  const [dataError, setDataError] = useState(() => authStore.getDataError())

  useEffect(() => {
    const unsubSelection = subscribeCompanySelection(() => {
      setActiveCompanyId(authStore.getActiveCompanyId())
    })
    const unsub = subscribeAuth(() => {
      setUser(authStore.getCurrentUser())
      setCompany(authStore.getCurrentCompany())
      setActiveCompanyId(authStore.getActiveCompanyId())
      setStatus(authStore.getAuthDataStatus())
      setDataError(authStore.getDataError())
      setLoading(false)
    })
    const timer = setTimeout(() => setLoading(false), 3000)
    return () => { unsub(); unsubSelection(); clearTimeout(timer) }
  }, [])

  const role = authStore.getEffectiveRole()
  // При data_error (повреждённый/невалидный документ users или companies)
  // — fail-closed: не авторизован, только чтение, без прав записи/admin,
  // независимо от того, что вернул getEffectiveRole() для очищенного
  // in-memory состояния.
  const hasDataError = status === 'data_error'

  return {
    user,
    company,
    isAuthenticated: !!user && !hasDataError,
    loading,
    // Наблюдаемый статус загрузки авторизационных данных — см.
    // authStore.getAuthDataStatus()/getDataError().
    status,
    dataError,
    activeCompanyId,
    allCompanies: authStore.getAllCompanies(),
    // Права доступа для активной компании.
    //
    // SEC-007 R1 fail-closed fix: `role` is null whenever there is no usable
    // canonical membership — missing, disabled, still invited, corrupted, or
    // belonging to another company. Previously `readOnly` was computed as
    // `role === 'viewer'` and `canWrite` as `role !== 'viewer'`, so null —
    // the "no access at all" case — produced readOnly:false and canWrite:true
    // and the UI offered write controls to someone with no membership.
    // Absence of a role must be the most restrictive state, not the least.
    role,
    readOnly: hasDataError || role === null ? true : role === 'viewer',
    canWrite: hasDataError ? false : role === 'accountant' || role === 'admin',
    isAdmin: hasDataError ? false : role === 'admin',
  }
}
