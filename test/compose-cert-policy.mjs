import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validWorkloadWindow} from '../dev/compose/cert-policy.mjs';

const start=Date.parse('2026-10-14T11:14:26Z');
const leaf=duration=>({validFrom:new Date(start).toUTCString(),
  validTo:new Date(start+duration).toUTCString()});

test('workload certificate accepts exactly 24 hours',()=>{
  assert.equal(validWorkloadWindow(leaf(86400000),start+1000),true);
});
test('workload certificate rejects 24 hours plus one second',()=>{
  assert.equal(validWorkloadWindow(leaf(86401000),start+1000),false);
});
test('workload certificate rejects expiry and insufficient renewal margin',()=>{
  assert.equal(validWorkloadWindow(leaf(86400000),start+86400000),false);
  assert.equal(validWorkloadWindow(leaf(86400000),start+23*3600000,3600000),false);
});
