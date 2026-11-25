import { describe, it, expect } from 'vitest';
import { kandidaten, profilSchritte, profilAbdruck, Pruefprofile, PROFIL_MAX, type ProfilZeile, type QuellChange } from './pruefprofile.js';
import type { Pruefung } from './change-schritte.js';

// Realfall 28.10./04.11. (I9 e87d1e8d, Matrix J f3fabf62 an docker-com-01): Marker-Dateien, Snapshot-Namen und Tagesordner sind
// Einmal-Beweise; Port-, HTTP-, Container- und Konfig-Prüfungen gelten dauerhaft.
const I9: QuellChange = { id: 'e87d1e8d-0000', titel: 'I9 – 149 docker-com-01 Nachtupgrade', schritte: [
  { pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'list_snapshots', erwartet: 'vor-i9-docker-com-01', parameter: { node: 'pve3', vmid: 149 } } },
  { pruefung: { typ: 'befehl', befehl: 'cat /srv/i9-149-20261028/upgrade_ok', zugang: 'docker-com-01', erwartet: 'I9_UPGRADE_OK' } },
  {},
] };
const J: QuellChange = { id: 'f3fabf62-0000', titel: 'Matrix J', schritte: [
  { pruefung: { typ: 'dns', ziel: 'turn.3033.at', erwartet: '91.114.43.173' } },
  { pruefung: { typ: 'befehl', befehl: 'nc -z -w 5 127.0.0.1 7880', zugang: 'docker-com-01' } },
  { pruefung: { typ: 'befehl', befehl: 'curl --fail --silent --show-error --connect-timeout 5 --max-time 10 http://localhost:8090/healthz', zugang: 'docker-com-01' } },
  { pruefung: { typ: 'befehl', befehl: 'cat /srv/matrix/proofs/j173-external', zugang: 'docker-com-01', erwartet: 'MATRIX_J173_EXTERNAL_TLS_DISCOVERY_OK' } },
  { pruefung: { typ: 'befehl', befehl: 'stat -c %a /srv/matrix/synapse/homeserver.yaml.matrix-k-20261026.bak', zugang: 'docker-com-01', erwartet: '600' } },
  { pruefung: { typ: 'befehl', befehl: 'docker inspect --format "{{.State.Running}}" synapse', zugang: 'docker-com-01', erwartet: 'true' } },
  { pruefung: { typ: 'befehl', befehl: "grep -nF 'msisdn: http://sydent:8090' /srv/matrix/synapse/homeserver.yaml", zugang: 'docker-com-01', erwartet: 'msisdn: http://sydent:8090' } },
  { pruefung: { typ: 'befehl', befehl: "grep -nF 'msisdn: http://sydent:8090' /srv/matrix/synapse/homeserver.yaml", zugang: 'docker-com-01', erwartet: 'msisdn: http://sydent:8090' } },
  { pruefung: { typ: 'befehl', befehl: 'nc -z -w 5 127.0.0.1 7880', zugang: 'docker-vault-01' } },
  { pruefung: { typ: 'befehl', befehl: 'nc -z -w 5 127.0.0.1 {{schritt3.port}}', zugang: 'docker-com-01' } },
] };

describe('S3 Prüfprofile — Kandidaten aus abgeschlossenen Changes', () => {
  it('nimmt nur dauerhaft gültige, an den Fernzugang gebundene Prüfungen, jede einmal', () => {
    const k = kandidaten([I9, J], 'docker-com-01');
    expect(k.pruefungen.map(p => p.befehl)).toEqual([
      'nc -z -w 5 127.0.0.1 7880',
      'curl --fail --silent --show-error --connect-timeout 5 --max-time 10 http://localhost:8090/healthz',
      'docker inspect --format "{{.State.Running}}" synapse',
      "grep -nF 'msisdn: http://sydent:8090' /srv/matrix/synapse/homeserver.yaml",
    ]);
    expect(k.quellen).toEqual(['f3fabf62']);
    expect(kandidaten([I9, J], undefined).pruefungen).toEqual([]);
  });
  it('Go-Template von docker inspect zählt nicht als Verweis, {{schrittN…}} schon', () => {
    const k = kandidaten([J], 'docker-com-01');
    expect(k.pruefungen.some(p => String(p.befehl).includes('{{.State.Running}}'))).toBe(true);
    expect(k.pruefungen.some(p => String(p.befehl).includes('{{schritt'))).toBe(false);
  });
  it('höchstens PROFIL_MAX, jüngste Changes zuerst', () => {
    const viele: QuellChange = { id: 'aaaaaaaa', titel: 'x', schritte: Array.from({ length: 20 }, (_, i) => ({ pruefung: { typ: 'befehl', zugang: 'h', befehl: `nc -z -w 5 127.0.0.1 ${8000 + i}` } })) };
    const neu: QuellChange = { id: 'bbbbbbbb', titel: 'y', schritte: [{ pruefung: { typ: 'befehl', zugang: 'h', befehl: 'nc -z -w 5 127.0.0.1 9999' } }] };
    const k = kandidaten([viele, neu], 'h');
    expect(k.pruefungen).toHaveLength(PROFIL_MAX);
    expect(k.pruefungen[0]!.befehl).toBe('nc -z -w 5 127.0.0.1 9999');
  });
  it('Profil-Schritte halten bei Abweichung an', () => {
    const s = profilSchritte('docker-com-01', [{ typ: 'befehl', zugang: 'docker-com-01', befehl: 'nc -z -w 5 127.0.0.1 7880' }]);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ art: 'pruefung', beiFehler: 'anhalten', zeitlimitS: 300 });
    expect(String(s[0]!.titel)).toMatch(/^Prüfprofil docker-com-01 1\/1: /);
  });
});

describe('S3 Prüfprofile — Vorschlag, Bestätigung, Ersetzen', () => {
  function welt(o: { planFehler?: string[]; scheitert?: string[] } = {}) {
    const zeilen: ProfilZeile[] = []; const fragen: Array<{ text: string; params: Record<string, unknown> }> = [];
    const geplant: Array<Record<string, unknown>> = [];
    let jetzt = Date.parse('2026-11-25T14:00:00Z');
    const pp = new Pruefprofile({
      lade: async () => zeilen.map(z => ({ ...z })),
      setze: async (_o, z) => { const i = zeilen.findIndex(x => x.assetId === z.assetId); if (i >= 0) zeilen[i] = { ...z }; else zeilen.push({ ...z }); },
      asset: async (_o, k) => (k === 'docker-com-01' || k === '149' ? { id: 'a-149', name: 'docker-com-01', zugang: 'docker-com-01' } : { fehler: `„${k}“: keine aktive Proxmox-VM` }),
      quellen: async () => [I9, J],
      planPruefen: async (_o, plan) => { geplant.push(plan); return o.planFehler ?? []; },
      pruefe: async (p: Pruefung) => (o.scheitert?.some(x => String(p.befehl).includes(x)) ? { ok: false, text: 'Exit 1' } : { ok: true, text: 'ok' }),
      frage: async (text, params) => { fragen.push({ text, params }); return true; },
      jetzt: () => jetzt,
    });
    return { pp, zeilen, fragen, geplant, spaeter: (ms: number) => { jetzt += ms; } };
  }

  it('leitet ab, prüft live, fragt den Owner; gültig erst nach dem Ja', async () => {
    const { pp, fragen, geplant } = welt({ scheitert: ['8090/healthz'] });
    const r = await pp.vorschlagen('o', 'docker-com-01');
    expect(r.ok).toBe(true);
    // v1957 — Realfall 25.11.: betroffen als volle Asset-ID, nie der (mehrdeutige) Name
    expect(geplant[0]!.betroffen).toEqual(['a-149']);
    expect(fragen).toHaveLength(1);
    expect(fragen[0]!.text).toContain('Prüfprofil für docker-com-01 bestätigen (3 Prüfungen, abgeleitet aus f3fabf62)');
    expect(fragen[0]!.text).toContain('besteht jetzt nicht');
    expect(fragen[0]!.params).toMatchObject({ action: 'pruefprofil_bestaetigen', asset: 'a-149' });
    expect(await pp.bestaetigt('o', 'a-149')).toBeUndefined();
    expect((await pp.bestaetigenNachJa('o', 'a-149', 'falsch')).ok).toBe(false);
    const ja = await pp.bestaetigenNachJa('o', 'a-149', fragen[0]!.params.freigabe);
    expect(ja).toEqual({ ok: true, text: 'Prüfprofil docker-com-01 bestätigt (3 Prüfungen).' });
    expect((await pp.bestaetigt('o', 'a-149'))?.map(p => p.befehl)).toEqual(['nc -z -w 5 127.0.0.1 7880', 'docker inspect --format "{{.State.Running}}" synapse', "grep -nF 'msisdn: http://sydent:8090' /srv/matrix/synapse/homeserver.yaml"]);
    // dieselbe Freigabe gilt nur einmal
    expect((await pp.bestaetigenNachJa('o', 'a-149', fragen[0]!.params.freigabe)).ok).toBe(false);
  });

  it('neuer Vorschlag lässt das bestätigte Profil bis zum Ja wirksam; Frage verfällt nach 24 h', async () => {
    const { pp, fragen, spaeter } = welt();
    await pp.vorschlagen('o', 'docker-com-01');
    await pp.bestaetigenNachJa('o', 'a-149', fragen[0]!.params.freigabe);
    const vorher = await pp.bestaetigt('o', 'a-149');
    const neu: Pruefung[] = [{ typ: 'befehl', zugang: 'docker-com-01', befehl: 'nc -z -w 5 127.0.0.1 8008' }];
    expect((await pp.vorschlagen('o', '149', neu)).ok).toBe(true);
    expect(fragen[1]!.text).toContain('Ersetzt das bisher bestätigte Profil.');
    expect(await pp.bestaetigt('o', 'a-149')).toEqual(vorher);
    spaeter(25 * 3_600_000);
    expect((await pp.bestaetigenNachJa('o', 'a-149', fragen[1]!.params.freigabe)).ok).toBe(false);
    expect(await pp.bestaetigt('o', 'a-149')).toEqual(vorher);
  });

  it('Planprüfung nimmt einzelne Prüfungen heraus; allgemeiner Fehler bricht ab; nichts bestanden → kein Vorschlag', async () => {
    const a = welt({ planFehler: ['Change profil: Schritt 1: Prüfbefehl nicht in der Leseliste'] });
    const r = await a.pp.vorschlagen('o', 'docker-com-01');
    expect(r.ok && r.text).toContain('3 Prüfungen zur Bestätigung vorgelegt, 1 nicht aufgenommen');
    const b = welt({ planFehler: ['Change profil: betroffen unbekannt'] });
    expect(await b.pp.vorschlagen('o', 'docker-com-01')).toMatchObject({ ok: false });
    expect(b.fragen).toHaveLength(0);
    const c = welt({ scheitert: ['127.0.0.1', 'docker', 'grep', 'curl'] });
    expect(await c.pp.vorschlagen('o', 'docker-com-01')).toMatchObject({ ok: false, fehler: expect.stringContaining('keine Prüfung besteht') });
  });

  it('genannte Prüfungen: Form und Höchstzahl; unbekanntes Asset', async () => {
    const { pp } = welt();
    expect(await pp.vorschlagen('o', 'docker-com-01', ['x'])).toMatchObject({ ok: false });
    expect(await pp.vorschlagen('o', 'docker-com-01', Array.from({ length: PROFIL_MAX + 1 }, () => ({ typ: 'ping', ziel: '10.0.0.1' })))).toMatchObject({ ok: false });
    expect(await pp.vorschlagen('o', 'gibtsnicht')).toMatchObject({ ok: false, fehler: '„gibtsnicht“: keine aktive Proxmox-VM' });
  });

  it('entfernen; Abdruck schützt vor veränderten Zeilen', async () => {
    const { pp, zeilen, fragen } = welt();
    await pp.vorschlagen('o', 'docker-com-01');
    await pp.bestaetigenNachJa('o', 'a-149', fragen[0]!.params.freigabe);
    zeilen[0]!.pruefungen = [...zeilen[0]!.pruefungen, { typ: 'ping', ziel: '1.1.1.1' }];
    expect(await pp.bestaetigt('o', 'a-149')).toBeUndefined();
    zeilen[0]!.abdruck = profilAbdruck('a-149', zeilen[0]!.pruefungen);
    expect((await pp.entfernen('o', 'docker-com-01')).ok).toBe(true);
    expect(await pp.bestaetigt('o', 'a-149')).toBeUndefined();
    expect(await pp.liste('o')).toEqual([]);
  });
});
