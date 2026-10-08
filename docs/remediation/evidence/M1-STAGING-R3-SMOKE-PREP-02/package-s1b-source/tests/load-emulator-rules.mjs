// Test-only helper: loads a Firestore Rules file into the LOCAL Firestore emulator (127.0.0.1:8080, demo-finapp).
// Used by the emulator rehearsals to make the API smoke hit a real Rules probe failure. Never used against staging.
//   node tests/load-emulator-rules.mjs --file <abs rules file>
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--file' || !path.isAbsolute(args[1]) || !fs.existsSync(args[1])) { console.log('LOAD_RULES_STOP usage'); process.exit(2) }
const res = await fetch('http://127.0.0.1:8080/emulator/v1/projects/demo-finapp:securityRules', {
  method: 'PUT', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: fs.readFileSync(args[1], 'utf8') }] } }),
})
console.log(`LOAD_RULES status=${res.status}`)
process.exitCode = res.status === 200 ? 0 : 2
