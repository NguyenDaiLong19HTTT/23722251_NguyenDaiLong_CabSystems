import {createHash,randomBytes,randomUUID} from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import {createClient,facadeError,readTlsFromEnvironment,serviceDefinition,unaryCall} from '@cab/grpc-transport';
import type {PrismaClient} from '../infrastructure/prisma/generated/client.js';
import {distanceMeters} from './dispatch-candidates.js';

type Data=Record<string,unknown>;
type Candidate={driver_id:string;account_id:string;vehicle_type:string;
  latitude:number;longitude:number;recorded_at:Date};
type Snapshot={account_id:string;params_digest:Uint8Array;items:unknown;
  snapshot_at:Date;expires_at:Date;page_offset:number};
type Item={driver_id:string;vehicle_type:string;distance_meters:number};
const record=(v:unknown):v is Data=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const stamp=(date:Date)=>({seconds:String(Math.floor(date.getTime()/1000)),
  nanos:(date.getTime()%1000)*1e6});
const digest=(value:string)=>createHash('sha256').update(value).digest();
const fail=(code:grpc.status,reason:string,origin?:'END_USER'|'SERVICE')=>
  facadeError(code,reason,origin);

export class NearbyDrivers {
  private readonly identity:grpc.Client;
  private readonly definition=serviceDefinition('cab.internal.v1.IdentityInternalService',
    'proto/cab/internal/v1/identity.proto');
  constructor(private readonly db:PrismaClient) {
    const target=process.env.IDENTITY_SERVICE_GRPC_TARGET;
    if (!target) throw new Error('Identity gRPC target is missing');
    this.identity=createClient(target,readTlsFromEnvironment('DRIVER_SERVICE'),'identity-service');
  }
  close():void {this.identity.close();}
  private async principal(metadata:grpc.Metadata):Promise<string> {
    const user=metadata.get('x-cab-user-authorization')[0];
    if (typeof user!=='string'||!/^Bearer [^\s]+$/.test(user))
      throw fail(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED','END_USER');
    const toIdentity=new grpc.Metadata();
    toIdentity.set('x-correlation-id',randomUUID());
    toIdentity.set('x-cab-user-authorization',user);
    let value:Data;
    try {value=await unaryCall<Data,Data>(this.identity,this.definition,'VerifyUserIdentity',
      {allowed_roles:['CUSTOMER','OPERATOR']},toIdentity,900);}
    catch(error) {
      const code=(error as grpc.ServiceError).code;
      if (code===grpc.status.UNAUTHENTICATED)
        throw fail(grpc.status.UNAUTHENTICATED,'UNAUTHENTICATED','END_USER');
      if (code===grpc.status.PERMISSION_DENIED)
        throw fail(grpc.status.PERMISSION_DENIED,'FORBIDDEN');
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    }
    if (!['CUSTOMER','OPERATOR'].includes(String(value.role))||
        typeof value.account_id!=='string'||!value.account_id)
      throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
    return value.account_id;
  }
  async search(request:unknown,metadata:grpc.Metadata):Promise<Data> {
    const accountId=await this.principal(metadata);
    const data=record(request)?request:{};
    const {latitude,longitude,radius_km:radiusKm,limit,cursor}=data;
    if (typeof latitude!=='number'||!Number.isFinite(latitude)||Math.abs(latitude)>90||
        typeof longitude!=='number'||!Number.isFinite(longitude)||Math.abs(longitude)>180||
        typeof radiusKm!=='number'||!Number.isFinite(radiusKm)||radiusKm<=0||radiusKm>5||
        !Number.isInteger(limit)||Number(limit)<1||Number(limit)>100||
        (cursor!==undefined&&(typeof cursor!=='string'||!/^[-_A-Za-z0-9]{43}$/.test(cursor))))
      throw fail(grpc.status.INVALID_ARGUMENT,'VALIDATION_ERROR');
    const params=digest(JSON.stringify([latitude,longitude,radiusKm,limit]));
    if (cursor!==undefined) {
      const rows=await this.db.$queryRaw<Snapshot[]>`
        SELECT s.account_id,s.params_digest,s.items,s.snapshot_at,s.expires_at,c.page_offset
        FROM nearby_page_cursor c JOIN nearby_search_snapshot s ON s.search_id=c.search_id
        WHERE c.token_digest=${digest(cursor as string)}`;
      const found=rows[0];
      if (!found||found.account_id!==accountId||
          !Buffer.from(found.params_digest).equals(params))
        throw fail(grpc.status.INVALID_ARGUMENT,'INVALID_CURSOR');
      if (found.expires_at.getTime()<=Date.now())
        throw fail(grpc.status.INVALID_ARGUMENT,'CURSOR_EXPIRED');
      if (!Array.isArray(found.items))
        throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
      return this.page(found.items as Item[],found.page_offset,Number(limit),
        Number(radiusKm),found.snapshot_at,found.expires_at,
        async offset=>this.issueCursor(accountId,params,offset,cursor as string));
    }
    const queryAt=new Date();
    const rows=await this.db.$queryRaw<Candidate[]>`
      SELECT d.driver_id,d.account_id,v.vehicle_type,l.latitude,l.longitude,l.recorded_at
      FROM driver_profile d
      JOIN vehicle_assignment a ON a.driver_id=d.driver_id AND a.ended_at IS NULL
      JOIN vehicle v ON v.vehicle_id=a.vehicle_id
      JOIN driver_location l ON l.driver_id=d.driver_id
      WHERE d.approval_status='APPROVED' AND d.driver_status='AVAILABLE'
        AND v.vehicle_status='ACTIVE' AND v.vehicle_type='MOTORBIKE'
        AND l.recorded_at>=${new Date(queryAt.getTime()-30000)}
        AND l.recorded_at<=${queryAt}`;
    const near=rows.map(row=>({row,distance:distanceMeters(
      {latitude:latitude as number,longitude:longitude as number},row)}))
      .filter(item=>item.distance<=Number(radiusKm)*1000)
      .sort((a,b)=>a.distance-b.distance||a.row.driver_id.localeCompare(b.row.driver_id));
    const verified:{item:Item;recordedAt:Date}[]=[];
    for(const {row,distance} of near) {
      const toIdentity=new grpc.Metadata();toIdentity.set('x-correlation-id',randomUUID());
      let eligible:Data;
      try {eligible=await unaryCall<Data,Data>(this.identity,this.definition,
        'VerifyAccountEligibility',{account_id:row.account_id,expected_role:'DRIVER'},
        toIdentity,900);}
      catch(error) {
        if ((error as grpc.ServiceError).code===grpc.status.FAILED_PRECONDITION) continue;
        throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
      }
      if (eligible.account_id!==row.account_id||eligible.role!=='DRIVER'||
          !eligible.verified_at||!eligible.account_version)
        throw fail(grpc.status.UNAVAILABLE,'SERVICE_UNAVAILABLE','SERVICE');
      verified.push({item:{driver_id:row.driver_id,vehicle_type:row.vehicle_type,
        distance_meters:Math.floor(distance/10)*10},recordedAt:row.recorded_at});
    }
    const snapshotAt=new Date();
    const items=verified.filter(value=>value.recordedAt.getTime()>=snapshotAt.getTime()-30000)
      .map(value=>value.item);
    const expiresAt=new Date(snapshotAt.getTime()+30000);
    const searchId=randomUUID();
    await this.db.$executeRaw`
      INSERT INTO nearby_search_snapshot
        (search_id,account_id,params_digest,items,snapshot_at,expires_at)
      VALUES (${searchId}::uuid,${accountId}::uuid,${params},${JSON.stringify(items)}::jsonb,
        ${snapshotAt},${expiresAt})`;
    return this.page(items,0,Number(limit),Number(radiusKm),snapshotAt,expiresAt,
      async offset=>{
        const token=randomBytes(32).toString('base64url');
        await this.db.$executeRaw`INSERT INTO nearby_page_cursor
          (token_digest,search_id,page_offset) VALUES
          (${digest(token)},${searchId}::uuid,${offset})`;
        return token;
      });
  }
  private async issueCursor(_accountId:string,_params:Buffer,offset:number,prior:string):Promise<string> {
    const token=randomBytes(32).toString('base64url');
    await this.db.$executeRaw`INSERT INTO nearby_page_cursor
      (token_digest,search_id,page_offset)
      SELECT ${digest(token)},search_id,${offset} FROM nearby_page_cursor
      WHERE token_digest=${digest(prior)}`;
    return token;
  }
  private async page(items:Item[],offset:number,limit:number,radiusKm:number,
    snapshotAt:Date,expiresAt:Date,cursor:(offset:number)=>Promise<string>):Promise<Data> {
    const selected=items.slice(offset,offset+limit);
    const hasMore=offset+limit<items.length;
    return {items:selected,radius_km:radiusKm,limit,snapshot_at:stamp(snapshotAt),
      expires_at:stamp(expiresAt),has_more:hasMore,
      ...(hasMore?{next_cursor:await cursor(offset+limit)}:{})};
  }
}
