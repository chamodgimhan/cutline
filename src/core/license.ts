// Offline licence keys. A key is a signed payload; the app holds only the public key, so it can
// check keys but never make them. Without a valid key the app works fully and exports are watermarked.

export const PRODUCT = 'cutline';
const PREFIX = 'CUTLINE-';

export interface LicensePayload {
  product: string;
  name: string;
  edition: string;
  /** Dates as YYYY-MM-DD. */
  issued: string;
  expires: string | null;
}

export type LicenseStatus =
  | ({ state: 'valid' } & Omit<LicensePayload, 'product'>)
  | { state: 'invalid'; reason: 'malformed' | 'tampered' | 'expired' | 'wrong-product'; message: string }
  | { state: 'none' };

const MESSAGES = {
  malformed: 'That is not a Cutline licence key. Check that you copied all of it.',
  tampered: 'That licence key is not valid. It may have been changed or mistyped.',
  expired: 'That licence key has expired.',
  'wrong-product': 'That licence key is for a different product.',
} as const;
const invalid = (reason: keyof typeof MESSAGES): LicenseStatus => ({ state: 'invalid', reason, message: MESSAGES[reason] });

const toB64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function fromB64(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Check a key against a raw 32-byte Ed25519 public key. `today` is YYYY-MM-DD. */
export async function verifyLicense(key: string, publicKey: Uint8Array, today: string): Promise<LicenseStatus> {
  const text = key.replace(/\s+/g, '');
  if (!text.startsWith(PREFIX)) return invalid('malformed');
  const [body, sig, ...rest] = text.slice(PREFIX.length).split('.');
  if (!body || !sig || rest.length) return invalid('malformed');
  let data: Uint8Array;
  let signature: Uint8Array;
  try {
    data = fromB64(body);
    signature = fromB64(sig);
  } catch {
    return invalid('malformed');
  }
  if (signature.length !== 64) return invalid('malformed');
  // Signature first: nothing inside an unsigned payload is trusted, not even to choose the error.
  let ok: boolean;
  try {
    const k = await crypto.subtle.importKey('raw', publicKey as Uint8Array<ArrayBuffer>, { name: 'Ed25519' }, false, ['verify']);
    ok = await crypto.subtle.verify({ name: 'Ed25519' }, k, signature as Uint8Array<ArrayBuffer>, data as Uint8Array<ArrayBuffer>);
  } catch {
    ok = false;
  }
  if (!ok) return invalid('tampered');
  let p: Partial<LicensePayload>;
  try {
    p = JSON.parse(new TextDecoder().decode(data)) as Partial<LicensePayload>;
  } catch {
    return invalid('malformed');
  }
  if (typeof p.name !== 'string' || typeof p.edition !== 'string' || typeof p.issued !== 'string' || !DATE.test(p.issued) || (p.expires !== null && (typeof p.expires !== 'string' || !DATE.test(p.expires)))) return invalid('malformed');
  if (p.product !== PRODUCT) return invalid('wrong-product');
  if (p.expires !== null && p.expires < today) return invalid('expired');
  return { state: 'valid', name: p.name, edition: p.edition, issued: p.issued, expires: p.expires };
}

/** Make a key. Needs the private key, which only the keygen tool has. */
export async function signLicense(payload: LicensePayload, privateKey: CryptoKey): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, data));
  return `${PREFIX}${toB64(data)}.${toB64(sig)}`;
}

export const isLicensed = (s: LicenseStatus): boolean => s.state === 'valid';

/** One line for the About dialog. */
export function describeLicense(s: LicenseStatus): string {
  if (s.state === 'valid') return `Licensed to ${s.name} (${s.edition})${s.expires ? `, valid until ${s.expires}` : ''}.`;
  if (s.state === 'invalid') return s.message;
  return 'Not activated. Everything works; exported video carries a small Cutline watermark.';
}
