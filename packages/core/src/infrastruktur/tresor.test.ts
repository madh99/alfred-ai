import { describe, it, expect } from 'vitest';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entschluessele, ladeSchluessel, ohneGeheimnisse, Tresor, verschluessele, zufallsPasswort } from './tresor.js';
import { pruefeChangePlan, type PruefKontext } from './change-schritte.js';
import { ChangeMotor, type MotorDeps } from './change-motor.js';
import type { CmdbChangeRequest } from '@alfred/types';
import type { ChangeSchritt } from './change-schritte.js';

// I4c — Tresor
describe('I4c Tresor', () => {
  it('Schlüssel 32 Byte (Datei 600), AES-GCM hin und zurück, Manipulation fällt auf', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tresor-'));
    const k = await ladeSchluessel(join(dir, 'tresor.key'));
    expect(k.length).toBe(32);
    expect((await ladeSchluessel(join(dir, 'tresor.key'))).equals(k)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(join(dir, 'tresor.key')).mode & 0o777).toBe(0o600);
    const c = verschluessele(k, 'geheim äöü\nzeile2');
    expect(c).not.toContain('geheim');
    expect(entschluessele(k, c)).toBe('geheim äöü\nzeile2');
    const kaputt = c.slice(0, -4) + (c.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => entschluessele(k, kaputt)).toThrow();
    expect(zufallsPasswort(20)).toMatch(/^[A-Za-z0-9_-]{20}$/);
    expect(ohneGeheimnisse('pw=abcd1234 ok', ['abcd1234'])).toBe('pw=*** ok');
    expect(readFileSync(join(dir, 'tresor.key'), 'utf8')).not.toContain('geheim');
  });
  it('erzeugen ohne Wert-Rückgabe, lesen protokolliert', async () => {
    const db = new Map<string, string>(); const prot: string[] = [];
    const t = new Tresor({ schluesselPfad: join(mkdtempSync(join(tmpdir(), 'tresor-')), 'k'), speicher: {
      liste: async () => [...db.keys()].map(name => ({ name, herkunft: 'erzeugt', erstellt: 'x', geaendert: 'x' })),
      roh: async (_o, n) => db.get(n), setze: async (_o, n, c) => { db.set(n, c); }, entferne: async (_o, n) => db.delete(n),
      protokolliere: async (_o, n, art, wofuer) => { prot.push(`${n}:${art}:${wofuer ?? ''}`); },
    } });
    await t.erzeuge('o', 'matrix-db');
    await expect(t.erzeuge('o', 'matrix-db')).rejects.toThrow('gibt es schon');
    await expect(t.setze('o', 'Böse Name', 'x', 'owner')).rejects.toThrow('Name');
    const w = await t.lies('o', 'matrix-db', 'Change abc Schritt 2');
    expect(w).toHaveLength(32);
    expect(prot).toEqual(['matrix-db:gesetzt:erzeugt', 'matrix-db:gelesen:Change abc Schritt 2']);
  });
});

const skill = (name: string, aktionen: string[]) => ({ metadata: { name, inputSchema: { type: 'object', properties: { action: { type: 'string', enum: aktionen } }, required: ['action'] } } });
const ctx = (namen?: string[]): PruefKontext => ({ skill: n => ({ fernzugriff: skill('fernzugriff', ['ausfuehren', 'lesen']), database: skill('database', ['query']) } as Record<string, unknown>)[n] as never, asset: k => ({ id: k, name: k }), changes: [], ...(namen ? { tresorNamen: new Set(namen) } : {}) });
const plan = (schritte: unknown[]) => ({ titel: 'Tresor-Probe', begruendung: 'Geheimnis an den Host', risiko: 'niedrig', ausfallMinuten: 0, betroffen: ['h'], ohneSicherungGrund: 'Test', schritte });

describe('I4c Tresor-Verweise in der Planprüfung', () => {
  it('geheimdatei nur im Fernzugriff-Befehl, geheim nur als ganzer Wert in geschwärzten Feldern, Name muss existieren', () => {
    const ok = pruefeChangePlan(plan([{ titel: 'env', art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: 'h', befehl: 'docker compose --env-file {{geheimdatei:matrix-env}} up -d' }, pruefung: { typ: 'ping', ziel: 'h' }, rueckweg: { skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: 'h', befehl: 'docker compose down' } } }]), ctx(['matrix-env']));
    expect(ok.fehler).toEqual([]);
    expect(ok.hinweise.join(' ')).toContain('das Modell sieht sie nie');
    const f = pruefeChangePlan(plan([
      { titel: 'a', art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: 'h', befehl: 'echo {{geheim:xy}}' }, pruefung: { typ: 'ping', ziel: 'h' }, rueckweg: { skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: 'h', befehl: 'true' } } },
      { titel: 'b', art: 'aktion', skill: 'database', aktion: 'query', parameter: { sql: '{{geheimdatei:xy}}', password: '{{geheim:fehlt}}' }, pruefung: { typ: 'ping', ziel: 'h' }, rueckweg: { skill: 'database', aktion: 'query', parameter: {} } },
    ]), ctx(['xy'])).fehler.join('\n');
    expect(f).toContain('{{geheim:xy}} nur als ganzer Wert');
    expect(f).toContain('{{geheimdatei:xy}} nur im Befehl eines Fernzugriff-Schritts');
    expect(pruefeChangePlan(plan([{ titel: 'c', art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: 'h', befehl: 'echo {{geheim:x}}' }, pruefung: { typ: 'ping', ziel: 'h' }, rueckweg: { skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: 'h', befehl: 'true' } } }]), ctx(['xy'])).fehler.join(' ')).toContain('Platzhalter');
    expect(f).toContain('Tresor-Eintrag „fehlt“ gibt es nicht');
  });
});

describe('I4c Motor mit Geheimnis-Datei', () => {
  it('Wert per Datei (nie im Befehl), Datei danach entfernt, Ausgabe ohne Wert', async () => {
    const befehle: string[] = []; const dateien: string[] = []; const entfernt: string[] = [];
    const s: ChangeSchritt = { nr: 1, titel: 'env', art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: 'h', befehl: 'docker compose --env-file {{geheimdatei:matrix-env}} up -d' }, zeitlimitS: 60, beiFehler: 'anhalten', einordnung: 'aendern' };
    const c = { id: 'c', title: 't', status: 'approved', type: 'normal', riskLevel: 'low', affectedAssetIds: ['a'], affectedServiceIds: [], schritte: [s], fingerabdruck: 'f', freigabeFingerabdruck: 'f', createdAt: 'x', updatedAt: 'x' } as unknown as CmdbChangeRequest;
    const d: MotorDeps = {
      owner: () => 'o',
      itsm: { liste: async () => [c], hole: async () => c, motorSetze: async (_o, _i, x) => { if (x.status) c.status = x.status; c.lauf = JSON.parse(JSON.stringify(x.lauf)); return c; } },
      fuehreAus: async () => ({ success: true }), fernLesen: async () => '',
      fernAusfuehren: async (_z, b) => { befehle.push(b); return { code: 0, stdout: 'PASSWORT=SuperGeheim123', stderr: '' }; },
      netz: { http: async () => ({ status: 200, text: '' }), port: async () => true, dns: async () => [], ping: async () => true },
      tresor: { lies: async () => 'PASSWORT=SuperGeheim123' },
      geheimDatei: { schreiben: async (_z, p) => { dateien.push(p); }, entfernen: async (_z, p) => { entfernt.push(p); return true; } },
      schlafe: async () => undefined, takt: { pruefAbstandMs: 0, pruefVersuche: 1, taskAbstandMs: 0, wartenAbstandMs: 1 },
    };
    const m = new ChangeMotor(d);
    await m.anstossen();
    await new Promise(r => setTimeout(r, 20));
    for (let i = 0; i < 50 && m.aktiv(); i++) await new Promise(r => setTimeout(r, 5));
    await new Promise(r => setTimeout(r, 10));
    expect(befehle[0]).toMatch(/^docker compose --env-file \/run\/alfred-g-[0-9a-f]{16} up -d$/);
    expect(befehle[0]).not.toContain('SuperGeheim');
    expect(entfernt).toEqual(dateien);
    expect(JSON.stringify(c.lauf)).not.toContain('SuperGeheim123');
    expect(JSON.stringify(c.lauf)).toContain('"ausgabe":"***"');
  });
});
