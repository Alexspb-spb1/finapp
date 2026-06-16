import * as XLSX from 'xlsx'

export function downloadSheet(
  rows: Record<string, string | number | null>[],
  sheetName: string,
  filename: string,
) {
  const ws = XLSX.utils.json_to_sheet(rows)

  // Auto column widths based on header + content
  const cols = Object.keys(rows[0] ?? {})
  ws['!cols'] = cols.map(key => {
    const max = Math.max(
      key.length,
      ...rows.map(r => String(r[key] ?? '').length),
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
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{}])
    const cols = Object.keys(rows[0] ?? {})
    ws['!cols'] = cols.map(key => {
      const max = Math.max(key.length, ...rows.map(r => String(r[key] ?? '').length))
      return { wch: Math.min(max + 2, 60) }
    })
    XLSX.utils.book_append_sheet(wb, ws, name)
  }
  XLSX.writeFile(wb, filename)
}
