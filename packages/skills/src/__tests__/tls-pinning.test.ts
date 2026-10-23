import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { pinnedFetch } from '../built-in/social/tls-fetch.js';

// v1618 (Sicherheitsprüfung) — Pinning auf derselben Verbindung: bei falschem Fingerabdruck erreicht KEINE Anfrage den Server.
// Wegwerf-Schlüssel nur für diesen Test (127.0.0.1, selbst signiert) — kein echtes System.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgW42xym3eCHRMW1Yd
v5pNpKG0b7DKzIgahU54LiWoB42hRANCAAQLVKAJVJsuOJsX4JoC6x972kOLGEzO
w53qlqC193usFh4Lx9Za6vVXvIw+4B+hITFTsPbmOPze83q9pH9ojZXa
-----END PRIVATE KEY-----`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBfzCCASWgAwIBAgIUSO+kBXhGrhqni/NSOEC3YzxMeKUwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MTAyMzE2MDcwNVoYDzIxMjYwOTI5
MTYwNzA1WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAQLVKAJVJsuOJsX4JoC6x972kOLGEzOw53qlqC193usFh4Lx9Za6vVX
vIw+4B+hITFTsPbmOPze83q9pH9ojZXao1MwUTAdBgNVHQ4EFgQUyUSGphdkjGBy
xUHulK7uGiZt8okwHwYDVR0jBBgwFoAUyUSGphdkjGByxUHulK7uGiZt8okwDwYD
VR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiEA84OxxAfWY/ksBLSYpwmJ
JxbjBX4X/5ouKUgdi5uDJOcCICUPRk1qEJtWN4I+B1J2vkVA4eGr+W6xuUibEOPM
6IMC
-----END CERTIFICATE-----`;
const RICHTIG = '23:CF:D8:97:C2:F9:E2:17:8B:31:5D:2E:66:1F:62:59:AF:A0:78:4C:CC:FA:7B:C7:0B:F0:24:66:8C:85:34:21';
const FALSCH = '00:CF:D8:97:C2:F9:E2:17:8B:31:5D:2E:66:1F:62:59:AF:A0:78:4C:CC:FA:7B:C7:0B:F0:24:66:8C:85:34:21';

describe('pinnedFetch', () => {
  let server: https.Server;
  let url = '';
  const angekommen: string[] = [];
  beforeAll(async () => {
    server = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => { angekommen.push(String(req.headers.authorization ?? '')); res.end('{"name":"test"}'); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    url = `https://127.0.0.1:${(server.address() as AddressInfo).port}/rest/system/identity`;
  });
  afterAll(() => new Promise<void>(r => server.close(() => r())));

  it('richtiger Fingerabdruck → Anfrage mit Zugangsdaten geht durch', async () => {
    const res = await pinnedFetch(url, { headers: { Authorization: 'Basic richtig' } }, RICHTIG);
    expect(res.status).toBe(200);
    expect(angekommen).toContain('Basic richtig');
  });

  it('falscher Fingerabdruck → Fehler, und beim Server kommt nichts an', async () => {
    const vorher = angekommen.length;
    await expect(pinnedFetch(url, { headers: { Authorization: 'Basic geheim' } }, FALSCH)).rejects.toThrow();
    expect(angekommen.length).toBe(vorher);
    expect(angekommen).not.toContain('Basic geheim');
  });

  it('kein gültiger SHA-256-Fingerabdruck → Abbruch vor jeder Verbindung', async () => {
    await expect(pinnedFetch(url, {}, '4A:6E')).rejects.toThrow(/SHA-256/);
  });
});
