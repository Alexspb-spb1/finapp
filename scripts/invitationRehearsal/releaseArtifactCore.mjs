import fs from 'node:fs'

export function assertNoLocalFunctionConfiguration(sourceDir) {
  // Firebase reads dotenv before archive ignore rules are applied. Reject all
  // matching root entries, including directories/symlinks and Windows casing.
  // Names alone suffice; never read configuration values to validate absence.
  if (fs.readdirSync(sourceDir).some(name => /^\.(?:env|secret)/i.test(name) || /^\.runtimeconfig\.json$/i.test(name))) {
    throw new Error('local_function_configuration')
  }
}
