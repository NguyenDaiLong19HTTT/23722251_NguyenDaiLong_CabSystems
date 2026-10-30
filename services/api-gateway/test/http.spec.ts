import { expect, it, vi } from 'vitest';
import request from 'supertest';
import { createHttpApplication } from '../src/interfaces/bootstrap.js';
import { GatewayConfig } from '../src/infrastructure/runtime-config.js';
import { GatewayRuntime } from '../src/infrastructure/runtime.js';
import { GatewayGrpcClients } from '../src/infrastructure/grpc-clients.js';
import { TripController } from '../src/interfaces/trip-controller.js';

it('initializes a real HTTP adapter with DI and rejects invalid requests before gRPC', async () => {
  const app = await createHttpApplication();
  try {
    await app.init();
    expect(app.get(GatewayRuntime).config).toBe(app.get(GatewayConfig));
    // Supertest owns the ephemeral HTTP listener; invalid requests never open gRPC/DB.
    const server = app.getHttpServer();
    expect((await request(server).get('/health').expect(200)).body).toEqual({status:'UP'});
    await request(server).post('/v1/auth/register').send({role:'CUSTOMER'}).expect(400);
    await request(server).get('/v1/auth/customer-registrations/example').expect(401);
    await request(server).post('/v1/auth/login').send({emailOrPhone:''}).expect(400);
    for (const phone of ['900000101','090000010','09000001011','09000a0101','1900000101','+84900000101']) {
      await request(server).post('/v1/auth/register').send({fullName:'Phone Test',
        email:'phone@example.test',phone,password:'test-only-password'}).expect(400);
      await request(server).post('/v1/auth/driver-registration/otp').send({phone}).expect(400);
      await request(server).post('/v1/auth/login').send({emailOrPhone:phone,password:'test-only-password'}).expect(400);
    }
    await request(server).get('/v1/accounts/me').expect(401);
    await request(server).get('/v1/customers/example').expect(401);
  } finally {
    await app.close();
  }
});

it('limits Booking creation before calling its service and ignores claimed proxy identity', async () => {
  const app=await createHttpApplication();
  try {
    await app.init();
    const connect=vi.spyOn(app.get(GatewayGrpcClients),'connect');
    const server=app.getHttpServer();
    for(let i=0;i<30;i++)
      await request(server).post('/v1/bookings').set('X-Forwarded-For',`198.51.100.${i+1}`)
        .send({}).expect(400);
    const blocked=await request(server).post('/v1/bookings')
      .set('X-Forwarded-For','203.0.113.10')
      .set('Authorization','Bearer test-only-token')
      .send({pickup:{address:'A',latitude:10,longitude:106},
        destination:{address:'B',latitude:10,longitude:106},vehicleType:'MOTORBIKE'})
      .expect(429);
    expect(blocked.body.errorCode).toBe('RATE_LIMIT_EXCEEDED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(connect).not.toHaveBeenCalled();
  } finally {await app.close();}
});

it('accepts two-coordinate GPS only with the explicit development demo flag', async () => {
  const priorNodeEnv=process.env.NODE_ENV;
  const priorFlag=process.env.CAB_DEMO_GPS_SERVER_TIME_ENABLED;
  const body={latitude:10.777,longitude:106.701};
  const app=await createHttpApplication();
  try {
    await app.init();
    const server=app.getHttpServer();
    process.env.NODE_ENV='development';
    delete process.env.CAB_DEMO_GPS_SERVER_TIME_ENABLED;
    expect((await request(server).put('/v1/drivers/me/location')
      .set('Authorization','Bearer test-only-token').send(body).expect(400)).body.errorCode)
      .toBe('VALIDATION_ERROR');
    process.env.CAB_DEMO_GPS_SERVER_TIME_ENABLED='1';
    // No Driver target is configured in this test: 503 proves the request passed HTTP validation.
    expect((await request(server).put('/v1/drivers/me/location')
      .set('Authorization','Bearer test-only-token').send(body).expect(503)).body.errorCode)
      .toBe('SERVICE_UNAVAILABLE');
    process.env.NODE_ENV='production';
    expect((await request(server).put('/v1/drivers/me/location')
      .set('Authorization','Bearer test-only-token').send(body).expect(400)).body.errorCode)
      .toBe('VALIDATION_ERROR');
  } finally {
    if (priorNodeEnv===undefined) delete process.env.NODE_ENV;else process.env.NODE_ENV=priorNodeEnv;
    if (priorFlag===undefined) delete process.env.CAB_DEMO_GPS_SERVER_TIME_ENABLED;
    else process.env.CAB_DEMO_GPS_SERVER_TIME_ENABLED=priorFlag;
    await app.close();
  }
});

it('maps Customer reason-only Trip cancellation to a versioned, coded RPC', async () => {
  const app=await createHttpApplication();
  const tripId='11111111-1111-4111-8111-111111111111';
  const stamp={seconds:'1790000000',nanos:0};
  const reason='Khách thay đổi kế hoạch — demo chấm';
  const rpc=vi.spyOn(app.get(TripController) as any,'call').mockImplementation(
    async (...args:unknown[])=>{
      const method=args[0] as string,body=args[1] as Record<string,unknown>;
      if(method==='GetTrip') return {trip_id:tripId,version:'2'};
      if(method==='CancelTrip') return {trip_id:tripId,
        booking_id:'22222222-2222-4222-8222-222222222222',
        customer_id:'33333333-3333-4333-8333-333333333333',
        driver_id:'44444444-4444-4444-8444-444444444444',
        vehicle_id:'55555555-5555-4555-8555-555555555555',
        vehicle_type:'MOTORBIKE',trip_status:'CANCELLED',version:'3',
        pickup:{address:'A',point:{latitude:10.7769,longitude:106.7009}},
        destination:{address:'B',point:{latitude:10.7869,longitude:106.7109}},
        created_at:stamp,updated_at:stamp,closed_at:stamp,status_history:[],
        cancellation:{reason_code:body.reason_code,reason:body.reason,
          cancelled_by:'33333333-3333-4333-8333-333333333333',cancelled_at:stamp}};
      throw new Error('Unexpected RPC');
    });
  try {
    await app.init();
    const server=app.getHttpServer();
    const result=await request(server).post(`/v1/trips/${tripId}/cancel`)
      .set('Authorization','Bearer test-only-token').send({reason}).expect(200);
    expect(result.body.cancellation).toMatchObject({reasonCode:'CHANGE_OF_PLANS',reason});
    expect(rpc.mock.calls.map(call=>call[0])).toEqual(['GetTrip','CancelTrip']);
    expect(rpc.mock.calls[1]?.[1]).toMatchObject({trip_id:tripId,
      expected_version:'2',reason_code:'CHANGE_OF_PLANS',reason});
    rpc.mockClear();
    await request(server).post(`/v1/trips/${tripId}/cancel`)
      .set('Authorization','Bearer test-only-token').send({reason,unexpected:true}).expect(400);
    expect(rpc).not.toHaveBeenCalled();
    rpc.mockClear();
    await request(server).post(`/v1/trips/${tripId}/cancel`)
      .set('Authorization','Bearer test-only-token')
      .send({expectedVersion:2,reasonCode:'CHANGE_OF_PLANS',reason}).expect(200);
    expect(rpc.mock.calls.map(call=>call[0])).toEqual(['CancelTrip']);
  } finally {rpc.mockRestore();await app.close();}
});
