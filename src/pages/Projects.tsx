import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, X, Trash2, Pencil, FolderOpen, TrendingUp, TrendingDown, AlertTriangle } from 'lucide-react'
import { useStore } from '../store/useStore'
import { formatCurrency } from '../utils/format'
import type { Project } from '../types'

const COLORS = ['#6366f1','#22c55e','#f59e0b','#ef4444','#3b82f6','#8b5cf6','#ec4899','#14b8a6','#f97316','#06b6d4']

const emptyForm = (): Omit<Project, 'id'> => ({
  name: '', description: '', color: COLORS[0], status: 'active', startDate: '', endDate: '',
})

export default function Projects() {
  const store = useStore()
  const navigate = useNavigate()
  const { projects, transactions } = store

  const [addOpen,  setAddOpen]  = useState(false)
  const [editId,   setEditId]   = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [form,     setForm]     = useState(emptyForm)

  function openAdd() { setForm(emptyForm()); setEditId(null); setAddOpen(true) }

  function openEdit(p: Project, e: React.MouseEvent) {
    e.stopPropagation()
    setForm({ name: p.name, description: p.description ?? '', color: p.color,
              status: p.status, startDate: p.startDate ?? '', endDate: p.endDate ?? '' })
    setEditId(p.id)
    setAddOpen(true)
  }

  function handleSubmit() {
    if (!form.name.trim()) return
    const data = { ...form, description: form.description || undefined,
                   startDate: form.startDate || undefined, endDate: form.endDate || undefined }
    setAddOpen(false); setEditId(null)
    if (editId) {
      store.updateProject(editId, data)
    } else {
      store.addProject({ id: 'prj_' + Date.now(), ...data })
    }
  }

  function confirmDelete() {
    if (deleteId) { store.deleteProject(deleteId); setDeleteId(null) }
  }

  // Stats per project
  function projectStats(id: string) {
    const tx = transactions.filter(t => t.projectId === id && t.type !== 'transfer')
    const income  = tx.filter(t => t.type === 'income').reduce((s, t)  => s + t.amount, 0)
    const expense = tx.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0)
    return { income, expense, count: tx.length }
  }

  // Find duplicate project groups by name
  const dupeGroups: Project[][] = (() => {
    const map = new Map<string, Project[]>()
    for (const p of projects) {
      const key = p.name.trim().toLowerCase()
      const arr = map.get(key) ?? []
      arr.push(p)
      map.set(key, arr)
    }
    return [...map.values()].filter(g => g.length >= 2)
  })()

  function removeDupeProjects() {
    const toDelete: string[] = []
    for (const group of dupeGroups) {
      // Keep the one with most transactions, delete the rest
      const scored = group.map(p => ({ p, count: transactions.filter(t => t.projectId === p.id).length }))
      scored.sort((a, b) => b.count - a.count)
      toDelete.push(...scored.slice(1).map(s => s.p.id))
    }
    for (const id of toDelete) store.deleteProject(id)
  }

  return (
    <div className="space-y-4">

      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">
            {projects.length > 0 ? `${projects.length} ${projects.length === 1 ? 'проект' : projects.length < 5 ? 'проекта' : 'проектов'}` : ''}
          </h2>
        </div>
        <button onClick={openAdd}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-4 py-2.5 rounded-xl transition-colors">
          <Plus size={16} /> Добавить проект
        </button>
      </div>

      {/* Duplicate projects warning */}
      {dupeGroups.length > 0 && (
        <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <AlertTriangle size={16} className="text-amber-500 shrink-0" />
          <p className="text-sm text-amber-800 flex-1">
            <span className="font-semibold">Найдены дубли проектов:</span>{' '}
            {dupeGroups.map(g => `«${g[0].name}»`).join(', ')} — одинаковые названия
          </p>
          <button onClick={removeDupeProjects}
            className="shrink-0 text-sm font-medium text-white bg-amber-500 hover:bg-amber-600 px-3 py-1.5 rounded-lg transition">
            Удалить дубли
          </button>
        </div>
      )}

      {/* Empty state */}
      {projects.length === 0 && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-16 text-center">
          <div className="text-5xl mb-4">📁</div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">Нет проектов</h3>
          <p className="text-sm text-slate-400 mb-6 max-w-xs mx-auto">
            Создайте проект, чтобы отслеживать движение денег отдельно по каждому направлению
          </p>
          <button onClick={openAdd}
            className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-5 py-2.5 rounded-xl transition-colors">
            <Plus size={16} /> Создать первый проект
          </button>
        </div>
      )}

      {/* Project cards */}
      {projects.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map(p => {
            const { income, expense, count } = projectStats(p.id)
            const net = income - expense
            return (
              <div key={p.id}
                onClick={() => navigate(`/projects/${p.id}`)}
                className="bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition-all cursor-pointer group relative overflow-hidden">

                {/* Color accent bar */}
                <div className="h-1.5 w-full" style={{ background: p.color }} />

                <div className="p-5">
                  {/* Actions */}
                  <div className="absolute top-4 right-3 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={e => openEdit(p, e)}
                      className="p-1.5 rounded-lg text-slate-300 hover:text-indigo-500 hover:bg-indigo-50 transition-all">
                      <Pencil size={13} />
                    </button>
                    <button onClick={e => { e.stopPropagation(); setDeleteId(p.id) }}
                      className="p-1.5 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 transition-all">
                      <Trash2 size={13} />
                    </button>
                  </div>

                  {/* Icon + status */}
                  <div className="flex items-start gap-3 mb-3">
                    <div className="w-10 h-10 icon-circle flex items-center justify-center shrink-0" style={{ background: p.color + '20' }}>
                      <FolderOpen size={18} strokeWidth={1.5} style={{ color: p.color }} />
                    </div>
                    <div className="flex-1 min-w-0 mt-0.5">
                      <p className="text-sm font-semibold text-slate-800 truncate">{p.name}</p>
                      {p.description && <p className="text-xs text-slate-400 mt-0.5 truncate">{p.description}</p>}
                    </div>
                  </div>

                  {/* Dates */}
                  {(p.startDate || p.endDate) && (
                    <p className="text-xs text-slate-400 mb-3">
                      {p.startDate ? p.startDate.split('-').reverse().join('.') : '…'}
                      {' — '}
                      {p.endDate ? p.endDate.split('-').reverse().join('.') : 'сейчас'}
                    </p>
                  )}

                  {/* Stats */}
                  <div className="border-t border-slate-100 pt-3 grid grid-cols-3 gap-2 text-center">
                    <div>
                      <div className="flex items-center justify-center gap-1 text-emerald-500 mb-0.5">
                        <TrendingUp size={12} />
                        <span className="text-xs font-semibold">{income > 0 ? formatCurrency(income) : '—'}</span>
                      </div>
                      <p className="text-[10px] text-slate-400">Доходы</p>
                    </div>
                    <div>
                      <div className="flex items-center justify-center gap-1 text-red-400 mb-0.5">
                        <TrendingDown size={12} />
                        <span className="text-xs font-semibold">{expense > 0 ? formatCurrency(expense) : '—'}</span>
                      </div>
                      <p className="text-[10px] text-slate-400">Расходы</p>
                    </div>
                    <div>
                      <p className={`text-xs font-semibold mb-0.5 ${net >= 0 ? 'text-indigo-600' : 'text-red-500'}`}>
                        {count > 0 ? (net >= 0 ? '+' : '') + formatCurrency(net) : '—'}
                      </p>
                      <p className="text-[10px] text-slate-400">{count} опер.</p>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── Add / Edit modal ── */}
      {addOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h2 className="font-semibold text-slate-800">{editId ? 'Редактировать проект' : 'Новый проект'}</h2>
              <button onClick={() => { setAddOpen(false); setEditId(null) }}
                className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><X size={18} /></button>
            </div>

            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Название</label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required
                  placeholder="Разработка сайта"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300" />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Описание <span className="font-normal text-slate-400">(необязательно)</span></label>
                <input value={form.description ?? ''} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Краткое описание проекта"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1.5">Дата начала</label>
                  <input type="date" value={form.startDate ?? ''} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1.5">Дата окончания</label>
                  <input type="date" value={form.endDate ?? ''} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300" />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Статус</label>
                <div className="grid grid-cols-2 gap-2">
                  {(['active','archived'] as const).map(s => (
                    <button key={s} type="button" onClick={() => setForm(f => ({ ...f, status: s }))}
                      className={`py-2 rounded-lg text-sm font-medium border transition-all ${
                        form.status === s ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                      }`}>
                      {s === 'active' ? 'Активный' : 'Архивный'}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1.5">Цвет</label>
                <div className="flex gap-2 flex-wrap">
                  {COLORS.map(c => (
                    <button key={c} type="button" onClick={() => setForm(f => ({ ...f, color: c }))}
                      className={`w-7 h-7 rounded-full transition-all ${form.color === c ? 'ring-2 ring-offset-2 ring-slate-400 scale-110' : ''}`}
                      style={{ background: c }} />
                  ))}
                </div>
              </div>

              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => { setAddOpen(false); setEditId(null) }}
                  className="flex-1 py-2.5 border border-slate-200 text-sm text-slate-600 font-medium rounded-lg hover:bg-slate-50 transition">
                  Отмена
                </button>
                <button type="button" onClick={handleSubmit} disabled={!form.name.trim()}
                  className={`flex-1 py-2.5 text-white text-sm font-medium rounded-lg transition ${
                    form.name.trim() ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-indigo-300 cursor-not-allowed'
                  }`}>
                  {editId ? 'Сохранить' : 'Создать'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete confirm ── */}
      {deleteId && (() => {
        const p = projects.find(x => x.id === deleteId)
        return (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 text-center">
              <div className="text-3xl mb-3">🗑️</div>
              <h3 className="text-base font-semibold text-slate-800 mb-1">Удалить проект?</h3>
              <p className="text-sm text-slate-500 mb-5">«{p?.name}» будет удалён. Операции останутся, но потеряют привязку к проекту.</p>
              <div className="flex gap-3">
                <button onClick={() => setDeleteId(null)}
                  className="flex-1 py-2.5 border border-slate-200 text-sm text-slate-600 font-medium rounded-lg hover:bg-slate-50 transition">
                  Отмена
                </button>
                <button onClick={confirmDelete}
                  className="flex-1 py-2.5 bg-red-500 hover:bg-red-600 text-white text-sm font-medium rounded-lg transition">
                  Удалить
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
