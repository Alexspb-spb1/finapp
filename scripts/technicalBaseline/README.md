# Technical baseline tooling (`BASE-005`)

## `report-bundle.mjs`

Reproducible production bundle report. Node-only (`fs`, `path`, `zlib`,
`crypto`, `child_process`) — adds zero npm dependencies.

### Run

```bash
npm run build -- --manifest
npm run baseline:bundle
```

Reads `dist/index.html`, `dist/.vite/manifest.json`, and every file under
`dist/assets/`. Writes
`docs/remediation/evidence/BASE-005-bundle-report.json`.

### What it reports

- The git commit SHA of the checkout that produced `dist/`.
- Node/npm/Vite versions and the exact build command used.
- The entry chunk and the **static import chain** used to define
  "initial JS": entry JS + the full transitive closure of its
  manifest `imports` (statically imported chunks). Chunks reachable
  only via `dynamicImports` (`import()`) are reported separately and
  excluded from the initial JS totals.
- Every JS/CSS asset under `dist/assets/`: raw size, gzip size (max
  compression level), Brotli size (max quality), SHA-256.
- Total JS chunk count, total CSS file count, total `dist/` size.

### Reproducibility check

To confirm `--manifest` doesn't itself change chunking:

```bash
npm run build            # capture asset names + SHA-256
npm run build -- --manifest   # capture asset names + SHA-256 again
```

The JS/CSS asset list and their SHA-256 hashes must be identical between
the two builds (only the additional `dist/.vite/manifest.json` file is new).
If they differ, the bundle is not reproducible and this should be treated
as a blocking finding, not silently accepted.

### What it never does

- Never reads or reports `.env*` contents or Firebase configuration values.
- Never modifies `vite.config.ts`, chunking, or any build configuration.
- Never installs anything — uses only Node built-ins.
