import 'reflect-metadata';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { NestFactory } from '@nestjs/core';
import * as grpc from '@grpc/grpc-js';
import {
  bindServer, closeServer, createClient, createServer, serviceDefinition, serverIdentityVerifier, callerInterceptor,
  readTlsFromEnvironment,
} from '@cab/grpc-transport';
import type { TlsMaterial } from '@cab/grpc-transport';
import { createTestPki } from './certificates.js';
import type { TestPki } from './certificates.js';
import { GatewayModule } from '../services/api-gateway/src/app.module.js';
import { GatewayGrpcClients } from '../services/api-gateway/src/infrastructure/grpc-clients.js';
import { IdentityCoreModule } from '../services/identity-service/src/app.module.js';
import { IdentityGrpcTransport } from '../services/identity-service/src/infrastructure/grpc-transport.js';
import { CustomerCoreModule } from '../services/customer-service/src/app.module.js';
import { CustomerGrpcTransport } from '../services/customer-service/src/infrastructure/grpc-transport.js';

const login = '/cab.gateway.v1.IdentityFacadeService/Login';
const getCustomer = '/cab.gateway.v1.CustomerFacadeService/GetCustomer';
const provision = '/cab.internal.v1.CustomerInternalService/ProvisionCustomer';
const compensate = '/cab.internal.v1.CustomerInternalService/CancelCustomerProvision';
const verify = '/cab.internal.v1.IdentityInternalService/VerifyUserIdentity';
const missing = '/cab.gateway.v1.CustomerFacadeService/TestOnlyNoPolicy';
const unknownPackage = '/cab.other.v1.TestOnlyService/Call';
let pki: TestPki;
const servers: grpc.Server[] = [];
const clients: grpc.Client[] = [];
const calls = new Map<string, number>();
let identityAddress: string;
let customerAddress: string;

function invoke(client: grpc.Client, method: string, metadata = new grpc.Metadata()): Promise<number> {
  return new Promise((resolve, reject) => {
    client.makeUnaryRequest(method, (value: Buffer) => value, (value: Buffer) => value,
      Buffer.alloc(0), metadata, { deadline: Date.now() + 2500 },
      error => error ? resolve(error.code) : reject(new Error('Unexpected business success')));
  });
}
function client(address: string, name = 'gateway', expectedService = 'customer-service') {
  const value = createClient(address, pki.material(name), expectedService);
  clients.push(value);
  return value;
}
function installTestHandlers(server: grpc.Server, definition: grpc.ServiceDefinition) {
  const handlers: grpc.UntypedServiceImplementation = {};
  for (const [name, descriptor] of Object.entries(definition)) {
    handlers[name] = (_call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      calls.set(descriptor.path, (calls.get(descriptor.path) ?? 0) + 1);
      callback({ code: grpc.status.UNIMPLEMENTED, details: 'Test handler reached after service auth' });
    };
  }
  server.addService(definition, handlers);
}
async function startHarness(owner: string, tls: TlsMaterial, definitions: grpc.ServiceDefinition[]) {
  const server = createServer(owner, tls);
  servers.push(server);
  for (const definition of definitions) installTestHandlers(server, definition);
  return 'localhost:' + await bindServer(server, '127.0.0.1:0', tls);
}
function synthetic(path: string): grpc.ServiceDefinition {
  return { call: {
    path, requestStream: false, responseStream: false,
    requestSerialize: (value: Buffer) => value, requestDeserialize: (value: Buffer) => value,
    responseSerialize: (value: Buffer) => value, responseDeserialize: (value: Buffer) => value,
  } };
}
async function denied(client: grpc.Client, method: string, code: number, metadata = new grpc.Metadata()) {
  const before = calls.get(method) ?? 0;
  expect(await invoke(client, method, metadata)).toBe(code);
  expect(calls.get(method) ?? 0).toBe(before);
}

beforeAll(async () => {
  pki = createTestPki();
  identityAddress = await startHarness('identity-service', pki.material('identity'), [
    serviceDefinition('cab.gateway.v1.IdentityFacadeService', 'proto/cab/gateway/v1/customer_facade.proto'),
    serviceDefinition('cab.internal.v1.IdentityInternalService', 'proto/cab/internal/v1/identity.proto'),
  ]);
  customerAddress = await startHarness('customer-service', pki.material('customer'), [
    serviceDefinition('cab.gateway.v1.CustomerFacadeService', 'proto/cab/gateway/v1/customer_facade.proto'),
    serviceDefinition('cab.internal.v1.CustomerInternalService', 'proto/cab/internal/v1/customer.proto'),
    synthetic(missing), synthetic(unknownPackage),
  ]);
}, 30000);

afterAll(async () => {
  for (const value of clients) value.close();
  for (const server of servers) await closeServer(server);
  if (pki) {
    pki.cleanup();
    expect(existsSync(pki.directory)).toBe(false);
  }
  for (const value of clients) expect(value.getChannel().getConnectivityState(false)).toBe(grpc.connectivityState.SHUTDOWN);
});

it('PASS: valid CA/URI SAN/EKU Gateway -> Identity and Customer; handler reached only after auth', async () => {
  const app = await NestFactory.createApplicationContext(GatewayModule, { logger: false, abortOnError: false });
  const channels: grpc.Client[] = [];
  try {
    const connections = app.get(GatewayGrpcClients);
    const identity = connections.connect(identityAddress, pki.material('gateway'), 'identity-service');
    const customer = connections.connect(customerAddress, pki.material('gateway'), 'customer-service');
    channels.push(identity, customer);
    for (const [value, method] of [[identity, login], [customer, getCustomer]] as const) {
      const before = calls.get(method) ?? 0;
      expect(await invoke(value, method)).toBe(grpc.status.UNIMPLEMENTED);
      expect(calls.get(method)).toBe(before + 1);
    }
  } finally { await app.close(); }
  for (const value of channels) expect(value.getChannel().getConnectivityState(false)).toBe(grpc.connectivityState.SHUTDOWN);
});

it('PASS: Identity -> Customer provisioning and Customer -> Identity verify allowed by internal policy', async () => {
  for (const [value, method] of [
    [client(customerAddress, 'identity'), provision],
    [client(identityAddress, 'customer', 'identity-service'), verify],
  ] as const) {
    const before = calls.get(method) ?? 0;
    expect(await invoke(value, method)).toBe(grpc.status.UNIMPLEMENTED);
    expect(calls.get(method)).toBe(before + 1);
  }
});

it('PASS: metadata above 8 KiB is rejected before an authorized handler, including repeated values', async () => {
  const metadata = new grpc.Metadata();
  metadata.add('x-cab-padding','x'.repeat(5000));
  metadata.add('x-cab-padding','y'.repeat(4000));
  await denied(client(identityAddress,'gateway','identity-service'),login,
    grpc.status.RESOURCE_EXHAUSTED,metadata);
});

it.each([
  '/cab.gateway.v1.IdentityFacadeService/RegisterCustomer',
  '/cab.gateway.v1.IdentityFacadeService/GetCustomerRegistration',
  '/cab.gateway.v1.IdentityFacadeService/GetMyAccount',
])('PASS: remaining facade method permits Gateway service identity %s', async method => {
  const before = calls.get(method) ?? 0;
  expect(await invoke(client(identityAddress, 'gateway', 'identity-service'), method)).toBe(grpc.status.UNIMPLEMENTED);
  expect(calls.get(method)).toBe(before + 1);
});

it('PASS: registered methods on the wrong owner service denied for both namespaces; no handler', async () => {
  const address = await startHarness('identity-service', pki.material('identity'), [
    serviceDefinition('cab.gateway.v1.CustomerFacadeService', 'proto/cab/gateway/v1/customer_facade.proto'),
    serviceDefinition('cab.internal.v1.CustomerInternalService', 'proto/cab/internal/v1/customer.proto'),
  ]);
  await denied(client(address, 'gateway', 'identity-service'), getCustomer, grpc.status.PERMISSION_DENIED);
  await denied(client(address, 'identity', 'identity-service'), provision, grpc.status.PERMISSION_DENIED);
});

it('PASS: no client certificate fails TLS; no handler', async () => {
  // Test-only negative credential. Production factory requires a full key pair.
  let serverIdentityChecked = false;
  const verifyServer = serverIdentityVerifier('customer-service');
  const value = new grpc.Client(customerAddress, grpc.credentials.createSsl(pki.material('gateway').ca, null, null, {
    rejectUnauthorized: true,
    checkServerIdentity: (host, cert) => {
      const error = verifyServer(host, cert);
      if (!error) serverIdentityChecked = true;
      return error;
    },
  }));
  clients.push(value);
  await denied(value, getCustomer, grpc.status.UNAVAILABLE);
  expect(serverIdentityChecked).toBe(true);
});

it('PASS: plaintext client cannot reach the mTLS listener; no handler', async () => {
  const value = new grpc.Client(customerAddress, grpc.credentials.createInsecure()); // Negative test only.
  clients.push(value);
  await denied(value, getCustomer, grpc.status.UNAVAILABLE);
});

it('PASS: expired server certificate fails client validity verification; no handler', async () => {
  // Deliberately invalid test endpoint: production createServer refuses this leaf before binding.
  const server = new grpc.Server({ interceptors: [callerInterceptor('identity-service')] });
  servers.push(server);
  installTestHandlers(server, serviceDefinition('cab.gateway.v1.IdentityFacadeService',
    'proto/cab/gateway/v1/customer_facade.proto'));
  const port = await bindServer(server, '127.0.0.1:0', pki.material('expired-server'));
  await denied(client('localhost:' + port, 'gateway', 'identity-service'), login, grpc.status.UNAVAILABLE);
});

it('PASS: client certificate from untrusted CA fails TLS; no handler', async () => {
  await denied(client(customerAddress, 'untrusted-client'), getCustomer, grpc.status.UNAVAILABLE);
});

it('PASS: server certificate from untrusted CA fails client TLS verification; no handler', async () => {
  const address = await startHarness('identity-service', pki.material('untrusted-server'), [
    serviceDefinition('cab.gateway.v1.IdentityFacadeService', 'proto/cab/gateway/v1/customer_facade.proto'),
  ]);
  await denied(client(address, 'gateway', 'identity-service'), login, grpc.status.UNAVAILABLE);
});

it('PASS: trusted certificate but wrong server URI SAN fails endpoint identity; no handler', async () => {
  await denied(client(customerAddress, 'gateway', 'identity-service'), getCustomer, grpc.status.UNAVAILABLE);
});

it('PASS: expired client certificate fails TLS; no handler', async () => {
  await denied(client(customerAddress, 'expired'), getCustomer, grpc.status.UNAVAILABLE);
});

it('PASS: client with server-only EKU fails TLS; no handler', async () => {
  await denied(client(customerAddress, 'wrong-eku'), getCustomer, grpc.status.UNAVAILABLE);
});

it.each(['missing-uri', 'multiple-uri'])('PASS: %s client identity fails service authentication; no handler', async name => {
  await denied(client(customerAddress, name), getCustomer, grpc.status.UNAUTHENTICATED);
});

it('PASS: valid rating-service caller lacks facade permission; no handler', async () => {
  await denied(client(customerAddress, 'outsider'), getCustomer, grpc.status.PERMISSION_DENIED);
});

it.each([provision, compensate])('PASS: Gateway denied internal provisioning/compensation %s; no handler', async method => {
  await denied(client(customerAddress), method, grpc.status.PERMISSION_DENIED);
});

it('PASS: forged caller/role/scope metadata cannot grant Gateway internal permission; no handler', async () => {
  const metadata = new grpc.Metadata();
  metadata.set('x-service-name', 'identity-service');
  metadata.set('scope', 'profile:provision');
  metadata.set('role', 'OPERATOR');
  metadata.set('x-cab-caller', 'identity-service');
  await denied(client(customerAddress), provision, grpc.status.PERMISSION_DENIED, metadata);
});

it('PASS: registered facade method without policy denied; no handler', async () => {
  await denied(client(customerAddress), missing, grpc.status.PERMISSION_DENIED);
});

it('PASS: unknown package has no fallback policy; no handler', async () => {
  await denied(client(customerAddress), unknownPackage, grpc.status.PERMISSION_DENIED);
});

it('PASS: internal caller identity-service cannot reuse internal permission for facade', async () => {
  await denied(client(customerAddress, 'identity'), getCustomer, grpc.status.PERMISSION_DENIED);
});

it('PASS: production Nest transport providers bind mTLS on dynamic loopback and close listener/channel', async () => {
  // Network-only harness uses the production transport providers without opening a database.
  for (const [prefix, name] of [['IDENTITY_SERVICE', 'identity'], ['CUSTOMER_SERVICE', 'customer']] as const) {
    vi.stubEnv(prefix + '_GRPC_BIND', '127.0.0.1:0');
    vi.stubEnv(prefix + '_CA_FILE', join(pki.directory, 'trusted.crt'));
    vi.stubEnv(prefix + '_CERT_FILE', join(pki.directory, name + '.crt'));
    vi.stubEnv(prefix + '_KEY_FILE', join(pki.directory, name + '.key'));
  }
  const apps: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>[] = [];
  const ports: number[] = [];
  const values: grpc.Client[] = [];
  try {
    const identity = await NestFactory.createApplicationContext(IdentityCoreModule, { logger: false, abortOnError: false });
    apps.push(identity);
    await identity.get(IdentityGrpcTransport).start(readTlsFromEnvironment('IDENTITY_SERVICE'), '127.0.0.1:0');
    const customer = await NestFactory.createApplicationContext(CustomerCoreModule, { logger: false, abortOnError: false });
    apps.push(customer);
    await customer.get(CustomerGrpcTransport).start(readTlsFromEnvironment('CUSTOMER_SERVICE'), '127.0.0.1:0');
    ports.push(identity.get(IdentityGrpcTransport).listeningPort!);
    ports.push(customer.get(CustomerGrpcTransport).listeningPort!);
    expect(identity.get(IdentityGrpcTransport).config.listenerEnabled).toBe(true);
    expect(customer.get(CustomerGrpcTransport).config.listenerEnabled).toBe(true);
    values.push(createClient('localhost:' + ports[0], pki.material('gateway'), 'identity-service'));
    values.push(createClient('localhost:' + ports[1], pki.material('gateway'), 'customer-service'));
    expect(await invoke(values[0]!, login)).toBe(grpc.status.UNIMPLEMENTED);
    expect(await invoke(values[1]!, getCustomer)).toBe(grpc.status.UNIMPLEMENTED);
    expect(await invoke(values[1]!, provision)).toBe(grpc.status.PERMISSION_DENIED);
  } finally {
    for (const value of values) value.close();
    for (const app of apps) await app.close();
    vi.unstubAllEnvs();
  }
  const [identity, customer] = apps;
  expect(values.every(value => value.getChannel().getConnectivityState(false) === grpc.connectivityState.SHUTDOWN)).toBe(true);
  expect(identity!.get(IdentityGrpcTransport).listeningPort).toBeUndefined();
  expect(customer!.get(CustomerGrpcTransport).listeningPort).toBeUndefined();
  for (const port of ports) {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(1000);
      socket.once('connect', () => { socket.destroy(); reject(new Error('Listener remained open')); });
      socket.once('timeout', () => { socket.destroy(); reject(new Error('Shutdown probe timed out')); });
      socket.once('error', (error: NodeJS.ErrnoException) => {
        socket.destroy();
        error.code === 'ECONNREFUSED' ? resolve() : reject(error);
      });
    });
  }
});
