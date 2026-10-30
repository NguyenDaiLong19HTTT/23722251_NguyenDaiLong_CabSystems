// Read-only HTTP check against the running Compose demo; no credential is needed.
import assert from 'node:assert/strict';

const base='http://127.0.0.1:33201';
const call=async(path)=>{
  const response=await fetch(base+path,{signal:AbortSignal.timeout(5000)});
  return {status:response.status,body:await response.json()};
};
assert.deepEqual(await call('/health'),{status:200,body:{status:'UP'}});
const readiness=await call('/ready');
const details=await call('/health/services');
if(readiness.status!==200||details.status!==200)
  console.error('CAB readiness components:',details.body.services?.filter(item=>item.status!=='UP')
    .map(item=>({name:item.name,status:item.status,reasonCode:item.reasonCode})));
assert.deepEqual(readiness,{status:200,body:{status:'READY'}});
assert.equal(details.status,200);
assert.equal(details.body.status,'UP');
assert.equal(details.body.services.length,12);
assert.ok(details.body.services.every(item=>item.status==='UP'));
assert.ok(details.body.services.some(item=>item.name==='mongo'));
assert.ok(details.body.services.every(item=>!JSON.stringify(item).includes('password')));
console.info('PASS Health HTTP: liveness 200, readiness 200, anonymous details 200/12 UP including MongoDB');
