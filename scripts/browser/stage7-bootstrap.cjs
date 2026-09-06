// Runs only against a local production build. The second loopback server is a
// real external-observer surrogate; no Firebase or public traffic is allowed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');
const repo = path.resolve(__dirname, '../..');
const rootRequire = createRequire(path.join(repo, 'package.json'));
const browserRequire = process.env.FINAPP_BROWSER_TOOLS
  ? createRequire(path.resolve(process.env.FINAPP_BROWSER_TOOLS, 'package.json')) : rootRequire;
const { chromium } = browserRequire('playwright');
const dist = path.join(repo, 'dist');
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
assert.equal(fs.readFileSync(path.join(dist, '404.html'), 'utf8'), html, 'Pages fallback must be identical, without token redirects');
const scripts = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)];
assert.equal(scripts.length, 1, 'No earlier inline or observer script');
assert.match(scripts[0][0], /type="module"/);
assert.doesNotMatch(html, /modulepreload/);
const entryPath = /src="\/finapp\/([^"?]+)"/.exec(scripts[0][0])?.[1];
assert.ok(entryPath);
const manifest = JSON.parse(fs.readFileSync(path.join(dist, '.vite/manifest.json'), 'utf8'));
const entry = Object.values(manifest).find(item => item.file === entryPath);
assert.ok(entry?.isEntry);
assert.ok(entry.dynamicImports?.length, 'Application must be behind a dynamic import');
const earlyFiles = new Set();
function addEarly(chunk) {
  earlyFiles.add(chunk.file);
  for (const key of chunk.imports || []) addEarly(manifest[key]);
}
addEarly(entry);
for (const file of earlyFiles) {
  const source = fs.readFileSync(path.join(dist, file), 'utf8');
  assert.doesNotMatch(source, /firebase|react-dom|createRoot|onAuthStateChanged|localStorage|sessionStorage/i,
    'Bootstrap static dependency graph must not load application observers or persistence');
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function main() {
  const observations = [];
  const collector = http.createServer((req, res) => {
    let body = '';
    req.on('data', part => { body += part; });
    req.on('end', () => {
      if (req.method === 'POST') observations.push(JSON.parse(body));
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
      res.end('ok');
    });
  });
  const collectorOrigin = await listen(collector);
  const server = http.createServer((req, res) => {
    const requested = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    const relative = requested.startsWith('/finapp/') ? requested.slice('/finapp/'.length) : '';
    const candidate = path.resolve(dist, relative);
    const exists = candidate.startsWith(dist + path.sep) && fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    const file = exists ? candidate : path.join(dist, '404.html');
    let body = fs.readFileSync(file);
    const extension = path.extname(file);
    if (extension === '.js' && !earlyFiles.has(relative.replaceAll('\\', '/'))) {
      // Instrument the *actual emitted downstream module*, before its body.
      // Static dependencies receive the same observer, so evaluation order is
      // exercised by the browser rather than inferred from import source order.
      body = Buffer.concat([Buffer.from(`void fetch(${JSON.stringify(collectorOrigin)}, {method:'POST',body:JSON.stringify({url:location.href,phase:'downstream-module'})});\n`), body]);
    }
    res.writeHead(exists ? 200 : 404, {
      'Content-Type': extension === '.js' ? 'text/javascript' : extension === '.css' ? 'text/css' : 'text/html',
    });
    res.end(body);
  });
  const origin = await listen(server);
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    const cases = [
      { name: 'valid-direct-pages-path', fragment: `#token=${'A'.repeat(43)}`, expected: '' },
      { name: 'malformed-token', fragment: '#token=%ZZ', expected: '' },
      { name: 'malformed-token-key', fragment: `#token%XX=${'A'.repeat(43)}`, expected: '' },
      { name: 'duplicate-token-preserved-anchor', fragment: '#section=help&token=bad&token=bad', expected: '#section=help' },
      { name: 'unrelated-anchor', fragment: '#details', expected: '#details' },
    ];
    for (const item of cases) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const network = [];
      await context.route('**/*', route => {
        const req = route.request();
        const url = new URL(req.url());
        if (url.origin !== origin && url.origin !== collectorOrigin) return route.abort();
        network.push({ url: req.url(), referer: req.headers().referer || '' });
        return route.continue();
      });
      const before = observations.length;
      const routePath = '/finapp/accept-invite/invite-123?lang=ru';
      await page.goto(origin + routePath + item.fragment);
      await page.waitForFunction(() => document.querySelector('#root')?.childElementCount > 0);
      await page.waitForTimeout(250);
      const received = observations.slice(before);
      assert.ok(received.length > 0, 'External observer must really receive a request');
      for (const record of received) assert.equal(record.url, origin + routePath + item.expected);
      for (const request of network) {
        assert.ok(!request.url.includes('token='));
        assert.ok(!request.referer.includes('token='));
      }
      assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
      assert.equal(page.url(), origin + routePath + item.expected);
      results.push({ case: item.name, status: 'PASS', observerRequests: received.length });
      await context.close();
    }
    console.log(JSON.stringify({ status: 'PASS', staticBootstrapFiles: [...earlyFiles], results }, null, 2));
  } finally {
    await browser.close();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => collector.close(resolve))]);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
