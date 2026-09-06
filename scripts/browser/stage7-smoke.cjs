// Synthetic demo-finapp only. Requires local Auth/Firestore/Functions and Vite.
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const path = require('node:path'); const fs = require('node:fs');
const rootRequire = createRequire(path.resolve(__dirname,'../../package.json'));
const browserRequire = createRequire(path.resolve(process.env.FINAPP_BROWSER_TOOLS,'package.json'));
const {chromium} = browserRequire('playwright');
process.env.FIRESTORE_EMULATOR_HOST='127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9099';
const {initializeApp}=rootRequire('firebase-admin/app');
const {getAuth}=rootRequire('firebase-admin/auth');
const {getFirestore,Timestamp}=rootRequire('firebase-admin/firestore');
initializeApp({projectId:'demo-finapp'}); const auth=getAuth(); const db=getFirestore();
const fb=rootRequire('firebase/app'), fa=rootRequire('firebase/auth'), ff=rootRequire('firebase/functions');
const client=fb.initializeApp({projectId:'demo-finapp',apiKey:'emulator-only-synthetic-key'});
const clientAuth=fa.getAuth(client); fa.connectAuthEmulator(clientAuth,'http://127.0.0.1:9099',{disableWarnings:true});
const functions=ff.getFunctions(client); ff.connectFunctionsEmulator(functions,'127.0.0.1',5001);
const origin='http://127.0.0.1:5176', base=origin+'/finapp/';
const suffix=Date.now(), companyId=`stage7-${suffix}`, password='Synthetic-password-7';
const artifacts=path.resolve('docs/remediation/evidence/SEC-006-stage7'); fs.mkdirSync(artifacts,{recursive:true});
let step='setup';
(async()=>{
  const admin=await auth.createUser({email:`s7-admin-${suffix}@example.test`,emailVerified:true});
  const now=Timestamp.now();
  await db.doc(`companies/${companyId}`).set({id:companyId,name:'Stage 7 Company',legalType:'ooo',currency:'RUB',ownerId:admin.uid,createdAt:new Date().toISOString()});
  await db.doc(`companies/${companyId}/members/${admin.uid}`).set({uid:admin.uid,role:'admin',status:'active',createdAt:now,updatedAt:now});
  await db.doc(`company_data/${companyId}`).set({accounts:[],categories:[],transactions:[],counterparties:[],projects:[],rules:[]});
  await fa.signInWithCustomToken(clientAuth,await auth.createCustomToken(admin.uid));
  async function invite(email,role='viewer') {return (await ff.httpsCallable(functions,'inviteMember')({companyId,email,role})).data;}
  const guestEmail=`s7-new-${suffix}@example.test`, link=await invite(guestEmail);
  const url=link=>`${base}accept-invite/${link.inviteId}#token=${link.token}`;
  const browser=await chromium.launch({headless:true}); const contexts=[];
  async function fresh(){
    const context=await browser.newContext({viewport:{width:1280,height:900}});contexts.push(context);
    const requested=[];
    await context.route('**/*',route=>{
      const u=new URL(route.request().url());
      assert(['127.0.0.1','localhost'].includes(u.hostname),'Nonlocal request attempted');
      requested.push(u.pathname); return route.continue();
    });
    await context.addInitScript(()=>{
      const reads=[]; window.__storageReads=reads;
      const get=Storage.prototype.getItem;
      Storage.prototype.getItem=function(key){reads.push(key);return get.call(this,key);};
      localStorage.setItem('finapp_last_company_id','unrelated');
      localStorage.setItem('company_data_unrelated',JSON.stringify({accounts:[{name:'PRIVATE-OLD-CACHE'}]}));
    });
    const page=await context.newPage();
    return {context,page,requested};
  }
  const signIn=async(page,email)=>{
    await page.getByLabel('Email',{exact:true}).fill(email);
    await page.getByLabel('Пароль',{exact:true}).fill(password);
    await page.getByRole('button',{name:'Войти',exact:true}).click();
    await page.getByRole('button',{name:'Принять приглашение',exact:true}).waitFor();
  };
  try {
    step='new-user-registration';
    const {page,context,requested}=await fresh(); await page.goto(url(link));
    await page.getByText('Stage 7 Company',{exact:true}).waitFor();
    assert.equal(new URL(page.url()).hash,'');
    assert(!requested.some(p=>/authStore|companyStore|LegacyApp/.test(p)));
    assert.equal(await page.evaluate(()=>window.__storageReads.some(k=>k.startsWith('company_data_')||k==='finapp_last_company_id')),false);
    await page.screenshot({path:path.join(artifacts,'accept-desktop.png')});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:path.join(artifacts,'accept-mobile.png'),fullPage:true});
    const count=(await auth.listUsers()).users.length;
    await page.getByRole('button',{name:'Создать аккаунт',exact:true}).click();
    await page.getByLabel('Email',{exact:true}).fill(guestEmail);
    await page.getByLabel('Пароль',{exact:true}).fill(password);
    await page.getByRole('button',{name:'Зарегистрироваться',exact:true}).click();
    await page.getByRole('button',{name:'Отправить письмо подтверждения',exact:true}).waitFor();
    const guest=await auth.getUserByEmail(guestEmail);
    assert.equal((await auth.listUsers()).users.length,count+1);
    assert.equal((await db.doc(`users/${guest.uid}`).get()).exists,false);
    assert.equal((await db.doc(`companies/${companyId}/members/${guest.uid}`).get()).exists,false);
    await page.getByRole('button',{name:'Я подтвердил email',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'Email ещё не подтверждён'}).waitFor();
    assert(!requested.some(p=>/authStore|companyStore|LegacyApp/.test(p)));
    step='verification-and-accept';
    await page.getByRole('button',{name:'Отправить письмо подтверждения',exact:true}).click();
    await page.getByText('Письмо отправлено.',{exact:false}).waitFor();
    const oobs=await (await fetch('http://127.0.0.1:9099/emulator/v1/projects/demo-finapp/oobCodes')).json();
    const code=oobs.oobCodes.find(c=>c.email===guestEmail&&c.requestType==='VERIFY_EMAIL').oobCode;
    // Apply the actual Auth emulator email action code, never admin emailVerified mutation.
    const verified=await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:update?key=emulator-only-synthetic-key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({oobCode:code})});
    assert.equal(verified.status,200);
    await page.getByRole('button',{name:'Я подтвердил email',exact:true}).click();
    await page.waitForURL('**/finapp/#/');
    await page.getByText('Режим только для чтения',{exact:false}).waitFor();
    assert.equal((await db.doc(`companies/${companyId}/members/${guest.uid}`).get()).data().role,'viewer');
    assert.equal(await page.getByText('PRIVATE-OLD-CACHE',{exact:true}).count(),0);
    assert.equal(await page.evaluate(token=>JSON.stringify({...localStorage,...sessionStorage}).includes(token),link.token),false);
    const committed=await db.doc(`invitations/${link.inviteId}`).get();
    step='replay';
    await page.goto(url(link)); await page.getByRole('button',{name:'Принять приглашение',exact:true}).click();
    await page.waitForURL('**/finapp/#/');
    assert((await db.doc(`invitations/${link.inviteId}`).get()).updateTime.isEqual(committed.updateTime));
    step='disabled-after-accept';
    await db.doc(`companies/${companyId}/members/${guest.uid}`).update({status:'disabled'});
    await page.goto(url(link)); await page.getByRole('button',{name:'Принять приглашение',exact:true}).click();
    await page.getByRole('alert').waitFor(); assert(new URL(page.url()).pathname.includes('/accept-invite/'));
    assert.equal(await page.getByText('Дашборд',{exact:true}).count(),0);
    step='existing-user-mismatch-and-success';
    const existingEmail=`s7-existing-${suffix}@example.test`;
    const existing=await auth.createUser({email:existingEmail,password,emailVerified:true});
    const secondLink=await invite(existingEmail,'accountant');
    const second=await fresh(); await second.page.goto(url(secondLink));
    step='mismatch-signin'; await signIn(second.page,guestEmail);
    await second.page.getByRole('button',{name:'Принять приглашение',exact:true}).click();
    step='mismatch-denial'; await second.page.getByRole('alert').waitFor();
    assert.equal((await db.doc(`companies/${companyId}/members/${existing.uid}`).get()).exists,false);
    await second.page.getByRole('button',{name:'Выйти',exact:true}).click();
    await second.page.getByText('Откройте исходную ссылку',{exact:false}).waitFor();
    step='existing-signin'; second.page=await second.context.newPage(); await second.page.goto(url(secondLink)); await signIn(second.page,existingEmail);
    await second.page.getByRole('button',{name:'Принять приглашение',exact:true}).click();
    step='existing-access'; await second.page.waitForURL('**/finapp/#/');
    assert.equal((await db.doc(`companies/${companyId}/members/${existing.uid}`).get()).data().role,'accountant');
    step='post-accept-logout-login';
    await second.page.evaluate(()=>{window.__acceptedDocument=true;});
    await second.page.getByRole('button',{name:'Выйти',exact:true}).click();
    await second.page.getByRole('heading',{name:'Вход в систему',exact:true}).waitFor();
    assert.equal(await second.page.evaluate(()=>window.__acceptedDocument),undefined,'Logout must start a fresh document');
    await second.page.locator('input[type=email]').fill(existingEmail);
    await second.page.locator('input[type=password]').fill(password);
    await second.page.getByRole('button',{name:'Войти',exact:true}).click();
    await second.page.waitForURL('**/finapp/#/');
    step='two-tab-logout-refresh';
    const logoutPage=await context.newPage(); await logoutPage.goto(url(link));
    const tab=await context.newPage(); await tab.goto(url(link));
    await tab.getByRole('button',{name:'Выйти',exact:true}).waitFor();
    await logoutPage.getByRole('button',{name:'Выйти',exact:true}).click();
    await tab.getByText('Откройте исходную ссылку',{exact:false}).waitFor();
    await tab.reload(); await tab.getByText('Откройте исходную ссылку',{exact:false}).waitFor();
    const result={status:'PASS',checks:['no early financial modules/cache','new Auth without company/profile','unverified denied','actual emulator verification action','accepted viewer','same-UID no-write replay','disabled access denied after replay','wrong account denied','existing accountant acceptance','post-accept logout/login','two-tab logout','refresh requires original link in fresh tab','desktop/mobile'],liveActions:0};
    fs.writeFileSync(path.join(artifacts,'acceptance.json'),JSON.stringify(result,null,2)); console.log(JSON.stringify(result));
  } catch(error) {
    for(let i=0;i<contexts.length;i++) {
      const pages=contexts[i].pages();
      if(pages.length) await pages[pages.length-1].screenshot({path:path.join(artifacts,`failure-${i}.png`),fullPage:true});
    }
    console.error(String(error?.stack||'').split('\n').filter(line=>/^\s+at .*stage7-smoke\.cjs:\d+:\d+/.test(line)).join('\n'));
    throw error;
  } finally {for(const c of contexts)await c.close();await browser.close();await fb.deleteApp(client);await db.terminate();}
})().catch(()=>{console.error(`Stage7 browser acceptance failed at ${step}; no tokens logged.`);process.exitCode=1;});
