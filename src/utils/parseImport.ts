import * as XLSX from 'xlsx'

export interface RawRow {
  [key: string]: string | number | null
}

export interface ParsedFile {
  headers: string[]
  rows: RawRow[]
  /** First few rows for preview (max 5) */
  preview: RawRow[]
}

export interface ImportRow {
  date: string           // YYYY-MM-DD
  amount: number         // always positive
  type: 'income' | 'expense'
  comment: string
  rawDate: string        // original string for display
  rawAmount: string
}

/** Parse Excel or CSV file into headers + rows */
export async function parseFile(file: File): Promise<ParsedFile> {
  const buf = await file.arrayBuffer()
  const wb  = XLSX.read(buf, { type: 'array', cellDates: true })
  const ws  = wb.Sheets[wb.SheetNames[0]]
  const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null })

  if (raw.length < 2) return { headers: [], rows: [], preview: [] }

  const headers = (raw[0] as unknown[]).map(h => String(h ?? ''))
  const rows: RawRow[] = (raw.slice(1) as unknown[][]).map(row =>
    Object.fromEntries(headers.map((h, i) => [h, (row[i] ?? null) as string | number | null]))
  )

  return { headers, rows, preview: rows.slice(0, 5) }
}

/** Try to parse a cell value as a date → YYYY-MM-DD or null */
export function parseDate(val: string | number | null): string | null {
  if (val === null || val === '') return null

  // Excel serial number
  if (typeof val === 'number') {
    const d = XLSX.SSF.parse_date_code(val)
    if (d) {
      const mm = String(d.m).padStart(2, '0')
      const dd = String(d.d).padStart(2, '0')
      return `${d.y}-${mm}-${dd}`
    }
  }

  const s = String(val).trim()

  // ISO: 2024-01-15
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)

  // DD.MM.YYYY or DD/MM/YYYY
  const dmy = s.match(/^(\d{2})[./](\d{2})[./](\d{4})/)
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`

  // MM/DD/YYYY
  const mdy = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/)
  if (mdy) {
    const month = parseInt(mdy[1])
    const day   = parseInt(mdy[2])
    if (month <= 12 && day <= 31) return `${mdy[3]}-${mdy[1]}-${mdy[2]}`
  }

  // Fallback: let Date parse it
  const d = new Date(s)
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)

  return null
}

/** Parse a cell value as a number */
export function parseAmount(val: string | number | null): number | null {
  if (val === null || val === '') return null
  if (typeof val === 'number') return val

  const s = String(val).replace(/\s/g, '').replace(',', '.')
  const n = parseFloat(s)
  return isNaN(n) ? null : n
}

/** Convert raw rows using column mapping */
export function applyMapping(
  rows: RawRow[],
  mapping: {
    dateCol: string
    amountCol: string
    commentCol: string
    typeMode: 'sign' | 'column'
    typeCol?: string
    incomeValue?: string   // value in typeCol that means income
  },
): ImportRow[] {
  return rows
    .map(row => {
      const rawDate   = String(row[mapping.dateCol] ?? '')
      const rawAmount = String(row[mapping.amountCol] ?? '')
      const date      = parseDate(row[mapping.dateCol])
      const amount    = parseAmount(row[mapping.amountCol])
      const comment   = String(row[mapping.commentCol] ?? '').trim()

      if (!date || amount === null) return null

      let type: 'income' | 'expense'
      if (mapping.typeMode === 'sign') {
        type = amount >= 0 ? 'income' : 'expense'
      } else if (mapping.typeCol && mapping.incomeValue) {
        const cell = String(row[mapping.typeCol] ?? '').toLowerCase()
        type = cell.includes(mapping.incomeValue.toLowerCase()) ? 'income' : 'expense'
      } else {
        type = amount >= 0 ? 'income' : 'expense'
      }

      return { date, amount: Math.abs(amount), type, comment, rawDate, rawAmount }
    })
    .filter((r): r is ImportRow => r !== null)
}
