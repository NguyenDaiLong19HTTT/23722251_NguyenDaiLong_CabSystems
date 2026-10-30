import {describe,expect,it} from 'vitest';
import {canonicalPhone,isDomesticPhone,publicPhone} from '@cab/phone-number';

describe('Vietnamese phone boundary',()=>{
  it('uses one stable lookup value for new and legacy representations',()=>{
    expect(canonicalPhone('0900000101')).toBe('+84900000101');
    expect(canonicalPhone('+84900000101')).toBe('+84900000101');
    expect(publicPhone('+84900000101')).toBe('0900000101');
    expect(publicPhone('0900000101')).toBe('0900000101');
  });
  it('preserves an overlength stored +84 phone only when reading legacy data',()=>{
    expect(publicPhone('+849000000101')).toBe('+849000000101');
    expect(()=>canonicalPhone('+849000000101')).toThrow();
    expect(isDomesticPhone('+849000000101')).toBe(false);
  });
  it.each(['900000101','090000010','09000001011','09000a0101','1900000101','+84900000101',' 0900000101'])
    ('rejects invalid public request %s',value=>{
      expect(isDomesticPhone(value)).toBe(false);
    });
  it('rejects unsupported stored values rather than showing a false phone',()=>{
    expect(()=>publicPhone('+12025550123')).toThrow();
  });
});
