import { useState, useRef } from 'react'
import { X } from 'lucide-react'

interface Props {
  value: string[]
  onChange: (tags: string[]) => void
  suggestions?: string[]
  placeholder?: string
}

export default function TagInput({ value, onChange, suggestions = [], placeholder = 'Добавить тег…' }: Props) {
  const [input, setInput] = useState('')
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = input.trim()
    ? suggestions.filter(s => s.toLowerCase().includes(input.toLowerCase()) && !value.includes(s))
    : []

  function addTag(tag: string) {
    const t = tag.trim().toLowerCase()
    if (!t || value.includes(t)) { setInput(''); return }
    onChange([...value, t])
    setInput('')
  }

  function removeTag(tag: string) {
    onChange(value.filter(t => t !== tag))
  }

  function handleKey(e: React.KeyboardEvent) {
    if ((e.key === 'Enter' || e.key === ',') && input.trim()) {
      e.preventDefault()
      addTag(input)
    }
    if (e.key === 'Backspace' && !input && value.length > 0) {
      removeTag(value[value.length - 1])
    }
  }

  return (
    <div
      onClick={() => inputRef.current?.focus()}
      className={`min-h-[38px] flex flex-wrap gap-1.5 items-center border rounded-lg px-2.5 py-1.5 cursor-text transition-all
        ${focused ? 'border-indigo-400 ring-2 ring-indigo-100' : 'border-slate-200 hover:border-slate-300'}`}
    >
      {value.map(tag => (
        <span key={tag}
          className="flex items-center gap-1 px-2 py-0.5 bg-indigo-100 text-indigo-700 text-xs font-medium rounded-full">
          #{tag}
          <button type="button" onClick={e => { e.stopPropagation(); removeTag(tag) }}
            className="text-indigo-400 hover:text-indigo-700 transition-colors">
            <X size={11} />
          </button>
        </span>
      ))}

      <div className="relative flex-1 min-w-[80px]">
        <input
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          onFocus={() => setFocused(true)}
          onBlur={() => { setFocused(false); if (input.trim()) addTag(input) }}
          placeholder={value.length === 0 ? placeholder : ''}
          className="w-full text-sm outline-none bg-transparent text-slate-700 placeholder:text-slate-300"
        />
        {focused && filtered.length > 0 && (
          <div className="absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-50 py-1 min-w-[140px]">
            {filtered.slice(0, 8).map(s => (
              <button key={s} type="button"
                onMouseDown={e => { e.preventDefault(); addTag(s) }}
                className="w-full text-left px-3 py-1.5 text-sm text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors">
                #{s}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
