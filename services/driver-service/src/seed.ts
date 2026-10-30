import { readFileSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { createDriverClient } from './infrastructure/prisma/client.js';
import { DriverLicenseCrypto } from './infrastructure/license-crypto.js';

// Opt-in dev seed, owned solely by Driver. Manifest/password live in ignored files.
const path=process.env.CAB_DRIVER_SEED_MANIFEST,url=process.env.CAB_DRIVER_RUNTIME_URL;
if (!path||!url) throw new Error('Driver seed configuration is missing');
const data=JSON.parse(readFileSync(path,'utf8')) as Record<string,string>;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (!['accountId','driverId','vehicleId','assignmentId'].every(key=>uuid.test(data[key]??''))||
    !['licenseNumber','plateNumber'].every(key=>typeof data[key]==='string'&&data[key]))
  throw new Error('Driver seed manifest is invalid');
const crypto=new DriverLicenseCrypto();
const db=createDriverClient(new PrismaPg({connectionString:url,connectionTimeoutMillis:5000}));
try {
  await db.$connect();
  await db.$transaction(async tx=>{
    const existing=await tx.$queryRaw<{account_id:string}[]>`
      SELECT account_id FROM driver_profile WHERE driver_id=${data.driverId}::uuid`;
    if (existing[0]) {
      if (existing[0].account_id!==data.accountId) throw new Error('Driver seed binding conflict');
      const assignment=await tx.$queryRaw<{vehicle_id:string}[]>`
        SELECT vehicle_id FROM vehicle_assignment WHERE driver_id=${data.driverId}::uuid
        AND ended_at IS NULL`;
      if (assignment.length!==1||assignment[0]?.vehicle_id!==data.vehicleId)
        throw new Error('Driver seed assignment drift');
      return;
    }
    const sealed=crypto.seal(data.licenseNumber!,data.driverId!);
    await tx.$executeRaw`INSERT INTO driver_profile(driver_id,account_id,license_ciphertext,
      license_nonce,license_tag,license_key_version,license_lookup_hmac,
      approval_status,driver_status) VALUES (${data.driverId}::uuid,${data.accountId}::uuid,
      ${sealed.ciphertext},${sealed.nonce},${sealed.tag},${sealed.keyVersion},
      ${crypto.digest(data.licenseNumber!)},'APPROVED','OFFLINE')`;
    await tx.$executeRaw`INSERT INTO vehicle(vehicle_id,plate_number,plate_key,vehicle_type,
      vehicle_status) VALUES (${data.vehicleId}::uuid,${data.plateNumber},
      ${data.plateNumber!.toUpperCase()},${data.vehicleType}::text,'ACTIVE')`;
    await tx.$executeRaw`INSERT INTO vehicle_assignment(assignment_id,driver_id,vehicle_id)
      VALUES (${data.assignmentId}::uuid,${data.driverId}::uuid,${data.vehicleId}::uuid)`;
  });
  console.info('Driver-owned seed transaction ready (new or verified existing).');
} finally {await db.$disconnect();}
