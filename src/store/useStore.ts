import { useState, useEffect } from 'react'
import { companyStore } from './companyStore'

export { companyStore as store }

export function useStore() {
  const [, forceUpdate] = useState(0)

  useEffect(() => {
    return companyStore.subscribe(() => forceUpdate(n => n + 1))
  }, [])

  return companyStore
}
