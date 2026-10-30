// Opt-in Postman fixture: register one Customer and create five real, then cancelled Bookings.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {existsSync,readFileSync,renameSync,writeFileSync} from 'node:fs';

const base='http://127.0.0.1:33201';
const file=new URL('../.secrets/customer-dev/grading_customer_l.json',import.meta.url);
const password=readFileSync(new URL('../.secrets/customer-dev/grading_customer_l_password',
  import.meta.url),'utf8').trim();
const state=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{bookingIds:[]};
const email=process.argv[2]??state.email;
if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email??'')||
    state.email&&state.email!==email||password.length<8)
  throw new Error('Invalid or mismatched local Customer fixture');
state.email=email;
const save=()=>{
  const pending=new URL('../.secrets/customer-dev/grading_customer_l.json.pending',import.meta.url);
  writeFileSync(pending,JSON.stringify(state),{mode:0o600});renameSync(pending,file);
};
async function call(path,{method='GET',token,body,headers={}}={}) {
  const response=await fetch(base+path,{method,headers:{
    ...(token?{Authorization:`Bearer ${token}`}:{ }),
    ...(body?{'Content-Type':'application/json'}:{ }),...headers},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(8000)});
  return {status:response.status,body:await response.json(),headers:response.headers};
}
function expect(result,status,label) {
  assert.equal(result.status,status,`${label}: ${result.body?.errorCode??result.status}`);
  return result.body;
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function login() {
  return call('/v1/auth/login',{method:'POST',body:{emailOrPhone:email,password}});
}
let auth=await login();
if(auth.status===401&&auth.body.errorCode==='INVALID_CREDENTIALS') {
  if(state.accountId) throw new Error('Existing Customer fixture credential no longer matches');
  state.phone='09'+String(randomBytes(4).readUInt32BE()%100000000).padStart(8,'0');
  const result=await call('/v1/auth/register',{method:'POST',body:{
    fullName:'Dai Long',email,phone:state.phone,password}});
  let created;
  if(result.status===201) created=result.body;
  else if(result.status===202) {
    const recovery=result.headers.get('Registration-Recovery-Token');
    assert.ok(recovery&&result.body.operationId,'Missing registration recovery');
    for(let i=0;i<30;i++) {
      await pause(500);
      const found=await call(`/v1/auth/customer-registrations/${result.body.operationId}`,{
        headers:{'Registration-Recovery-Token':recovery}});
      if(found.status===200&&found.body.status==='SUCCEEDED') {
        created=found.body.result;break;
      }
      if(found.status===200&&found.body.status==='FAILED')
        throw new Error('Customer registration failed');
    }
  } else throw new Error(`Customer registration rejected: ${result.body.errorCode??result.status}`);
  assert.equal(created?.role,'CUSTOMER','Customer registration did not finish');
  state.accountId=created.accountId;state.customerId=created.customerId;save();
  auth=await login();
}
const principal=expect(auth,200,'Customer login');
assert.equal(principal.account.role,'CUSTOMER');
assert.equal(principal.account.email,email);
if(state.accountId&&state.accountId!==principal.account.accountId)
  throw new Error('Fixture Account changed');
state.accountId=principal.account.accountId;
state.customerId=principal.account.customerId;
save();
const token=principal.accessToken;

async function list() {
  return expect(await call('/v1/bookings?limit=100',{token}),200,'list own Booking').items;
}
let existing=await list();
while(existing.length<5) {
  const createdResult=await call('/v1/bookings',{method:'POST',token,body:{
    pickup:{latitude:10.7769,longitude:106.7009,address:'Điểm đón demo CAB'},
    destination:{latitude:10.7869,longitude:106.7109,address:'Điểm đến demo CAB'},
    vehicleType:'MOTORBIKE',note:`Booking phân trang demo ${existing.length+1}`}});
  let created;
  if(createdResult.status===201) created=createdResult.body;
  else if(createdResult.status===202) {
    const id=createdResult.body.operationId;
    assert.ok(id,'Missing Booking operation');
    for(let i=0;i<30;i++) {
      await pause(400);
      const found=expect(await call(`/v1/booking-operations/${id}`,{token}),
        200,'Booking operation');
      if(found.status==='SUCCEEDED') {created=found.result;break;}
      if(found.status==='FAILED') throw new Error('Booking operation failed');
    }
  } else throw new Error(`Booking create rejected: ${createdResult.body.errorCode??createdResult.status}`);
  assert.ok(created?.bookingId,'Booking did not complete');
  assert.equal(created.customerId,state.customerId);
  if(!state.bookingIds.includes(created.bookingId)) {
    state.bookingIds.push(created.bookingId);save();
  }
  let cancelled=await call(`/v1/bookings/${created.bookingId}/cancel`,{
    method:'POST',token,body:{reason:'Dữ liệu demo cho kiểm tra phân trang'}});
  if(cancelled.status===202) {
    const id=cancelled.body.operationId;
    assert.ok(id,'Missing cancellation operation');
    for(let i=0;i<30;i++) {
      await pause(400);
      const found=expect(await call(`/v1/booking-operations/${id}`,{token}),
        200,'Cancellation operation');
      if(found.status==='SUCCEEDED') {cancelled={status:200,body:found.result};break;}
      if(found.status==='FAILED') throw new Error('Booking cancellation failed');
    }
  }
  assert.equal(expect(cancelled,200,'cancel pagination Booking').bookingStatus,'CANCELLED');
  existing=await list();
  console.log(`Prepared ${existing.length}/5 Booking records for this Customer`);
}
const ids=new Set(),sizes=[];let cursor;
for(let page=0;page<20;page++) {
  const path='/v1/bookings?limit=2'+(cursor?`&cursor=${encodeURIComponent(cursor)}`:'');
  const result=expect(await call(path,{token}),200,'Booking page');
  assert.ok(result.items.length<=2);
  sizes.push(result.items.length);
  for(const item of result.items) ids.add(item.bookingId);
  if(!result.hasMore) break;
  assert.ok(result.nextCursor,'Missing nextCursor');cursor=result.nextCursor;
}
assert.ok(ids.size>=5,'Fewer than five Booking records are visible');
for(const id of ids) {
  const detail=expect(await call(`/v1/bookings/${id}`,{token}),200,'Booking detail');
  assert.equal(detail.customerId,state.customerId,'Booking belongs to another Customer');
}
console.log(`PASS Customer Booking pagination: ${ids.size} own Bookings, page sizes ${sizes.join('/')}; no active fixture Booking left by this script.`);
