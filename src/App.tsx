import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/layout/Layout'
import ProtectedRoute from './components/layout/ProtectedRoute'
import Login from './pages/Login'
import Register from './pages/Register'
import Dashboard from './pages/Dashboard'
import Transactions from './pages/Transactions'
import CashFlow from './pages/CashFlow'
import PnL from './pages/PnL'
import Calendar from './pages/Calendar'
import Accounts from './pages/Accounts'
import Counterparties from './pages/Counterparties'
import Projects from './pages/Projects'
import ProjectDetail from './pages/ProjectDetail'
import Settings from './pages/Settings'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public routes */}
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />

        {/* Protected routes */}
        <Route path="/" element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }>
          <Route index element={<Dashboard />} />
          <Route path="transactions" element={<Transactions />} />
          <Route path="reports/cashflow" element={<CashFlow />} />
          <Route path="reports/pnl" element={<PnL />} />
          <Route path="calendar" element={<Calendar />} />
          <Route path="accounts" element={<Accounts />} />
          <Route path="counterparties" element={<Counterparties />} />
          <Route path="projects" element={<Projects />} />
          <Route path="projects/:id" element={<ProjectDetail />} />
          <Route path="settings" element={<Settings />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
