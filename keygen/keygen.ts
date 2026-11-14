// Cutline licence key generator. Owner's tool: it is not part of the app and is never shipped.
//
//   node keygen/keygen.ts init
//       Create the signing key pair. The private key is written to keygen/private-key.json (git-ignored;
//       keep a backup somewhere safe, it cannot be recreated). The public key is written into
//       src/core/licenseKey.ts, which is built into the app.
//   node keygen/keygen.ts make --name "Jane Doe" [--edition Pro] [--expires 2027-12-31]
//       Print a licence key.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT, signLicense, verifyLicense } from '../src/core/license.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const PRIVATE_KEY_FILE = path.join(DIR, 'private-key.json');
const PUBLIC_KEY_FILE = path.resolve(DIR, '../src/core/licenseKey.ts');
const today = (): string => new Date().toISOString().slice(0, 10);

export async function loadPrivateKey(): Promise<CryptoKey> {
  if (!fs.existsSync(PRIVATE_KEY_FILE)) throw new Error('No private key. Run: node keygen/keygen.ts init');
  return crypto.subtle.importKey('jwk', JSON.parse(fs.readFileSync(PRIVATE_KEY_FILE, 'utf8')) as JsonWebKey, { name: 'Ed25519' }, false, ['sign']);
}

async function init(force: boolean): Promise<void> {
  if (fs.existsSync(PRIVATE_KEY_FILE) && !force) throw new Error('A private key already exists. Replacing it would make every key issued so far invalid. Use --force only if that is what you want.');
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  fs.writeFileSync(PRIVATE_KEY_FILE, JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)), { mode: 0o600 });
  const raw = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
  fs.writeFileSync(PUBLIC_KEY_FILE, `// Public half of the licence signing key. Written by keygen/keygen.ts init. Safe to publish.\nexport const LICENSE_PUBLIC_KEY = '${raw}';\n`);
  console.log(`Private key: ${PRIVATE_KEY_FILE} (keep it secret and backed up)\nPublic key written to ${PUBLIC_KEY_FILE}`);
}

async function make(args: string[]): Promise<void> {
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const name = opt('name');
  const expires = opt('expires') ?? null;
  if (!name) throw new Error('Give the licensee: --name "Full Name"');
  if (expires !== null && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) throw new Error('Write the expiry date as YYYY-MM-DD.');
  const key = await signLicense({ product: PRODUCT, name, edition: opt('edition') ?? 'Standard', issued: today(), expires }, await loadPrivateKey());
  // Check the new key against the public key the app ships with before handing it out.
  const { LICENSE_PUBLIC_KEY } = (await import('../src/core/licenseKey.ts')) as { LICENSE_PUBLIC_KEY: string };
  const status = await verifyLicense(key, Buffer.from(LICENSE_PUBLIC_KEY, 'base64url'), today());
  if (status.state !== 'valid') throw new Error('The key does not verify against the public key in the app. Was init run again after the app was built?');
  console.log(key);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const job = cmd === 'init' ? init(rest.includes('--force')) : cmd === 'make' ? make(rest) : Promise.reject(new Error('Usage: node keygen/keygen.ts init | make --name "Full Name" [--edition Pro] [--expires YYYY-MM-DD]'));
  job.catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
