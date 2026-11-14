import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FernzugriffSkill, isoAblegenFehler, type FernzugriffRepo } from './fernzugriff-skill.js';
import type { Fernzugang } from '@alfred/storage';
import type { SkillContext } from '@alfred/types';

// v1865 — PKI-Lab: SQL-ISO von einem Windows-Zugang hashgeprüft in den ISO-Speicher eines Proxmox-Knotens
const ctx = { userId: 'owner', platform: 'api', chatId: 'c1', ausChange: true } as unknown as SkillContext;
const INHALT = Buffer.from('ISO-INHALT '.repeat(1000));
const HASH = createHash('sha256').update(INHALT).digest('hex');

function welt(o: { zielHash?: string; zielSchon?: string; frei?: number; quelleHash?: string } = {}) {
  const z = (name: string, system?: 'windows'): Fernzugang => ({ id: name, userId: 'owner', name, host: '10.0.0.1', port: 22, benutzer: 'alfred', schluesselPfad: '/k', hostSchluessel: 'x', status: 'aktiv', erstellt: 't', geaendert: 't', ...(system ? { system } : {}) } as Fernzugang);
  const zugaenge = [z('sql01', 'windows'), z('pve')];
  const repo = { liste: async () => zugaenge, finde: async (_u: string, n: string) => zugaenge.find(x => x.name === n) ?? null, merkeErgebnis: async () => undefined, setzeStatus: async () => undefined } as unknown as FernzugriffRepo;
  const befehle: Array<{ an: string; b: string }> = [];
  let gesendet = '', lokalPfad = '';
  const skill = new FernzugriffSkill({
    repo, owner: () => 'owner', istOwner: () => true, bestaetigung: async () => true,
    keyscan: async () => '', schluessel: async () => ({ pfad: '/k', oeffentlich: 'k', neu: false }),
    ssh: async (ziel, b) => {
      befehle.push({ an: ziel.id, b });
      if (ziel.id === 'sql01') return { code: 0, stdout: `${INHALT.length} ${(o.quelleHash ?? HASH).toUpperCase()}\r\n`, stderr: '', hostSchluesselGeaendert: false };
      if (b.includes('df -B1')) return { code: 0, stdout: `${o.zielSchon ? `${o.zielSchon}\n` : ''}${o.frei ?? 50_000_000_000}\n`, stderr: '', hostSchluesselGeaendert: false };
      if (b.includes('stat -c %s')) return { code: 0, stdout: `${INHALT.length}\n${o.zielHash ?? HASH}\n`, stderr: '', hostSchluesselGeaendert: false };
      return { code: 0, stdout: '', stderr: '', hostSchluesselGeaendert: false };
    },
    sftpHolen: async (_z, pfad) => {
      befehle.push({ an: 'sftp', b: pfad });
      const d = await mkdtemp(path.join(tmpdir(), 'iso-')); lokalPfad = path.join(d, 'x');
      await writeFile(lokalPfad, INHALT);
      return { code: 0, stdout: '', stderr: '', hostSchluesselGeaendert: false, lokal: lokalPfad };
    },
    dateiSenden: async (_z, b) => { gesendet = b; return { code: 0, stdout: '', stderr: '', hostSchluesselGeaendert: false }; },
  });
  return { skill, befehle, gesendet: () => gesendet, lokal: () => lokalPfad };
}
const P = { action: 'iso_ablegen', quelle: 'sql01', quelle_pfad: 'C:\\SQLMedia\\iso\\SQLServer2025-x64-ENU-EntDev.iso', ziel: 'pve' };

describe('v1865 iso_ablegen', () => {
  it('nur in Changes; Eingaben geprüft', async () => {
    const w = welt();
    expect((await w.skill.execute(P, { ...ctx, ausChange: false } as SkillContext)).error).toContain('nur als Schritt eines freigegebenen Changes');
    expect(isoAblegenFehler({ ...P, quelle_pfad: 'C:\\x\\..\\y.iso' })).toContain('quelle_pfad');
    expect(isoAblegenFehler({ ...P, quelle_pfad: '/etc/passwd' })).toContain('quelle_pfad');
    expect(isoAblegenFehler({ ...P, dateiname: '../x.iso' })).toContain('dateiname');
    expect(isoAblegenFehler(P)).toBeUndefined();
  });
  it('holt, prüft dreifach, streamt in eine Teildatei und benennt erst danach um; Zwischendatei weg', async () => {
    const w = welt();
    const r = await w.skill.execute(P, ctx);
    expect(r.display, String(r.error)).toContain('ISO_STORED');
    expect(r.data).toMatchObject({ volid: 'local:iso/SQLServer2025-x64-ENU-EntDev.iso', sha256: HASH, zustand: 'abgelegt' });
    expect(w.befehle.find(b => b.an === 'sftp')!.b).toBe('/C:/SQLMedia/iso/SQLServer2025-x64-ENU-EntDev.iso');
    expect(w.gesendet()).toMatch(/^sudo -n sh -c .*cat > \/var\/lib\/vz\/template\/iso\/\.alfred-[0-9a-f]{12}\.part/);
    const mv = w.befehle.findIndex(b => b.b.includes('mv -n')), pr = w.befehle.findIndex(b => b.b.includes('stat -c %s'));
    expect(pr).toBeGreaterThan(-1);
    expect(mv).toBeGreaterThan(pr);
    await expect(access(w.lokal())).rejects.toThrow();
  });
  it('am Ziel abweichend → Teildatei entfernt, nicht umbenannt', async () => {
    const w = welt({ zielHash: 'f'.repeat(64) });
    const r = await w.skill.execute(P, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toContain('am Ziel abweichend');
    expect(w.befehle.some(b => b.b.includes('mv -n'))).toBe(false);
    expect(w.befehle.some(b => /rm -f \/var\/lib\/vz\/template\/iso\/\.alfred-/.test(b.b))).toBe(true);
  });
  it('gleiche Datei schon da → nur Abnahme; andere Datei gleichen Namens → nie überschrieben; zu wenig Platz → Abbruch', async () => {
    const gleich = welt({ zielSchon: HASH });
    const r = await gleich.skill.execute(P, ctx);
    expect(r.display).toContain('schon vorhanden');
    expect(gleich.befehle.some(b => b.an === 'sftp')).toBe(false);
    const anders = await welt({ zielSchon: 'a'.repeat(64) }).skill.execute(P, ctx);
    expect(anders.error).toContain('nicht überschrieben');
    const voll = await welt({ frei: 1_000_000 }).skill.execute(P, ctx);
    expect(voll.error).toContain('zu wenig Platz');
  });
  it('erwarteter SHA-256 weicht von der Quelle ab → Abbruch vor dem Holen', async () => {
    const w = welt();
    const r = await w.skill.execute({ ...P, sha256: 'b'.repeat(64) }, ctx);
    expect(r.error).toContain('statt erwartet');
    expect(w.befehle.some(b => b.an === 'sftp')).toBe(false);
  });
});
