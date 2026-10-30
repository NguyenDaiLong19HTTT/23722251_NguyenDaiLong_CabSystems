import assert from 'node:assert/strict';
import request from 'supertest';
import {createHttpApplication} from '../services/api-gateway/dist/interfaces/bootstrap.js';
import {GatewayGrpcClients} from '../services/api-gateway/dist/infrastructure/grpc-clients.js';

const app=await createHttpApplication();
try {
  await app.init();
  const clients=app.get(GatewayGrpcClients);
  let downstream=0;
  clients.connect=()=>{downstream++;throw new Error('unexpected downstream call');};
  for(let i=0;i<30;i++) {
    const response=await request(app.getHttpServer()).post('/v1/bookings')
      .set('X-Forwarded-For',`198.51.100.${i+1}`).send({});
    assert.equal(response.status,400);
  }
  const blocked=await request(app.getHttpServer()).post('/v1/bookings')
    .set('X-Forwarded-For','203.0.113.10')
    .set('Authorization','Bearer test-only-token')
    .send({pickup:{address:'A',latitude:10,longitude:106},
      destination:{address:'B',latitude:10,longitude:106},vehicleType:'MOTORBIKE'});
  assert.equal(blocked.status,429);
  assert.equal(blocked.body.errorCode,'RATE_LIMIT_EXCEEDED');
  assert.ok(Number(blocked.headers['retry-after'])>0);
  assert.equal(downstream,0);
  const injection=await request(app.getHttpServer()).post('/v1/auth/login')
    .send({emailOrPhone:"' OR 1=1 --",password:'irrelevant'});
  assert.equal(injection.status,400);
  assert.equal(injection.body.errorCode,'VALIDATION_ERROR');
  assert.equal(downstream,0);
  process.stdout.write('Booking rate-limit built HTTP: PASS (30 accepted to validation, 31st 429, zero downstream calls)\n');
} finally {await app.close();}
