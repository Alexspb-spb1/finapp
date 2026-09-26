import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertNoLocalFunctionConfiguration } from './releaseArtifactCore.mjs'

function removeTemporarySource(source) {
  const resolved = fs.realpathSync(source)
  if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('finapp-artifact-')) throw new Error('temporary path')
  fs.rmSync(resolved, { recursive: true })
}

test('local source without function configuration passes', () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'finapp-artifact-'))
  try {
    fs.writeFileSync(path.join(source, 'package.json'), '{}')
    fs.mkdirSync(path.join(source, 'lib'))
    assert.doesNotThrow(() => assertNoLocalFunctionConfiguration(source))
  } finally { removeTemporarySource(source) }
})

for (const name of ['.env', '.env.finapp-staging', '.env.local', '.ENV.LOCAL', '.secret.local', '.runtimeconfig.json']) {
  test(`refuses ${name} even when deployment archive excludes it`, () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'finapp-artifact-'))
    try {
      // Empty directory also proves the gate examines names, not file content.
      fs.mkdirSync(path.join(source, name))
      assert.throws(() => assertNoLocalFunctionConfiguration(source), /local_function_configuration/)
    } finally { removeTemporarySource(source) }
  })
}
