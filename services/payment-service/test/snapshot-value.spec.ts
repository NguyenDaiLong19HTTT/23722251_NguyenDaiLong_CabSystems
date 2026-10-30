import {describe,expect,it} from 'vitest';
import {sameSnapshotValue} from '../src/infrastructure/owner-context.js';

describe('Payment immutable snapshot comparison',()=>{
  it('accepts protobuf and jsonb object key order without changing values',()=>{
    expect(sameSnapshotValue({nanos:892000000,seconds:'1791787344'},
      {seconds:'1791787344',nanos:892000000})).toBe(true);
  });
  it('rejects changed timestamp or decimal type',()=>{
    expect(sameSnapshotValue({seconds:'1791787344',nanos:892000000},
      {seconds:'1791787344',nanos:892000001})).toBe(false);
    expect(sameSnapshotValue({value:'5300'},{value:5300})).toBe(false);
  });
});
