import { describe, it, expect } from 'vitest';
import { FernzugriffSkill, type FernzugriffRepo } from './fernzugriff-skill.js';
import type { Fernzugang } from '@alfred/storage';

// Dokument-Vorlagen — Kopie in die Dokumentablage auf pve2: nur unter /srv/alfred-dokumente, nur aktive Linux-Zugänge
function welt(o: { status?: Fernzugang['status']; code?: number; geaendert?: boolean } = {}) {
  const z = (name: string, system?: 'windows'): Fernzugang => ({ id: name, userId: 'owner', name, host: '10.0.0.1', port: 22, benutzer: 'alfred', schluesselPfad: '/k', hostSchluessel: 'x', status: o.status ?? 'aktiv', erstellt: 't', geaendert: 't', ...(system ? { system } : {}) } as Fernzugang);
  const zugaenge = [z('pve2'), z('sql01', 'windows')];
  const status: string[] = [];
  const repo = { liste: async () => zugaenge, finde: async (_u: string, n: string) => zugaenge.find(x => x.name === n) ?? null, merkeErgebnis: async () => undefined, setzeStatus: async (_u: string, _i: string, s: string) => { status.push(s); } } as unknown as FernzugriffRepo;
  const gesendet: Array<{ an: string; b: string; lokal: string }> = [];
  const skill = new FernzugriffSkill({
    repo, owner: () => 'owner', istOwner: () => true, bestaetigung: async () => true,
    keyscan: async () => '', schluessel: async () => ({ pfad: '/k', oeffentlich: 'k', neu: false }),
    ssh: async () => ({ code: 0, stdout: '', stderr: '', hostSchluesselGeaendert: false }),
    dateiSenden: async (ziel, b, lokal) => { gesendet.push({ an: ziel.id, b, lokal }); return { code: o.code ?? 0, stdout: '', stderr: o.code ? 'Permission denied' : '', hostSchluesselGeaendert: o.geaendert ?? false }; },
  });
  return { skill, gesendet, status };
}

describe('ablageSenden', () => {
  it('schreibt per sudo mit mkdir -p und cat in den Ablage-Pfad', async () => {
    const w = welt();
    const r = await w.skill.ablageSenden('pve2', '/srv/alfred-dokumente/change-288c3716/v1/PRUEFUNG.txt', '/daten/x');
    expect(r).toEqual({ ok: true });
    expect(w.gesendet).toHaveLength(1);
    expect(w.gesendet[0]!.lokal).toBe('/daten/x');
    expect(w.gesendet[0]!.b).toBe("sudo -n sh -c 'umask 077; mkdir -p /srv/alfred-dokumente/change-288c3716/v1 && cat > /srv/alfred-dokumente/change-288c3716/v1/PRUEFUNG.txt'");
  });
  it('fremde Pfade, Pfad-Tricks und Windows-Zugänge werden abgewiesen, ohne zu senden', async () => {
    const w = welt();
    for (const p of ['/etc/passwd', '/srv/alfred-dokumente', '/srv/alfred-dokumente/../etc/x', '/srv/alfred-dokumente/a/../../x', '/srv/alfred-dokumente/a/./b', '/srv/alfred-dokumente/a b', "/srv/alfred-dokumente/a'b", '/srv/alfred-dokumente/a;rm', '/srv/alfred-dokumente//a']) {
      const r = await w.skill.ablageSenden('pve2', p, '/daten/x');
      expect(r.ok, p).toBe(false);
    }
    expect((await w.skill.ablageSenden('sql01', '/srv/alfred-dokumente/a/b', '/daten/x')).fehler).toContain('kein Linux-Zugang');
    expect(w.gesendet).toHaveLength(0);
  });
  it('nicht bestätigter oder unbekannter Zugang → Fehler als Ergebnis, keine Ausnahme', async () => {
    expect((await welt({ status: 'wartet' }).skill.ablageSenden('pve2', '/srv/alfred-dokumente/a/b', '/x')).ok).toBe(false);
    const u = await welt().skill.ablageSenden('fehlt', '/srv/alfred-dokumente/a/b', '/x');
    expect(u.ok).toBe(false);
    expect(u.fehler).toContain('Kein Fernzugang');
  });
  it('Schreibfehler und geänderter Host-Schlüssel', async () => {
    const f = await welt({ code: 1 }).skill.ablageSenden('pve2', '/srv/alfred-dokumente/a/b', '/x');
    expect(f).toEqual({ ok: false, fehler: 'Exit 1: Permission denied' });
    const w = welt({ geaendert: true });
    expect((await w.skill.ablageSenden('pve2', '/srv/alfred-dokumente/a/b', '/x')).fehler).toContain('gesperrt');
    expect(w.status).toEqual(['gesperrt']);
  });
});
