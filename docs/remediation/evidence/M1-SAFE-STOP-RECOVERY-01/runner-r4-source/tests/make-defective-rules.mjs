// Test-only helper: writes a DEFECTIVE copy of the round-3 Firestore Rules (never deployed anywhere) in which the
// round-3 finding 2 is undone: `companies get` accepts the ownerId again. Loaded into the LOCAL emulator, the UI
// smoke still passes and the API smoke stops at the real R6 probe (a confirmed Rules failure). The reviewed rules
// file of the release clone is only read.
//   node tests/make-defective-rules.mjs --out <new abs file>
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--out' || !path.isAbsolute(args[1]) || fs.existsSync(args[1])) { console.log('MAKE_DEFECTIVE_RULES_STOP usage'); process.exit(2) }
const text = fs.readFileSync('D:\\projects\\finapp\\m1-release-714d0f91\\firestore.rules', 'utf8')
const from = '      // компанию и его admin-membership в одной транзакции.\n      allow get: if isMemberOf(companyId);'
const crlf = text.includes('\r\n')
const anchor = crlf ? from.replaceAll('\n', '\r\n') : from
if (text.split(anchor).length !== 2) { console.log('MAKE_DEFECTIVE_RULES_STOP anchor not unique'); process.exit(2) }
fs.writeFileSync(args[1], text.replace(anchor, () => anchor.replace('allow get: if isMemberOf(companyId);', 'allow get: if isMemberOf(companyId) || (isSignedIn() && resource.data.ownerId == callerUid());')), { flag: 'wx' })
console.log('MAKE_DEFECTIVE_RULES_WRITTEN')
