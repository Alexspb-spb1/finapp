import { useEffect, useState } from 'react'
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
  '/reconciliation': 'Сверка остатков',
  '/users': 'Пользователи',
  '/settings': 'Настройки',
}

export default function Layout() {
  const { pathname } = useLocation()
  const { company } = useAuth()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const isProjectDetail = /^\/projects\/.+/.test(pathname)
  const title = isProjectDetail ? 'Проект' : (titles[pathname] ?? 'ФинУчёт')

  // close sidebar on route change (mobile)
  useEffect(() => { setSidebarOpen(false) }, [pathname])

  useEffect(() => {
    if (company?.id) { companyStore.init(company.id) }
  }, [company?.id])

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-slate-50">
      {/* Хедер — на всю ширину страницы */}
      <Header title={title} onMenuClick={() => setSidebarOpen(v => !v)} />

      {/* Сайдбар + контент */}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <main className="flex-1 overflow-y-auto p-3 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
