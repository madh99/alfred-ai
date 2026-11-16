import { describe, it, expect } from 'vitest';
import { FernzugriffSkill, eingabeWerte, type FernzugriffRepo } from './fernzugriff-skill.js';
import { registriereLinuxBaustein } from './linux-bausteine.js';
import type { Fernzugang } from '@alfred/storage';
import type { SshErgebnis } from './ssh.js';

// I8e Paket 1 — Linux-Bausteinskripte: nur registrierte Bausteine, Skript und Geheimnis nur über stdin, Datei immer entfernt
const GEHEIM = 'Geheim-Kennwort-Xy9!aBcDeFgH';
const EINGABE = JSON.stringify({ sa: GEHEIM, port: 1433, kurz: 'ab' });
registriereLinuxBaustein<{ instanz: string }>('test.sql-setup', p => {
  if (!/^[a-z0-9-]{1,20}$/.test(p.instanz)) throw new Error('ungültige Instanz');
  return `set -eu\necho "angelegt ${p.instanz}"\n# Bausteinskript-Text MARKE-SKRIPT-4711\n`;
});
const SKRIPT = 'set -eu\necho "angelegt mssql"\n# Bausteinskript-Text MARKE-SKRIPT-4711\n';

type Aufruf = { art: 'ssh' | 'eingabe'; befehl: string; stdin?: string };

function welt(o: { lauf?: (befehl: string, stdin: string) => SshErgebnis | Promise<SshErgebnis>; wirft?: boolean } = {}) {
  const z = (name: string, system?: 'windows'): Fernzugang => ({ id: name, userId: 'owner', name, host: '10.0.0.5', port: 22, benutzer: 'alfred', schluesselPfad: '/k', hostSchluessel: 'x', status: 'aktiv', erstellt: 't', geaendert: 't', ...(system ? { system } : {}) } as Fernzugang);
  const zugaenge = [z('sql-lx01'), z('sql01', 'windows')];
  const status: string[] = [];
  const gemerkt: Array<string | undefined> = [];
  const repo = { liste: async () => zugaenge, finde: async (_u: string, n: string) => zugaenge.find(x => x.name === n) ?? null, merkeErgebnis: async (_u: string, _i: string, _ok: boolean, t?: string) => { gemerkt.push(t); }, setzeStatus: async (_u: string, _i: string, s: string) => { status.push(s); } } as unknown as FernzugriffRepo;
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
        return o.lauf ? o.lauf(befehl, stdin) : ok('angelegt mssql');
      }
      return ok();
    },
    protokoll: (m, d) => { protokoll.push({ m, d }); },
  });
  return { skill, aufrufe, protokoll, status, gemerkt };
}
const pfadAus = (b: string) => /\/run\/alfred-s-[0-9a-f]{16}\.sh/.exec(b)![0];

describe('linuxSkript', () => {
  it('legt das Skript des registrierten Bausteins per stdin ab und führt es zeitbegrenzt mit der Eingabe auf stdin aus', async () => {
    const w = welt();
    const r = await w.skill.linuxSkript('sql-lx01', 'test.sql-setup', { instanz: 'mssql' }, EINGABE, 60_000, 'mssql-conf setup');
    expect(r.code).toBe(0);
    const [ablegen, ausfuehren] = w.aufrufe;
    const pfad = pfadAus(ablegen!.befehl);
    expect(ablegen).toEqual({ art: 'eingabe', befehl: `sudo -n sh -c 'umask 077; cat > ${pfad}'`, stdin: expect.stringContaining(SKRIPT) });
    expect(ablegen!.stdin).not.toContain(GEHEIM);
    expect(ausfuehren).toEqual({ art: 'eingabe', befehl: `sudo -n timeout --kill-after=15s 40s bash ${pfad}`, stdin: `${EINGABE}\n` });
  });

  it('fester Kopf: Selbstlöschung, Eingabe in nicht exportierte Variable, danach stdin auf /dev/null — alles vor dem Baustein', async () => {
    const w = welt();
    await w.skill.linuxSkript('sql-lx01', 'test.sql-setup', { instanz: 'mssql' }, EINGABE, 60_000, 'x');
    const s = w.aufrufe[0]!.stdin!;
    const pfad = pfadAus(w.aufrufe[0]!.befehl);
    const kopf = `#!/bin/bash\ntrap 'rm -f -- ${pfad}' EXIT\nrm -f -- ${pfad}\nALFRED_EINGABE=''\nIFS= read -r ALFRED_EINGABE || true\nexec </dev/null\n`;
    expect(s).toBe(kopf + SKRIPT);
    expect(s).not.toMatch(/export\s+ALFRED_EINGABE/);
  });

  it('Zeitgrenze am Host: Gesamtzeit minus 20 s, mindestens 30 s', async () => {
    const w = welt();
    await w.skill.linuxSkript('sql-lx01', 'test.sql-setup', { instanz: 'mssql' }, undefined, 20_000, 'x');
    await w.skill.linuxSkript('sql-lx01', 'test.sql-setup', { instanz: 'mssql' }, undefined, 900_000, 'x');
    const laeufe = w.aufrufe.filter(a => a.befehl.includes(' bash ')).map(a => a.befehl.replace(/\/run\/\S+/, 'D'));
    expect(laeufe).toEqual(['sudo -n timeout --kill-after=15s 30s bash D', 'sudo -n timeout --kill-after=15s 880s bash D']);
  });

  it('nur registrierte Bausteine: unbekannter Schlüssel oder ungültige Parameter → Fehler ohne SSH-Aufruf', async () => {
    const w = welt();
    await expect(w.skill.linuxSkript('sql-lx01', 'test.fremd', {}, EINGABE, 60_000, 'x')).rejects.toThrow(/Unbekannter Linux-Baustein/);
    await expect(w.skill.linuxSkript('sql-lx01', 'test.sql-setup', { instanz: 'x; rm -rf /' }, EINGABE, 60_000, 'x')).rejects.toThrow(/ungültige Instanz/);
    expect(w.aufrufe).toHaveLength(0);
  });

  it('Eingabe mit Zeilenumbruch wird abgewiesen (der Kopf liest genau eine Zeile)', async () => {
    const w = welt();
    await expect(w.skill.linuxSkript('sql-lx01', 'test.sql-setup', { instanz: 'mssql' }, `${GEHEIM}\nzweite`, 60_000, 'x')).rejects.toThrow(/eine Zeile/);
    expect(w.aufrufe).toHaveLength(0);
  });

  it('Skript- und Geheimnis-Text erscheinen in keinem Befehl, nicht im Protokoll, nicht im Ergebnis und nicht im gemerkten Fehler', async () => {
    const w = welt({ lauf: () => ({ code: 1, stdout: `sa=${GEHEIM} gesetzt`, stderr: `Fehler: Anmeldung mit ${GEHEIM} abgelehnt`, hostSchluesselGeaendert: false }) });
    const r = await w.skill.linuxSkript('sql-lx01', 'test.sql-setup', { instanz: 'mssql' }, EINGABE, 60_000, 'mssql-conf setup');
    for (const a of w.aufrufe) {
      expect(a.befehl).not.toContain('MARKE-SKRIPT-4711');
      expect(a.befehl).not.toContain(GEHEIM);
    }
    expect(JSON.stringify(w.protokoll)).not.toContain(GEHEIM);
    expect(JSON.stringify(w.protokoll)).not.toContain('MARKE-SKRIPT-4711');
    expect(w.protokoll.at(-1)).toMatchObject({ d: { name: 'sql-lx01', zweck: 'mssql-conf setup', code: 1, mitGeheimnis: true } });
    expect(r.stdout).not.toContain(GEHEIM);
    expect(r.stderr).not.toContain(GEHEIM);
    expect(r.stderr).toContain('[geschwärzt]');
    expect(w.gemerkt.join('|')).not.toContain(GEHEIM);
    expect(w.gemerkt.join('|')).toContain('[geschwärzt]');
  });

  it('nicht-JSON-Eingabe: die Zeile selbst wird geschwärzt; kurze Werte (< 6 Zeichen) bleiben', async () => {
    const w = welt({ lauf: () => ({ code: 0, stdout: `${GEHEIM} ab 1433`, stderr: '', hostSchluesselGeaendert: false }) });
    const r = await w.skill.linuxSkript('sql-lx01', 'test.sql-setup', { instanz: 'mssql' }, GEHEIM, 60_000, 'x');
    expect(r.stdout).not.toContain(GEHEIM);
    const j = await welt({ lauf: () => ({ code: 0, stdout: 'ab 1433', stderr: '', hostSchluesselGeaendert: false }) }).skill.linuxSkript('sql-lx01', 'test.sql-setup', { instanz: 'mssql' }, EINGABE, 60_000, 'x');
    expect(j.stdout).toBe('ab 1433');
  });

  it('eingabeWerte: JSON-Zeichenketten (auch verschachtelt), sonst die ganze Zeile; Zahlenzeilen zählen als Zeile', () => {
    expect(eingabeWerte(JSON.stringify({ a: { b: ['langer-wert-1', 'kurz'] }, c: 'zweiter-wert' }))).toEqual(['langer-wert-1', 'zweiter-wert']);
    expect(eingabeWerte('"geheimwert"')).toEqual(['geheimwert']);
    expect(eingabeWerte('12345678')).toEqual(['12345678']);
    expect(eingabeWerte(undefined)).toEqual([]);
  });

  it('jeder Aufruf bekommt einen neuen zufälligen Dateinamen; ohne Eingabe leere Standardeingabe', async () => {
    const w = welt();
    await w.skill.linuxSkript('sql-lx01', 'test.sql-setup', { instanz: 'a' }, undefined, 60_000, 'a');
    await w.skill.linuxSkript('sql-lx01', 'test.sql-setup', { instanz: 'b' }, undefined, 60_000, 'b');
    const namen = w.aufrufe.filter(a => a.befehl.includes('cat >')).map(a => pfadAus(a.befehl));
    expect(namen).toHaveLength(2);
    expect(namen[0]).not.toBe(namen[1]);
    expect(w.aufrufe[1]!.stdin).toBe('');
    expect(w.protokoll.at(-1)).toMatchObject({ d: { mitGeheimnis: false } });
  });

  it('bei Fehler und Zeitüberschreitung wird die Datei zusätzlich von außen entfernt', async () => {
    for (const code of [1, 124]) {
      const w = welt({ lauf: () => ({ code, stdout: '', stderr: 'kaputt', hostSchluesselGeaendert: false }) });
      const r = await w.skill.linuxSkript('sql-lx01', 'test.sql-setup', { instanz: 'mssql' }, EINGABE, 60_000, 'x');
      expect(r.code).toBe(code);
      expect(w.aufrufe.at(-1)).toEqual({ art: 'ssh', befehl: `sudo -n rm -f -- ${pfadAus(w.aufrufe[0]!.befehl)}` });
    }
  });

  it('bricht die Verbindung ab, wird die Datei entfernt und der Fehler weitergegeben', async () => {
    const w = welt({ wirft: true });
    await expect(w.skill.linuxSkript('sql-lx01', 'test.sql-setup', { instanz: 'mssql' }, EINGABE, 60_000, 'x')).rejects.toThrow('Verbindung weg');
    expect(w.aufrufe.at(-1)!.befehl).toMatch(/^sudo -n rm -f -- \/run\/alfred-s-[0-9a-f]{16}\.sh$/);
  });

  it('Ablegen scheitert → Fehler, kein Ausführen, Datei wird entfernt', async () => {
    const w = welt();
    const skill = w.skill as unknown as { deps: { sshEingabe: (...a: unknown[]) => Promise<SshErgebnis> } };
    skill.deps.sshEingabe = async (_z, befehl) => { w.aufrufe.push({ art: 'eingabe', befehl: String(befehl) }); return { code: 1, stdout: '', stderr: 'sudo: a password is required', hostSchluesselGeaendert: false }; };
    await expect(w.skill.linuxSkript('sql-lx01', 'test.sql-setup', { instanz: 'mssql' }, EINGABE, 60_000, 'x')).rejects.toThrow(/nicht abgelegt.*Exit 1/);
    expect(w.aufrufe.some(a => a.befehl.includes(' bash '))).toBe(false);
    expect(w.aufrufe.at(-1)!.befehl).toMatch(/^sudo -n rm -f -- /);
  });

  it('geänderter Host-Schlüssel sperrt den Zugang', async () => {
    const w = welt({ lauf: () => ({ code: 255, stdout: '', stderr: 'REMOTE HOST IDENTIFICATION HAS CHANGED', hostSchluesselGeaendert: true }) });
    await expect(w.skill.linuxSkript('sql-lx01', 'test.sql-setup', { instanz: 'mssql' }, EINGABE, 60_000, 'x')).rejects.toThrow(/gesperrt/);
    expect(w.status).toEqual(['gesperrt']);
  });

  it('Windows-Zugang wird abgewiesen, ohne etwas zu senden', async () => {
    const w = welt();
    await expect(w.skill.linuxSkript('sql01', 'test.sql-setup', { instanz: 'mssql' }, EINGABE, 60_000, 'x')).rejects.toThrow(/kein Linux-Zugang/);
    expect(w.aufrufe).toHaveLength(0);
  });
});
