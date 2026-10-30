import * as grpc from '@grpc/grpc-js';
import { describe, expect, it } from 'vitest';
import { serviceDefinition } from '@cab/grpc-transport';
import { mapCustomerProfile } from '../src/application/customer-profile.js';

const accountId='11111111-1111-4111-8111-111111111111';
const customerId='22222222-2222-4222-8222-222222222222';
const created={seconds:'1700000000',nanos:123000000};
const updated={seconds:'1700000100',nanos:456000000};
const fixture={account_id:accountId,full_name:'Probe Customer',
  email:'probe@example.test',phone:'+84900000000',account_version:'3',
  verified_at:{seconds:'1700000200',nanos:0},
  account_status:'INACTIVE',created_at:created,updated_at:updated};
const method=serviceDefinition('cab.internal.v1.IdentityInternalService',
  'proto/cab/internal/v1/identity.proto').GetAccountContact!;
const wire=(value:Record<string,unknown>)=>method.responseDeserialize(method.responseSerialize(value));

describe('CustomerProfile from Identity AccountContact',()=>{
  it('roundtrips all three new protobuf fields and preserves Identity Account timestamps',()=>{
    const decoded=wire(fixture);
    const dto=mapCustomerProfile(accountId,customerId,decoded);
    expect(dto).toMatchObject({account_id:accountId,customer_id:customerId,
      account_status:'INACTIVE',created_at:created,updated_at:updated});
    expect(dto.created_at).not.toEqual(fixture.verified_at);
    expect(mapCustomerProfile(accountId,customerId,wire({...fixture,account_status:'SUSPENDED'}))
      .account_status).toBe('SUSPENDED');
  });

  it.each([
    ['missing status',{account_status:undefined}],
    ['unspecified status',{account_status:'ACCOUNT_STATUS_UNSPECIFIED'}],
    ['missing created_at',{created_at:undefined}],
    ['missing updated_at',{updated_at:undefined}],
    ['wrong account',{account_id:'33333333-3333-4333-8333-333333333333'}],
  ])('fails closed for %s after protobuf decoding',(_case,changed)=>{
    expect(()=>mapCustomerProfile(accountId,customerId,wire({...fixture,...changed})))
      .toThrow(expect.objectContaining({code:grpc.status.UNAVAILABLE}));
  });

  it.each([
    ['wrong enum',{account_status:'GARBAGE'}],
    ['negative nanos',{updated_at:{seconds:'1700000100',nanos:-1}}],
    ['overflow nanos',{updated_at:{seconds:'1700000100',nanos:1000000000}}],
    ['missing seconds',{created_at:{nanos:0}}],
  ])('fails closed for %s before REST rendering',(_case,changed)=>{
    expect(()=>mapCustomerProfile(accountId,customerId,{...fixture,...changed}))
      .toThrow(expect.objectContaining({code:grpc.status.UNAVAILABLE}));
  });
});
