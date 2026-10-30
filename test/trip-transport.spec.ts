import {afterAll,beforeAll,expect,it} from 'vitest';
import * as grpc from '@grpc/grpc-js';
import {bindServer,closeServer,createClient,createServer,serviceDefinition,unaryCall}
  from '@cab/grpc-transport';
import {createTestPki} from './certificates.js';
import {OwnerClients} from '../services/trip-service/src/infrastructure/owner-clients.js';
import type {TestPki} from './certificates.js';

const tripDef=serviceDefinition('cab.internal.v1.TripInternalService',
  'proto/cab/internal/v1/trip.proto');
const facadeDef=serviceDefinition('cab.gateway.v1.TripFacadeService',
  'proto/cab/gateway/v1/trip_facade.proto');
const paymentDef=serviceDefinition('cab.internal.v1.PaymentInternalService',
  'proto/cab/internal/v1/payment.proto');
const bookingDef=serviceDefinition('cab.internal.v1.BookingInternalService',
  'proto/cab/internal/v1/booking.proto');
const customerDef=serviceDefinition('cab.internal.v1.CustomerInternalService',
  'proto/cab/internal/v1/customer.proto');
const driverDef=serviceDefinition('cab.internal.v1.DriverInternalService',
  'proto/cab/internal/v1/driver.proto');
let pki:TestPki,payment:grpc.Server,trip:grpc.Server;
let paymentAddress:string,tripAddress:string;
const clients:grpc.Client[]=[];
const hits=new Map<string,number>();
const handlers=(definition:grpc.ServiceDefinition)=>Object.fromEntries(
  Object.entries(definition).map(([method,descriptor])=>[method,
    (_call:grpc.ServerUnaryCall<unknown,unknown>,done:grpc.sendUnaryData<unknown>)=>{
      hits.set(descriptor.path,(hits.get(descriptor.path)??0)+1);
      done({code:grpc.status.UNIMPLEMENTED,details:'Test-only handler reached'});
    }]));
const invoke=async(client:grpc.Client,definition:grpc.ServiceDefinition,method:string,body={})=>{
  try {await unaryCall(client,definition,method,body,new grpc.Metadata(),1200);
    throw new Error('Unexpected business success');}
  catch(error) {return (error as grpc.ServiceError).code;}
};
beforeAll(async()=>{
  pki=createTestPki();
  payment=createServer('payment-service',pki.material('payment'));
  payment.addService(paymentDef,handlers(paymentDef));
  paymentAddress='localhost:'+await bindServer(payment,'127.0.0.1:0',pki.material('payment'));
  trip=createServer('trip-service',pki.material('trip'));
  trip.addService(tripDef,handlers(tripDef));
  trip.addService(facadeDef,handlers(facadeDef));
  tripAddress='localhost:'+await bindServer(trip,'127.0.0.1:0',pki.material('trip'));
},30000);
afterAll(async()=>{for(const client of clients) client.close();
  if(payment) await closeServer(payment);if(trip) await closeServer(trip);
  pki?.cleanup();});
it('Trip identity may call Payment decision; Gateway may not',async()=>{
  const path=paymentDef.GetTripPaymentDecision!.path;
  const valid=createClient(paymentAddress,pki.material('trip'),'payment-service');clients.push(valid);
  expect(await invoke(valid,paymentDef,'GetTripPaymentDecision',{trip_id:'test'}))
    .toBe(grpc.status.UNIMPLEMENTED);
  expect(hits.get(path)).toBe(1);
  const invalid=createClient(paymentAddress,pki.material('gateway'),'payment-service');clients.push(invalid);
  expect(await invoke(invalid,paymentDef,'GetTripPaymentDecision',{trip_id:'test'}))
    .toBe(grpc.status.PERMISSION_DENIED);
  expect(hits.get(path)).toBe(1);
});
it('Gateway facade reads Trip; Gateway cannot call Booking preparation',async()=>{
  const gateway=createClient(tripAddress,pki.material('gateway'),'trip-service');clients.push(gateway);
  const facadePath=facadeDef.GetTrip!.path,internalPath=tripDef.PrepareTrip!.path;
  expect(await invoke(gateway,facadeDef,'GetTrip',{trip_id:'test'})).toBe(grpc.status.UNIMPLEMENTED);
  expect(hits.get(facadePath)).toBe(1);
  expect(await invoke(gateway,tripDef,'PrepareTrip',{})).toBe(grpc.status.PERMISSION_DENIED);
  expect(hits.get(internalPath)??0).toBe(0);
});
it('Trip preparation verifies Booking snapshot, Driver reservation, and Customer guard over mTLS',async()=>{
  const ids=['1e5ae501-8ab1-49f2-92bf-14ec0e393001','1e5ae501-8ab1-49f2-92bf-14ec0e393002',
    '1e5ae501-8ab1-49f2-92bf-14ec0e393003','1e5ae501-8ab1-49f2-92bf-14ec0e393004',
    '1e5ae501-8ab1-49f2-92bf-14ec0e393005','1e5ae501-8ab1-49f2-92bf-14ec0e393006',
    '1e5ae501-8ab1-49f2-92bf-14ec0e393007','1e5ae501-8ab1-49f2-92bf-14ec0e393008',
    '1e5ae501-8ab1-49f2-92bf-14ec0e393009','1e5ae501-8ab1-49f2-92bf-14ec0e39300a'];
  const [assignment,tripId,bookingId,customerId,customerAccount,driverId,driverAccount,
    vehicleId,guardId,reservationId]=ids;
  const parties={customer_id:customerId,customer_account_id:customerAccount,
    driver_id:driverId,driver_account_id:driverAccount,vehicle_id:vehicleId};
  const guard={customer_id:customerId,guard_id:guardId,generation:'1',booking_id:bookingId};
  const reservation={reservation_id:reservationId,generation:'1',assignment_id:assignment,
    booking_id:bookingId,driver_id:driverId,vehicle_id:vehicleId};
  const pickup={point:{latitude:10.77,longitude:106.7},address:'A'};
  const destination={point:{latitude:10.78,longitude:106.71},address:'B'};
  const pricing={pricing_version_id:ids[0],vehicle_type:'MOTORBIKE',
    base_fare:{value:'0'},price_per_km:{value:'5300'},price_per_minute:{value:'0'},
    currency:'VND',accepted_at:{seconds:'1791600000',nanos:0},route_id:ids[1],
    route_version:'1',distance_meters:'1250',total_amount:'6625'};
  const input={assignment_id:assignment,trip_id:tripId,booking_id:bookingId,
    parties,guard,reservation,pickup,destination,pricing};
  let phase:'PREPARING'|'ACTIVATING'='PREPARING',wrong=false;
  const start=async(owner:string,name:string,definition:grpc.ServiceDefinition,
    method:string,reply:()=>unknown)=>{
    const server=createServer(owner,pki.material(name));
    server.addService(definition,{...handlers(definition),[method]:(
      _call:grpc.ServerUnaryCall<unknown,unknown>,done:grpc.sendUnaryData<unknown>)=>done(null,reply())});
    return {server,address:'localhost:'+await bindServer(server,'127.0.0.1:0',pki.material(name))};
  };
  const booking=await start('booking-service','booking',bookingDef,'GetAssignmentDecision',()=>({
    assignment_id:assignment,booking_id:wrong?ids[9]:bookingId,trip_id:tripId,
    customer_id:customerId,driver_id:driverId,vehicle_id:vehicleId,
    state:phase,cancel_requested:false,version:'1',parties,guard,pickup,destination,pricing}));
  const driver=await start('driver-service','driver',driverDef,'GetReservation',()=>({
    reservation,state:phase==='PREPARING'?'HELD':'BOUND',
    ...(phase==='ACTIVATING'?{trip_id:tripId}:{}),version:'1'}));
  const customer=await start('customer-service','customer',customerDef,'GetGuard',()=>({
    guard,state:'TRIP_BOUND',trip_id:tripId,assignment_id:assignment,version:'1'}));
  const old=new Map<string,string|undefined>();
  const set=(key:string,value:string)=>{old.set(key,process.env[key]);process.env[key]=value;};
  set('BOOKING_SERVICE_GRPC_TARGET',booking.address);
  set('DRIVER_SERVICE_GRPC_TARGET',driver.address);
  set('CUSTOMER_SERVICE_GRPC_TARGET',customer.address);
  set('IDENTITY_SERVICE_GRPC_TARGET','localhost:1');
  set('PAYMENT_SERVICE_GRPC_TARGET','localhost:1');
  set('TRIP_SERVICE_CA_FILE',`${pki.directory}/trusted.crt`);
  set('TRIP_SERVICE_CERT_FILE',`${pki.directory}/trip.crt`);
  set('TRIP_SERVICE_KEY_FILE',`${pki.directory}/trip.key`);
  let owners:OwnerClients|undefined;
  try {owners=new OwnerClients();
    await expect(owners.verifyPreparation(input,'PREPARING')).resolves.toBeUndefined();
    phase='ACTIVATING';
    await expect(owners.verifyPreparation(input,'ACTIVATING')).resolves.toBeUndefined();
    wrong=true;
    await expect(owners.verifyPreparation(input,'ACTIVATING')).rejects.toMatchObject({
      details:'ASSIGNMENT_MISMATCH'});
  } finally {owners?.close();
    for(const [key,value] of old) if(value===undefined) delete process.env[key];
    else process.env[key]=value;
    await Promise.all([booking.server,driver.server,customer.server].map(closeServer));}
});
