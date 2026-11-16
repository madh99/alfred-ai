import { describe, it, expect } from 'vitest';
import { FernzugriffSkill, type FernzugriffRepo } from './fernzugriff-skill.js';
import type { Fernzugang } from '@alfred/storage';
import type { SshErgebnis } from './ssh.js';

// I8e Paket 1 — Linux-Bausteinskripte: Skript und Geheimnis gehen nur über stdin, die Skriptdatei wird immer entfernt
const SKRIPT = 'set -eu\nread -r KENNWORT\necho "angelegt"\n# Bausteinskript-Text MARKE-SKRIPT-4711\n';
const GEHEIM = 'Geheim-Kennwort-Xy9!aBcDeFgH';

type Aufruf = { art: 'ssh' | 'eingabe'; befehl: string; stdin?: string };

function welt(o: { lauf?: (befehl: string, stdin: string) => SshErgebnis | Promise<SshErgebnis>; wirft?: boolean } = {}) {
  const z = (name: string, system?: 'windows'): Fernzugang => ({ id: name, userId: 'owner', name, host: '10.0.0.5', port: 22, benutzer: 'alfred', schluesselPfad: '/k', hostSchluessel: 'x', status: 'aktiv', erstellt: 't', geaendert: 't', ...(system ? { system } : {}) } as Fernzugang);
  const zugaenge = [z('sql-lx01'), z('sql01', 'windows')];
  const status: string[] = [];
  const repo = { liste: async () => zugaenge, finde: async (_u: string, n: string) => zugaenge.find(x => x.name === n) ?? null, merkeErgebnis: async () => undefined, setzeStatus: async (_u: string, _i: string, s: string) => { status.push(s); } } as unknown as FernzugriffRepo;
  const aufrufe: Aufruf[] = [];
  const protokoll: Array<{ m: string; d: unknown }> = [];
  const ok = (stdout = ''): SshErgebnis => ({ code: 0, stdout, stderr: '', hostSchluesselGeaendert: false });
  const skill = new FernzugriffSkill({
    repo, owner: () => 'owner', istOwner: () => true, bestaetigung: async () => true,
    keyscan: async () => '', schluessel: async () => ({ pfad: '/k', oeffentlich: 'k', neu: false }),
    ssh: async (_z, befehl) => { aufrufe.push({ art: 'ssh', befehl }); return ok(); },
    sshEingabe: async (_z, befehl, stdin) => {
      aufrufe.push({ art: 'eingabe', befehl, stdin });
      if (/ bash \/run\/alfred-s-/.test(befehl)) {
        if (o.wirft) throw new Error('Verbindung weg');
        return o.lauf ? o.lauf(befehl, stdin) : ok(`angelegt ${GEHEIM}`);
      }
      return ok();
    },
    protokoll: (m, d) => { protokoll.push({ m, d }); },
  });
  return { skill, aufrufe, protokoll, status };
}

describe('linuxSkript', () => {
  it('legt das Skript per stdin als root-Datei unter /run ab und führt es mit der Eingabe auf stdin aus', async () => {
    const w = welt();
    const r = await w.skill.linuxSkript('sql-lx01', SKRIPT, GEHEIM, 60_000, 'mssql-conf setup');
    expect(r.code).toBe(0);
    const [ablegen, ausfuehren] = w.aufrufe;
    const pfad = /\/run\/alfred-s-[0-9a-f]{16}\.sh/.exec(ablegen!.befehl)?.[0];
    expect(pfad).toBeDefined();
    expect(ablegen).toEqual({ art: 'eingabe', befehl: `sudo -n sh -c 'umask 077; cat > ${pfad}'`, stdin: expect.stringContaining(SKRIPT) });
    // die Datei entfernt sich selbst — vor dem eigentlichen Skript
    expect(ablegen!.stdin!.indexOf(`trap 'rm -f -- ${pfad}' EXIT`)).toBeGreaterThanOrEqual(0);
    expect(ablegen!.stdin!.indexOf(`rm -f -- ${pfad}`)).toBeLessThan(ablegen!.stdin!.indexOf(SKRIPT));
    expect(ablegen!.stdin).not.toContain(GEHEIM);
    expect(ausfuehren).toEqual({ art: 'eingabe', befehl: `sudo -n bash ${pfad}`, stdin: GEHEIM });
  });

  it('Skript- und Geheimnis-Text erscheinen in keinem ausgeführten Befehl, das Geheimnis nicht im Ergebnis und nicht im Protokoll', async () => {
    const w = welt();
    const r = await w.skill.linuxSkript('sql-lx01', SKRIPT, GEHEIM, 60_000, 'mssql-conf setup');
    for (const a of w.aufrufe) {
      expect(a.befehl).not.toContain('MARKE-SKRIPT-4711');
      expect(a.befehl).not.toContain('KENNWORT');
      expect(a.befehl).not.toContain(GEHEIM);
    }
    expect(JSON.stringify(w.protokoll)).not.toContain(GEHEIM);
    expect(JSON.stringify(w.protokoll)).not.toContain('MARKE-SKRIPT-4711');
    expect(w.protokoll.at(-1)).toMatchObject({ d: { name: 'sql-lx01', zweck: 'mssql-conf setup', code: 0, mitGeheimnis: true } });
    expect(r.stdout).toContain('angelegt');
  });

  it('jeder Aufruf bekommt einen neuen zufälligen Dateinamen', async () => {
    const w = welt();
    await w.skill.linuxSkript('sql-lx01', SKRIPT, undefined, 60_000, 'a');
    await w.skill.linuxSkript('sql-lx01', SKRIPT, undefined, 60_000, 'b');
    const namen = w.aufrufe.filter(a => a.befehl.includes('cat >')).map(a => /alfred-s-[0-9a-f]{16}/.exec(a.befehl)![0]);
    expect(namen).toHaveLength(2);
    expect(namen[0]).not.toBe(namen[1]);
  });

  it('ohne Eingabe läuft das Skript mit leerer Standardeingabe', async () => {
    const w = welt();
    await w.skill.linuxSkript('sql-lx01', SKRIPT, undefined, 60_000, 'lesen');
    expect(w.aufrufe[1]!.stdin).toBe('');
    expect(w.protokoll.at(-1)).toMatchObject({ d: { mitGeheimnis: false } });
  });

  it('bei Fehler und Zeitüberschreitung wird die Datei zusätzlich von außen entfernt', async () => {
    for (const code of [1, 124]) {
      const w = welt({ lauf: () => ({ code, stdout: '', stderr: 'kaputt', hostSchluesselGeaendert: false }) });
      const r = await w.skill.linuxSkript('sql-lx01', SKRIPT, GEHEIM, 60_000, 'x');
      expect(r.code).toBe(code);
      const pfad = /\/run\/alfred-s-[0-9a-f]{16}\.sh/.exec(w.aufrufe[0]!.befehl)![0];
      expect(w.aufrufe.at(-1)).toEqual({ art: 'ssh', befehl: `sudo -n rm -f -- ${pfad}` });
    }
  });

  it('bricht die Verbindung ab, wird die Datei entfernt und der Fehler weitergegeben', async () => {
    const w = welt({ wirft: true });
    await expect(w.skill.linuxSkript('sql-lx01', SKRIPT, GEHEIM, 60_000, 'x')).rejects.toThrow('Verbindung weg');
    expect(w.aufrufe.at(-1)!.befehl).toMatch(/^sudo -n rm -f -- \/run\/alfred-s-[0-9a-f]{16}\.sh$/);
  });

  it('Ablegen scheitert → Fehler, kein Ausführen, Datei wird entfernt', async () => {
    const w = welt();
    const skill = w.skill as unknown as { deps: { sshEingabe: (...a: unknown[]) => Promise<SshErgebnis> } };
    skill.deps.sshEingabe = async (_z, befehl) => { w.aufrufe.push({ art: 'eingabe', befehl: String(befehl) }); return { code: 1, stdout: '', stderr: 'sudo: a password is required', hostSchluesselGeaendert: false }; };
    await expect(w.skill.linuxSkript('sql-lx01', SKRIPT, GEHEIM, 60_000, 'x')).rejects.toThrow(/nicht abgelegt.*Exit 1/);
    expect(w.aufrufe.some(a => a.befehl.includes(' bash '))).toBe(false);
    expect(w.aufrufe.at(-1)!.befehl).toMatch(/^sudo -n rm -f -- /);
  });

  it('geänderter Host-Schlüssel sperrt den Zugang', async () => {
    const w = welt({ lauf: () => ({ code: 255, stdout: '', stderr: 'REMOTE HOST IDENTIFICATION HAS CHANGED', hostSchluesselGeaendert: true }) });
    await expect(w.skill.linuxSkript('sql-lx01', SKRIPT, GEHEIM, 60_000, 'x')).rejects.toThrow(/gesperrt/);
    expect(w.status).toEqual(['gesperrt']);
  });

  it('Windows-Zugang wird abgewiesen, ohne etwas zu senden', async () => {
    const w = welt();
    await expect(w.skill.linuxSkript('sql01', SKRIPT, GEHEIM, 60_000, 'x')).rejects.toThrow(/kein Linux-Zugang/);
    expect(w.aufrufe).toHaveLength(0);
  });
});
