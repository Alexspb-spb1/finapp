import { useState, useEffect } from 'react'
import { authStore, subscribeAuth } from '../store/authStore'

export function useAuth() {
  const [user, setUser] = useState(() => authStore.getCurrentUser())
  const [company, setCompany] = useState(() => authStore.getCurrentCompany())

  useEffect(() => {
    const unsub = subscribeAuth(() => {
      setUser(authStore.getCurrentUser())
      setCompany(authStore.getCurrentCompany())
    })
    return () => { unsub() }
  }, [])

  return { user, company, isAuthenticated: !!user }
}
