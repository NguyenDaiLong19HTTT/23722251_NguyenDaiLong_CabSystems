// Bounded load against an ephemeral built Nest HTTP adapter, not shared Compose.
import assert from 'node:assert/strict';
import request from 'supertest';
import {createHttpApplication} from '../services/api-gateway/dist/interfaces/bootstrap.js';

const total=1200,concurrency=48,deadline=Date.now()+20_000;
const app=await createHttpApplication();
try {
  await app.init();
  const server=app.getHttpServer();
  let next=0,limited=0,validated=0;
  const began=performance.now();
  await Promise.all(Array.from({length:concurrency},async()=>{
    while(next<total) {
      if(Date.now()>deadline) throw new Error('Load probe deadline exceeded');
      const index=next++;
      const response=await request(server).post('/v1/bookings')
        .set('X-Forwarded-For',`198.51.100.${index%200+1}`).send({});
      if(response.status===429) {
        assert.equal(response.body.errorCode,'RATE_LIMIT_EXCEEDED');
        assert.ok(Number(response.headers['retry-after'])>0);
        limited++;
      } else if(response.status===400) validated++;
      else throw new Error('Unexpected HTTP status '+response.status);
    }
  }));
  const seconds=(performance.now()-began)/1000;
  assert.equal(validated,30);
  assert.equal(limited,total-30);
  console.info(JSON.stringify({total,concurrency,validated,limited,
    seconds:Number(seconds.toFixed(3)),measuredRequestsPerSecond:Number((total/seconds).toFixed(1))}));
} finally {await app.close();}
