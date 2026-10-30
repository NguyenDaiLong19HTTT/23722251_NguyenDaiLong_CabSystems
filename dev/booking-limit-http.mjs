// Bounded probe of the shared demo Gateway. No Booking is created.
import assert from 'node:assert/strict';
const base='http://127.0.0.1:33201';
async function call(path,method='GET',body,forwarded='203.0.113.5') {
  const response=await fetch(base+path,{method,headers:{
    'X-Forwarded-For':forwarded,
    ...(body?{'Content-Type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});
  return {status:response.status,retry:response.headers.get('retry-after'),
    body:await response.json()};
}
let rejected=0,limited=0;
for(let i=0;i<31;i++) {
  const result=await call('/v1/bookings','POST',{},`198.51.100.${i+1}`);
  if(result.status===400) rejected++;
  else if(result.status===429) {
    assert.equal(result.body.errorCode,'RATE_LIMIT_EXCEEDED');
    assert.ok(Number(result.retry)>0);
    limited++;
  } else throw new Error('Unexpected Booking status '+result.status);
}
assert.equal(rejected+limited,31);
assert.ok(limited>=1);
const valid=await call('/v1/bookings','POST',{
  pickup:{address:'Demo pickup',latitude:10.7769,longitude:106.7009},
  destination:{address:'Demo destination',latitude:10.7869,longitude:106.7109},
  vehicleType:'MOTORBIKE'
});
assert.equal(valid.status,429);
assert.equal(valid.body.errorCode,'RATE_LIMIT_EXCEEDED');
const available=await call('/v1/bookings');
assert.equal(available.status,401,'independent read route remains available');
console.info(JSON.stringify({rejected,limited,blockedValid:valid.status,
  independentRead:available.status,retryAfter:Number(valid.retry)}));
