import { useState, useEffect } from 'react'
import { authStore, subscribeAuth } from '../store/authStore'

export function useAuth() {
  const [user,      setUser]      = useState(() => authStore.getCurrentUser())
  const [company,   setCompany]   = useState(() => authStore.getCurrentCompany())
  const [loading,   setLoading]   = useState(true)
  const [status,    setStatus]    = useState(() => authStore.getAuthDataStatus())
  const [dataError, setDataError] = useState(() => authStore.getDataError())

  useEffect(() => {
    const unsub = subscribeAuth(() => {
      setUser(authStore.getCurrentUser())
      setCompany(authStore.getCurrentCompany())
      setStatus(authStore.getAuthDataStatus())
      setDataError(authStore.getDataError())
      setLoading(false)
    })
    const timer = setTimeout(() => setLoading(false), 3000)
    return () => { unsub(); clearTimeout(timer) }
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
    activeCompanyId: authStore.getActiveCompanyId(),
    allCompanies: authStore.getAllCompanies(),
    // Права доступа для активной компании
    role,
    readOnly: hasDataError ? true : role === 'viewer',
    canWrite: hasDataError ? false : role !== 'viewer',
    isAdmin: hasDataError ? false : role === 'admin',
  }
}
