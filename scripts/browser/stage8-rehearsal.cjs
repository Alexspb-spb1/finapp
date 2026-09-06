// SEC-006 Phase 1 integrated rehearsal. Synthetic local demo-finapp only.
// Serves the actual dist artifact (including Pages 404 entry), never Vite/HMR.
// Tokens, credentials, payloads, browser traces and raw errors are never persisted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const {createRequire} = require('node:module');
const root = path.resolve(__dirname, '../..');
const rootRequire = createRequire(path.join(root, 'package.json'));
const browserRequire = process.env.FINAPP_BROWSER_TOOLS
  ? createRequire(path.resolve(process.env.FINAPP_BROWSER_TOOLS, 'package.json')) : rootRequire;
const {chromium} = browserRequire('playwright');
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
const {initializeApp, deleteApp} = rootRequire('firebase-admin/app');
const {getAuth} = rootRequire('firebase-admin/auth');
const {getFirestore, Timestamp} = rootRequire('firebase-admin/firestore');
const adminApp = initializeApp({projectId: 'demo-finapp'});
const auth = getAuth(adminApp), db = getFirestore(adminApp);
const dist = path.join(root, 'dist');
const artifacts = path.resolve(process.env.FINAPP_BROWSER_ARTIFACTS || path.join(root, 'docs/remediation/evidence/SEC-006-stage8'));
const origin = 'http://127.0.0.1:5176', base = `${origin}/finapp/`;
const acceptEndpoint = 'http://127.0.0.1:5001/demo-finapp/us-central1/acceptInvite';
const suffix = Date.now();
const companyA = `stage8-a-${suffix}`, companyB = `stage8-b-${suffix}`;
const password = 'Synthetic-stage8-password';
const contexts = [], checks = [], tokens = new Set();
const blockedOrigins = new Set(), pageErrorKinds = new Set();
let browser, server, step = 'artifact-preflight', externalAttempts = 0, capabilityUrlAttempts = 0, pageErrors = 0;
const say = value => console.log(`Stage8 ${value}`);
const begin = name => { step = name; say(`START ${name}`); };
const pass = () => { checks.push(step); say(`PASS ${step}`); };
const button = (page, name) => page.getByRole('button', {name, exact:true});
const memberRef = uid => db.doc(`companies/${companyA}/members/${uid}`);
const now = () => Timestamp.now();
const emptyData = {accounts:[], categories:[], transactions:[], counterparties:[], projects:[], rules:[]};

async function createUser(label, verified = true) {
  return auth.createUser({email:`s8-${label}-${suffix}@example.test`, password, emailVerified:verified});
}
async function membership(companyId, user, role) {
  await db.doc(`companies/${companyId}/members/${user.uid}`).set({uid:user.uid, role, status:'active', createdAt:now(), updatedAt:now()});
}
async function profile(user, companyId, role, companies = []) {
  await db.doc(`users/${user.uid}`).set({id:user.uid, name:'Synthetic participant', email:user.email,
    companyId, role, companies, createdAt:new Date().toISOString()});
}
async function fresh() {
  const context = await browser.newContext({viewport:{width:1280,height:900}, permissions:['clipboard-read','clipboard-write'], serviceWorkers:'block'});
  contexts.push(context);
  const requested = [], calls = [];
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    // Inspect the entire URL before classifying origins; never persist a capability-bearing host.
    if ([...tokens].some(token => request.url().includes(token))) {capabilityUrlAttempts++; return route.abort();}
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !['5176','9099','8080','5001'].includes(url.port)) {
      blockedOrigins.add(url.origin);
      externalAttempts++; return route.abort();
    }
    requested.push(url.pathname);
    if (url.port === '5001' && request.method() === 'POST') calls.push(url.pathname.split('/').pop());
    return route.continue();
  });
  await context.addInitScript(() => {
    // Auth creates auxiliary documents; storage instrumentation belongs only to the app origin.
    if (location.origin !== 'http://127.0.0.1:5176') return;
    window.__stage8Reads = [];
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key) {window.__stage8Reads.push(key); return get.call(this,key);};
    localStorage.setItem('finapp_last_company_id','stage8-unrelated');
    localStorage.setItem('company_data_stage8-unrelated',JSON.stringify({accounts:[{name:'STAGE8-PRIVATE-CACHE'}]}));
  });
  context.on('page', page => page.on('pageerror', error => {
    pageErrors++;
    const known = ['Failed to fetch','Missing or insufficient permissions','auth/network-request-failed','auth/internal-error'];
    pageErrorKinds.add(known.find(value => error.message.includes(value)) || 'unknown-page-error');
  }));
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  return {context, page, requested, calls};
}
async function signIn(page, user, invitation = true) {
  await page.locator('input[type=email]').fill(user.email);
  await page.locator('input[type=password]').fill(password);
  await button(page,'Войти').click();
  if (invitation) await button(page,user.emailVerified ? 'Принять приглашение':'Я подтвердил email').waitFor();
  else await page.waitForURL(`${base}#/`);
}
async function noFinancial(client) {
  assert(!client.requested.some(p => /(?:LegacyApp|authStore)-|\/src\/|@vite/.test(p)), 'Financial or dev module before access');
  assert.equal(await client.page.evaluate(() => window.__stage8Reads.some(k => k === 'finapp_last_company_id' || k.startsWith('company_data_'))),false);
  assert.equal(await client.page.getByText('STAGE8-PRIVATE-CACHE',{exact:true}).count(),0);
}
async function noStoredToken(page) {
  assert.equal(await page.evaluate(values => values.some(t => JSON.stringify({...localStorage,...sessionStorage}).includes(t)), [...tokens]),false);
  // Firebase Auth persists its own credentials; the invitation capability must not be among any IDB values.
  assert.equal(await page.evaluate(async values => {
    for (const {name} of await indexedDB.databases()) {
      const opened = await new Promise((resolve,reject) => {const r=indexedDB.open(name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject();});
      try {
        for (const store of opened.objectStoreNames) {
          const rows = await new Promise((resolve,reject) => {const r=opened.transaction(store).objectStore(store).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject();});
          if (values.some(t => JSON.stringify(rows).includes(t))) return true;
        }
      } finally {opened.close();}
    }
    return false;
  }, [...tokens]),false);
}
async function openInvite(link, client) {
  const target = client || await fresh();
  await target.page.goto(link.url);
  assert.equal(new URL(target.page.url()).hash,'');
  return target;
}
async function readLink(page) {
  const field=page.getByLabel('Ссылка',{exact:true}); await field.waitFor();
  const url=await field.inputValue(), parsed=new URL(url);
  assert.equal(parsed.origin,origin); assert.equal(parsed.search,'');
  assert.match(parsed.pathname,/^\/finapp\/accept-invite\/[A-Za-z0-9_-]+$/);
  assert.match(parsed.hash,/^#token=[\w-]{43}$/);
  const token=parsed.hash.slice(7); tokens.add(token);
  await button(page,'Копировать ссылку').click();
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),url);
  await noStoredToken(page);
  await button(page,'Закрыть').click();
  assert.equal(await field.count(),0);
  return {url, inviteId:parsed.pathname.split('/').pop()};
}
async function createInvitation(page,email,role='viewer') {
  await button(page,'Пригласить по email').click();
  assert.equal(await page.getByRole('dialog').locator('input[type=password]').count(),0);
  await page.getByLabel('Email',{exact:true}).fill(email);
  await page.getByRole('dialog').getByRole('combobox').selectOption(role);
  const before=(await auth.listUsers()).users.length;
  await button(page,'Создать приглашение').click();
  const link=await readLink(page);
  assert.equal((await auth.listUsers()).users.length,before);
  const doc=(await db.doc(`invitations/${link.inviteId}`).get()).data();
  assert.equal(doc.token,undefined); assert.equal(doc.rawToken,undefined);
  // Expiry is generated before the transaction's server timestamp; allow emulator latency.
  assert(Math.abs(doc.expiresAt.toMillis()-doc.createdAt.toMillis()-7*86400000)<10000);
  return link;
}
function row(page,email) { return page.getByRole('region',{name:'Приглашения',exact:true}).locator('li').filter({hasText:email}); }
async function refresh(page) {
  await button(page,'Обновить список').click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Пригласить по email' && !b.disabled));
}
async function verifyEmail(client,user) {
  await button(client.page,'Я подтвердил email').click();
  await client.page.getByRole('alert').filter({hasText:'Email ещё не подтверждён'}).waitFor();
  assert.equal((await memberRef(user.uid).get()).exists,false);
  await noFinancial(client);
  await button(client.page,'Отправить письмо подтверждения').click();
  await client.page.getByText('Письмо отправлено.',{exact:false}).waitFor();
  assert.equal(await client.page.locator('[data-verification-send]').isDisabled(),true);
  const response=await fetch('http://127.0.0.1:9099/emulator/v1/projects/demo-finapp/oobCodes');
  assert.equal(response.status,200);
  const codes=(await response.json()).oobCodes;
  const code=codes.findLast(c => c.email===user.email && c.requestType==='VERIFY_EMAIL');
  assert(code,'Actual emulator verification action exists');
  // Consume the code emitted by the UI sendEmailVerification, without admin flag mutation.
  const applied=await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:update?key=emulator-only-synthetic-key',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({oobCode:code.oobCode})});
  assert.equal(applied.status,200);
  assert.equal((await auth.getUser(user.uid)).emailVerified,true);
}
async function accepted(client,user,role,buttonName='Принять приглашение') {
  await button(client.page,buttonName).click();
  await client.page.waitForURL(`${base}#/`);
  assert.equal((await memberRef(user.uid).get()).data().role,role);
  assert.equal((await memberRef(user.uid).get()).data().status,'active');
  await noStoredToken(client.page);
}
async function mutationSnapshot(inviteId,uid) {
  const refs=[db.doc(`invitations/${inviteId}`),memberRef(uid),db.doc(`users/${uid}`)];
  return Promise.all(refs.map(async ref => {const doc=await ref.get();return doc.exists?[doc.updateTime.seconds,doc.updateTime.nanoseconds]:null;}));
}

(async () => {
  fs.mkdirSync(artifacts,{recursive:true});
  const entry=fs.readFileSync(path.join(dist,'index.html'));
  assert.deepEqual(fs.readFileSync(path.join(dist,'404.html')),entry);
  const manifest=JSON.parse(fs.readFileSync(path.join(dist,'.vite/manifest.json'),'utf8'));
  assert(Object.values(manifest).some(v => v.isEntry));
  assert(!entry.toString().includes('/src/') && !entry.toString().includes('@vite'));
  const artifactHashes=Object.fromEntries(['index.html','404.html',...new Set(Object.values(manifest).flatMap(v => [v.file,...v.css||[]]))].sort().map(file => [file,crypto.createHash('sha256').update(fs.readFileSync(path.join(dist,file))).digest('hex')]));
  // No configurable external host/target: static host and every emulator are fixed loopback.
  server=http.createServer((req,res) => {
    try {
      const pathname=decodeURIComponent(new URL(req.url,origin).pathname);
      if (!pathname.startsWith('/finapp/')) {res.writeHead(404);res.end();return;}
      let target=path.resolve(dist,pathname.slice('/finapp/'.length) || 'index.html');
      if (!target.startsWith(`${dist}${path.sep}`)) {res.writeHead(400);res.end();return;}
      let status=200;
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {target=path.join(dist,'404.html');status=404;}
      const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json'};
      res.writeHead(status,{'Content-Type':mime[path.extname(target)]||'application/octet-stream','Cache-Control':'no-store'});
      res.end(fs.readFileSync(target));
    } catch {res.writeHead(400);res.end();}
  });
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(5176,'127.0.0.1',resolve);});
  pass();
  begin('synthetic-fixtures');
  const administrator=await createUser('admin');
  for (const [id,name] of [[companyA,'Stage 8 Alpha'],[companyB,'Stage 8 Beta']]) {
    await db.doc(`companies/${id}`).set({id,name,legalType:'ooo',currency:'RUB',ownerId:administrator.uid,createdAt:new Date().toISOString()});
    await db.doc(`company_data/${id}`).set(emptyData);
  }
  await membership(companyA,administrator,'admin'); await membership(companyB,administrator,'viewer');
  await profile(administrator,companyA,'admin',[{companyId:companyB,role:'viewer'}]);
  browser=await chromium.launch({headless:true});
  const admin=await fresh(); await admin.page.goto(`${base}#/login`); await signIn(admin.page,administrator,false);
  await admin.page.goto(`${base}#/users`); await button(admin.page,'Пригласить по email').waitFor();
  pass();

  begin('admin-create-copy-new-invitee-verification-accept');
  const email=`s8-new-${suffix}@example.test`;
  const link=await createInvitation(admin.page,email);
  const guest=await openInvite(link);
  await guest.page.getByText('Stage 8 Alpha',{exact:true}).waitFor(); await noFinancial(guest);
  await button(guest.page,'Создать аккаунт').click();
  await guest.page.getByLabel('Email',{exact:true}).fill(email); await guest.page.getByLabel('Пароль',{exact:true}).fill(password);
  await button(guest.page,'Зарегистрироваться').click(); await button(guest.page,'Отправить письмо подтверждения').waitFor();
  const newUser=await auth.getUserByEmail(email);
  assert.equal((await db.doc(`users/${newUser.uid}`).get()).exists,false);
  await verifyEmail(guest,newUser);
  await accepted(guest,newUser,'viewer','Я подтвердил email');
  await guest.page.getByText('Режим только для чтения',{exact:false}).waitFor();
  await guest.page.screenshot({path:path.join(artifacts,'accepted-viewer.png')});
  pass();

  begin('existing-invitee-verification-accountant');
  const existing=await createUser('existing',false);
  const existingLink=await createInvitation(admin.page,existing.email,'accountant');
  const existingClient=await openInvite(existingLink); await signIn(existingClient.page,existing);
  await verifyEmail(existingClient,existing); await accepted(existingClient,existing,'accountant','Я подтвердил email');
  pass();

  begin('cancel-and-expiry-deny-without-partial-access');
  for (const mode of ['cancel','expiry']) {
    const user=await createUser(mode), invalid=await createInvitation(admin.page,user.email);
    if (mode==='cancel') {
      await button(row(admin.page,user.email),'Отменить приглашение').click();
      assert.equal((await db.doc(`invitations/${invalid.inviteId}`).get()).data().status,'pending');
      await button(admin.page,'Подтвердить отмену').click();
      await row(admin.page,user.email).getByText('Отменено · Срок:',{exact:false}).waitFor();
    } else await db.doc(`invitations/${invalid.inviteId}`).update({expiresAt:Timestamp.fromMillis(Date.now()-1000)});
    const client=await openInvite(invalid); await signIn(client.page,user);
    const before=await mutationSnapshot(invalid.inviteId,user.uid);
    await button(client.page,'Принять приглашение').click(); await client.page.getByRole('alert').waitFor();
    assert.deepEqual(await mutationSnapshot(invalid.inviteId,user.uid),before);
    assert.equal((await memberRef(user.uid).get()).exists,false); await noFinancial(client);
  }
  pass();

  begin('resend-cooldown-old-token-denial-new-token-success');
  const rotatedUser=await createUser('rotate'), old=await createInvitation(admin.page,rotatedUser.email);
  assert.equal(await button(row(admin.page,rotatedUser.email),'Новая ссылка').isDisabled(),true);
  await db.doc(`invitations/${old.inviteId}`).update({createdAt:Timestamp.fromMillis(Date.now()-180000),lastSentAt:Timestamp.fromMillis(Date.now()-120000)});
  await refresh(admin.page); await button(row(admin.page,rotatedUser.email),'Новая ссылка').click();
  await button(admin.page,'Создать новую ссылку').click(); const rotated=await readLink(admin.page);
  assert.notEqual(rotated.url,old.url); assert.equal(rotated.inviteId,old.inviteId);
  const oldClient=await openInvite(old); await signIn(oldClient.page,rotatedUser);
  await button(oldClient.page,'Принять приглашение').click(); await oldClient.page.getByRole('alert').waitFor();
  assert.equal((await memberRef(rotatedUser.uid).get()).exists,false); await noFinancial(oldClient);
  // Fresh document is required when reusing a fragment capability.
  const rotatedClient=await openInvite(rotated); await signIn(rotatedClient.page,rotatedUser); await accepted(rotatedClient,rotatedUser,'viewer');
  pass();

  begin('resend-limit-five');
  const limitedUser=await createUser('limit'), limitedLink=await createInvitation(admin.page,limitedUser.email);
  for(let count=1;count<=5;count++) {
    await db.doc(`invitations/${limitedLink.inviteId}`).update({createdAt:Timestamp.fromMillis(Date.now()-180000),lastSentAt:Timestamp.fromMillis(Date.now()-120000)});
    await refresh(admin.page); await button(row(admin.page,limitedUser.email),'Новая ссылка').click();
    await button(admin.page,'Создать новую ссылку').click(); await readLink(admin.page);
    assert.equal((await db.doc(`invitations/${limitedLink.inviteId}`).get()).data().resendCount,count);
  }
  await db.doc(`invitations/${limitedLink.inviteId}`).update({lastSentAt:Timestamp.fromMillis(Date.now()-120000)});
  await refresh(admin.page);
  assert.equal(await button(row(admin.page,limitedUser.email),'Новая ссылка').isDisabled(),true);
  await row(admin.page,limitedUser.email).getByText('Лимит исчерпан',{exact:false}).waitFor();
  pass();

  begin('wrong-account-denial-without-partial-access');
  const intended=await createUser('intended'), wrong=await createUser('wrong');
  const mismatchLink=await createInvitation(admin.page,intended.email);
  const mismatch=await openInvite(mismatchLink); await signIn(mismatch.page,wrong);
  const untouched=await mutationSnapshot(mismatchLink.inviteId,intended.uid);
  await button(mismatch.page,'Принять приглашение').click(); await mismatch.page.getByRole('alert').waitFor();
  assert.deepEqual(await mutationSnapshot(mismatchLink.inviteId,intended.uid),untouched);
  assert.equal((await memberRef(wrong.uid).get()).exists,false); await noFinancial(mismatch);
  pass();

  begin('duplicate-click-lost-success-response-idempotent-retry');
  const replayUser=await createUser('replay'), replayLink=await createInvitation(admin.page,replayUser.email);
  const replay=await openInvite(replayLink); await signIn(replay.page,replayUser);
  let committedResponse=false, acceptRequests=0;
  await replay.context.route(acceptEndpoint,async route => {
    if (route.request().method()!=='POST') return route.continue();
    acceptRequests++;
    if (acceptRequests===1) {
      const response=await route.fetch({maxRedirects:0}); assert.equal(response.status(),200);
      committedResponse=true; await route.abort('failed'); return;
    }
    return route.continue();
  });
  await button(replay.page,'Принять приглашение').evaluate(b => {b.click();b.click();});
  await replay.page.getByRole('alert').waitFor(); assert.equal(committedResponse,true); assert.equal(acceptRequests,1);
  assert.equal((await memberRef(replayUser.uid).get()).data().role,'viewer'); await noFinancial(replay);
  const committed=await mutationSnapshot(replayLink.inviteId,replayUser.uid);
  await accepted(replay,replayUser,'viewer'); assert.equal(acceptRequests,2);
  assert.deepEqual(await mutationSnapshot(replayLink.inviteId,replayUser.uid),committed);
  pass();

  begin('offline-accept-failure-and-recovery');
  const offlineUser=await createUser('offline'), offlineLink=await createInvitation(admin.page,offlineUser.email);
  const offline=await openInvite(offlineLink); await signIn(offline.page,offlineUser);
  await offline.context.setOffline(true); await button(offline.page,'Принять приглашение').click();
  await offline.page.getByRole('alert').waitFor({timeout:80000});
  assert.equal((await memberRef(offlineUser.uid).get()).exists,false); await noFinancial(offline);
  await offline.context.setOffline(false); await accepted(offline,offlineUser,'viewer'); pass();

  begin('two-independent-clients-race-same-uid');
  const racer=await createUser('race'), raceLink=await createInvitation(admin.page,racer.email,'accountant');
  const first=await openInvite(raceLink), second=await openInvite(raceLink);
  await signIn(first.page,racer); await signIn(second.page,racer);
  // Both real HTTP requests are held before dispatch, then released together.
  let arrivals=0, release, gateTimedOut=false;
  const gate=new Promise(resolve => {release=resolve;});
  const gateTimeout=setTimeout(()=>{gateTimedOut=true;release();},15000);
  const hold=async route => {if(route.request().method()!=='POST')return route.continue(); arrivals++;if(arrivals===2)release();await gate;return route.continue();};
  await first.context.route(acceptEndpoint,hold); await second.context.route(acceptEndpoint,hold);
  try {await Promise.all([accepted(first,racer,'accountant'),accepted(second,racer,'accountant')]);}
  finally {clearTimeout(gateTimeout);release();}
  assert.equal(arrivals,2); assert.equal(gateTimedOut,false,'Both clients must reach the barrier before release');
  const membershipDocs=await db.collection(`companies/${companyA}/members`).where('uid','==',racer.uid).get(); assert.equal(membershipDocs.size,1);
  assert.equal((await db.doc(`invitations/${raceLink.inviteId}`).get()).data().acceptedByUid,racer.uid);
  pass();

  begin('cross-company-admin-role-does-not-leak');
  const cross=await createUser('cross'); await membership(companyB,cross,'admin'); await profile(cross,companyB,'admin');
  const crossLink=await createInvitation(admin.page,cross.email,'viewer');
  const crossClient=await openInvite(crossLink); await signIn(crossClient.page,cross); await accepted(crossClient,cross,'viewer');
  await crossClient.page.goto(`${base}#/users`);
  await crossClient.page.getByText('Управление пользователями доступно администратору активной компании после загрузки прав.',{exact:true}).waitFor();
  assert.equal(await button(crossClient.page,'Пригласить по email').count(),0);
  // Exercise the real production company selector for A-admin / B-viewer.
  await button(admin.page,'Stage 8 Alpha').click();
  await admin.page.getByRole('button',{name:/Stage 8 Beta/}).click();
  await admin.page.getByText('Управление пользователями доступно администратору активной компании после загрузки прав.',{exact:true}).waitFor();
  assert.equal(await button(admin.page,'Пригласить по email').count(),0);
  pass();

  begin('isolation-and-artifact-evidence');
  // Existing dashboard code asks for rates after financial access; no provider request is sent.
  assert([...blockedOrigins].every(value=>value==='https://api.exchangerate-api.com'));
  assert.equal(capabilityUrlAttempts,0); assert.equal(pageErrors,0);
  assert(contexts.length>=10);
  for (const client of [guest,existingClient,replay,offline,first,second,crossClient]) await noStoredToken(client.page);
  assert(admin.calls.includes('inviteMember') && admin.calls.includes('resendInvite') && admin.calls.includes('cancelInvite') && admin.calls.includes('listInvitations'));
  pass();
  fs.writeFileSync(path.join(artifacts,'rehearsal.json'),JSON.stringify({status:'PASS',project:'demo-finapp',build:'production static dist',checks,artifactHashes,
    contexts:contexts.length,externalAttempts,blockedOriginKinds:[...blockedOrigins].map(value=>value==='https://api.exchangerate-api.com'?'legacy-exchange-rate':'unexpected-origin'),capabilityUrlAttempts,pageErrors,liveActions:0,realEmailDeliveryVerified:false},null,2)+'\n');
  const failedEvidence=path.join(artifacts,'failure.json');
  if(fs.existsSync(failedEvidence)) fs.unlinkSync(failedEvidence);
  say('PASS integrated rehearsal; real email delivery remains external');
})().catch(error => {
  // Safe step/line evidence only. Never print a Playwright error containing link values.
  const lines=String(error?.stack||'').split('\n').filter(line=>/^\s+at .*stage8-rehearsal\.cjs:\d+:\d+/.test(line));
  console.error(`Stage8 FAIL ${step}\n${lines.join('\n')}`);
  fs.mkdirSync(artifacts,{recursive:true});
  fs.writeFileSync(path.join(artifacts,'failure.json'),JSON.stringify({status:'FAIL',step,completed:checks,externalAttempts,blockedOriginKinds:[...blockedOrigins].map(value=>value==='https://api.exchangerate-api.com'?'legacy-exchange-rate':'unexpected-origin'),capabilityUrlAttempts,pageErrors,pageErrorKinds:[...pageErrorKinds]},null,2)+'\n');
  process.exitCode=1;
}).finally(async () => {
  for(const context of contexts) await context.close();
  if(browser) await browser.close();
  if(server?.listening) await new Promise(resolve=>server.close(resolve));
  await db.terminate(); await deleteApp(adminApp);
});
