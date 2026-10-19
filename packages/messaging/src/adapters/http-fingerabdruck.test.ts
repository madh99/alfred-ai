import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spkiFingerabdruck } from './http.js';

/** Phase 5 H1 — der Server rechnet denselben Fingerabdruck wie die App (apps/flutter/lib/spki.dart, test/spki_test.dart). */
describe('spkiFingerabdruck', () => {
  it('SHA-256 des öffentlichen Schlüssels des laufenden Zertifikats (DER und PEM)', () => {
    const der = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../../apps/flutter/test/daten/server-cert.der'));
    const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
    expect(spkiFingerabdruck(der)).toBe('75ed3a0bc4f26c967e5b0b12b637865b936cc22c852b465d86224dc0b4fe63c5');
    expect(spkiFingerabdruck(pem)).toBe('75ed3a0bc4f26c967e5b0b12b637865b936cc22c852b465d86224dc0b4fe63c5');
  });
});
