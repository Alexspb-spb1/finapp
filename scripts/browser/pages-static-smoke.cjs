// Static-only post-publication check. No sign-in, live Firebase or invitation.
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const assert=require('node:assert/strict'); const {createRequire}=require('node:module');
const {chromium}=createRequire(path.resolve(process.env.FINAPP_BROWSER_TOOLS,'package.json'))('playwright');
const [artifact,source]=process.argv.slice(2);
assert(artifact && path.isAbsolute(artifact) && /^[a-f0-9]{40}$/.test(source));
const unpacked=path.join(artifact,'unpacked'), base='https://alexspb-spb1.github.io/finapp/';
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
async function verify(file,status=200,target=file){
  assert(!file.includes('..') && !path.isAbsolute(file));
  const expected=fs.readFileSync(path.join(unpacked,file));
  const response=await fetch(base+target+'?release='+source);
  assert.equal(response.status,status); const actual=Buffer.from(await response.arrayBuffer());
  assert.equal(sha(actual),sha(expected),`Static hash mismatch: ${file}`);
  return {file,sha256:sha(actual)};
}
(async()=>{
  const files=['index.html','404.html',...fs.readdirSync(path.join(unpacked,'assets')).filter(file=>/\.(js|css)$/.test(file)).map(file=>'assets/'+file)];
  const hashes=[];for(const file of files)hashes.push(await verify(file));
  await verify('404.html',404,'accept-invite/static-smoke');
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext();let blocked=0;const errors=[];
    await context.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.origin!==new URL(base).origin || !url.pathname.startsWith('/finapp/')){blocked++;return route.abort();}
      return route.continue();
    });
    const page=await context.newPage();page.on('pageerror',()=>errors.push('runtime-error'));
    await page.goto(base+'#/login');await page.getByRole('heading',{name:'Вход в систему',exact:true}).waitFor();
    assert.equal(await page.locator('input[type=email]').count(),1);
    await page.screenshot({path:path.join(artifact,'public-login.png')});
    await page.goto(base+'accept-invite/static-smoke');
    await page.getByRole('heading',{name:'Приглашение в компанию',exact:true}).waitFor();
    await page.getByText('Откройте исходную ссылку',{exact:false}).waitFor();
    assert.equal(errors.length,0);
    await page.screenshot({path:path.join(artifact,'public-invite-missing-token.png')});
    const result={status:'PASS',source,hashes,blockedNonStaticRequests:blocked,authActions:0,dataActions:0};
    fs.writeFileSync(path.join(artifact,'public-smoke.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }finally{await browser.close();}
})().catch(()=>{console.error('Static publication smoke failed; no configuration or payload logged.');process.exitCode=1;});
