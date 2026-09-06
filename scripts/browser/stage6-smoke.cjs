// Local acceptance helper, synthetic demo-finapp only. Never logs tokens.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const artifacts = path.resolve(process.env.FINAPP_BROWSER_ARTIFACTS || 'docs/remediation/evidence/SEC-006-stage6');
fs.mkdirSync(artifacts, {recursive:true});
const rootRequire = createRequire(path.resolve(__dirname, '../../package.json'));
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
const { initializeApp } = rootRequire('firebase-admin/app');
const { getAuth } = rootRequire('firebase-admin/auth');
const { getFirestore, Timestamp } = rootRequire('firebase-admin/firestore');
const browserRequire = process.env.FINAPP_BROWSER_TOOLS ? createRequire(path.resolve(process.env.FINAPP_BROWSER_TOOLS, 'package.json')) : rootRequire;
const { chromium } = browserRequire('playwright');
initializeApp({ projectId: 'demo-finapp' });
const db = getFirestore(); const auth = getAuth();
const origin = 'http://127.0.0.1:5176';
const suffix = Date.now();
const companyA = `stage6-a-${suffix}`, companyB = `stage6-b-${suffix}`;
const pw = 'Synthetic-test-password-6';
const now = Timestamp.now();
async function seedUser(role) {
  const email = `stage6-${role}-${suffix}@example.test`;
  const user = await auth.createUser({ email, password: pw, emailVerified: true });
  await db.doc(`users/${user.uid}`).set({ id: user.uid, name: `Test ${role}`, email,
    companyId: companyA, role, createdAt: new Date().toISOString(),
    companies: [{companyId: companyB, role}] });
  for (const id of [companyA, companyB]) await db.doc(`companies/${id}/members/${user.uid}`).set({
    uid: user.uid, role, status:'active', createdAt:now, updatedAt:now });
  return { ...user, email };
}
(async () => {
  const users = {};
  for (const role of ['admin','viewer','accountant']) users[role] = await seedUser(role);
  for (const id of [companyA,companyB]) {
    await db.doc(`companies/${id}`).set({id, name:id===companyA?'Stage 6 Alpha':'Stage 6 Beta', legalType:'ooo', currency:'RUB', createdAt:new Date().toISOString(), ownerId:users.admin.uid});
    await db.doc(`company_data/${id}`).set({accounts:[],categories:[],counterparties:[],transactions:[],projects:[],rules:[],budgets:[],recurring:[],paymentCalendar:[],auditLog:[]});
  }
  const browser = await chromium.launch({headless:true});
  const contexts=[]; let externalAttempts=0;
  async function login(role) {
    const context=await browser.newContext({ viewport:{width:1280,height:900}, permissions:['clipboard-read','clipboard-write'] }); contexts.push(context);
    await context.route('**/*', route => {
      const url=new URL(route.request().url());
      if (!['127.0.0.1','localhost'].includes(url.hostname)) {externalAttempts++; return route.abort();}
      assert(!url.search.includes('token='));
      return route.continue();
    });
    const page=await context.newPage();
    await page.goto(`${origin}/finapp/#/login`);
    await page.locator('input[type=email]').fill(users[role].email);
    await page.locator('input[type=password]').fill(pw);
    await page.getByRole('button',{name:'Войти',exact:true}).click();
    await page.waitForURL('**/finapp/#/');
    await page.goto(`${origin}/finapp/#/users`);
    return {page,context};
  }
  try {
    const {page,context}=await login('admin');
    const invite=page.getByRole('button',{name:'Пригласить по email',exact:true});
    await invite.waitFor(); await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(b=>b.textContent==='Пригласить по email')?.disabled);
    const before=(await auth.listUsers()).users.length;
    await invite.click(); assert.equal(await page.locator('[role=dialog] input[type=password]').count(),0);
    await page.getByLabel('Email',{exact:true}).fill(`guest-${suffix}@example.test`);
    await page.getByRole('combobox').selectOption('viewer');
    await page.getByRole('button',{name:'Создать приглашение',exact:true}).click();
    const input=page.getByLabel('Ссылка',{exact:true}); await input.waitFor();
    const link=await input.inputValue(); const parsed=new URL(link);
    assert.match(parsed.pathname,/^\/finapp\/accept-invite\//); assert.equal(parsed.search,''); assert.match(parsed.hash,/^#token=[\w-]{43}$/);
    assert.equal((await auth.listUsers()).users.length,before);
    await page.getByRole('button',{name:'Копировать ссылку',exact:true}).click();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),link);
    const raw=parsed.hash.slice(7);
    assert.equal(await page.evaluate(t=>JSON.stringify({...localStorage,...sessionStorage}).includes(t),raw),false);
    await page.getByRole('button',{name:'Закрыть',exact:true}).click();
    assert.equal(await page.getByLabel('Ссылка',{exact:true}).count(),0);
    const inviteId=parsed.pathname.split('/').pop();
    const original=(await db.doc(`invitations/${inviteId}`).get()).data();
    assert.equal(original.token,undefined); assert.equal(original.rawToken,undefined);
    // Advance this synthetic fixture past cooldown; no wall-clock sleep needed.
    const past=Timestamp.fromMillis(Date.now()-120000);
    await db.doc(`invitations/${inviteId}`).update({createdAt:past,lastSentAt:past});
    await page.getByRole('button',{name:'Обновить список',exact:true}).click();
    await page.getByRole('button',{name:'Новая ссылка',exact:true}).click();
    await page.getByRole('button',{name:'Создать новую ссылку',exact:true}).click();
    await input.waitFor(); assert.notEqual(await input.inputValue(),link);
    const rotated=(await db.doc(`invitations/${inviteId}`).get()).data();
    assert.equal(rotated.resendCount,1); assert.notEqual(rotated.tokenHash,original.tokenHash);
    // Real store change while transient link is open, before company I/O finishes.
    await page.evaluate(async id=>{ const {authStore}=await import('/finapp/src/store/authStore.ts'); await authStore.switchCompany(id); },companyB);
    await page.getByText('Приглашений пока нет.',{exact:true}).waitFor();
    assert.equal(await input.count(),0); assert.equal(await page.getByText(`guest-${suffix}@example.test`,{exact:false}).count(),0);
    await page.evaluate(async id=>{ const {authStore}=await import('/finapp/src/store/authStore.ts'); await authStore.switchCompany(id); },companyA);
    await page.getByRole('button',{name:'Отменить приглашение',exact:true}).click();
    assert.equal((await db.doc(`invitations/${inviteId}`).get()).data().status,'pending');
    await page.getByRole('button',{name:'Подтвердить отмену',exact:true}).click();
    await page.getByText('Отменено · Срок:',{exact:false}).waitFor();
    assert.equal((await db.doc(`invitations/${inviteId}`).get()).data().status,'revoked');
    await page.screenshot({path:path.join(artifacts,'desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.waitForFunction(()=>document.querySelector('aside').getBoundingClientRect().right <= 0);
    await page.screenshot({path:path.join(artifacts,'mobile.png'),fullPage:true,animations:'disabled'});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await invite.click();
    await page.getByRole('dialog').screenshot({path:path.join(artifacts,'mobile-create.png'),animations:'disabled'});
    await page.keyboard.press('Escape');
    await context.setOffline(true); await page.getByRole('button',{name:'Обновить список',exact:true}).click();
    await page.getByRole('alert').waitFor({timeout:80000}); assert.equal(await invite.isDisabled(),true);
    await context.setOffline(false); await page.getByRole('button',{name:'Обновить список',exact:true}).click();
    await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(b=>b.textContent==='Пригласить по email')?.disabled);
    const second=await context.newPage(); await second.goto(`${origin}/finapp/#/users`); await second.getByRole('button',{name:'Пригласить по email',exact:true}).waitFor();
    await page.evaluate(async()=>{const {authStore}=await import('/finapp/src/store/authStore.ts');await authStore.logout();});
    await second.waitForURL('**/login');
    for (const role of ['viewer','accountant']) {const limited=await login(role); await limited.page.getByText('Управление пользователями доступно администратору активной компании после загрузки прав.',{exact:true}).waitFor(); assert.equal(await limited.page.getByRole('button',{name:'Пригласить по email',exact:true}).count(),0);}
    console.log(JSON.stringify({result:'PASS',checks:['real create/list/resend/cancel callables','no admin-created Auth user','fragment URL and clipboard','no token storage','company switch clears link/data','mobile width','offline refresh denial/recovery','two-tab logout','viewer/accountant deny'],externalRequestsBlocked:externalAttempts}));
  } finally {for(const context of contexts)await context.close();await browser.close();await db.terminate();}
})().catch(error=>{console.error('Browser acceptance failed:',error.name,error.message.replace(/#token=[\w-]+/g,'#token=[redacted]'));process.exitCode=1;});
