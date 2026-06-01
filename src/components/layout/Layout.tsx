import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import Header from './Header'
import { useAuth } from '../../hooks/useAuth'
import { companyStore } from '../../store/companyStore'

const titles: Record<string, string> = {
  '/': 'Дашборд',
  '/transactions': 'Операции',
  '/reports/cashflow': 'Движение денежных средств',
  '/reports/pnl': 'Прибыль и убытки',
  '/calendar': 'Платёжный календарь',
  '/accounts': 'Счета',
  '/counterparties': 'Контрагенты',
  '/projects': 'Проекты',
  '/settings': 'Настройки',
}

export default function Layout() {
  const { pathname } = useLocation()
  const { company } = useAuth()

  const isProjectDetail = /^\/projects\/.+/.test(pathname)
  const title = isProjectDetail ? 'Проект' : (titles[pathname] ?? 'ФинУчёт')

  useEffect(() => {
    if (company?.id) companyStore.init(company.id)
  }, [company?.id])

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Header title={title} />
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
