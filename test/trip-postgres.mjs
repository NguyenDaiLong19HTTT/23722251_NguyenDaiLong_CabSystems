// Disposable PostgreSQL integration harness; container and secret belong to this run only.
import assert from 'node:assert/strict';
import 'reflect-metadata';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import pg from 'pg';
import {NestFactory} from '@nestjs/core';
import * as grpc from '@grpc/grpc-js';
import {bindServer,closeServer,createServer,serviceDefinition} from '@cab/grpc-transport';
import {TripLedger} from '../services/trip-service/dist/application/trip-ledger.js';
import {TripCommands} from '../services/trip-service/dist/application/trip-commands.js';
import {TripModule} from '../services/trip-service/dist/app.module.js';
import {TripDatabase} from '../services/trip-service/dist/infrastructure/trip-database.js';
import {OwnerClients} from '../services/trip-service/dist/infrastructure/owner-clients.js';
import {PaymentLedger} from '../services/payment-service/dist/application/payment-ledger.js';
import {PricingCapture} from '../services/payment-service/dist/application/pricing-capture.js';

const temp=mkdtempSync(join(tmpdir(),'cab-trip-check-'));
const name=`cab-trip-check-${process.pid}-${randomBytes(4).toString('hex')}`;
const password=randomBytes(32).toString('base64url');
const runtimePassword=randomBytes(32).toString('base64url');
const secretFile=join(temp,'postgres-password');
writeFileSync(secretFile,password,{mode:0o600});
const docker=(args)=>{const result=spawnSync('docker',args,{encoding:'utf8',timeout:120000});
  if(result.status!==0) throw new Error(`Disposable PostgreSQL command failed: ${args[0]}`);
  return result.stdout.trim();};
const wait=async()=>{for(let i=0;i<60;i++) {
  const result=spawnSync('docker',['exec',name,'pg_isready','-U','postgres','-d','cab_trip'],
    {encoding:'utf8',timeout:5000});
  if(result.status===0) return;
  await new Promise(resolve=>setTimeout(resolve,500));
} throw new Error('Disposable PostgreSQL did not become ready');};
const fixture=()=>{const assignment=randomUUID(),trip=randomUUID(),booking=randomUUID();
  const customer=randomUUID(),customerAccount=randomUUID(),driver=randomUUID(),driverAccount=randomUUID();
  const vehicle=randomUUID();return {assignment_id:assignment,trip_id:trip,booking_id:booking,
    command:{command_id:randomUUID(),operation_id:assignment},
    parties:{customer_id:customer,customer_account_id:customerAccount,driver_id:driver,
      driver_account_id:driverAccount,vehicle_id:vehicle},
    guard:{customer_id:customer,guard_id:randomUUID(),generation:'1',booking_id:booking},
    reservation:{reservation_id:randomUUID(),generation:'1',assignment_id:assignment,
      booking_id:booking,driver_id:driver,vehicle_id:vehicle},
    pickup:{point:{latitude:10.7769,longitude:106.7009},address:'A'},
    destination:{point:{latitude:10.7869,longitude:106.7109},address:'B'},
    pricing:{vehicle_type:'MOTORBIKE',pricing_version_id:randomUUID(),route_id:randomUUID(),
      route_version:'1',distance_meters:'1250',total_amount:'6625',currency:'VND'}};};
const rejected=async(fn,reason)=>assert.rejects(fn,error=>error?.details===reason,reason);
const pki=()=>{
  let openssl='openssl';
  try {execFileSync(openssl,['version'],{stdio:'ignore'});}
  catch {const git=execFileSync('where.exe',['git.exe'],{encoding:'utf8'}).trim().split(/\r?\n/)[0];
    openssl=join(git,'..','..','usr','bin','openssl.exe');
    if(!existsSync(openssl)) throw new Error('Test OpenSSL unavailable');}
  const run=args=>execFileSync(openssl,args,{cwd:temp,stdio:'ignore',timeout:10000});
  run(['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','1',
    '-subj','/CN=CAB-TRIP-TEST','-keyout','ca.key','-out','ca.crt',
    '-addext','basicConstraints=critical,CA:TRUE',
    '-addext','keyUsage=critical,keyCertSign,cRLSign']);
  for(const service of ['trip','payment','identity']) {
    run(['req','-new','-newkey','rsa:2048','-nodes','-sha256',
      '-subj',`/CN=ignored-${service}`,'-keyout',`${service}.key`,
      '-out',`${service}.csr`]);
    writeFileSync(join(temp,`${service}.ext`),
      'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n'+
      'extendedKeyUsage=serverAuth,clientAuth\n'+
      `subjectAltName=URI:spiffe://cab.local/service/${service}-service\n`);
    run(['x509','-req','-in',`${service}.csr`,'-CA','ca.crt','-CAkey','ca.key',
      '-CAcreateserial','-days','1','-sha256','-extfile',`${service}.ext`,
      '-out',`${service}.crt`]);
  }
  return service=>({ca:readFileSync(join(temp,'ca.crt')),
    cert:readFileSync(join(temp,`${service}.crt`)),key:readFileSync(join(temp,`${service}.key`))});
};
let started=false,admin,runtime,paymentAdmin,paymentRuntime,paymentServer,identityServer,owners,commands;
let transferTripForIdentity;
try {
  docker(['run','-d','--rm','--name',name,
    '--mount',`type=bind,source=${secretFile},target=/run/secrets/cab_pw,readonly`,
    '-e','POSTGRES_PASSWORD_FILE=/run/secrets/cab_pw','-e','POSTGRES_DB=cab_trip',
    '-p','127.0.0.1::5432',
    'postgres:17.11-bookworm@sha256:639ab7ceb90e13123085b741fb31ef493fba25463002f6da665352e7b534b652']);
  started=true;await wait();
  const published=docker(['port',name,'5432/tcp']);
  const port=Number(published.split(/\r?\n/).find(line=>line.startsWith('127.0.0.1:'))
    ?.match(/:(\d+)$/)?.[1]);
  assert.ok(Number.isSafeInteger(port)&&port>0);
  const url=new URL(`postgresql://postgres@127.0.0.1:${port}/cab_trip`);url.password=password;
  admin=new pg.Pool({connectionString:url.toString(),max:3});
  let hostReady=false;
  for(let attempt=0;attempt<40;attempt++) {
    try {await admin.query('SELECT 1');hostReady=true;break;}
    catch {await new Promise(resolve=>setTimeout(resolve,250));}
  }
  if(!hostReady) throw new Error('Disposable PostgreSQL host port not ready');
  const role=await admin.query(`SELECT format(
    'CREATE ROLE trip_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L',
    $1::text) AS sql`,[runtimePassword]);
  await admin.query(role.rows[0].sql);
  await admin.query('GRANT CONNECT ON DATABASE cab_trip TO trip_runtime');
  await admin.query('GRANT USAGE ON SCHEMA public TO trip_runtime');
  const migration=readFileSync(new URL('../services/trip-service/src/infrastructure/migrations/202610100001_trip.sql',
    import.meta.url),'utf8');
  await admin.query(migration);
  await admin.query(readFileSync(new URL(
    '../services/trip-service/src/infrastructure/migrations/202610100002_journey_metrics.sql',
    import.meta.url),'utf8'));
  await admin.query(readFileSync(new URL(
    '../services/trip-service/src/infrastructure/migrations/202610120003_incident.sql',
    import.meta.url),'utf8'));
  const runtimeUrl=new URL(url);runtimeUrl.username='trip_runtime';runtimeUrl.password=runtimePassword;
  runtimeUrl.searchParams.set('application_name','cab-trip-lifecycle-check');
  process.env.CAB_TRIP_RUNTIME_URL=runtimeUrl.toString();
  for(let i=0;i<2;i++) {
    const context=await NestFactory.createApplicationContext(TripModule,
      {logger:false,abortOnError:false});
    try {assert.equal((await context.get(TripDatabase).client.query('SELECT 1 AS ok')).rows[0].ok,1);}
    finally {await context.close();}
    const remaining=await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE application_name='cab-trip-lifecycle-check'`);
    assert.equal(remaining.rows[0].n,0,'Nest shutdown closed every owned connection');
  }
  runtime=new pg.Pool({connectionString:runtimeUrl.toString(),max:4});
  const ledger=new TripLedger(runtime,randomBytes(32));
  await runtime.query('SELECT 1');
  await assert.rejects(()=>runtime.query('CREATE TABLE forbidden_trip_ddl(id INT)'),error=>
    error?.code==='42501','runtime DDL denied');
  const a=fixture();
  const first=await ledger.prepare(a);assert.equal(first.state,'PREPARED');
  assert.deepEqual(await ledger.prepare(a),first);
  await rejected(()=>ledger.prepare({...a,pickup:{...a.pickup,address:'Different'}}),
    'IDEMPOTENCY_CONFLICT');
  await rejected(()=>ledger.prepare({...a,command:{...a.command,command_id:randomUUID()},
    pickup:{...a.pickup,address:'Different'}}),'TRIP_PREPARATION_CONFLICT');
  const tombstone=fixture();
  assert.equal((await ledger.cancelPreparation(tombstone)).state,'PREPARATION_CANCELLED');
  await rejected(()=>ledger.prepare({...tombstone,command:{...tombstone.command,
    command_id:randomUUID()}}),'TRIP_PREPARATION_CANCELLED');
  assert.equal((await ledger.activate(a.assignment_id,'1')).state,'ACTIVE');
  assert.equal((await ledger.activate(a.assignment_id,'1')).state,'ACTIVE');
  const initial=await ledger.view(a.trip_id);assert.equal(initial.trip_status,'DRIVER_ASSIGNED');
  const recordedAt=new Date(Math.max(Date.now(),Number(initial.created_at.seconds)*1000)+2);
  const location={sample_id:randomUUID(),assignment_id:a.assignment_id,
    trip_id:a.trip_id,driver_id:a.parties.driver_id,
    point:{latitude:10.777,longitude:106.701},
    recorded_at:{seconds:String(Math.floor(recordedAt.getTime()/1000)),
      nanos:(recordedAt.getTime()%1000)*1e6},
    received_at:{seconds:String(Math.floor(recordedAt.getTime()/1000)),
      nanos:(recordedAt.getTime()%1000)*1e6}};
  assert.equal((await ledger.recordAssignedLocation(location)).recorded,true);
  assert.equal((await ledger.recordAssignedLocation(location)).recorded,true);
  await rejected(()=>ledger.recordAssignedLocation({...location,assignment_id:randomUUID()}),
    'ASSIGNMENT_MISMATCH');
  await rejected(()=>ledger.recordAssignedLocation({...location,
    point:{latitude:10.778,longitude:106.701}}),'LOCATION_SAMPLE_CONFLICT');
  assert.equal((await runtime.query('SELECT count(*)::int AS n FROM trip_route_point WHERE trip_id=$1',
    [a.trip_id])).rows[0].n,1);
  assert.equal((await ledger.trackingPoint(a.trip_id)).latitude,10.777);
  await rejected(()=>ledger.closure(a.trip_id),'TRIP_NOT_CLOSED');
  const race=await Promise.allSettled([1,2].map(()=>ledger.transition({tripId:a.trip_id,
    commandId:randomUUID(),expected:'1',next:'ARRIVED_PICKUP',
    accountId:a.parties.driver_account_id})));
  assert.equal(race.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(race.filter(result=>result.status==='rejected').length,1);
  const arrived=await ledger.view(a.trip_id);assert.equal(arrived.version,'2');
  await rejected(()=>ledger.transition({tripId:a.trip_id,commandId:randomUUID(),expected:'1',
    next:'PICKED_UP',accountId:a.parties.driver_account_id}),'TRIP_VERSION_CONFLICT');
  const pickupCommand=randomUUID();
  const picked=await ledger.transition({tripId:a.trip_id,commandId:pickupCommand,
    expected:'2',next:'PICKED_UP',accountId:a.parties.driver_account_id});
  assert.deepEqual(await ledger.statusReplay(pickupCommand,a.trip_id,'2','PICKED_UP',
    a.parties.driver_account_id),picked);
  const startedTrip=await ledger.transition({tripId:a.trip_id,commandId:randomUUID(),
    expected:'3',next:'IN_PROGRESS',accountId:a.parties.driver_account_id});
  assert.equal(startedTrip.trip_status,'IN_PROGRESS');assert.ok(startedTrip.started_at);
  const completed=await ledger.transition({tripId:a.trip_id,commandId:randomUUID(),
    expected:'4',next:'COMPLETED',accountId:a.parties.driver_account_id});
  assert.equal(completed.trip_status,'COMPLETED');assert.ok(completed.closed_at);
  await rejected(()=>ledger.transition({tripId:a.trip_id,commandId:randomUUID(),
    expected:'5',next:'ARRIVED_PICKUP',accountId:a.parties.driver_account_id}),
    'INVALID_TRIP_TRANSITION');
  assert.equal((await ledger.closure(a.trip_id)).status,'PROCESSING');
  assert.equal((await runtime.query('SELECT status FROM journey_metrics WHERE trip_id=$1',
    [a.trip_id])).rows[0].status,'PENDING');
  const b=fixture();await ledger.prepare(b);await ledger.activate(b.assignment_id,'1');
  const cancelled=await ledger.cancel({tripId:b.trip_id,commandId:randomUUID(),expected:'1',
    reasonCode:'CHANGE_OF_PLANS',reason:'Test cancellation',accountId:b.parties.customer_account_id,
    role:'CUSTOMER'});
  assert.equal(cancelled.trip_status,'CANCELLED');
  assert.deepEqual(cancelled.cancellation.cancelled_at,cancelled.closed_at);
  const pending=(await runtime.query('SELECT payment_fence FROM trip_closure WHERE trip_id=$1',
    [b.trip_id])).rows[0];assert.equal(pending.payment_fence,'PENDING');
  const raceTrip=fixture();await ledger.prepare(raceTrip);
  await ledger.activate(raceTrip.assignment_id,'1');
  await ledger.transition({tripId:raceTrip.trip_id,commandId:randomUUID(),expected:'1',
    next:'ARRIVED_PICKUP',accountId:raceTrip.parties.driver_account_id});
  const closingRace=await Promise.allSettled([
    ledger.transition({tripId:raceTrip.trip_id,commandId:randomUUID(),expected:'2',
      next:'PICKED_UP',accountId:raceTrip.parties.driver_account_id}),
    ledger.cancel({tripId:raceTrip.trip_id,commandId:randomUUID(),expected:'2',
      reasonCode:'OTHER',reason:'Race test',accountId:raceTrip.parties.customer_account_id,
      role:'CUSTOMER'}),
  ]);
  assert.equal(closingRace.filter(item=>item.status==='fulfilled').length,1);
  assert.equal(closingRace.filter(item=>item.status==='rejected').length,1);
  assert.ok(['PICKED_UP','CANCELLED'].includes((await ledger.view(raceTrip.trip_id)).trip_status));
  const incidentTrip=fixture();await ledger.prepare(incidentTrip);
  await ledger.activate(incidentTrip.assignment_id,'1');
  const incidentInput={tripId:incidentTrip.trip_id,commandId:randomUUID(),expected:'1',
    issueType:'VEHICLE_BREAKDOWN',description:'Demo incident',
    accountId:incidentTrip.parties.driver_account_id};
  const reported=await ledger.incident(incidentInput);
  assert.equal(reported.trip.trip_status,'ERROR');
  assert.equal(reported.trip.status_before_error,'DRIVER_ASSIGNED');
  assert.deepEqual(await ledger.incident(incidentInput),reported);
  await rejected(()=>ledger.incident({...incidentInput,description:'Changed'}),
    'IDEMPOTENCY_CONFLICT');
  const again=await ledger.incident({...incidentInput,commandId:randomUUID(),expected:'2',
    issueType:'OTHER',description:'Additional evidence'});
  assert.equal(again.trip.status_before_error,'DRIVER_ASSIGNED');
  assert.equal(again.trip.version,'3');
  assert.equal((await runtime.query('SELECT count(*)::int AS n FROM trip_status_history WHERE trip_id=$1',
    [incidentTrip.trip_id])).rows[0].n,2);
  assert.equal((await runtime.query('SELECT count(*)::int AS n FROM trip_outbox WHERE trip_id=$1',
    [incidentTrip.trip_id])).rows[0].n,1);
  await rejected(()=>ledger.incident({...incidentInput,commandId:randomUUID(),expected:'3',
    accountId:randomUUID()}),'TRIP_NOT_FOUND');
  const page=await ledger.list({role:'DRIVER',accountId:a.parties.driver_account_id,
    driverId:a.parties.driver_id},{limit:1});
  assert.equal(page.items.length,1);
  assert.equal((await runtime.query('SELECT count(*)::int AS n FROM trip_status_history WHERE trip_id=$1',
    [a.trip_id])).rows[0].n,5);
  assert.equal((await runtime.query('SELECT count(*)::int AS n FROM trip_outbox WHERE trip_id=$1',
    [a.trip_id])).rows[0].n,3);
  // Payment owns a second database. Its real ledger serves policy-checked gRPC over test-only mTLS.
  const paymentRole=await admin.query(`SELECT format(
    'CREATE ROLE payment_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L',
    $1::text) AS sql`,[runtimePassword]);
  await admin.query(paymentRole.rows[0].sql);
  await admin.query('CREATE DATABASE cab_payment');
  await admin.query('REVOKE ALL ON DATABASE cab_payment FROM PUBLIC');
  await admin.query('GRANT CONNECT ON DATABASE cab_payment TO payment_runtime');
  const paymentUrl=new URL(url);paymentUrl.pathname='/cab_payment';
  paymentAdmin=new pg.Pool({connectionString:paymentUrl.toString(),max:2});
  await paymentAdmin.query('GRANT USAGE ON SCHEMA public TO payment_runtime');
  for(const filename of ['202610090001_payment_pricing.sql',
    '202610090002_trip_cancellation.sql'])
    await paymentAdmin.query(readFileSync(new URL(`../services/payment-service/src/infrastructure/migrations/${filename}`,
      import.meta.url),'utf8'));
  const paymentRuntimeUrl=new URL(paymentUrl);paymentRuntimeUrl.username='payment_runtime';
  paymentRuntimeUrl.password=runtimePassword;
  paymentRuntime=new pg.Pool({connectionString:paymentRuntimeUrl.toString(),max:4});
  const price=new PricingCapture(paymentRuntime);
  const snapshot=await price.get({operation_id:randomUUID(),vehicle_type:'MOTORBIKE',
    booking_accepted_at:{seconds:String(Math.floor(Date.now()/1000)),nanos:0},
    pickup:a.pickup,destination:a.destination});
  const ledgerPayment=new PaymentLedger(paymentRuntime,randomBytes(32));
  const obligation=(trip)=>({tripId:trip.trip_id,bookingId:trip.booking_id,
    customerId:trip.parties.customer_id,customerAccountId:trip.parties.customer_account_id,
    driverId:trip.parties.driver_id,driverAccountId:trip.parties.driver_account_id,
    pricingVersionId:snapshot.pricing_version_id,routeId:snapshot.route_id,
    routeVersion:snapshot.route_version,distanceMeters:snapshot.distance_meters,
    amountVnd:snapshot.total_amount,pricingSnapshot:snapshot});
  const payment=await ledgerPayment.create(obligation(b),b.parties.customer_account_id,
    'trip-test-payment','DEMO_TRANSFER');
  const material=pki();
  paymentServer=createServer('payment-service',material('payment'));
  const definition=serviceDefinition('cab.internal.v1.PaymentInternalService',
    'proto/cab/internal/v1/payment.proto');
  const wrap=fn=>(call,done)=>{void fn(call.request).then(value=>done(null,value),error=>done(error));};
  paymentServer.addService(definition,{
    GetPricingSnapshot:(_call,done)=>done({code:grpc.status.UNIMPLEMENTED}),
    GetTripPaymentDecision:wrap(request=>ledgerPayment.tripStartDecision(request.trip_id)),
    RecordTripCancellation:wrap(request=>ledgerPayment.recordTripCancellation(
      request.trip_id,request.cancellation_id)),
  });
  const grpcPort=await bindServer(paymentServer,'127.0.0.1:0',material('payment'));
  identityServer=createServer('identity-service',material('identity'));
  const identityDef=serviceDefinition('cab.internal.v1.IdentityInternalService',
    'proto/cab/internal/v1/identity.proto');
  identityServer.addService(identityDef,{
    VerifyUserIdentity:(call,done)=>{
      const token=call.metadata.get('x-cab-user-authorization')[0];
      const driver=String(token)==='Bearer test-driver';
      const customer=String(token)==='Bearer test-customer';
      if(!driver&&!customer) return done({code:grpc.status.UNAUTHENTICATED});
      const part=transferTripForIdentity.parties;
      return done(null,driver?{account_id:part.driver_account_id,role:'DRIVER',
        driver_id:part.driver_id}:{account_id:part.customer_account_id,role:'CUSTOMER',
        customer_id:part.customer_id});
    },
  });
  const identityPort=await bindServer(identityServer,'127.0.0.1:0',material('identity'));
  for(const name of ['BOOKING','CUSTOMER','DRIVER'])
    process.env[`${name}_SERVICE_GRPC_TARGET`]='127.0.0.1:1';
  process.env.IDENTITY_SERVICE_GRPC_TARGET=`localhost:${identityPort}`;
  process.env.PAYMENT_SERVICE_GRPC_TARGET=`localhost:${grpcPort}`;
  process.env.TRIP_SERVICE_CA_FILE=join(temp,'ca.crt');
  process.env.TRIP_SERVICE_CERT_FILE=join(temp,'trip.crt');
  process.env.TRIP_SERVICE_KEY_FILE=join(temp,'trip.key');
  owners=new OwnerClients();
  const before=await owners.paymentDecision(b.trip_id);
  assert.equal(before.can_start_trip,false);assert.equal(before.status,'TRIP_PAYMENT_PENDING');
  const fence=await owners.fenceCancellation(b.trip_id,(await ledger.closure(b.trip_id)).operation_id);
  assert.equal(fence.trip_id,b.trip_id);
  assert.equal((await owners.paymentDecision(b.trip_id)).can_start_trip,false);
  await rejected(()=>ledgerPayment.result(payment.payment_id,b.parties.customer_id,
    b.parties.customer_account_id,payment.current_attempt_id,'late-result','1',
    snapshot.total_amount,'VND','SUCCESS',true),'TRIP_CANCELLED');
  const cashTrip=fixture();await ledger.prepare(cashTrip);await ledger.activate(cashTrip.assignment_id,'1');
  const cashPayment=await ledgerPayment.create(obligation(cashTrip),cashTrip.parties.customer_account_id,
    'trip-test-cash','CASH');
  assert.equal((await owners.paymentDecision(cashTrip.trip_id)).can_start_trip,true);
  const transferTrip=fixture();await ledger.prepare(transferTrip);
  transferTripForIdentity=transferTrip;
  await ledger.activate(transferTrip.assignment_id,'1');
  const transfer=await ledgerPayment.create(obligation(transferTrip),
    transferTrip.parties.customer_account_id,'trip-test-transfer','DEMO_TRANSFER');
  assert.equal((await owners.paymentDecision(transferTrip.trip_id)).can_start_trip,false);
  const cursorFile=join(temp,'trip-cursor');
  writeFileSync(cursorFile,randomBytes(32).toString('base64url'),{mode:0o600});
  process.env.CAB_TRIP_CURSOR_KEY_FILE=cursorFile;
  commands=new TripCommands(runtime);
  const metadata=new grpc.Metadata();metadata.set('x-cab-user-authorization','Bearer test-driver');
  const wrong=new grpc.Metadata();wrong.set('x-cab-user-authorization','Bearer test-customer');
  await rejected(()=>commands.status({trip_id:transferTrip.trip_id,expected_version:'1',
    trip_status:'ARRIVED_PICKUP',command_id:randomUUID()},wrong),'FORBIDDEN');
  await commands.status({trip_id:transferTrip.trip_id,expected_version:'1',
    trip_status:'ARRIVED_PICKUP',command_id:randomUUID()},metadata);
  await commands.status({trip_id:transferTrip.trip_id,expected_version:'2',
    trip_status:'PICKED_UP',command_id:randomUUID()},metadata);
  const begun=await commands.status({trip_id:transferTrip.trip_id,expected_version:'3',
    trip_status:'IN_PROGRESS',command_id:randomUUID()},metadata);
  assert.equal(begun.trip_status,'IN_PROGRESS');
  const done=await commands.status({trip_id:transferTrip.trip_id,expected_version:'4',
    trip_status:'COMPLETED',command_id:randomUUID()},metadata);
  assert.equal(done.trip_status,'COMPLETED');
  await ledgerPayment.result(transfer.payment_id,transferTrip.parties.customer_id,
    transferTrip.parties.customer_account_id,transfer.current_attempt_id,'transfer-result',
    '1',snapshot.total_amount,'VND','SUCCESS',true);
  assert.equal((await owners.paymentDecision(transferTrip.trip_id)).status,'TRIP_PAYMENT_SUCCESS');
  transferTripForIdentity=cashTrip;
  await commands.status({trip_id:cashTrip.trip_id,expected_version:'1',
    trip_status:'ARRIVED_PICKUP',command_id:randomUUID()},metadata);
  await commands.status({trip_id:cashTrip.trip_id,expected_version:'2',
    trip_status:'PICKED_UP',command_id:randomUUID()},metadata);
  const cashStarted=await commands.status({trip_id:cashTrip.trip_id,expected_version:'3',
    trip_status:'IN_PROGRESS',command_id:randomUUID()},metadata);
  assert.equal(cashStarted.trip_status,'IN_PROGRESS');
  await rejected(()=>ledgerPayment.confirmCash(cashPayment.payment_id,
    cashTrip.parties.driver_account_id,cashTrip.parties.driver_id,'cash-before-completion',
    '1',false),'TRIP_NOT_COMPLETED');
  const finished=await commands.status({trip_id:cashTrip.trip_id,expected_version:'4',
    trip_status:'COMPLETED',command_id:randomUUID()},metadata);
  assert.equal(finished.trip_status,'COMPLETED');
  const confirmed=await ledgerPayment.confirmCash(cashPayment.payment_id,
    cashTrip.parties.driver_account_id,cashTrip.parties.driver_id,'cash-after-completion',
    '1',true);
  assert.equal(confirmed.payment_status,'PAYMENT_SUCCESS');
  const replayedCash=await ledgerPayment.confirmCash(cashPayment.payment_id,
    cashTrip.parties.driver_account_id,cashTrip.parties.driver_id,'cash-after-completion',
    '1',true);
  assert.deepEqual(replayedCash,confirmed);
  await rejected(()=>ledgerPayment.confirmCash(cashPayment.payment_id,
    cashTrip.parties.driver_account_id,cashTrip.parties.driver_id,'new-cash-command',
    '1',true),'PAYMENT_ALREADY_PAID');
  const paidTrip=fixture();await ledger.prepare(paidTrip);
  await ledger.activate(paidTrip.assignment_id,'1');
  const paid=await ledgerPayment.create(obligation(paidTrip),
    paidTrip.parties.customer_account_id,'paid-before-cancel','DEMO_TRANSFER');
  await ledgerPayment.result(paid.payment_id,paidTrip.parties.customer_id,
    paidTrip.parties.customer_account_id,paid.current_attempt_id,'paid-result',
    '1',snapshot.total_amount,'VND','SUCCESS',true);
  await ledger.cancel({tripId:paidTrip.trip_id,commandId:randomUUID(),expected:'1',
    reasonCode:'CHANGE_OF_PLANS',reason:'Paid before cancellation',
    accountId:paidTrip.parties.customer_account_id,role:'CUSTOMER'});
  const closureId=(await ledger.closure(paidTrip.trip_id)).operation_id;
  const review=await owners.fenceCancellation(paidTrip.trip_id,closureId);
  assert.equal(review.review_recorded,true);
  assert.equal((await owners.paymentDecision(paidTrip.trip_id)).requires_review,true);
  assert.equal((await ledgerPayment.find(paid.payment_id)).status,'SUCCESS');
  assert.equal((await owners.fenceCancellation(paidTrip.trip_id,closureId)).review_recorded,true);
  const failedTrip=fixture();await ledger.prepare(failedTrip);
  await ledger.activate(failedTrip.assignment_id,'1');
  const failed=await ledgerPayment.create(obligation(failedTrip),
    failedTrip.parties.customer_account_id,'failed-transfer','DEMO_TRANSFER');
  await ledgerPayment.result(failed.payment_id,failedTrip.parties.customer_id,
    failedTrip.parties.customer_account_id,failed.current_attempt_id,'failed-result',
    '1',snapshot.total_amount,'VND','FAILED',true);
  assert.equal((await owners.paymentDecision(failedTrip.trip_id)).can_start_trip,false);
  assert.equal((await owners.paymentDecision(failedTrip.trip_id)).status,'TRIP_PAYMENT_FAILED');
  console.info('PASS disposable PostgreSQL Trip: runtime role, preparation replay/tombstone, activation, assigned-location replay/fence, incident ERROR/replay/additional evidence, CAS race, receipts, timestamps, closure/fence and outbox');
  console.info('PASS Nest Trip persistence lifecycle: two real DB bootstrap/query/close cycles; zero owned connections after each close');
  console.info('PASS isolated Trip identity -> real Payment ledger gRPC/mTLS: Trip starts and completes with transfer PENDING, then transfer SUCCESS; legacy paid-before-cancel stays SUCCESS with review; cash confirmation before completion rejected, after completion succeeds once with replay');
} finally {
  commands?.close();owners?.close();
  if(identityServer) await closeServer(identityServer);
  if(paymentServer) await closeServer(paymentServer);
  await paymentRuntime?.end().catch(()=>undefined);await paymentAdmin?.end().catch(()=>undefined);
  await runtime?.end().catch(()=>undefined);await admin?.end().catch(()=>undefined);
  if(started) spawnSync('docker',['stop',name],{encoding:'utf8',timeout:20000});
  rmSync(temp,{recursive:true,force:true});
}
