import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApnsSender, apnsJwt, apnsKoerper, PUSH_TEXT_MAX, type ApnsTransport } from './push-apns.js';
import { PushDienst } from './push-dienst.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-push-'));
const schluesselPfad = path.join(tmp, 'AuthKey_TEST.p8');
fs.writeFileSync(schluesselPfad, pem);

describe('APNs — Phase 5 H2', () => {
  it('JWT: ES256 mit kid und iss, mit dem öffentlichen Schlüssel prüfbar', () => {
    const jwt = apnsJwt(pem, 'KEY123', 'TEAM456', 1_800_000_000);
    const [k, i, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(k, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEY123' });
    expect(JSON.parse(Buffer.from(i, 'base64url').toString())).toEqual({ iss: 'TEAM456', iat: 1_800_000_000 });
    expect(crypto.verify('sha256', Buffer.from(`${k}.${i}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('Nutzlast: Text gekürzt, Faden als thread-id, eigener Schlüssel alfred', () => {
    const j = JSON.parse(apnsKoerper({ titel: 'Bestätigung nötig', text: 'x'.repeat(300), art: 'bestaetigung', id: 'b1', faden: 'f1' }));
    expect(j.aps.alert.title).toBe('Bestätigung nötig');
    expect(j.aps.alert.body.length).toBe(PUSH_TEXT_MAX);
    expect(j.aps['thread-id']).toBe('f1');
    expect(j.alfred).toEqual({ art: 'bestaetigung', id: 'b1', faden: 'f1' });
  });

  it('Sender: Host je Umgebung, Kopf mit Thema und Anmeldung; JWT wird 50 min wiederverwendet; 410 = Token ungültig', async () => {
    const aufrufe: Array<{ host: string; pfad: string; kopf: Record<string, string> }> = [];
    let antwort = { status: 200, koerper: '' };
    const transport: ApnsTransport = async (z) => { aufrufe.push(z); return antwort; };
    let jetzt = 1_800_000_000_000;
    const s = new ApnsSender({ schluesselPfad, keyId: 'K', teamId: 'T', bundleId: 'at.alfred.app', transport, now: () => jetzt });
    expect((await s.sende('ab12', 'production', { titel: 't', text: 'x', art: 'hinweis' })).ok).toBe(true);
    jetzt += 10 * 60_000;
    await s.sende('ab12', 'sandbox', { titel: 't', text: 'x', art: 'hinweis' });
    expect(aufrufe[0].host).toBe('https://api.push.apple.com');
    expect(aufrufe[1].host).toBe('https://api.sandbox.push.apple.com');
    expect(aufrufe[0].pfad).toBe('/3/device/ab12');
    expect(aufrufe[0].kopf['apns-topic']).toBe('at.alfred.app');
    expect(aufrufe[1].kopf.authorization).toBe(aufrufe[0].kopf.authorization);
    jetzt += 45 * 60_000;
    await s.sende('ab12', 'production', { titel: 't', text: 'x', art: 'hinweis' });
    expect(aufrufe[2].kopf.authorization).not.toBe(aufrufe[0].kopf.authorization);
    antwort = { status: 410, koerper: '{"reason":"Unregistered"}' };
    const r = await s.sende('ab12', 'production', { titel: 't', text: 'x', art: 'hinweis' });
    expect(r).toMatchObject({ ok: false, status: 410, grund: 'Unregistered', tokenUngueltig: true });
  });
});

describe('PushDienst — wer bekommt einen Push', () => {
  function aufbau(verbunden: string[], status = 200) {
    const gesetzt: Array<[string, unknown]> = [];
    const gesendet: string[] = [];
    const geraete = [
      { id: 'a', name: 'iPhone', plattform: 'ios', push: { art: 'apns' as const, token: 'aa', umgebung: 'production' as const } },
      { id: 'b', name: 'iPad', plattform: 'ios', push: { art: 'apns' as const, token: 'bb', umgebung: 'sandbox' as const } },
    ];
    const d = new PushDienst({
      repo: { mitPush: async () => geraete as never, setzePush: async (id, p) => { gesetzt.push([id, p]); } },
      apns: { sende: async (token) => { gesendet.push(token); return { ok: status === 200, status, dauerMs: 1, tokenUngueltig: status === 410 }; } },
      istVerbunden: (id) => verbunden.includes(id), ownerUserId: () => 'owner',
      logger: { info: () => {}, warn: () => {} }, einstellungenDatei: path.join(tmp, `e-${Math.random()}.json`),
    });
    return { d, gesetzt, gesendet };
  }

  it('App vorne (verbunden) → kein Push; die anderen bekommen ihn', async () => {
    const { d, gesendet } = aufbau(['a']);
    expect(await d.anOwner({ titel: 'Hinweis', text: '1 neuer Hinweis', art: 'hinweis' })).toEqual({ zugestellt: 1, versucht: 1 });
    expect(gesendet).toEqual(['bb']);
  });

  it('APNs 410 löscht den Token', async () => {
    const { d, gesetzt } = aufbau([], 410);
    await d.anOwner({ titel: 'Hinweis', text: 'x', art: 'hinweis' });
    expect(gesetzt).toEqual([['a', undefined], ['b', undefined]]);
  });

  it('Token-Meldung: nur APNs auf iOS, Hex-Token, bekannte Umgebung', async () => {
    const { d, gesetzt } = aufbau([]);
    expect(await d.merkeToken({ id: 'a', plattform: 'ios' }, { art: 'apns', token: 'AB'.repeat(32), umgebung: 'production' })).toEqual({ ok: true });
    expect(gesetzt[0]).toEqual(['a', { art: 'apns', token: 'ab'.repeat(32), umgebung: 'production' }]);
    expect((await d.merkeToken({ id: 'a', plattform: 'windows' }, { art: 'apns', token: 'ab'.repeat(32), umgebung: 'production' })).ok).toBe(false);
    expect((await d.merkeToken({ id: 'a', plattform: 'ios' }, { art: 'apns', token: 'x; drop', umgebung: 'production' })).ok).toBe(false);
    expect((await d.merkeToken({ id: 'a', plattform: 'ios' }, { art: 'apns', token: 'ab'.repeat(32), umgebung: 'irgendwo' })).ok).toBe(false);
  });

  it('Antwort fertig: nur an das fragende Gerät, nicht wenn verbunden, höchstens einmal je Minute', async () => {
    const { d, gesendet } = aufbau(['b']);
    expect(await d.antwortFertig('a', 'f1', 1_000_000)).toBe(true);
    expect(await d.antwortFertig('a', 'f1', 1_030_000)).toBe(false);
    expect(await d.antwortFertig('a', 'f1', 1_061_000)).toBe(true);
    expect(await d.antwortFertig('b', 'f1', 1_000_000)).toBe(false); // App vorne
    expect(gesendet).toEqual(['aa', 'aa']);
  });

  it('Schalter „Telegram stumm“: Standard aus, bleibt gespeichert', () => {
    const { d } = aufbau([]);
    expect(d.einstellungen()).toEqual({ telegramStumm: false });
    d.setzeEinstellungen({ telegramStumm: true });
    expect(d.einstellungen()).toEqual({ telegramStumm: true });
  });
});
