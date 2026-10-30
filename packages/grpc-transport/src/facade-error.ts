import * as grpc from '@grpc/grpc-js';
import protobuf from 'protobufjs';
import { fileURLToPath } from 'node:url';

const root=protobuf.loadSync(fileURLToPath(new URL(
  '../../../contracts/proto/cab/gateway/v1/customer_facade.proto',import.meta.url)));
protobuf.parse(`syntax = "proto3"; package google.protobuf;
  message Any { string type_url = 1; bytes value = 2; }`,root);
protobuf.parse(`syntax = "proto3"; package google.rpc;
  message Status { int32 code = 1; string message = 2; repeated google.protobuf.Any details = 3; }`,root);
const statusType=root.lookupType('google.rpc.Status');
const detailType=root.lookupType('cab.gateway.v1.FacadeErrorDetail');
const typeUrl='type.googleapis.com/cab.gateway.v1.FacadeErrorDetail';

export function facadeError(code:grpc.status,reason:string,origin?:'END_USER'|'SERVICE',
  retryAfterSeconds?:number):grpc.ServiceError {
  const metadata=new grpc.Metadata();
  const detail=detailType.fromObject({error:{errorCode:reason,message:reason},
    ...(origin?{authOrigin:origin}:{}),
    ...(retryAfterSeconds?{retryAfterSeconds}:{})});
  const status=statusType.create({code,message:reason,details:[{
    typeUrl,value:detailType.encode(detail).finish(),
  }]});
  metadata.set('grpc-status-details-bin',Buffer.from(statusType.encode(status).finish()));
  return Object.assign(new Error(reason),{code,details:reason,metadata});
}

export interface DecodedFacadeError { code:grpc.status; reason:string; origin?:string; retryAfterSeconds?:number }
export function decodeFacadeError(error:grpc.ServiceError):DecodedFacadeError|null {
  const value=error.metadata?.get('grpc-status-details-bin')[0];
  if (!Buffer.isBuffer(value)) return null;
  try {
    const status=statusType.toObject(statusType.decode(value),{enums:String,bytes:Buffer}) as {
      code:number;details?:{typeUrl:string;value:Buffer}[]};
    if (status.code!==error.code || status.details?.length!==1 ||
        status.details[0]?.typeUrl!==typeUrl) return null;
    const detail=detailType.toObject(detailType.decode(status.details[0].value),{enums:String}) as {
      error?:{errorCode?:string};authOrigin?:string;retryAfterSeconds?:number};
    if (!detail.error?.errorCode) return null;
    return {code:error.code,reason:detail.error.errorCode,origin:detail.authOrigin,
      retryAfterSeconds:detail.retryAfterSeconds};
  } catch {return null;}
}
