// Builds an isolated process environment for local-emulator runs: default-deny allowlist of variables, credential/config locations redirected to
// empty directories under <root>, project fixed to the demo project, the loopback fence preloaded for every Node process. Pure function over
// the base environment (it never reads or writes owner credential files, system settings or the real profile).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DEMO_PROJECT = 'demo-finapp'

// Only these base variables survive (Windows runtime essentials). Everything else - tokens, proxies, cloud/Google/Firebase/GitHub/AWS
// variables, NODE_OPTIONS, user profile redirects - is dropped by default.
const ALLOW = ['SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'COMPUTERNAME', 'SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'ALLUSERSPROFILE', 'ProgramData']
// Names that must never be present in the result; checked again by the test and by assertNoCredentialEnv.
export const CREDENTIAL_ENV = /^(GOOGLE_|GCLOUD|CLOUDSDK_(?!CONFIG$)|FIREBASE_(?!EMULATORS_PATH$|CLI_DISABLE_UPDATE_CHECK$)|GH_|GITHUB_|AWS_|AZURE_|NPM_TOKEN|NODE_AUTH_TOKEN|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSH_|GIT_ASKPASS)/i

export function buildIsolatedEnv({ root, base = process.env, jdkBin, emulatorsPath, fenceLog, fencePath = path.join(HERE, 'loopback-only.cjs'), extraPreload = [], extra = {} }) {
  if (!root) throw new Error('ISOLATED_ROOT_REQUIRED')
  const dirs = {
    appdata: path.join(root, 'appdata'), localappdata: path.join(root, 'localappdata'), home: path.join(root, 'home'), xdg: path.join(root, 'xdg-config'),
    xdgCache: path.join(root, 'xdg-cache'), gcloud: path.join(root, 'gcloud'), tmp: path.join(root, 'tmp')
  }
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true })
  const env = {}
  for (const k of Object.keys(base)) if (ALLOW.some(a => a.toLowerCase() === k.toLowerCase())) env[k] = base[k]
  const pathKey = Object.keys(base).find(k => k.toLowerCase() === 'path') || 'PATH'
  const basePath = base[pathKey] || ''
  Object.assign(env, {
    [pathKey]: [jdkBin, basePath].filter(Boolean).join(path.delimiter),
    APPDATA: dirs.appdata, LOCALAPPDATA: dirs.localappdata, USERPROFILE: dirs.home, HOME: dirs.home, HOMEDRIVE: dirs.home.slice(0, 2), HOMEPATH: dirs.home.slice(2),
    XDG_CONFIG_HOME: dirs.xdg, XDG_CACHE_HOME: dirs.xdgCache, CLOUDSDK_CONFIG: dirs.gcloud, TEMP: dirs.tmp, TMP: dirs.tmp, TMPDIR: dirs.tmp,
    GCLOUD_PROJECT: DEMO_PROJECT, GOOGLE_CLOUD_PROJECT: DEMO_PROJECT, // project id only (no credential); the emulators require it
    FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true', CI: 'true',
    ...(emulatorsPath ? { FIREBASE_EMULATORS_PATH: emulatorsPath } : {}),
    ...(fenceLog ? { M1_FENCE_LOG: fenceLog, NODE_OPTIONS: [...extraPreload, fencePath].map(p => `--require=${p}`).join(' ') } : {}),
    ...extra
  })
  return env
}

// Returns the names (never values) of variables in `env` that look like credentials or network/proxy configuration.
export function credentialEnvNames(env) {
  return Object.keys(env).filter(k => CREDENTIAL_ENV.test(k) && !['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT'].includes(k))
}
