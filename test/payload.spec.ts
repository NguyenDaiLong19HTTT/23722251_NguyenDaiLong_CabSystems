import { afterAll, beforeAll, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { bindServer, callerInterceptor, clientCredentials, closeServer, createClient, createServer } from '@cab/grpc-transport';
import { createTestPki } from './certificates.js';
import type { TestPki } from './certificates.js';

// Independent expected contract bound; do not import the implementation constant.
const limit = 1_048_576;
const permissiveLimit = 4 * limit;
// Test-only diagnostic codec on a policy-approved path. No business DTO/success.
const path = '/cab.gateway.v1.IdentityFacadeService/Login';
interface Payload { text: string }
const loaded = loadSync(fileURLToPath(new URL('./fixtures/payload-probe.proto', import.meta.url)));
const definition = loaded['cab.test.PayloadProbeService'] as grpc.ServiceDefinition;
const probe = definition.Probe! as grpc.MethodDefinition<Payload, Payload>;
let pki: TestPki;
const servers: grpc.Server[] = [];
const clients: grpc.Client[] = [];

function payloadOfWireSize(bytes: number): Payload {
  let textBytes = bytes;
  for (let attempt = 0; attempt < 5; attempt++) {
    const payload = { text: 'x'.repeat(textBytes) };
    const actual = probe.requestSerialize(payload).byteLength;
    if (actual === bytes) return payload;
    textBytes -= actual - bytes;
  }
  throw new Error('Could not construct exact protobuf wire size');
}

async function endpoint(strictServer: boolean, response?: Payload) {
  const tls = pki.material('identity');
  const server = strictServer ? createServer('identity-service', tls) : new grpc.Server({
    interceptors: [callerInterceptor('identity-service')],
    'grpc.max_send_message_length': permissiveLimit,
    'grpc.max_receive_message_length': permissiveLimit,
  });
  servers.push(server);
  const counter = { calls: 0 };
  server.addService({ probe: { ...probe, path } }, {
    probe: (call: grpc.ServerUnaryCall<Payload, Payload>, done: grpc.sendUnaryData<Payload>) => {
      counter.calls++;
      // Echo/probe is test-only; production has no diagnostic success handler.
      done(null, response ?? call.request);
    },
  });
  return { address: 'localhost:' + await bindServer(server, '127.0.0.1:0', tls), counter };
}

function connect(address: string, strictClient: boolean) {
  const tls = pki.material('gateway');
  const client = strictClient ? createClient(address, tls, 'identity-service') : new grpc.Client(
    address, clientCredentials(tls, 'identity-service'), {
      'grpc.max_send_message_length': permissiveLimit,
      'grpc.max_receive_message_length': permissiveLimit,
    },
  );
  clients.push(client);
  return client;
}

function invoke(client: grpc.Client, payload: Payload): Promise<{ error: grpc.ServiceError | null; response?: Payload }> {
  return new Promise(resolve => {
    client.makeUnaryRequest(path, probe.requestSerialize, probe.responseDeserialize,
      payload, new grpc.Metadata(), { deadline: Date.now() + 3000 },
      (error, response) => resolve({ error, response }));
  });
}

function expectExhausted(result: Awaited<ReturnType<typeof invoke>>, source: 'client-send' | 'server-send' | 'receive', bytes: number) {
  expect(result.error?.code).toBe(grpc.status.RESOURCE_EXHAUSTED);
  const details = source === 'client-send' ? 'Attempted to send message with a size larger than ' + limit :
    // grpc-js 1.14.5 compares response.length - 5, but reports framed response.length.
    source === 'server-send' ? 'Sent message larger than max (' + (bytes + 5) + ' vs. ' + limit + ')' :
    'Received message larger than max (' + bytes + ' vs ' + limit + ')';
  expect(result.error?.details).toBe(details);
  expect(result.response).toBeUndefined();
}

beforeAll(() => { pki = createTestPki(); }, 30000);
afterAll(async () => {
  for (const client of clients) client.close();
  for (const server of servers) await closeServer(server);
  if (pki) {
    pki.cleanup();
    expect(existsSync(pki.directory)).toBe(false);
  }
  for (const client of clients) expect(client.getChannel().getConnectivityState(false)).toBe(grpc.connectivityState.SHUTDOWN);
});

it('accepts valid protobuf request AND response exactly 1 MiB with strict client/server', async () => {
  const payload = payloadOfWireSize(limit);
  expect(probe.requestSerialize(payload).byteLength).toBe(limit);
  expect(probe.responseSerialize(payload).byteLength).toBe(limit);
  const target = await endpoint(true);
  const result = await invoke(connect(target.address, true), payload);
  expect(result.error).toBeNull();
  expect(result.response?.text === payload.text).toBe(true);
  expect(target.counter.calls).toBe(1);
});

it('client send rejects 1 MiB + 1 byte with permissive server; handler stays zero', async () => {
  const payload = payloadOfWireSize(limit + 1);
  expect(probe.requestSerialize(payload).byteLength).toBe(limit + 1);
  const target = await endpoint(false);
  expectExhausted(await invoke(connect(target.address, true), payload), 'client-send', limit + 1);
  expect(target.counter.calls).toBe(0);
});

it.each([limit + 1, 2 * limit])('server receive rejects %i protobuf bytes with permissive client BEFORE handler', async bytes => {
  const payload = payloadOfWireSize(bytes);
  expect(probe.requestSerialize(payload).byteLength).toBe(bytes);
  const target = await endpoint(true);
  expectExhausted(await invoke(connect(target.address, false), payload), 'receive', bytes);
  expect(target.counter.calls).toBe(0);
});

it('server send rejects response 1 MiB + 1 byte despite permissive client receive', async () => {
  const response = payloadOfWireSize(limit + 1);
  expect(probe.responseSerialize(response).byteLength).toBe(limit + 1);
  const target = await endpoint(true, response);
  expectExhausted(await invoke(connect(target.address, false), { text: 'small request' }), 'server-send', limit + 1);
  expect(target.counter.calls).toBe(1);
});

it('client receive rejects response 1 MiB + 1 byte sent by permissive server', async () => {
  const response = payloadOfWireSize(limit + 1);
  expect(probe.responseSerialize(response).byteLength).toBe(limit + 1);
  const target = await endpoint(false, response);
  // Positive control: the same server actually delivers this larger response.
  const control = await invoke(connect(target.address, false), { text: 'small request' });
  expect(control.error).toBeNull();
  expect(control.response?.text === response.text).toBe(true);
  expect(target.counter.calls).toBe(1);
  expectExhausted(await invoke(connect(target.address, true), { text: 'small request' }), 'receive', limit + 1);
  expect(target.counter.calls).toBe(2);
});

it('server counts serialized UTF-8 protobuf bytes, not JavaScript string length', async () => {
  const payload = { text: '🚕'.repeat(limit / 4) };
  expect(payload.text.length).toBe(limit / 2);
  expect(probe.requestSerialize(payload).byteLength).toBe(limit + 4);
  const target = await endpoint(true);
  expectExhausted(await invoke(connect(target.address, false), payload), 'receive', limit + 4);
  expect(target.counter.calls).toBe(0);
});
