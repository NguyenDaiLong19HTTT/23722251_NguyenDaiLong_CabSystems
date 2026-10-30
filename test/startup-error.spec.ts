import {describe,expect,it} from 'vitest';
import {describeStartupFailure} from '@cab/grpc-transport';

describe('safe startup diagnostics',()=>{
  it('names an expired workload certificate without exposing data',()=>{
    expect(describeStartupFailure(new Error('Invalid service certificate validity')))
      .toContain('dev:certs:renew');
  });
  it('never echoes an unknown error containing credentials',()=>{
    const message=describeStartupFailure(new Error(
      'postgresql://identity_runtime:secret-marker@127.0.0.1:55439/cab_identity'));
    expect(message).toContain('dev:diagnose');
    expect(message).not.toContain('secret-marker');
    expect(message).not.toContain('postgresql://');
  });
});
