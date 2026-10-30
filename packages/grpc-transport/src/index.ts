import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSecureContext } from 'node:tls';
import type { PeerCertificate } from 'node:tls';
import * as grpc from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
export { facadeError, decodeFacadeError } from './facade-error.js';
export { describeStartupFailure } from './startup-error.js';
export { markWorkerHealthy } from './worker-health.js';

export interface TlsMaterial { ca: Buffer; cert: Buffer; key: Buffer }
export const identityPrefix = 'spiffe://cab.local/service/';
// RPC.md and GATEWAY-CUSTOMER.md: serialized protobuf bytes per unary message.
const maxUnaryMessageBytes = 1024 * 1024;
const clientAuth = '1.3.6.1.5.5.7.3.2';
const serverAuth = '1.3.6.1.5.5.7.3.1';

// Node escapes ambiguous SAN values as JSON strings. Reject those instead of
// splitting an attacker-controlled quoted URI into apparently trusted entries.
export function certificateIdentity(raw: Buffer, purpose: 'client' | 'server'): string {
  const cert = new X509Certificate(raw);
  const now = Date.now();
  const from = Date.parse(cert.validFrom);
  const to = Date.parse(cert.validTo);
  if (cert.ca || !Number.isFinite(from) || !Number.isFinite(to) ||
      now < from || now >= to || to - from > 24 * 60 * 60 * 1000) {
    throw new Error('Invalid service certificate validity');
  }
  if (!cert.keyUsage?.includes(purpose === 'client' ? clientAuth : serverAuth)) {
    throw new Error('Invalid service certificate EKU');
  }
  const san = cert.subjectAltName ?? '';
  if (/["\\\r\n]/.test(san)) throw new Error('Ambiguous certificate SAN');
  const uris = san.split(', ').filter(value => value.startsWith('URI:'));
  if (uris.length !== 1 || !/^URI:spiffe:\/\/cab\.local\/service\/[a-z][a-z0-9-]*$/.test(uris[0]!)) {
    throw new Error('Invalid service URI SAN');
  }
  return uris[0]!.slice('URI:'.length);
}

export function clientCredentials(tls: TlsMaterial, expectedService: string): grpc.ChannelCredentials {
  // TLS validates the trust chain and dates before invoking this callback.
  // URI SAN is the CAB endpoint identity, not the loopback/DNS dial address.
  return grpc.credentials.createFromSecureContext(createSecureContext({
    ca: tls.ca, cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2',
  }), {
    rejectUnauthorized: true,
    checkServerIdentity: serverIdentityVerifier(expectedService),
  });
}

export function serverIdentityVerifier(expectedService: string) {
  if (!/^[a-z][a-z0-9-]*$/.test(expectedService)) throw new Error('Invalid expected service');
  return (_hostname: string, cert: PeerCertificate): Error | undefined => {
    try {
      if (!cert.raw || certificateIdentity(cert.raw, 'server') !== identityPrefix + expectedService) {
        return new Error('Service server identity mismatch');
      }
      return undefined;
    } catch {
      return new Error('Invalid service server certificate');
    }
  };
}

export function createClient(address: string, tls: TlsMaterial, expectedService: string): grpc.Client {
  return new grpc.Client(address, clientCredentials(tls, expectedService), {
    'grpc.max_send_message_length': maxUnaryMessageBytes,
    'grpc.max_receive_message_length': maxUnaryMessageBytes,
  });
}

export interface MethodPolicy { callers: string[]; scope: string; ownerService?: string }
interface Policy { default: 'deny'; identityPrefix: string; package?: string; methods: Record<string, MethodPolicy> }
const contracts = fileURLToPath(new URL('../../../contracts/', import.meta.url));
export function contractPath(relativePath: string): string {
  // Call sites supply source-controlled paths, never request data.
  return fileURLToPath(new URL(relativePath, new URL('../../../contracts/', import.meta.url)));
}
function readPolicy(name: string, namespace: string): Policy {
  const policy: Policy = JSON.parse(readFileSync(contracts + name, 'utf8'));
  if (policy.default !== 'deny' || policy.identityPrefix !== identityPrefix ||
      (policy.package !== undefined && policy.package !== namespace)) throw new Error('Invalid caller policy');
  for (const [method, entry] of Object.entries(policy.methods)) {
    if (!method.startsWith('/' + namespace + '.') || !Array.isArray(entry.callers) ||
        !entry.callers.every(caller => /^[a-z][a-z0-9-]*$/.test(caller)) ||
        typeof entry.scope !== 'string' ||
        (namespace === 'cab.gateway.v1' && typeof entry.ownerService !== 'string')) throw new Error('Invalid method policy');
  }
  return policy;
}

export class CallerPolicy {
  private readonly facade = readPolicy('gateway-customer-policy.json', 'cab.gateway.v1');
  private readonly internal = readPolicy('rpc-policy.json', 'cab.internal.v1');
  allows(method: string, callerUri: string, ownerService: string): boolean {
    // Exact namespace dispatch. There is intentionally no fallback.
    const selected = method.startsWith('/cab.gateway.v1.') ? this.facade :
      method.startsWith('/cab.internal.v1.') ? this.internal : undefined;
    const entry = selected?.methods[method];
    const internalOwner = /^\/cab\.internal\.v1\.(Identity|Customer|Driver|Booking|Trip|Payment|Rating|Notification)InternalService\//.exec(method)?.[1];
    const owner = selected === this.internal ? internalOwner?.toLowerCase() + '-service' : entry?.ownerService;
    return !!entry && owner === ownerService &&
      entry.callers.some(caller => callerUri === identityPrefix + caller);
  }
}

export function callerInterceptor(ownerService: string, policy = new CallerPolicy()): grpc.ServerInterceptor {
  return (descriptor, call) => new grpc.ServerInterceptingCall(call, {
    start: next => {
      let caller: string;
      try {
        const auth = call.getAuthContext();
        if (auth.transportSecurityType !== 'ssl' || !auth.sslPeerCertificate?.raw) throw new Error('No trusted TLS peer');
        caller = certificateIdentity(auth.sslPeerCertificate.raw, 'client');
      } catch {
        call.sendStatus({ code: grpc.status.UNAUTHENTICATED, details: 'Service certificate rejected' });
        return;
      }
      if (!policy.allows(descriptor.path, caller, ownerService)) {
        call.sendStatus({ code: grpc.status.PERMISSION_DENIED, details: 'Service method denied' });
        return;
      }
      // No metadata participates in service identity or scope decisions.
      next({ onReceiveMetadata: (metadata, forward) => {
        const entries = Object.entries(metadata.toJSON());
        const size = entries.reduce((n,[key,values]) => n + values.reduce((sum,value) =>
          sum + Buffer.byteLength(key) + (Buffer.isBuffer(value) ? value.length :
            Buffer.byteLength(String(value))),0),0);
        if (size > 8 * 1024) {
          call.sendStatus({code:grpc.status.RESOURCE_EXHAUSTED,details:'Metadata limit exceeded'});
          return;
        }
        forward(metadata);
      } });
    },
  });
}

export function createServer(ownerService: string, tls: TlsMaterial): grpc.Server {
  // Fail before binding if our own certificate is wrong.
  if (certificateIdentity(tls.cert, 'server') !== identityPrefix + ownerService) {
    throw new Error('Local server identity mismatch');
  }
  const server = new grpc.Server({
    interceptors: [callerInterceptor(ownerService)],
    'grpc.max_send_message_length': maxUnaryMessageBytes,
    'grpc.max_receive_message_length': maxUnaryMessageBytes,
    // grpc-js adds +/-10% jitter: 8m * 1.1 + 30s grace stays below 10m.
    'grpc.max_connection_age_ms': 8 * 60 * 1000,
    'grpc.max_connection_age_grace_ms': 30 * 1000,
  });
  return server;
}

export async function bindServer(server: grpc.Server, address: string, tls: TlsMaterial): Promise<number> {
  // true requests AND requires a client certificate; no insecure credentials.
  const credentials = grpc.ServerCredentials.createSsl(tls.ca, [{
    private_key: tls.key, cert_chain: tls.cert,
  }], true);
  return new Promise((resolve, reject) => {
    server.bindAsync(address, credentials, (error, port) => error ? reject(error) : resolve(port));
  });
}

export async function closeServer(server: grpc.Server): Promise<void> {
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { server.forceShutdown(); resolve(); }, 1000);
    timer.unref();
    server.tryShutdown(() => { clearTimeout(timer); resolve(); });
  });
}

export function serviceDefinition(name: string, protoRelativePath: string): grpc.ServiceDefinition {
  const loaded = loadSync(contractPath(protoRelativePath), {
    includeDirs: [contractPath('proto/')],
    keepCase: true, longs: String, enums: String, defaults: false, oneofs: true,
  });
  const definition = loaded[name];
  if (!definition || 'format' in definition) {
    throw new Error('Missing service contract');
  }
  return definition as grpc.ServiceDefinition;
}

export function unaryCall<Request extends object, Response extends object>(
  client: grpc.Client, definition: grpc.ServiceDefinition, method: string,
  request: Request, metadata: grpc.Metadata, deadlineMs: number,
): Promise<Response> {
  const descriptor = definition[method];
  if (!descriptor || descriptor.requestStream || descriptor.responseStream) throw new Error('Invalid unary method');
  const bytes = Object.entries(metadata.toJSON()).reduce((size,[key,values]) => size +
    values.reduce((sum,value) => sum + Buffer.byteLength(key) +
      (Buffer.isBuffer(value) ? value.length : Buffer.byteLength(String(value))),0),0);
  if (bytes > 8 * 1024) throw new Error('Metadata limit exceeded');
  return new Promise<Response>((resolve,reject) => client.makeUnaryRequest(
    descriptor.path,descriptor.requestSerialize,descriptor.responseDeserialize,request,metadata,
    {deadline:new Date(Date.now()+deadlineMs)},(error,response) => error ? reject(error) :
      resolve(response as Response)));
}

export function readTlsFromEnvironment(prefix: string): TlsMaterial {
  const readRequired = (suffix: string) => {
    const path = process.env[prefix + '_' + suffix];
    if (!path) throw new Error('Missing transport TLS configuration');
    return readFileSync(path); // Only explicit workload certificate paths; never dotenv/global credentials.
  };
  return { ca: readRequired('CA_FILE'), cert: readRequired('CERT_FILE'), key: readRequired('KEY_FILE') };
}
