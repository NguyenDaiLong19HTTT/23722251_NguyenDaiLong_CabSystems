import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const local=join(root,'.secrets','customer-dev');
const base=process.env.CAB_DEMO_BASE_URL??'http://127.0.0.1:33201';
const phase=process.argv[2];
if (!['approved','rejected'].includes(phase)) throw new Error('Use approved or rejected');
const fixture=JSON.parse(readFileSync(join(local,phase==='approved'
  ?'driver_registration_smoke.json':'driver_registration_reject_smoke.json'),'utf8'));
const other=JSON.parse(readFileSync(join(local,phase==='approved'
  ?'driver_registration_reject_smoke.json':'driver_registration_smoke.json'),'utf8'));
async function request(path,token,method='GET') {
  const response=await fetch(base+path,{method,headers:token?{Authorization:`Bearer ${token}`}:{}});
  return {status:response.status,body:await response.json()};
}
async function login(person) {
  const response=await fetch(base+'/v1/auth/login',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({
      emailOrPhone:person.email,password:person.password})});
  assert.equal(response.status,200,'Driver login');
  return (await response.json()).accessToken;
}
const token=await login(fixture),otherToken=await login(other);
assert.equal((await request('/v1/notifications')).status,401,'missing bearer');
assert.equal((await request('/v1/notifications','invalid')).status,401,'bad bearer');
let match;
for (let i=0;i<30;i++) {
  const result=await request('/v1/notifications?limit=100',token);
  assert.equal(result.status,200,'own list');
  match=result.body.items.find(item=>item.referenceId===fixture.applicationId&&
    item.eventType===`DRIVER_APPLICATION_${phase==='approved'?'APPROVED':'REJECTED'}`);
  if (match) break;
  await new Promise(resolve=>setTimeout(resolve,500));
}
assert.ok(match,'review event delivered to own inbox');
assert.equal(match.recipientAccountId,fixture.accountId);
assert.equal(match.isRead,false);
if (phase==='rejected') assert.ok(match.message.includes('Demo: supplied details need correction'));
const own=await request('/v1/notifications/'+match.notificationId+'/read',token,'PATCH');
assert.equal(own.status,200,'mark own read');
assert.equal(own.body.isRead,true);
assert.ok(own.body.readAt);
const again=await request('/v1/notifications/'+match.notificationId+'/read',token,'PATCH');
assert.equal(again.status,200,'repeat read');
assert.equal(again.body.readAt,own.body.readAt,'first read timestamp stable');
const denied=await request('/v1/notifications/'+match.notificationId+'/read',otherToken,'PATCH');
assert.equal(denied.status,404,'other recipient denied');
const otherList=await request('/v1/notifications?limit=100',otherToken);
assert.equal(otherList.status,200);
assert.ok(!otherList.body.items.some(item=>item.notificationId===match.notificationId),
  'other recipient cannot list this notice');
const bodyRejected=await fetch(base+'/v1/notifications/'+match.notificationId+'/read',{
  method:'PATCH',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
  body:'{}'});
assert.equal(bodyRejected.status,400,'PATCH body forbidden');
const page1=await request('/v1/notifications?limit=1',token);
assert.equal(page1.status,200);assert.equal(page1.body.items.length,1);
assert.ok(page1.body.nextCursor,'notification pagination cursor');
const page2=await request('/v1/notifications?limit=1&cursor='+
  encodeURIComponent(page1.body.nextCursor),token);
assert.equal(page2.status,200);assert.equal(page2.body.items.length,1);
assert.notEqual(page1.body.items[0].notificationId,page2.body.items[0].notificationId);
const badCursor=await request('/v1/notifications?limit=1&cursor='+
  encodeURIComponent(page1.body.nextCursor+'x'),token);
assert.equal(badCursor.status,400,'tampered cursor denied');
const filtered=await request('/v1/notifications?isRead=true',token);
assert.equal(filtered.status,200);assert.ok(filtered.body.items.some(x=>x.notificationId===match.notificationId));
console.info(`PASS Notification ${phase}: broker delivery, own inbox, auth, read replay, cross-owner denial, pagination`);
