import { useState, useEffect } from 'react'
import { authStore, subscribeAuth } from '../store/authStore'

export function useAuth() {
  const [user,    setUser]    = useState(() => authStore.getCurrentUser())
  const [company, setCompany] = useState(() => authStore.getCurrentCompany())
  // loading = true until Firebase returns the first auth state
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsub = subscribeAuth(() => {
      setUser(authStore.getCurrentUser())
      setCompany(authStore.getCurrentCompany())
      setLoading(false)
    })
    // If already resolved (e.g. quick re-mount), stop loading
    const timer = setTimeout(() => setLoading(false), 3000)
    return () => { unsub(); clearTimeout(timer) }
  }, [])

  return { user, company, isAuthenticated: !!user, loading }
}
