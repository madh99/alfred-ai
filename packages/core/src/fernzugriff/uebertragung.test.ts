import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { leseListe, abgleich, nulListe, pruefePfad, leseSumme, leseZaehlung, vergleicheZaehlung, kopiere, kopiereDatenbank, volumePfad, type Wege, type Eintrag } from './uebertragung.js';

// I6 — Abgleich nach rsync-Art gegen zwei simulierte Dateisysteme (die echten find/tar-Befehle prüft der Live-Lauf)
type Fs = Map<string, Eintrag & { inhalt?: string }>;
const f = (inhalt: string, zeit = 100, modus = '644'): Eintrag & { inhalt: string } => ({ typ: 'f', groesse: inhalt.length, zeit, modus, uid: '1000', gid: '1000', link: '', inhalt });
const d = (modus = '755'): Eintrag => ({ typ: 'd', groesse: 4096, zeit: 1, modus, uid: '1000', gid: '1000', link: '' });
const liste = (fs: Fs) => [...fs].map(([p, e]) => `${e.typ} ${e.groesse} ${e.zeit}.5 ${e.modus} ${e.uid} ${e.gid} ${p}\0${e.link}\0`).join('');

function welt(quelle: Fs, ziel: Fs) {
  const hosts: Record<string, Fs> = { q: quelle, z: ziel };
  const befehle: string[] = [];
  const summe = (fs: Fs) => { const dateien = [...fs].filter(([, e]) => e.typ === 'f').sort(([a], [b]) => a.localeCompare(b)); return `${createHash('sha256').update(dateien.map(([p, e]) => `${p}:${e.inhalt}`).join('|')).digest('hex')}\n${dateien.length}\n`; };
  const w: Wege<string> = {
    lauf: async (h, b, eingabe) => {
      befehle.push(`${h}: ${b}`);
      const fs = hosts[h]!;
      if (b.includes('find . -xdev -printf')) return { code: 0, stdout: fs.size ? liste(fs) : '', stderr: '' };
      if (b.includes('rm -rf')) { for (const p of eingabe.split('\0').filter(Boolean)) for (const k of [...fs.keys()]) if (k === p || k.startsWith(`${p}/`)) fs.delete(k); return { code: 0, stdout: '', stderr: '' }; }
      if (b.includes('sha256sum')) return { code: 0, stdout: summe(fs), stderr: '' };
      if (b.includes('psql')) return { code: 0, stdout: h === 'q' ? 'public.a|3\npublic.b|5\n' : 'public.a|3\npublic.b|4\n', stderr: '' };
      return { code: 1, stdout: '', stderr: 'unbekannt' };
    },
    strom: async (q, qb, qe, z, zb) => {
      befehle.push(`strom ${q}→${z}: ${qb} | ${zb}`);
      let bytes = 0;
      if (qb.includes('pg_dump')) return { codeQuelle: 0, codeZiel: 0, bytes: 1234, stderrQuelle: '', stderrZiel: '' };
      const zfs = hosts[z]!; if (!zfs.has('.')) zfs.set('.', d());
      for (const p of qe.split('\0').filter(Boolean)) { const e = hosts[q]!.get(p)!; zfs.set(p, { ...e }); bytes += e.groesse; }
      return { codeQuelle: 0, codeZiel: 0, bytes, stderrQuelle: '', stderrZiel: '' };
    },
  };
  return { w, befehle };
}

describe('I6 Bausteine', () => {
  it('liest die Dateiliste (Leerzeichen im Namen, Link-Ziel, Sekunden abgerundet)', () => {
    const l = leseListe('d 4096 1.2 755 0 0 .\0\0f 3 1700000000.9 644 1000 1000 ./mein ordner/a b.txt\0\0l 9 5.0 777 0 0 ./link\0ziel.txt\0');
    expect(l.get('./mein ordner/a b.txt')).toMatchObject({ typ: 'f', groesse: 3, zeit: 1700000000, modus: '644' });
    expect(l.get('./link')!.link).toBe('ziel.txt');
    expect(l.size).toBe(3);
  });
  it('Abgleich: neu, Größe/Zeit/Rechte geändert, Typwechsel, Löschen nur oberste Einträge, Sonderdateien übersprungen', () => {
    const q: Fs = new Map([['.', d()], ['./a', f('x')], ['./b', f('yy', 200)], ['./c', f('z', 100, '600')], ['./neu', d()], ['./neu/x', f('1')], ['./sock', { ...d(), typ: 's' }], ['./t', f('t')]]);
    const z: Fs = new Map([['.', d()], ['./a', f('x')], ['./b', f('yy', 100)], ['./c', f('z')], ['./alt', d()], ['./alt/y', f('2')], ['./t', d()]]);
    const a = abgleich(leseListe(liste(q)), leseListe(liste(z)), true);
    expect(a.uebertragen).toEqual(['./b', './c', './neu', './neu/x', './t']);
    expect(a.loeschen).toEqual(['./alt', './t']);
    expect(a).toMatchObject({ neu: 2, geaendert: 3, uebersprungen: 1 });
    expect(abgleich(leseListe(liste(q)), leseListe(liste(z)), false).loeschen).toEqual(['./t']); // Typwechsel muss weg, sonst nichts
  });
  it('Pfade: nur sichere, keine Systembereiche, Ziele nur in Datenbereichen', () => {
    expect(pruefePfad('/opt/dashy', 'quelle')).toBeUndefined();
    expect(pruefePfad('/srv/dashy/data', 'ziel')).toBeUndefined();
    expect(pruefePfad('/var/lib/docker/volumes/dashy_data/_data', 'ziel')).toBeUndefined();
    expect(pruefePfad('/etc', 'quelle')).toMatch(/Systembereich/);
    expect(pruefePfad('/var/lib/docker/overlay2/x', 'quelle')).toMatch(/Systembereich/);
    expect(pruefePfad('/opt/../etc', 'quelle')).toMatch(/ohne \.\./);
    expect(pruefePfad("/opt/a'b", 'quelle')).toMatch(/absoluter Pfad/);
    expect(pruefePfad('/opt', 'ziel')).toMatch(/nur unter/);
    expect(pruefePfad('/var/www/x', 'ziel')).toMatch(/nur unter/);
    expect(() => nulListe(['./a', '../etc/passwd'])).toThrow(/unzulässig/);
    expect(() => nulListe(['/etc/passwd'])).toThrow(/unzulässig/);
  });
  it('Prüfsumme und Zeilenzählung lesen und vergleichen', () => {
    expect(leseSumme(`${'a'.repeat(64)}\n12\n`)).toEqual({ summe: 'a'.repeat(64), dateien: 12 });
    expect(leseSumme('kaputt')).toBeUndefined();
    const q = leseZaehlung('public.a|3\npublic.b|5\nmüll\n');
    expect(vergleicheZaehlung(q, leseZaehlung('public.a|3\npublic.c|1'))).toEqual(['public.b fehlt am Ziel', 'public.c gibt es nur am Ziel']);
  });
});

describe('I6 kopiere (zwei Durchgänge)', () => {
  it('erst vorkopieren, dann nur Unterschiede mit Löschen — Prüfsumme gleich, keine Restunterschiede', async () => {
    const q: Fs = new Map([['.', d()], ['./conf.yml', f('a: 1')], ['./data', d()], ['./data/1.db', f('eins')]]);
    const z: Fs = new Map();
    const { w, befehle } = welt(q, z);
    const e1 = await kopiere(w, 'q', '/opt/dashy', 'z', '/srv/dashy', { loeschen: false, pruefsumme: false, timeoutMs: 60_000 });
    expect(e1).toMatchObject({ neu: 3, geaendert: 0, restUnterschiede: 0 });
    // Dienst schreibt weiter, dann gestoppt: eine Datei ändert sich, eine verschwindet, eine kommt dazu
    q.set('./data/1.db', f('eins-neu', 300)); q.delete('./conf.yml'); q.set('./data/2.db', f('zwei'));
    befehle.length = 0;
    const e2 = await kopiere(w, 'q', '/opt/dashy', 'z', '/srv/dashy', { loeschen: true, pruefsumme: true, timeoutMs: 60_000 });
    expect(e2).toMatchObject({ neu: 1, geaendert: 1, geloescht: 1, restUnterschiede: 0, summe: { gleich: true, dateien: 2 } });
    expect(befehle.find(b => b.startsWith('strom'))).toContain("tar -C '/opt/dashy' --numeric-owner --no-recursion --null -T - -cf -");
    expect(befehle.find(b => b.startsWith('strom'))).toContain(String.raw`sudo -n sh -c 'mkdir -p '\''/srv/dashy'\'' && tar -C '\''/srv/dashy'\'' --numeric-owner -xpf -'`);
    expect(befehle.every(b => b.includes('sudo -n'))).toBe(true);
    expect([...z.keys()].sort()).toEqual(['.', './data', './data/1.db', './data/2.db']);
  });
  it('dritter Lauf ohne Änderungen überträgt nichts (Fortsetzen nach Abbruch = einfach erneut aufrufen)', async () => {
    const q: Fs = new Map([['.', d()], ['./x', f('1')]]);
    const z: Fs = new Map([['.', d()], ['./x', f('1')]]);
    const { w, befehle } = welt(q, z);
    const e = await kopiere(w, 'q', '/opt/a', 'z', '/srv/a', { loeschen: true, pruefsumme: true, timeoutMs: 60_000 });
    expect(e).toMatchObject({ neu: 0, geaendert: 0, geloescht: 0, bytes: 0, summe: { gleich: true } });
    expect(befehle.some(b => b.startsWith('strom'))).toBe(false);
  });
  it('fehlende Quelle ist ein Fehler, nicht „nichts zu tun“', async () => {
    const { w } = welt(new Map(), new Map());
    await expect(kopiere(w, 'q', '/opt/gibtsnicht', 'z', '/srv/x', { loeschen: true, pruefsumme: true, timeoutMs: 60_000 })).rejects.toThrow(/gibt es nicht/);
  });
  it('Datenbank: Strom pg_dump → pg_restore, Abweichung der Zeilenzahl wird gemeldet', async () => {
    const { w, befehle } = welt(new Map(), new Map());
    const e = await kopiereDatenbank(w, 'q', 'pg-alt', 'z', 'pg-neu', 'app', 'app', { timeoutMs: 60_000 });
    expect(befehle[0]).toContain('docker exec pg-alt pg_dump -U app -Fc app');
    expect(befehle[0]).toContain('docker exec -i pg-neu pg_restore -U app -d app --clean --if-exists --no-owner --exit-on-error');
    expect(e).toMatchObject({ tabellen: 2, zeilen: 8, abweichungen: ['public.b: 5 → 4 Zeilen'] });
    await expect(kopiereDatenbank(w, 'q', 'pg; rm -rf /', 'z', 'pg', 'app', 'app', { timeoutMs: 1000 })).rejects.toThrow(/ungültiger Name/);
  });
});

// Realfall 22.10. (Change e1843faa Schritt 4): anonymes Volume mit 64-stelliger ID wurde als ungültig abgewiesen
describe('I6 Volume-Namen', () => {
  it('64-stellige Docker-ID ist gültig, Shell-Zeichen nicht', async () => {
    const id = 'c3805b9065b214f3e198b3bb8ced0484230938c0146e65348fa8d2c5c2ebb4ab';
    const w = { lauf: async () => ({ code: 0, stdout: `/var/lib/docker/volumes/${id}/_data
`, stderr: '' }), strom: async () => ({ codeQuelle: 0, codeZiel: 0, bytes: 0, stderrQuelle: '', stderrZiel: '' }) } as Wege<string>;
    expect(await volumePfad(w, 'q', id, false)).toBe(`/var/lib/docker/volumes/${id}/_data`);
    await expect(volumePfad(w, 'q', 'x; rm -rf /', false)).rejects.toThrow(/ungültiger Volume-Name/);
  });
});

// Realfall 22.10. (pgAdmin: „Permission denied“ — Zielordner root 755 statt 5050:0 775)
describe('I6 Wurzelordner', () => {
  it('Besitzer und Rechte des Wurzelordners werden wie an der Quelle gesetzt', async () => {
    const q: Fs = new Map<string, Eintrag & { inhalt?: string }>([['.', { ...d('775'), uid: '5050', gid: '0' }], ['./a.db', f('x')]]);
    const z: Fs = new Map([['.', { ...d('755'), uid: '0', gid: '0' }]]);
    const { w, befehle } = welt(q, z);
    const lauf0 = w.lauf;
    w.lauf = async (h, b, e, t, m) => { if (b.includes('chown 5050:0')) { z.set('.', { ...d('775'), uid: '5050', gid: '0' }); return { code: 0, stdout: '', stderr: '' }; } return lauf0(h, b, e, t, m); };
    const e = await kopiere(w, 'q', '/var/lib/docker/volumes/x/_data', 'z', '/var/lib/docker/volumes/y/_data', { loeschen: true, pruefsumme: false, timeoutMs: 60_000 });
    expect(e.wurzelAngeglichen).toBe(true);
    expect(e.restUnterschiede).toBe(0);
    void befehle;
  });
});
