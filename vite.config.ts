import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss(), {
    name: 'pages-invite-entry',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const visited = new Set<string>()
      const checkBootstrapGraph = (fileName: string): void => {
        if (visited.has(fileName)) return
        visited.add(fileName)
        const chunk = bundle[fileName]
        if (!chunk || chunk.type !== 'chunk') throw new Error('Missing bootstrap dependency')
        for (const rawId of Object.keys(chunk.modules)) {
          const id = rawId.replaceAll('\\', '/')
          const permitted = id.endsWith('/src/main.tsx')
            || id.endsWith('/src/bootstrap/inviteTokenBootstrap.ts')
            || id.endsWith('/index.html') || id === '\0vite/preload-helper.js'
          if (!permitted) throw new Error(`Module evaluates before invitation scrub: ${id}`)
        }
        for (const dependency of chunk.imports) checkBootstrapGraph(dependency)
      }
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk' && chunk.isEntry) checkBootstrapGraph(chunk.fileName)
      }
      const entry = bundle['index.html']
      if (!entry || entry.type !== 'asset') throw new Error('Missing Pages entry')
      // Pages serves this file at unknown real paths. Do not redirect through
      // query parameters, storage or another URL carrying the invitation token.
      this.emitFile({ type: 'asset', fileName: '404.html', source: entry.source })
    },
  }],
  base: '/finapp/',
  build: {
    // Keep the bootstrap entry free of preloaded application dependencies.
    modulePreload: false,
    manifest: true,
  },
})
