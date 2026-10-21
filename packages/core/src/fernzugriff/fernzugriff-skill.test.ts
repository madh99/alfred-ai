import { describe, it, expect, vi } from 'vitest';
import { FernzugriffSkill, type FernzugriffRepo } from './fernzugriff-skill.js';
import type { Fernzugang } from '@alfred/storage';
import type { SkillContext } from '@alfred/types';

// v1539 — Fernzugriff: lesen sofort, ausführen nur mit Freigabe, nie abgewiesen, Host-Schlüssel gepinnt
const K = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const ctx = { userId: 'owner', platform: 'api', chatId: 'c1' } as unknown as SkillContext;

function aufbau(ssh: (b: string) => { code: number; stdout: string; stderr: string; hostSchluesselGeaendert?: boolean } = () => ({ code: 0, stdout: 'ok\n', stderr: '' })) {
  const zeilen = new Map<string, Fernzugang>();
  const repo: FernzugriffRepo = {
    liste: async () => [...zeilen.values()],
    finde: async (_u, n) => [...zeilen.values()].find(z => z.name.toLowerCase() === n.toLowerCase() || z.host === n) ?? null,
    hole: async (_u, id) => zeilen.get(id) ?? null,
    speichere: async (_u, e) => { const z = { id: 'z1', userId: 'owner', erstellt: 't', geaendert: 't', ...e } as Fernzugang; zeilen.set(z.id, z); return z; },
    setzeStatus: async (_u, id, s) => { zeilen.get(id)!.status = s; },
    merkeErgebnis: async () => undefined,
    entferne: async (_u, id) => zeilen.delete(id),
  };
  const fragen: Array<{ description: string; params: Record<string, unknown> }> = [];
  const befehle: string[] = [];
  const melde = vi.fn();
  const skill = new FernzugriffSkill({
    repo, owner: () => 'owner', istOwner: (c) => c.userId === 'owner',
    cmdbFinde: async (n) => (n === 'pve' ? { id: 'a1', name: 'pve', host: '192.168.1.22' } : null),
    cmdbMarkiere: vi.fn(async () => undefined),
    bestaetigung: async (f) => { fragen.push(f); return true; },
    ssh: async (_z, b) => { befehle.push(b); const r = ssh(b); return { hostSchluesselGeaendert: false, ...r }; },
    keyscan: async () => `# kommentar\n192.168.1.22 ssh-ed25519 ${K}\n`,
    schluessel: async () => ({ pfad: '/data/fernzugriff/id_ed25519', oeffentlich: 'ssh-ed25519 XYZ alfred-fernzugriff', neu: false }),
    melde,
  });
  return { skill, zeilen, fragen, befehle, melde };
}

async function aktiv(t: ReturnType<typeof aufbau>) {
  await t.skill.execute({ action: 'anlegen', name: 'pve' }, ctx);
  const f = t.fragen.pop()!;
  const r = await t.skill.execute(f.params, ctx);
  expect(r.success).toBe(true);
}

describe('v1539 FernzugriffSkill', () => {
  it('anlegen: Host aus der CMDB, Host-Schlüssel zur Bestätigung, erst danach aktiv', async () => {
    const t = aufbau();
    const r = await t.skill.execute({ action: 'anlegen', name: 'pve' }, ctx);
    expect(r.success).toBe(true);
    expect(t.zeilen.get('z1')).toMatchObject({ host: '192.168.1.22', benutzer: 'alfred', status: 'wartet', cmdbAssetId: 'a1' });
    expect(t.fragen[0]!.description).toContain('SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU');
    expect(t.befehle).toHaveLength(0); // vor der Bestätigung keine Verbindung
    expect((await t.skill.execute({ action: 'lesen', name: 'pve', befehl: 'zpool status' }, ctx)).error).toContain('noch nicht bestätigt');
    // erfundene Freigabe wirkt nicht
    expect((await t.skill.execute({ ...t.fragen[0]!.params, freigabe: 'erfunden' }, ctx)).success).toBe(false);
    await t.skill.execute(t.fragen[0]!.params, ctx);
    expect(t.zeilen.get('z1')!.status).toBe('aktiv');
  });

  it('lesen läuft sofort als root (sudo -n), Steuerzeichen werden abgewiesen', async () => {
    const t = aufbau();
    await aktiv(t);
    t.befehle.length = 0;
    const r = await t.skill.execute({ action: 'lesen', name: 'pve', befehl: 'zpool status' }, ctx);
    expect(r.success).toBe(true);
    expect(t.befehle).toEqual(['sudo -n zpool status']);
    expect((await t.skill.execute({ action: 'lesen', name: 'pve', befehl: 'zpool status; reboot' }, ctx)).error).toContain('kein reiner Lesebefehl');
  });

  it('lesen ohne sudo-Recht fällt auf den Benutzer zurück', async () => {
    const t = aufbau(b => (b.startsWith('sudo') ? { code: 1, stdout: '', stderr: 'sudo: a password is required' } : { code: 0, stdout: 'pool: rpool', stderr: '' }));
    await aktiv(t);
    t.befehle.length = 0;
    const r = await t.skill.execute({ action: 'lesen', name: 'pve', befehl: 'zpool status' }, ctx);
    expect(r.success).toBe(true);
    expect(t.befehle).toEqual(['sudo -n zpool status', 'zpool status']);
  });

  it('ausfuehren: erst Frage, dann genau dieser Befehl; veränderter Befehl mit alter Freigabe wird abgewiesen', async () => {
    const t = aufbau();
    await aktiv(t);
    t.befehle.length = 0;
    const r = await t.skill.execute({ action: 'ausfuehren', name: 'pve', befehl: 'systemctl restart pveproxy' }, ctx);
    expect(r.data).toMatchObject({ zurBestaetigung: true });
    expect(t.befehle).toHaveLength(0);
    const f = t.fragen.pop()!;
    expect((await t.skill.execute({ ...f.params, befehl: 'zpool scrub tank' }, ctx)).success).toBe(false);
    const f2 = (await t.skill.execute({ action: 'ausfuehren', name: 'pve', befehl: 'systemctl restart pveproxy' }, ctx), t.fragen.pop()!);
    const ok = await t.skill.execute(f2.params, ctx);
    expect(ok.success).toBe(true);
    expect(t.befehle).toEqual(['sudo -n systemctl restart pveproxy']);
    expect((await t.skill.execute(f2.params, ctx)).success).toBe(false); // Freigabe nur einmal
  });

  it('nie: zerstörerische Befehle werden ohne Frage abgewiesen', async () => {
    const t = aufbau();
    await aktiv(t);
    const r = await t.skill.execute({ action: 'ausfuehren', name: 'pve', befehl: 'zpool destroy rpool' }, ctx);
    expect(r.error).toContain('nie erlaubt');
    expect(t.fragen).toHaveLength(0);
  });

  it('geänderter Host-Schlüssel sperrt den Zugang und meldet es dem Owner', async () => {
    const t = aufbau(() => ({ code: 255, stdout: '', stderr: 'Host key verification failed.', hostSchluesselGeaendert: true }));
    await t.skill.execute({ action: 'anlegen', name: 'pve' }, ctx);
    await t.skill.execute(t.fragen.pop()!.params, ctx); // Bestätigung → pruefen schlägt fehl
    expect(t.zeilen.get('z1')!.status).toBe('gesperrt');
    expect(t.melde).toHaveBeenCalledWith(expect.stringContaining('gesperrt'));
  });

  it('nur der Owner; Prüfung vor „Ausführen“ eines Vorgangs', async () => {
    const t = aufbau();
    expect((await t.skill.execute({ action: 'liste' }, { ...ctx, userId: 'fremd' } as SkillContext)).error).toContain('nur für den Owner');
    expect(t.skill.pruefeEingabe({ action: 'lesen', name: 'pve' })).toContain('befehl');
    expect(t.skill.pruefeEingabe({ action: 'lesen', name: 'pve', befehl: 'qm list' })).toBeUndefined();
  });
});

describe('v1542 F3 Ergebnisse', () => {
  it('Exit ≠ 0 mit Ausgabe ist ein Ergebnis (smartctl-Bitmaske), ohne Ausgabe ein Fehler; lange Ausgabe behält das Ende', async () => {
    const lang = Array.from({ length: 3000 }, (_, i) => `zeile ${i}`).join('\n') + '\nSMART overall-health: PASSED';
    const t = aufbau(b => (b.includes('smartctl') ? { code: 4, stdout: lang, stderr: '' } : b.includes('kaputt') ? { code: 1, stdout: '', stderr: 'nicht gefunden' } : { code: 0, stdout: 'ok', stderr: '' }));
    await aktiv(t);
    const r = await t.skill.execute({ action: 'lesen', name: 'pve', befehl: 'smartctl -a /dev/nvme0n1' }, ctx);
    expect(r.success).toBe(true);
    expect(r.display).toContain('(Exit 4)');
    expect(r.display).toContain('SMART overall-health: PASSED');
    expect(r.display!.length).toBeLessThan(30_200); // v1548 K1: Grenze 30 000
    const f = await t.skill.execute({ action: 'lesen', name: 'pve', befehl: 'ls -l /dev/disk/by-id/kaputt' }, ctx);
    expect(f.success).toBe(false);
    expect(f.error).toContain('nicht gefunden');
  });
});

describe('v1543 F4 Wiederherstellbarkeit', () => {
  it('zpool status mit dauerhaften Fehlern hängt die Prüfung der betroffenen VMs an, sonst nicht', async () => {
    const zpool = 'pool: zfs-nvme002\n state: DEGRADED\nerrors: Permanent errors have been detected in the following files:\n        zfs-nvme002/vm-106-disk-1:<0x1>\n';
    let ausgabe = zpool;
    const t = aufbau(() => ({ code: 0, stdout: ausgabe, stderr: '' }));
    const gefragt: number[][] = [];
    (t.skill as unknown as { deps: { wiederherstellbarkeit: (v: number[]) => Promise<string> } }).deps.wiederherstellbarkeit = async (v) => { gefragt.push(v); return '### Wiederherstellbarkeit (automatisch geprüft)\n- VM 106: …'; };
    await aktiv(t);
    const r = await t.skill.execute({ action: 'lesen', name: 'pve', befehl: 'zpool status -v zfs-nvme002' }, ctx);
    expect(gefragt).toEqual([[106]]);
    expect(r.display).toContain('### Wiederherstellbarkeit');
    // v1544 — als Nachsatz für die Pipeline vorgemerkt
    const mitZusatz = { ...ctx, antwortZusatz: { quellen: [] as string[] } } as SkillContext;
    await t.skill.execute({ action: 'lesen', name: 'pve', befehl: 'zpool status -v zfs-nvme002' }, mitZusatz);
    expect(mitZusatz.antwortZusatz?.nachsaetze?.[0]).toContain('### Wiederherstellbarkeit');
    ausgabe = 'pool: rpool\n state: ONLINE\nerrors: No known data errors\n';
    const ok = await t.skill.execute({ action: 'lesen', name: 'pve', befehl: 'zpool status' }, ctx);
    expect(ok.display).not.toContain('Wiederherstellbarkeit');
    ausgabe = zpool;
    await t.skill.execute({ action: 'lesen', name: 'pve', befehl: 'zfs list' }, ctx); // nicht zpool status → keine Prüfung
    expect(gefragt).toHaveLength(2);
  });
});

describe('v1548 K1 Kürzung', () => {
  it('bis 30 000 Zeichen ganz, darüber gekürzt mit Hinweis, wie es kompakter geht', async () => {
    const zeilen = (n: number) => Array.from({ length: n }, (_, i) => `container-${i} `.padEnd(300, '.')).join('\n');
    let ausgabe = zeilen(48); // ≈ 14 600 Zeichen wie im Realfall (docker ps, 40+ Container)
    const t = aufbau(() => ({ code: 0, stdout: ausgabe, stderr: '' }));
    await aktiv(t);
    const r = await t.skill.execute({ action: 'lesen', name: 'pve', befehl: 'docker ps' }, ctx);
    expect(r.display).toContain('container-47');
    expect(r.display).not.toContain('ausgelassen');
    ausgabe = zeilen(200); // ≈ 60 000
    const g = await t.skill.execute({ action: 'lesen', name: 'pve', befehl: 'docker ps' }, ctx);
    expect(g.display!.length).toBeLessThan(30_200);
    expect(g.display).toContain('Ausgabe gekürzt — kompakter abfragen');
    expect(g.display).toContain('container-199');
  });
});
