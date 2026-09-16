import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { canonicalString, deriveLanKeys, openMeta, sealMeta, sha256Hex, signLanReceipt, signLanRequest, verifyLanMac, verifyLanReceipt, type LanAuthFields } from './lan-auth.js';

// `lan-auth.ts` is a byte-exact copy of the cli's, which carries the full
// suite. What this repo owes is parity with the contract: the vectors file,
// produced by an independent Python implementation, reproduced here.

interface VectorCase {
    name: string;
    sharedSecretHex: string;
    macKeyHex: string;
    metaKeyHex: string;
    method: string;
    path: string;
    bodyHex: string;
    bodySha256: string;
    fields: Omit<LanAuthFields, 'bodySha256' | 'method' | 'path'>;
    canonical: string;
    macHex: string;
    receiptHex: string;
    metaJson?: string;
    metaIvHex?: string;
    metaSealedBase64?: string;
}
const vectors = JSON.parse(readFileSync(new URL('./lan-auth.vectors.json', import.meta.url), 'utf8')) as { cases: VectorCase[] };

describe('lan-auth vectors', () => {
    it('has cases to check', () => {
        expect(vectors.cases.length).toBeGreaterThan(0);
    });

    it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
        const k = deriveLanKeys(Buffer.from(c.sharedSecretHex, 'hex'));
        expect(k.macKey.toString('hex')).toBe(c.macKeyHex);
        expect(k.metaKey.toString('hex')).toBe(c.metaKeyHex);
        expect(sha256Hex(Buffer.from(c.bodyHex, 'hex'))).toBe(c.bodySha256);
        const f: LanAuthFields = { ...c.fields, method: c.method, path: c.path, bodySha256: c.bodySha256 };
        expect(canonicalString(f)).toBe(c.canonical);
        expect(signLanRequest(k.macKey, f)).toBe(c.macHex);
        expect(verifyLanMac(k.macKey, f, c.macHex)).toBe(true);
        expect(signLanReceipt(k.macKey, c.macHex)).toBe(c.receiptHex);
        expect(verifyLanReceipt(k.macKey, c.macHex, c.receiptHex)).toBe(true);
        if (c.metaSealedBase64 !== undefined) {
            expect(openMeta(k.metaKey, c.metaSealedBase64)).toEqual(JSON.parse(c.metaJson ?? ''));
            expect(sealMeta(k.metaKey, JSON.parse(c.metaJson ?? '') as object, Buffer.from(c.metaIvHex ?? '', 'hex'))).toBe(c.metaSealedBase64);
        }
    });
});
