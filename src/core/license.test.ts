import * as fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadPrivateKey, PRIVATE_KEY_FILE } from '../../keygen/keygen.ts';
import { describeLicense, fromB64, isLicensed, PRODUCT, signLicense, verifyLicense, type LicensePayload } from './license.ts';
import { LICENSE_PUBLIC_KEY } from './licenseKey.ts';
import { stampWatermark, watermarkBox } from './watermark.ts';

let pub: Uint8Array;
let priv: CryptoKey;
const payload = (extra: Partial<LicensePayload> = {}): LicensePayload => ({ product: PRODUCT, name: 'Ada Lovelace', edition: 'Pro', issued: '2026-11-01', expires: null, ...extra });
const TODAY = '2026-11-14';

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  priv = pair.privateKey;
  pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
});

describe('licence keys', () => {
  it('accepts a valid key, with or without an expiry, however it was pasted', async () => {
    const key = await signLicense(payload(), priv);
    expect(await verifyLicense(key, pub, TODAY)).toEqual({ state: 'valid', name: 'Ada Lovelace', edition: 'Pro', issued: '2026-11-01', expires: null });
    const wrapped = `  ${key.slice(0, 30)}\n${key.slice(30, 70)} \r\n${key.slice(70)}  `;
    expect((await verifyLicense(wrapped, pub, TODAY)).state).toBe('valid');
    const dated = await verifyLicense(await signLicense(payload({ expires: TODAY }), priv), pub, TODAY);
    expect(dated).toMatchObject({ state: 'valid', expires: TODAY }); // valid through its last day
    expect(isLicensed(dated)).toBe(true);
    expect(describeLicense(dated)).toBe(`Licensed to Ada Lovelace (Pro), valid until ${TODAY}.`);
  });

  it('rejects a tampered key: changed payload, changed signature, or another signer', async () => {
    const key = await signLicense(payload({ name: 'Bob' }), priv);
    const [body, sig] = key.slice(8).split('.') as [string, string];
    const forged = btoa(JSON.stringify(payload({ name: 'Eve', edition: 'Unlimited' }))).replace(/=+$/, '');
    expect(await verifyLicense(`CUTLINE-${forged}.${sig}`, pub, TODAY)).toMatchObject({ state: 'invalid', reason: 'tampered' });
    const flipped = sig.slice(0, 10) + (sig[10] === 'A' ? 'B' : 'A') + sig.slice(11);
    expect(await verifyLicense(`CUTLINE-${body}.${flipped}`, pub, TODAY)).toMatchObject({ reason: 'tampered' });
    const other = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    expect(await verifyLicense(await signLicense(payload(), other.privateKey), pub, TODAY)).toMatchObject({ reason: 'tampered' });
    expect(isLicensed(await verifyLicense(`CUTLINE-${forged}.${sig}`, pub, TODAY))).toBe(false);
  });

  it('rejects an expired key and a key for another product', async () => {
    expect(await verifyLicense(await signLicense(payload({ expires: '2026-11-13' }), priv), pub, TODAY)).toMatchObject({ state: 'invalid', reason: 'expired', message: 'That licence key has expired.' });
    expect(await verifyLicense(await signLicense(payload({ product: 'otherapp' }), priv), pub, TODAY)).toMatchObject({ state: 'invalid', reason: 'wrong-product' });
  });

  it('rejects malformed keys with one clear reason, never an exception', async () => {
    const good = await signLicense(payload(), priv);
    const sig = good.split('.')[1] as string;
    const signedJunk = async (text: string): Promise<string> => {
      const data = new TextEncoder().encode(text);
      const s = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, priv, data));
      const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
      return `CUTLINE-${b64(data)}.${b64(s)}`;
    };
    for (const bad of ['', 'hello', 'CUTLINE-', 'CUTLINE-abc', 'CUTLINE-abc.def', `CUTLINE-!!!.${sig}`, `CUTLINE-abc.${sig}.extra`, good.replace('CUTLINE-', 'OTHER-'), `${good.split('.')[0]}.AAAA`]) {
      expect(await verifyLicense(bad, pub, TODAY), bad.slice(0, 20)).toMatchObject({ state: 'invalid', reason: 'malformed' });
    }
    // Properly signed, but not a licence payload.
    expect(await verifyLicense(await signedJunk('not json'), pub, TODAY)).toMatchObject({ reason: 'malformed' });
    expect(await verifyLicense(await signedJunk('{"product":"cutline","name":"x"}'), pub, TODAY)).toMatchObject({ reason: 'malformed' });
    expect(await verifyLicense(await signedJunk('{"product":"cutline","name":"x","edition":"y","issued":"soon","expires":null}'), pub, TODAY)).toMatchObject({ reason: 'malformed' });
    expect(describeLicense({ state: 'none' })).toMatch(/watermark/);
  });

  it('ships a real 32-byte public key that the keygen can sign for', async () => {
    const shipped = fromB64(LICENSE_PUBLIC_KEY);
    expect(shipped).toHaveLength(32);
    // A key made with a different private key must not pass against the shipped public key.
    expect((await verifyLicense(await signLicense(payload(), priv), shipped, TODAY)).state).toBe('invalid');
    // The owner's private key is not in the repository; where it exists, check the pair matches.
    if (fs.existsSync(PRIVATE_KEY_FILE)) expect((await verifyLicense(await signLicense(payload(), await loadPrivateKey()), shipped, TODAY)).state).toBe('valid');
  });
});

describe('watermark', () => {
  it('marks only the bottom-right corner, at any size', () => {
    for (const [w, h] of [[320, 180], [1920, 1080], [1080, 1920], [64, 48], [16, 16]] as const) {
      const frame = new Uint8Array(w * h * 4).fill(120);
      stampWatermark(frame, w, h);
      const [bx, by, bw, bh] = watermarkBox(w, h);
      let outside = 0;
      let inside = 0;
      let bright = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = frame[(y * w + x) * 4] as number;
          const inBox = x >= bx && x < bx + bw && y >= by && y < by + bh;
          if (v !== 120 && inBox) inside++;
          else if (v !== 120) outside++;
          if (v > 200) bright++;
          expect(frame[(y * w + x) * 4 + 3]).toBe(120); // alpha untouched
        }
      }
      expect(outside, `${w}x${h}`).toBe(0);
      expect(inside, `${w}x${h}`).toBe(bw * bh);
      if (w >= 64) expect(bright, `${w}x${h}`).toBeGreaterThan(20);
      expect(bx + bw).toBeLessThanOrEqual(w);
      expect(by + bh).toBeLessThanOrEqual(h);
    }
  });

  it('stays readable on black and on white', () => {
    for (const fill of [0, 255]) {
      const frame = new Uint8Array(320 * 180 * 4).fill(fill);
      stampWatermark(frame, 320, 180);
      const [bx, by, bw, bh] = watermarkBox(320, 180);
      const values = new Set<number>();
      for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) values.add(frame[(y * 320 + x) * 4] as number);
      const [lo, hi] = [Math.min(...values), Math.max(...values)];
      expect(hi - lo, `on ${fill}`).toBeGreaterThan(100);
    }
  });
});
