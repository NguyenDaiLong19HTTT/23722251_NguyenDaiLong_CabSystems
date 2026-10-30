// Test-only PKI. Never import this helper into production code.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { TlsMaterial } from '@cab/grpc-transport';

function opensslExecutable(): string {
  if (process.env.CAB_TEST_OPENSSL) return process.env.CAB_TEST_OPENSSL;
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return 'openssl'; } catch {}
  if (process.platform === 'win32') {
    const git = execFileSync('where.exe', ['git.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]!;
    const candidate = join(dirname(dirname(git)), 'usr', 'bin', 'openssl.exe');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('OpenSSL required for test PKI; use CAB_TEST_OPENSSL with an existing executable');
}
export interface TestPki {
  material(name: string): TlsMaterial;
  cleanup(): void;
  directory: string;
}
export function createTestPki(): TestPki {
  const openssl = opensslExecutable();
  const directory = mkdtempSync(join(tmpdir(), 'cab-mtls-test-'));
  const cleanup = () => {
    // Delete only the exact mkdtemp directory we own, never workspace/volumes.
    if (existsSync(directory)) {
      const absolute = realpathSync(directory);
      if (dirname(absolute) !== realpathSync(tmpdir()) || !basename(absolute).startsWith('cab-mtls-test-')) {
        throw new Error('Refusing PKI cleanup outside the owned temporary directory');
      }
      rmSync(absolute, { recursive: true, force: true });
    }
  };
  const run = (args: string[]) => execFileSync(openssl, args, { cwd: directory, stdio: 'ignore', timeout: 10000 });
  try {
    for (const ca of ['trusted', 'untrusted']) {
      run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
        '-subj', '/CN=CAB-TEST-' + ca, '-keyout', ca + '.key', '-out', ca + '.crt',
        '-addext', 'basicConstraints=critical,CA:TRUE',
        '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
    }
    const issue = (name: string, identity: string | undefined, purpose: string, ca = 'trusted', extraSan = '') => {
      run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', '/CN=ignored-' + name,
        '-keyout', name + '.key', '-out', name + '.csr']);
      const san = identity ? 'URI:spiffe://cab.local/service/' + identity + extraSan : 'DNS:api-gateway';
      writeFileSync(join(directory, name + '.ext'),
        'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n' +
        'extendedKeyUsage=' + purpose + '\nsubjectAltName=' + san + '\n');
      run(['x509', '-req', '-in', name + '.csr', '-CA', ca + '.crt', '-CAkey', ca + '.key',
        '-CAcreateserial', '-days', '1', '-sha256', '-extfile', name + '.ext', '-out', name + '.crt']);
    };
    issue('gateway', 'api-gateway', 'clientAuth');
    issue('identity', 'identity-service', 'serverAuth,clientAuth');
    issue('customer', 'customer-service', 'serverAuth,clientAuth');
    issue('trip', 'trip-service', 'serverAuth,clientAuth');
    issue('payment', 'payment-service', 'serverAuth,clientAuth');
    issue('booking', 'booking-service', 'serverAuth,clientAuth');
    issue('driver', 'driver-service', 'serverAuth,clientAuth');
    issue('outsider', 'rating-service', 'clientAuth');
    issue('untrusted-client', 'api-gateway', 'clientAuth', 'untrusted');
    issue('untrusted-server', 'identity-service', 'serverAuth', 'untrusted');
    issue('wrong-eku', 'api-gateway', 'serverAuth');
    issue('missing-uri', undefined, 'clientAuth');
    issue('multiple-uri', 'api-gateway', 'clientAuth', 'trusted', ',URI:spiffe://cab.local/service/identity-service');
    // Expired client with a valid chain and correct URI/EKU, using explicit dates.
    issue('expired', 'api-gateway', 'clientAuth');
    issue('expired-server', 'identity-service', 'serverAuth');
    writeFileSync(join(directory, 'index'), '');
    writeFileSync(join(directory, 'serial'), '2000\n');
    const path = (name: string) => resolve(directory, name).replaceAll('\\', '/');
    writeFileSync(join(directory, 'ca.conf'), `[ca]
default_ca=issuer
[issuer]
database="${path('index')}"
serial="${path('serial')}"
new_certs_dir="${path('.')}"
certificate="${path('trusted.crt')}"
private_key="${path('trusted.key')}"
default_md=sha256
policy=subject
[subject]
commonName=supplied
`);
    for (const name of ['expired', 'expired-server']) {
      run(['ca', '-batch', '-config', 'ca.conf', '-in', name + '.csr', '-out', name + '.crt',
        '-startdate', '20200101000000Z', '-enddate', '20200101230000Z',
        '-extfile', name + '.ext', '-notext']);
    }
    return {
      directory,
      material: name => ({
        // Dialers always trust the trusted CA, even if their own leaf is rogue.
        ca: readFileSync(join(directory, 'trusted.crt')),
        cert: readFileSync(join(directory, name + '.crt')),
        key: readFileSync(join(directory, name + '.key')),
      }),
      cleanup,
    };
  } catch (error) { cleanup(); throw error; }
}
