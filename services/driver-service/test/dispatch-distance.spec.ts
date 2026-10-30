import {describe,expect,it} from 'vitest';
import {distanceMeters} from '../src/application/dispatch-candidates.js';

describe('dispatch geodesic distance',()=>{
  const pickup={latitude:10.7731,longitude:106.703};
  it('keeps exact distance for a one kilometre filter before display rounding',()=>{
    const inside=distanceMeters(pickup,{latitude:10.7819,longitude:106.703});
    const outside=distanceMeters(pickup,{latitude:10.7822,longitude:106.703});
    expect(inside).toBeGreaterThan(970);
    expect(inside).toBeLessThan(1000);
    expect(outside).toBeGreaterThan(1000);
    expect(Math.floor(inside/10)*10).toBeLessThan(1000);
  });
  it('returns zero only for identical coordinates',()=>{
    expect(distanceMeters(pickup,pickup)).toBe(0);
    expect(distanceMeters(pickup,{latitude:pickup.latitude,longitude:pickup.longitude+0.01}))
      .toBeGreaterThan(1000);
  });
});
