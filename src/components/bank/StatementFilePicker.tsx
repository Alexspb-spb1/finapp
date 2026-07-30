import type { ChangeEvent, RefObject } from 'react'
import { FileText, Loader2, Upload, X } from 'lucide-react'
import type { ParseResult } from '../../utils/bankStatementParser'

interface Props {
  file: File | null
  result: ParseResult | null
  loading: boolean
  error: string
  inputRef: RefObject<HTMLInputElement | null>
  onChange: (event: ChangeEvent<HTMLInputElement>) => void
  onClear: () => void
}

export default function StatementFilePicker({
  file,
  result,
  loading,
  error,
  inputRef,
  onChange,
  onClear,
}: Props) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-500 mb-1.5">
        Выписка из банка <span className="text-slate-400 font-normal">(TXT или CSV)</span>
      </label>
      {!file ? (
        <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-slate-200 rounded-xl px-4 py-5 cursor-pointer hover:border-indigo-300 hover:bg-indigo-50/30 transition-all group">
          <Upload size={20} className="text-slate-300 group-hover:text-indigo-400 transition-colors" />
          <span className="text-sm text-slate-400 group-hover:text-indigo-500">Выбрать файл выписки</span>
          <span className="text-xs text-slate-300">Сбербанк, Тинькофф, Альфа, ВТБ и др.</span>
          <input ref={inputRef} type="file" accept=".txt,.csv" onChange={onChange} className="hidden" />
        </label>
      ) : (
        <div className={`flex items-start gap-3 p-3 rounded-xl border transition-colors ${
          error ? 'border-red-200 bg-red-50' :
          result?.ok ? 'border-emerald-200 bg-emerald-50' :
          'border-slate-200 bg-slate-50'
        }`}>
          {loading ? (
            <Loader2 size={18} className="text-indigo-500 animate-spin mt-0.5 shrink-0" />
          ) : error ? (
            <span className="text-lg shrink-0">❌</span>
          ) : (
            <FileText size={18} className="text-emerald-600 mt-0.5 shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-700 truncate">{file.name}</p>
            {loading && <p className="text-xs text-slate-400 mt-0.5">Читаю выписку…</p>}
            {!loading && result?.ok && (
              <p className="text-xs text-emerald-700 mt-0.5">
                {result.bankName} · {result.transactions.length} операций
                {result.period && ` · ${result.period}`}
              </p>
            )}
            {!loading && error && <p className="text-xs text-red-600 mt-0.5">{error}</p>}
          </div>
          <button type="button" onClick={onClear}
            className="text-slate-400 hover:text-slate-600 shrink-0">
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  )
}
