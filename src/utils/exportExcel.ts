import * as XLSX from 'xlsx'

// Формула/CSV Injection: значение, начинающееся с =, +, -, @, TAB или CR,
// Excel/Sheets может интерпретировать как формулу при открытии файла.
// Данные в отчётах могут происходить из назначения платежа во входящей
// банковской выписке — то есть их контролирует отправитель платежа, а не
// пользователь приложения. Экранируем такие значения апострофом.
const FORMULA_PREFIX = /^[=+\-@\t\r]/

function sanitizeCell(value: string | number | null): string | number | null {
  if (typeof value === 'string' && FORMULA_PREFIX.test(value)) {
    return `'${value}`
  }
  return value
}

function sanitizeRows(
  rows: Record<string, string | number | null>[],
): Record<string, string | number | null>[] {
  return rows.map(row => {
    const out: Record<string, string | number | null> = {}
    for (const key of Object.keys(row)) out[key] = sanitizeCell(row[key])
    return out
  })
}

export function downloadSheet(
  rows: Record<string, string | number | null>[],
  sheetName: string,
  filename: string,
) {
  const safeRows = sanitizeRows(rows)
  const ws = XLSX.utils.json_to_sheet(safeRows)

  // Auto column widths based on header + content
  const cols = Object.keys(safeRows[0] ?? {})
  ws['!cols'] = cols.map(key => {
    const max = Math.max(
      key.length,
      ...safeRows.map(r => String(r[key] ?? '').length),
    )
    return { wch: Math.min(max + 2, 60) }
  })

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  XLSX.writeFile(wb, filename)
}

export function downloadMultiSheet(
  sheets: { name: string; rows: Record<string, string | number | null>[] }[],
  filename: string,
) {
  const wb = XLSX.utils.book_new()
  for (const { name, rows } of sheets) {
    const safeRows = sanitizeRows(rows)
    const ws = XLSX.utils.json_to_sheet(safeRows.length ? safeRows : [{}])
    const cols = Object.keys(safeRows[0] ?? {})
    ws['!cols'] = cols.map(key => {
      const max = Math.max(key.length, ...safeRows.map(r => String(r[key] ?? '').length))
      return { wch: Math.min(max + 2, 60) }
    })
    XLSX.utils.book_append_sheet(wb, ws, name)
  }
  XLSX.writeFile(wb, filename)
}
