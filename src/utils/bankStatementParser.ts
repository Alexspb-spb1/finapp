export interface ParsedTransaction {
  date: string
  amount: number
  type: 'income' | 'expense'
  description: string
  counterpart?: string
  counterpartInn?: string
  counterpartAccount?: string
  counterpartBankName?: string
  counterpartBik?: string
  raw: string
}

export interface ParseResult {
  ok: boolean
  bankName: string
  accountNumber?: string
  period?: string
  transactions: ParsedTransaction[]
  skipped: number
  errors: string[]
}

// ─── Date / amount helpers ───────────────────────────────────────────────────

function parseDate(s: string): string | null {
  if (!s) return null
  s = s.trim()
  const dmy = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/)
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2,'0')}-${dmy[1].padStart(2,'0')}`
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`
  const ymd2 = s.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (ymd2) return `${ymd2[1]}-${ymd2[2]}-${ymd2[3]}`
  return null
}

function parseAmount(s: string): number | null {
  if (!s) return null
  const cleaned = s.trim().replace(/\s/g,'').replace(',','.').replace(/[^\d.+\-]/g,'')
  const n = parseFloat(cleaned)
  return isNaN(n) ? null : n
}

// ─── 1C ClientBankExchange format ────────────────────────────────────────────
// Used by Alfa-Bank, Sberbank, VTB, and many others for 1C integration.
// Encoding: Windows-1251 (declared as Кодировка=Windows in header)
// Structure: key=value lines, documents between СекцияДокумент / КонецДокумента

export function is1CFormat(text: string): boolean {
  return text.trimStart().startsWith('1CClientBankExchange')
}

function parse1C(text: string): ParseResult {
  const lines = text.split('\n').map(l => l.trim())

  // ── Extract header metadata ──────────────────────────────
  let bankName = '1C / Банк'
  let ourAccount: string | undefined
  let period: string | undefined
  let dateStart: string | undefined
  let dateEnd: string | undefined

  for (const line of lines) {
    const [key, val] = splitKV(line)
    if (!val) continue
    if (key === 'Программа') bankName = val
    if (key === 'РасчСчет' && !ourAccount) ourAccount = val
    if (key === 'ДатаНачала') dateStart = val
    if (key === 'ДатаКонца') dateEnd = val
  }
  if (dateStart && dateEnd) period = `${dateStart} — ${dateEnd}`

  // ── Extract account from СекцияРасчСчет ─────────────────
  let inAcctSection = false
  for (const line of lines) {
    if (line === 'СекцияРасчСчет') { inAcctSection = true; continue }
    if (line === 'КонецРасчСчет') { inAcctSection = false; continue }
    if (inAcctSection) {
      const [key, val] = splitKV(line)
      if (key === 'РасчСчет' && val) { ourAccount = val; break }
    }
  }

  // ── Split into document blocks ───────────────────────────
  const docBlocks: string[] = []
  const docSectionTypes: string[] = []
  let current: string[] = []
  let currentDocType = ''
  let inDoc = false

  for (const line of lines) {
    if (line.startsWith('СекцияДокумент')) {
      inDoc = true; current = []
      currentDocType = line.includes('=') ? line.slice(line.indexOf('=') + 1).trim() : ''
      continue
    }
    if (line === 'КонецДокумента') {
      if (inDoc && current.length) {
        docBlocks.push(current.join('\n'))
        docSectionTypes.push(currentDocType)
      }
      inDoc = false; current = []; currentDocType = ''; continue
    }
    if (inDoc) current.push(line)
  }

  // ── Parse each document ──────────────────────────────────
  const transactions: ParsedTransaction[] = []
  let skipped = 0

  for (let bi = 0; bi < docBlocks.length; bi++) {
    const block = docBlocks[bi]
    const sectionType = docSectionTypes[bi].toLowerCase()
    const kv = parseKVBlock(block)

    const date = parseDate(kv['Дата'] ?? '')
    const amount = parseAmount(kv['Сумма'] ?? '')
    if (!date || !amount || amount <= 0) { skipped++; continue }

    // Support both naming conventions:
    // Standard 1C: СчетПлательщика / СчетПолучателя (Alfa-Bank, VTB)
    // Sberbank: ПлательщикСчет / ПолучательСчет
    const payerAcct     = kv['СчетПлательщика'] ?? kv['ПлательщикСчет'] ?? ''
    const recipientAcct = kv['СчетПолучателя']  ?? kv['ПолучательСчет'] ?? ''
    const docRasчSchet  = kv['РасчСчет'] ?? kv['ПлательщикРасчСчет'] ?? ''

    const isExplicitOutgoing = sectionType.includes('исходящий') || sectionType.includes('списани')
    const isExplicitIncoming = sectionType.includes('входящий')  || sectionType.includes('зачислени')

    // Direction detection: account comparison takes priority, then document type
    let type: 'income' | 'expense' = 'income'
    if (ourAccount) {
      if (payerAcct === ourAccount) {
        type = 'expense'
      } else if (recipientAcct === ourAccount) {
        type = 'income'
      } else if (docRasчSchet === ourAccount) {
        // Our account is the document's acting account; use doc type or recipient clue
        if (isExplicitOutgoing) type = 'expense'
        else if (isExplicitIncoming) type = 'income'
        else if (recipientAcct && recipientAcct !== ourAccount) type = 'expense'
        else type = 'expense'
      }
      // Otherwise keep 'income' (e.g. transit account paying into ours)
    } else {
      if (isExplicitOutgoing) type = 'expense'
      else if (isExplicitIncoming) type = 'income'
      else if (payerAcct && payerAcct === docRasчSchet) type = 'expense'
    }

    const counterpart = shortenCounterpartName(
      type === 'expense' ? (kv['Получатель'] ?? '') : (kv['Плательщик'] ?? '')
    )

    // INN: Sberbank uses ПолучательИНН/ПлательщикИНН, standard 1C uses ИНН Получателя/ИНН Плательщика
    const counterpartInn = (type === 'expense'
      ? (kv['ПолучательИНН'] ?? kv['ИНН Получателя'] ?? kv['ИНН получателя'] ?? '')
      : (kv['ПлательщикИНН'] ?? kv['ИНН Плательщика'] ?? kv['ИНН плательщика'] ?? '')
    ).trim().replace(/\D/g, '')

    // Settlement account: ПолучательРасчСчет → ПолучательСчет (expense); symmetric for income
    const counterpartAccount = (type === 'expense'
      ? (kv['ПолучательРасчСчет'] ?? kv['ПолучательСчет'] ?? kv['СчетПолучателя'] ?? '')
      : (kv['ПлательщикРасчСчет'] ?? kv['ПлательщикСчет'] ?? kv['СчетПлательщика'] ?? '')
    ).trim()

    // Bank name and BIC
    const counterpartBankName = (type === 'expense'
      ? (kv['ПолучательБанк1'] ?? kv['БанкПолучателя'] ?? '')
      : (kv['ПлательщикБанк1'] ?? kv['БанкПлательщика'] ?? '')
    ).trim()

    const counterpartBik = (type === 'expense'
      ? (kv['ПолучательБИК'] ?? kv['БИКПолучателя'] ?? '')
      : (kv['ПлательщикБИК'] ?? kv['БИКПлательщика'] ?? '')
    ).trim().replace(/\D/g, '')

    const purpose = kv['НазначениеПлатежа'] ?? ''

    const description = [counterpart, purpose]
      .map(s => s.trim())
      .filter(Boolean)
      .join(' | ')
      .slice(0, 250)

    transactions.push({
      date, amount, type, description,
      counterpart:         counterpart         || undefined,
      counterpartInn:      counterpartInn      || undefined,
      counterpartAccount:  counterpartAccount  || undefined,
      counterpartBankName: counterpartBankName || undefined,
      counterpartBik:      counterpartBik      || undefined,
      raw: block,
    })
  }

  // Guess bank from Программа field
  const bp = bankName.toLowerCase()
  if (bp.includes('альфа') || bp.includes('alfa')) bankName = 'Альфа-Банк'
  else if (bp.includes('сбер') || bp.includes('sber')) bankName = 'Сбербанк'
  else if (bp.includes('тинькофф') || bp.includes('tinkoff')) bankName = 'Тинькофф'
  else if (bp.includes('втб') || bp.includes('vtb')) bankName = 'ВТБ'
  else if (bp.includes('точка') || bp.includes('tochka')) bankName = 'Точка'

  return {
    ok: transactions.length > 0,
    bankName,
    accountNumber: ourAccount,
    period,
    transactions,
    skipped,
    errors: transactions.length === 0 ? ['Не найдено ни одной операции'] : [],
  }
}

// ─── Generic delimiter-based parser ──────────────────────────────────────────

const DATE_HDRS = ['дата операции','дата совершения','дата','date','дата проводки']
const AMT_HDRS  = ['сумма','amount','сумма операции','сумма платежа','сумма в валюте счёта']
const CRD_HDRS  = ['приход','зачисление','credit','поступление','сумма зачисления']
const DBT_HDRS  = ['расход','списание','debit','сумма списания']
const DSC_HDRS  = ['описание','назначение','description','назначение платежа','информация о платеже','детали']

function findCol(headers: string[], patterns: string[]): number {
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i].toLowerCase().trim()
    if (patterns.some(p => h.includes(p))) return i
  }
  return -1
}

function parseDelimited(lines: string[], delim: string): ParsedTransaction[] {
  const result: ParsedTransaction[] = []
  let headerIdx = -1
  let headers: string[] = []

  for (let i = 0; i < Math.min(20, lines.length); i++) {
    const cols = lines[i].split(delim).map(c => c.trim().replace(/^["']|["']$/g,''))
    if (cols.length >= 2 && cols.some(c =>
      [...DATE_HDRS, ...AMT_HDRS, ...CRD_HDRS].some(p => c.toLowerCase().includes(p))
    )) {
      headerIdx = i
      headers = cols.map(c => c.toLowerCase().trim())
      break
    }
  }
  if (headerIdx === -1) return []

  const datCol = findCol(headers, DATE_HDRS)
  const amtCol = findCol(headers, AMT_HDRS)
  const crdCol = findCol(headers, CRD_HDRS)
  const dbtCol = findCol(headers, DBT_HDRS)
  const dscCol = findCol(headers, DSC_HDRS)
  if (datCol === -1 || (amtCol === -1 && crdCol === -1 && dbtCol === -1)) return []

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const cols = lines[i].split(delim).map(c => c.trim().replace(/^["']|["']$/g,''))

    const date = parseDate((cols[datCol] ?? '').split(' ')[0])
    if (!date) continue

    let amount: number | null = null
    let type: 'income' | 'expense' = 'expense'

    if (amtCol !== -1) {
      amount = parseAmount(cols[amtCol] ?? '')
      if (amount !== null) type = amount >= 0 ? 'income' : 'expense'
    } else {
      const crd = parseAmount(cols[crdCol] ?? '')
      const dbt = parseAmount(cols[dbtCol] ?? '')
      if (crd && crd > 0) { amount = crd; type = 'income' }
      else if (dbt && dbt > 0) { amount = dbt; type = 'expense' }
    }
    if (!amount || amount === 0) continue

    const description = dscCol !== -1
      ? (cols[dscCol] ?? '')
      : cols.filter((_,idx) => ![datCol,amtCol,crdCol,dbtCol].includes(idx)).find(Boolean) ?? ''

    result.push({ date, amount: Math.abs(amount), type, description: description.slice(0,200), raw: line })
  }
  return result
}

function parseFreeform(lines: string[]): ParsedTransaction[] {
  const result: ParsedTransaction[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length < 10) continue
    const date = parseDate(trimmed)
    if (!date) continue
    const amtMatch = trimmed.match(/([+-]?\s*[\d\s]{1,12}[,.][\d]{2})\s*(руб|rub|₽)?/i)
      ?? trimmed.match(/([+-]?\s*[\d]{3,})\s*(руб|rub|₽)/i)
    if (!amtMatch) continue
    const amount = parseAmount(amtMatch[1])
    if (!amount || amount === 0) continue
    const type: 'income' | 'expense' = amount > 0 ? 'income' : 'expense'
    const amtEnd = trimmed.indexOf(amtMatch[0]) + amtMatch[0].length
    const description = trimmed.slice(amtEnd).trim().replace(/^[,;:–\-\s]+/,'') || trimmed
    result.push({ date, amount: Math.abs(amount), type, description: description.slice(0,200), raw: line })
  }
  return result
}

// ─── Bank detection ───────────────────────────────────────────────────────────

function detectBank(text: string): string {
  const t = text.toLowerCase()
  if (t.includes('сбербанк') || t.includes('sberbank') || t.includes('пао сбер')) return 'Сбербанк'
  if (t.includes('тинькофф') || t.includes('tinkoff') || t.includes('т-банк')) return 'Тинькофф / Т-Банк'
  if (t.includes('альфа') || t.includes('alfa')) return 'Альфа-Банк'
  if (t.includes('втб') || t.includes('vtb')) return 'ВТБ'
  if (t.includes('райффайзен') || t.includes('raiffeisen')) return 'Райффайзен'
  if (t.includes('газпром')) return 'Газпромбанк'
  if (t.includes('открытие')) return 'Банк Открытие'
  if (t.includes('точка') || t.includes('tochka')) return 'Точка'
  if (t.includes('модульбанк')) return 'МодульБанк'
  if (t.includes('озон')) return 'Озон Банк'
  return 'Неизвестный банк'
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export function parseBankStatement(text: string): ParseResult {
  // 1C ClientBankExchange format — most common for Russian banks
  if (is1CFormat(text)) return parse1C(text)

  const lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n')
  const nonEmpty = lines.filter(l => l.trim().length > 0)

  if (nonEmpty.length < 2) {
    return { ok: false, bankName: 'Неизвестный банк', transactions: [], skipped: 0, errors: ['Файл пуст или нечитаем'] }
  }

  const bankName = detectBank(text)
  const accountNumber = text.match(/\b(\d{20})\b/)?.[1]
  const periodMatch = text.match(/с\s*(\d{2}\.\d{2}\.\d{4})\s*(?:по|—|-)\s*(\d{2}\.\d{2}\.\d{4})/i)
  const period = periodMatch ? `${periodMatch[1]} — ${periodMatch[2]}` : undefined

  // Detect delimiter
  const sample = nonEmpty.slice(0,10).join('\n')
  const counts: Record<string,number> = { ';':0, '\t':0, '|':0 }
  for (const d of Object.keys(counts)) counts[d] = (sample.match(new RegExp(d.replace('|','\\|'),'g'))??[]).length
  const delim = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][1] > 0
    ? Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0]
    : '\t'

  let transactions = parseDelimited(nonEmpty, delim)
  if (transactions.length === 0) transactions = parseFreeform(nonEmpty)

  return {
    ok: transactions.length > 0,
    bankName,
    accountNumber,
    period,
    transactions,
    skipped: Math.max(0, nonEmpty.length - transactions.length),
    errors: transactions.length === 0 ? ['Не удалось распознать структуру выписки'] : [],
  }
}

// ─── Counterpart name shortener ───────────────────────────────────────────────
// Converts full legal names to short form: "ООО Фаворит", "ИП Коршков", etc.

const LEGAL_FORMS: [RegExp, string][] = [
  [/^ПУБЛИЧНОЕ\s+АКЦИОНЕРНОЕ\s+ОБЩЕСТВО\s*/i,                      'ПАО' ],
  [/^НЕПУБЛИЧНОЕ\s+АКЦИОНЕРНОЕ\s+ОБЩЕСТВО\s*/i,                    'НАО' ],
  [/^ОТКРЫТОЕ\s+АКЦИОНЕРНОЕ\s+ОБЩЕСТВО\s*/i,                       'ОАО' ],
  [/^ЗАКРЫТОЕ\s+АКЦИОНЕРНОЕ\s+ОБЩЕСТВО\s*/i,                       'ЗАО' ],
  [/^АКЦИОНЕРНОЕ\s+ОБЩЕСТВО\s*/i,                                   'АО'  ],
  [/^ОБЩЕСТВО\s+С\s+ОГРАНИЧЕННОЙ\s+ОТВЕТСТВЕННОСТЬЮ\s*/i,          'ООО' ],
  [/^ОБЩЕСТВО\s+С\s+ДОПОЛНИТЕЛЬНОЙ\s+ОТВЕТСТВЕННОСТЬЮ\s*/i,        'ОДО' ],
  [/^ИНДИВИДУАЛЬНЫЙ\s+ПРЕДПРИНИМАТЕЛЬ\s*/i,                        'ИП'  ],
  [/^ФЕДЕРАЛЬНОЕ\s+ГОСУДАРСТВЕННОЕ\s+УНИТАРНОЕ\s+ПРЕДПРИЯТИЕ\s*/i, 'ФГУП'],
  [/^ГОСУДАРСТВЕННОЕ\s+УНИТАРНОЕ\s+ПРЕДПРИЯТИЕ\s*/i,               'ГУП' ],
  [/^МУНИЦИПАЛЬНОЕ\s+УНИТАРНОЕ\s+ПРЕДПРИЯТИЕ\s*/i,                 'МУП' ],
  [/^ПРОИЗВОДСТВЕННЫЙ\s+КООПЕРАТИВ\s*/i,                           'ПК'  ],
  [/^ПОТРЕБИТЕЛЬСКИЙ\s+КООПЕРАТИВ\s*/i,                            'ПК'  ],
  [/^ТОВАРИЩЕСТВО\s+СОБСТВЕННИКОВ\s+ЖИЛЬЯ\s*/i,                    'ТСЖ' ],
  [/^НЕКОММЕРЧЕСКАЯ\s+ОРГАНИЗАЦИЯ\s*/i,                            'НКО' ],
]

const SHORT_FORMS = /^(ООО|ОАО|ЗАО|АО|ПАО|НАО|ОДО|ИП|ГУП|МУП|ФГУП|ТСЖ|СНТ|НКО|ПК)\s+/i

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s
}

function capWords(s: string): string {
  // Keep short uppercase words (abbreviations) as-is, capitalise the rest
  return s.split(/\s+/).map(w => w.length <= 3 && w === w.toUpperCase() ? w : cap(w)).join(' ')
}

export function shortenCounterpartName(raw: string): string {
  if (!raw) return raw
  // Strip INN / KPP embedded in the name string, e.g. "ООО ФАВОРИТ ИНН 1234567890 КПП 123456789"
  const s = raw
    .replace(/\s*,?\s*ИНН\s*:?\s*\d{10,12}/gi, '')
    .replace(/\s*,?\s*КПП\s*:?\s*\d{9}/gi, '')
    .replace(/\s*,?\s*ОГРН\s*:?\s*\d{13,15}/gi, '')
    .trim()

  let prefix = ''
  let rest   = s

  // Already in short form: "ООО ФАВОРИТ", "ИП КОРШКОВ И.А."
  const shortMatch = s.match(SHORT_FORMS)
  if (shortMatch) {
    prefix = shortMatch[1].toUpperCase()
    rest   = s.slice(shortMatch[0].length).trim()
  } else {
    // Full form: "ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ 'ФАВОРИТ'"
    for (const [re, short] of LEGAL_FORMS) {
      if (re.test(s)) {
        prefix = short
        rest   = s.replace(re, '').trim()
        break
      }
    }
  }

  // Remove surrounding quotes: «», "", '', ""
  rest = rest.replace(/^[«"""''‘’“”]+|[«"""''‘’“”]+$/g, '').trim()

  if (!rest) return capWords(s) // no name part found — just capitalise

  if (prefix === 'ИП') {
    // "КОРШКОВ АЛЕКСЕЙ НИКОЛАЕВИЧ" → take only last name
    const lastName = rest.split(/\s+/)[0]
    return `ИП ${cap(lastName)}`
  }

  return prefix ? `${prefix} ${capWords(rest)}` : capWords(s)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function splitKV(line: string): [string, string] {
  const idx = line.indexOf('=')
  if (idx < 1) return ['', '']
  return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()]
}

function parseKVBlock(block: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const [key, val] = splitKV(line.trim())
    if (key && !(key in result)) result[key] = val  // first occurrence wins
  }
  return result
}
