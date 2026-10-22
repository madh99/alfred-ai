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
    setzeKaefig: async (_u, id, k) => { zeilen.get(id)!.kaefig = k; },
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
    expect((await t.skill.execute({ action: 'lesen', name: 'pve', befehl: 'zpool status; reboot' }, ctx)).error).toContain('Lese-Käfig'); // v1549: ohne bestandenen Selbsttest kein Käfig
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
    expect(g.display).toContain('Vollständig gespeichert'); // v1549 S3 statt reinem Kürzungshinweis
    expect(g.display).toContain('container-199');
  });
});

describe('v1549 S1–S3 Lese-Käfig, Geheimnisse, Seiten', () => {
  const kaefigSsh = (probe: string, ausgabe: () => string) => (b: string) => (
    b.includes('PROBE_ENDE') ? { code: 0, stdout: probe, stderr: '' }
      : b.includes('touch /etc/x') ? { code: 1, stdout: '', stderr: "touch: cannot touch '/etc/x': Read-only file system" }
      : { code: 0, stdout: ausgabe(), stderr: '' });

  it('unbekannter Lesebefehl läuft nach bestandenem Selbsttest im Käfig, ohne Rückfrage', async () => {
    const t = aufbau(kaefigSsh('PROBE_LESEN_OK\nPROBE_ENDE\n', () => 'server { listen 80; }'));
    await aktiv(t);
    t.befehle.length = 0;
    const r = await t.skill.execute({ action: 'lesen', name: 'pve', befehl: 'cat /etc/nginx/nginx.conf' }, ctx);
    expect(r.success).toBe(true);
    expect(r.display).toContain('(Lese-Käfig)');
    expect(t.fragen).toHaveLength(0);
    expect(t.zeilen.get('z1')!.kaefig).toBe('aktiv');
    expect(t.befehle.at(-1)).toMatch(/^sudo -n systemd-run .*ProtectSystem=strict.* -- \/bin\/sh -c 'cat \/etc\/nginx\/nginx.conf'$/);
  });

  it('Selbsttest mit Verstoß → Käfig „fehlt“, Befehl nur mit Bestätigung', async () => {
    const t = aufbau(kaefigSsh('PROBE_SCHREIBEN /etc\nPROBE_LESEN_OK\nPROBE_ENDE\n', () => 'x'));
    await aktiv(t);
    const r = await t.skill.execute({ action: 'lesen', name: 'pve', befehl: 'cat /etc/nginx/nginx.conf' }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toContain('Lese-Käfig ist auf pve nicht verfügbar');
    expect(t.zeilen.get('z1')!.kaefig).toBe('fehlt');
  });

  it('Schreibversuch im Käfig scheitert mit Hinweis auf ausfuehren', async () => {
    const t = aufbau(kaefigSsh('PROBE_LESEN_OK\nPROBE_ENDE\n', () => 'x'));
    await aktiv(t);
    const r = await t.skill.execute({ action: 'lesen', name: 'pve', befehl: 'touch /etc/x' }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toContain('stieß an den Lese-Käfig');
  });

  it('Geheimnisse und abgeschalteter Käfig', async () => {
    const t = aufbau(kaefigSsh('PROBE_LESEN_OK\nPROBE_ENDE\n', () => 'x'));
    await aktiv(t);
    expect((await t.skill.execute({ action: 'lesen', name: 'pve', befehl: 'cat /opt/app/.env' }, ctx)).error).toContain('.env');
    await t.skill.execute({ action: 'kaefig', name: 'pve', an: false }, ctx);
    expect((await t.skill.execute({ action: 'lesen', name: 'pve', befehl: 'cat /etc/nginx/nginx.conf' }, ctx)).error).toContain('abgeschaltet');
    // Einschalten nur mit Bestätigung, dann neuer Selbsttest
    await t.skill.execute({ action: 'kaefig', name: 'pve', an: true }, ctx);
    const f = t.fragen.pop()!;
    expect(f.description).toContain('Lese-Käfig');
    const r = await t.skill.execute(f.params, ctx);
    expect(r.display).toContain('ist an');
  });

  it('S3: lange Ausgabe vollständig abgelegt — Seiten und Suche ohne erneuten Lauf', async () => {
    const lang = Array.from({ length: 4000 }, (_, i) => `logzeile ${i}${i === 3333 ? ' FEHLER: disk timeout' : ''}`).join('\n');
    const t = aufbau(kaefigSsh('PROBE_LESEN_OK\nPROBE_ENDE\n', () => lang));
    await aktiv(t);
    const r = await t.skill.execute({ action: 'lesen', name: 'pve', befehl: 'cat /var/log/syslog' }, ctx);
    const id = /id=([0-9a-f]{8})/.exec(r.display!)![1]!;
    const laeufe = t.befehle.length;
    const s2 = await t.skill.execute({ action: 'seite', id, seite: 2 }, ctx);
    expect(s2.display).toMatch(/Seite 2\/\d+/);
    const such = await t.skill.execute({ action: 'seite', id, suche: 'fehler' }, ctx);
    expect(such.display).toContain('3335: logzeile 3333 FEHLER: disk timeout'); // Zeile 1 ist der Kopf „pve$ …“
    expect(t.befehle.length).toBe(laeufe);
    expect((await t.skill.execute({ action: 'seite', id: 'deadbeef' }, ctx)).success).toBe(false);
  });
});

describe('v1550 S4c Fachskill-Hinweis', () => {
  it('Ergebnis nennt, was der Fachskill zum selben Host kann', async () => {
    const t = aufbau();
    (t.skill as unknown as { deps: { fachskillHinweis: (z: unknown) => Promise<string> } }).deps.fachskillHinweis = async () => 'ℹ️ Für pve gibt es auch: Proxmox-Skill: … Abwägen, was für die Aufgabe besser ist.';
    await aktiv(t);
    const r = await t.skill.execute({ action: 'lesen', name: 'pve', befehl: 'zpool list' }, ctx);
    expect(r.display).toContain('Für pve gibt es auch: Proxmox-Skill');
  });
});

describe('v1551 Schwärzung im Ergebnis', () => {
  it('Geheimnis in der Ausgabe erreicht weder Anzeige noch Daten', async () => {
    const t = aufbau(() => ({ code: 0, stdout: 'APP_SECRET=abc123def456\nPORT=8080', stderr: '' }));
    await aktiv(t);
    const r = await t.skill.execute({ action: 'lesen', name: 'pve', befehl: 'zpool list' }, ctx);
    expect(r.display).not.toContain('abc123def456');
    expect(JSON.stringify(r.data)).not.toContain('abc123def456');
    expect(r.display).toContain('1 Geheimnis(se) geschwärzt');
    expect(r.display).toContain('PORT=8080');
  });
});

// I5 — Zugang einer von Alfred angelegten VM: eigener Host-Schlüssel, ohne Keyscan/Rückfrage aktiv; Snippets nur unter snippets/alfred-*
describe('I5 Vorlagen-Fabrik', () => {
  it('legt den Zugang mit dem bekannten Host-Schlüssel aktiv an (kein Keyscan, keine Frage) und meldet ihn wieder ab', async () => {
    const t = aufbau();
    const z = await t.skill.zugangBereitstellen({ name: 'probe-i5', host: '192.168.1.140', hostSchluessel: `ssh-ed25519 ${K}`, cmdbAssetId: 'a9' });
    expect(z.status).toBe('aktiv');
    expect(z.hostSchluessel).toBe(`192.168.1.140 ssh-ed25519 ${K}\n`);
    expect(z.kaefig).toBe('ungeprueft');
    expect(t.fragen).toHaveLength(0);
    await expect(t.skill.zugangBereitstellen({ name: 'probe-i5', host: '192.168.1.141', hostSchluessel: `ssh-ed25519 ${K}` })).rejects.toThrow(/gibt es schon/);
    expect(await t.skill.zugangAbmelden('probe-i5', '192.168.1.99')).toBe(false);
    expect(await t.skill.zugangAbmelden('probe-i5', '192.168.1.140')).toBe(true);
    expect(t.zeilen.size).toBe(0);
  });
  it('weist unlesbare Host-Schlüssel ab', async () => {
    const t = aufbau();
    await expect(t.skill.zugangBereitstellen({ name: 'x', host: '192.168.1.140', hostSchluessel: 'ssh-ed25519 kaputt!' })).rejects.toThrow(/nicht lesbar/);
  });
  it('schreibt Snippets nur an den erlaubten Ort', async () => {
    const t = aufbau();
    await aktiv(t);
    await expect(t.skill.snippetSchreiben('pve', '/etc/sudoers.d/x', 'a')).rejects.toThrow(/Snippet-Pfad/);
    await expect(t.skill.snippetSchreiben('pve', '/var/lib/vz/snippets/../../x-9021-user.yaml', 'a')).rejects.toThrow(/Snippet-Pfad/);
    expect(await t.skill.snippetEntfernen('pve', '/var/lib/vz/snippets/fremd.yaml')).toBe(false);
    expect(await t.skill.snippetEntfernen('pve', '/var/lib/vz/snippets/alfred-9021-user.yaml')).toBe(true);
    expect(t.befehle.at(-1)).toContain('rm -f /var/lib/vz/snippets/alfred-9021-user.yaml');
  });
});

// I6 — Datenübertragung und Geheimnis-Übernahme nur im Change-Motor
describe('I6 nur im Change', () => {
  it('kopieren, datenbank_kopieren, geheim_uebernehmen werden aus dem Chat abgewiesen', async () => {
    const t = aufbau();
    for (const action of ['kopieren', 'datenbank_kopieren', 'geheim_uebernehmen']) {
      const r = await t.skill.execute({ action, quelle: 'pve', ziel: 'pve', name: 'pve' }, ctx);
      expect(r.error).toMatch(/nur als Schritt eines freigegebenen Changes/);
    }
    expect(t.befehle).toEqual([]);
  });
});
