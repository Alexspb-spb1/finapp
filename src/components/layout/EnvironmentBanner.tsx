import { AlertTriangle } from 'lucide-react'

// BASE-002: показывается только при VITE_APP_ENV=staging — ни в production,
// ни в обычной локальной разработке с эмуляторами (там VITE_APP_ENV=development).
// Занимает свою полосу в обычном потоке документа (не position: fixed/absolute),
// поэтому не перекрывает Header/Sidebar. Текст обязателен и не заменяется
// только цветом/иконкой — это единственный источник смысла для скринридеров.
export default function EnvironmentBanner() {
  return (
    <div
      role="status"
      className="w-full bg-amber-400 text-amber-950 text-sm font-semibold px-3 sm:px-6 py-1.5 flex items-center gap-2 shrink-0"
    >
      <AlertTriangle size={14} className="shrink-0" aria-hidden="true" />
      <span>STAGING — ТЕСТОВАЯ СРЕДА</span>
    </div>
  )
}
