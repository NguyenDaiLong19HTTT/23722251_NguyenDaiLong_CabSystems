// Isolated Booking persistence check. This is not a cross-service E2E test.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {BookingLedger} from '../services/booking-service/dist/application/booking-ledger.js';

const temp=mkdtempSync(join(tmpdir(),'cab-booking-check-'));
const name=`cab-booking-check-${process.pid}-${randomBytes(4).toString('hex')}`;
const adminPassword=randomBytes(32).toString('base64url');
const runtimePassword=randomBytes(32).toString('base64url');
const secretFile=join(temp,'postgres-password');
writeFileSync(secretFile,adminPassword,{mode:0o600});
const docker=args=>{const result=spawnSync('docker',args,{encoding:'utf8',timeout:120000});
  if(result.status!==0) throw new Error(`Disposable Booking PostgreSQL command failed: ${args[0]}`);
  return result.stdout.trim();};
const wait=async()=>{for(let i=0;i<60;i++) {
  const result=spawnSync('docker',['exec',name,'pg_isready','-U','postgres','-d','cab_booking'],
    {encoding:'utf8',timeout:5000});if(result.status===0) return;
  await new Promise(resolve=>setTimeout(resolve,500));
} throw new Error('Disposable Booking PostgreSQL readiness timeout');};
const fixture=()=>({pickup:{point:{latitude:10.7769,longitude:106.7009},address:'A'},
  destination:{point:{latitude:10.7869,longitude:106.7109},address:'B'},
  vehicle_type:'MOTORBIKE'});
let started=false,admin,runtime;
try {
  docker(['run','-d','--rm','--name',name,
    '--mount',`type=bind,source=${secretFile},target=/run/secrets/cab_pw,readonly`,
    '-e','POSTGRES_PASSWORD_FILE=/run/secrets/cab_pw','-e','POSTGRES_DB=cab_booking',
    '-p','127.0.0.1::5432',
    'postgres:17.11-bookworm@sha256:639ab7ceb90e13123085b741fb31ef493fba25463002f6da665352e7b534b652']);
  started=true;await wait();
  const port=Number(docker(['port',name,'5432/tcp']).split(/\r?\n/)
    .find(line=>line.startsWith('127.0.0.1:'))?.match(/:(\d+)$/)?.[1]);
  assert.ok(Number.isSafeInteger(port)&&port>0);
  const url=new URL(`postgresql://postgres@127.0.0.1:${port}/cab_booking`);
  url.password=adminPassword;
  admin=new pg.Pool({connectionString:url.toString(),max:2,connectionTimeoutMillis:5000});
  let hostReady=false;
  for(let attempt=0;attempt<40;attempt++) {
    try {await admin.query('SELECT 1');hostReady=true;break;}
    catch {await new Promise(resolve=>setTimeout(resolve,250));}
  }
  if(!hostReady) throw new Error('Disposable Booking PostgreSQL host port not ready');
  const role=await admin.query(`SELECT format(
    'CREATE ROLE booking_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L',
    $1::text) AS sql`,[runtimePassword]);
  await admin.query(role.rows[0].sql);
  await admin.query('GRANT CONNECT ON DATABASE cab_booking TO booking_runtime');
  await admin.query('GRANT USAGE ON SCHEMA public TO booking_runtime');
  const migration=readFileSync(new URL('../services/booking-service/src/infrastructure/migrations/202610120001_booking.sql',
    import.meta.url),'utf8');
  await admin.query(migration);
  const runtimeUrl=new URL(url);runtimeUrl.username='booking_runtime';
  runtimeUrl.password=runtimePassword;
  runtime=new pg.Pool({connectionString:runtimeUrl.toString(),max:4,connectionTimeoutMillis:5000});
  assert.equal((await runtime.query('SELECT 1 AS ok')).rows[0].ok,1);
  await assert.rejects(()=>runtime.query('CREATE TABLE forbidden_booking_ddl(id INT)'),
    error=>error?.code==='42501','runtime DDL denied');
  const ledger=new BookingLedger(runtime,randomBytes(32));
  const customer=randomUUID(),account=randomUUID();
  const created=await ledger.createOperation(customer,account,fixture());
  await assert.rejects(()=>ledger.createOperation(customer,account,fixture()),
    error=>error?.details==='ACTIVE_BOOKING_OR_TRIP_EXISTS');
  await ledger.saveGuard(created.operation_id,{customer_id:customer,guard_id:randomUUID(),
    generation:'1',booking_id:created.booking_id});
  const price={pricing_version_id:randomUUID(),vehicle_type:'MOTORBIKE',
    base_fare:{value:'0'},price_per_km:{value:'5300'},price_per_minute:{value:'0'},
    currency:'VND',accepted_at:{seconds:'1791763200',nanos:0},route_id:randomUUID(),
    route_version:'1',distance_meters:'1250',total_amount:'6625'};
  await ledger.savePricing(created.operation_id,price);
  const first=await ledger.finishCreate(created.operation_id);
  assert.equal(first.booking_status,'PENDING');
  assert.deepEqual(await ledger.finishCreate(created.operation_id),first);
  const dispatch=await ledger.startDispatch(created.booking_id);
  assert.equal(dispatch.status,'SEARCHING');
  const driver=randomUUID(),driverAccount=randomUUID(),vehicle=randomUUID();
  const offer=await ledger.issueOffer(created.booking_id,{driver_id:driver,
    driver_account_id:driverAccount,vehicle_id:vehicle,
    driver_version:'1',vehicle_version:'1'});
  assert.equal(offer.status,'PENDING');
  const [a,b]=await Promise.all([ledger.claimOffer(offer.trip_request_id,driver,driverAccount),
    ledger.claimOffer(offer.trip_request_id,driver,driverAccount)]);
  assert.equal(a.assignment_id,b.assignment_id,'concurrent accept reused one assignment');
  assert.equal((await ledger.offer(offer.trip_request_id)).status,'PENDING',
    'TripRequest remains pending until activation/finalization');
  await assert.rejects(()=>ledger.rejectOffer(offer.trip_request_id,driver),
    error=>error?.details==='TRIP_REQUEST_NOT_PENDING');
  const assignments=await runtime.query('SELECT count(*)::int AS n FROM booking_assignment');
  assert.equal(assignments.rows[0].n,1);
  const noDuplicate=await runtime.query(`SELECT count(*)::int AS n FROM booking_outbox
    WHERE event_type='TRIP_REQUEST_RECEIVED'`);
  assert.equal(noDuplicate.rows[0].n,1);
  const reservation={reservation_id:randomUUID(),generation:'1',
    assignment_id:a.assignment_id,booking_id:a.booking_id,driver_id:driver,vehicle_id:vehicle};
  await ledger.saveReservation(a.assignment_id,reservation);
  await ledger.saveReservation(a.assignment_id,Object.fromEntries(
    Object.entries(reservation).reverse()));
  await ledger.advanceAssignment(a.assignment_id,'CLAIMED','PREPARING');
  await ledger.advanceAssignment(a.assignment_id,'PREPARING','ACTIVATING');
  const assigned=await ledger.completeAssignment(a.assignment_id);
  assert.equal(assigned.status,'DRIVER_ASSIGNED');
  assert.equal(assigned.trip_id,a.trip_id);
  assert.equal((await ledger.offer(offer.trip_request_id)).status,'ACCEPTED');
  assert.equal((await ledger.paymentContext(a.trip_id)).pricing_operation_id,
    created.operation_id);
  assert.deepEqual(await ledger.completeAssignment(a.assignment_id),assigned,
    'finalize replay kept one Booking result');
  assert.equal((await runtime.query(`SELECT count(*)::int AS n FROM booking_outbox
    WHERE event_type='DRIVER_ASSIGNED'`)).rows[0].n,1);
  console.info('PASS disposable Booking PostgreSQL: runtime DDL denial, create snapshot replay, dispatch offer, concurrent claim fence, JSONB reservation replay, pending visibility, assignment finalize/replay, Payment context and one outbox per event');
} finally {
  await runtime?.end().catch(()=>undefined);await admin?.end().catch(()=>undefined);
  if(started) spawnSync('docker',['stop',name],{encoding:'utf8',timeout:20000});
  rmSync(temp,{recursive:true,force:true});
}
