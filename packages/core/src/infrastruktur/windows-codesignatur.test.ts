import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Codesignierer, CodesignaturAblage, pruefeAusgestellt, pruefeVorlage, vorlageAnlegenSkript, vorlageEntfernenSkript, ausstellenSkript, ersteZertifikat, type Lokal } from './windows-codesignatur.js';
import { TEST_CA_PEM, TEST_SCHLUESSEL_PEM, TEST_ZERT_PEM, TEST_ZERT_OHNE_EKU_PEM, TEST_CA_THUMBPRINT } from './windows-codesignatur.fixture.js';
import { WindowsPkiSkill } from './windows-pki-skill.js';
import { FernzugriffSkill, type FernzugriffRepo } from '../fernzugriff/fernzugriff-skill.js';
import type { Fernzugang } from '@alfred/storage';

const der = (pem: string) => pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
const KETTE = `${TEST_ZERT_PEM}${TEST_CA_PEM}`;

/** osslsigncode-Attrappe: hängt einen Signaturblock an und schreibt die Ausgabedatei */
function attrappe(): { lokal: Lokal; aufrufe: string[][] } {
  const aufrufe: string[][] = [];
  const lokal: Lokal = async (befehl, args) => {
    aufrufe.push([befehl, ...args]);
    const { readFile, writeFile } = await import('node:fs/promises');
    const ein = args[args.indexOf('-in') + 1]!; const aus = args[args.indexOf('-out') + 1]!;
    await writeFile(aus, `${await readFile(ein, 'utf8')}# SIG # Begin signature block\r\n# SIG # End signature block\r\n`);
    return { code: 0, stdout: 'Succeeded', stderr: '' };
  };
  return { lokal, aufrufe };
}

describe('Etappe 3a Codesignatur — Signieren und Bewerten', () => {
  it('aus: unsigniert (null), an: osslsigncode mit Kette und Schlüssel, Arbeitsordner wieder weg', async () => {
    const { lokal, aufrufe } = attrappe();
    let an = false;
    const s = new Codesignierer({ aktiv: async () => an, material: async () => ({ schluesselPem: TEST_SCHLUESSEL_PEM, kettePem: KETTE }), lokal });
    expect(await s.signiere('Write-Output 1\n')).toBeNull();
    expect(aufrufe).toHaveLength(0);
    an = true;
    const r = await s.signiere('\uFEFFWrite-Output "Grüße"\n');
    expect(r).toContain('# SIG # End signature block');
    expect(r!.startsWith('\uFEFFWrite-Output "Grüße"')).toBe(true);
    expect(aufrufe[0]!.slice(0, 2)).toEqual(['osslsigncode', 'sign']);
    expect(aufrufe[0]).toContain('sha256');
    const ordner = aufrufe[0]![aufrufe[0]!.indexOf('-key') + 1]!.replace(/[\\/]k\.pem$/, '');
    await expect(stat(ordner)).rejects.toThrow();
  });

  it('HashMismatch/NotSigned brechen ab, Valid/NotTrusted werden gezählt, Unlesbares ist „unbekannt“', () => {
    const p = vi.fn();
    const s = new Codesignierer({ aktiv: async () => true, material: async () => ({ schluesselPem: '', kettePem: '' }), lokal: async () => ({ code: 0, stdout: '', stderr: '' }), protokoll: p });
    expect(s.bewerte('Valid\r\n', 'fs01')).toBe('Valid');
    expect(s.bewerte('UnknownError\n', 'probe')).toBe('UnknownError');
    expect(s.bewerte('Der Befehl ist unbekannt', 'x')).toBe('unbekannt');
    expect(() => s.bewerte('HashMismatch', 'fs01')).toThrow(/verändert; nicht ausgeführt/);
    expect(() => s.bewerte('NotSigned', 'fs01')).toThrow(/NotSigned/);
    expect(s.zaehler).toEqual({ Valid: 1, UnknownError: 1, unbekannt: 1, HashMismatch: 1, NotSigned: 1 });
    expect(p).toHaveBeenCalledWith('Codesignatur geprüft', { wo: 'fs01', status: 'Valid' });
  });

  it('Prüfausdruck nur für Alfreds Skriptdateien', () => {
    expect(Codesignierer.pruefAusdruck('C:\\Windows\\Temp\\alfred-s-0123456789abcdef.ps1')).toBe('(Get-AuthenticodeSignature -LiteralPath C:\\Windows\\Temp\\alfred-s-0123456789abcdef.ps1).Status.ToString()');
    expect(() => Codesignierer.pruefAusdruck('C:\\Windows\\Temp\\x.ps1; rm')).toThrow();
  });

  it('Ablaufwarnung höchstens einmal am Tag, abgelaufen = kein Signieren', async () => {
    const { lokal } = attrappe();
    const melde = vi.fn();
    const bis = new Date(ersteZertifikat(TEST_ZERT_PEM).validTo).getTime();
    let jetzt = bis - 10 * 86_400_000;
    const s = new Codesignierer({ aktiv: async () => true, material: async () => ({ schluesselPem: TEST_SCHLUESSEL_PEM, kettePem: KETTE }), lokal, melde, jetzt: () => jetzt });
    await s.signiere('a'); await s.signiere('b');
    expect(melde).toHaveBeenCalledTimes(1);
    expect(melde.mock.calls[0]![0]).toMatch(/läuft in (9|10) Tagen ab/);
    jetzt = bis + 1000; s.vergiss();
    await expect(s.signiere('c')).rejects.toThrow(/abgelaufen/);
  });
});

describe('Etappe 3a Codesignatur — ausgestelltes Zertifikat prüfen', () => {
  const basis = { schluesselPem: TEST_SCHLUESSEL_PEM, zertBase64: der(TEST_ZERT_PEM), caBase64: der(TEST_CA_PEM), erwartet_cn: 'Alfred Codesignatur', erwartet_aussteller_thumbprint: TEST_CA_THUMBPRINT };
  it('passendes Zertifikat: Kette, Seriennummer, Restlaufzeit', () => {
    const g = pruefeAusgestellt(basis);
    expect(g.kettePem).toContain('BEGIN CERTIFICATE');
    expect(g.kettePem.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect(g.tage).toBeGreaterThan(300);
    expect(g.aussteller).toContain('Test Issuing CA');
  });
  it('lehnt falschen Aussteller, falschen Namen, fehlende Verwendung und fremden Schlüssel ab', () => {
    expect(() => pruefeAusgestellt({ ...basis, erwartet_aussteller_thumbprint: '0'.repeat(40) })).toThrow(/nicht die erwartete Issuing-CA/);
    expect(() => pruefeAusgestellt({ ...basis, erwartet_cn: 'Jemand' })).toThrow(/statt CN=Jemand/);
    expect(() => pruefeAusgestellt({ ...basis, zertBase64: der(TEST_ZERT_OHNE_EKU_PEM) })).toThrow(/ohne Verwendung Codesignatur/);
    const { generateKeyPairSync } = require('node:crypto') as typeof import('node:crypto');
    const fremd = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    expect(() => pruefeAusgestellt({ ...basis, schluesselPem: fremd })).toThrow(/gehört nicht zum Schlüssel/);
  });
});

describe('Etappe 3a Codesignatur — Bausteine', () => {
  it('Vorlage: nur Codesignatur, Name aus der Anforderung, CA-Freigabe, nur Domänen-Admins, auf der CA ausgestellt', () => {
    const v = pruefeVorlage({ vorlage: 'AD3033AlfredCodesignatur', anzeige: 'AD3033 Alfred Codesignatur' });
    expect(v).toEqual({ vorlage: 'AD3033AlfredCodesignatur', anzeige: 'AD3033 Alfred Codesignatur', gueltig_tage: 365, schluessel_bits: 3072 });
    expect(pruefeVorlage({ vorlage: 'a b', anzeige: 'x y z' })).toContain('vorlage');
    expect(pruefeVorlage({ vorlage: 'Abc', anzeige: 'Abc', gueltig_tage: 3650 })).toContain('gueltig_tage');
    // das innere Skript steht als PowerShell-Literal (einfache Anführungszeichen verdoppelt) im äußeren
    const s = vorlageAnlegenSkript(v as never).replace(/''/g, "'");
    for (const t of ["'msPKI-Enrollment-Flag', 2", "'msPKI-Certificate-Name-Flag', 1", '1.3.6.1.5.5.7.3.3', '0e10c968-78fb-11d2-90d4-00c04f79dc55', 'AccountDomainAdminsSid', "-SetCATemplates ('+' + $p.vorlage)", 'pKIExpirationPeriod', '864000000000', 'MitKonto']) expect(s).toContain(t);
    expect(vorlageEntfernenSkript(v as never).replace(/''/g, "'")).toContain("-SetCATemplates ('-' + $p.vorlage)");
  });
  it('Ausstellen: Hash der Anforderung vor dem Einreichen, Freigabe als CA-Verwalter, Abholen', () => {
    const s = ausstellenSkript({ vorlage: 'AD3033AlfredCodesignatur', csr_sha256: 'a'.repeat(64), erwartet_cn: 'Alfred Codesignatur' });
    expect(s.indexOf("passt nicht zum Hash")).toBeLessThan(s.indexOf('function MitKonto'));
    for (const t of ['certreq.exe -submit', '-resubmit', 'certreq.exe -retrieve', '-ca.cert']) expect(s).toContain(t);
  });
});

describe('Etappe 3a Codesignatur — Skill windows_pki und Ablage', () => {
  async function aufbau() {
    const dir = await mkdtemp(join(tmpdir(), 'alfred-cs-test-'));
    const ablage = new CodesignaturAblage(join(dir, 'codesignatur'));
    const zaehler = { Valid: 3 };
    const skill = new WindowsPkiSkill({ skript: async () => ({ code: 1, stdout: '', stderr: 'nicht erwartet' }), lokal: async () => ({ code: 1, stdout: '', stderr: 'nicht erwartet' }), codesignatur: { ablage, zaehler: () => zaehler, vergiss: () => undefined } });
    return { dir, ablage, skill };
  }
  const ausChange = { ausChange: true } as never;
  it('schalten an verweigert ohne Material; mit Material an, Status zeigt Zertifikat und Zähler; Ablage 700/600', async () => {
    const t = await aufbau();
    try {
      expect((await t.skill.execute({ action: 'codesignatur_schalten', an: true }, ausChange)).error).toContain('Material fehlt');
      expect((await t.skill.execute({ action: 'codesignatur_schalten', an: true })).error).toContain('nur als Schritt');
      await t.ablage.speichere({ schluesselPem: TEST_SCHLUESSEL_PEM, kettePem: KETTE });
      const r = await t.skill.execute({ action: 'codesignatur_schalten', an: true }, ausChange);
      expect(r.display).toContain('CODESIGN_SWITCH an');
      expect(await t.ablage.an()).toBe(true);
      const st = await t.skill.execute({ action: 'codesignatur_status' });
      expect(st.display).toMatch(/Codesignatur AN; Zertifikat CN=Alfred Codesignatur.*Prüfungen seit dem Start: Valid 3/);
      if (process.platform !== 'win32') {
        expect((await stat(join(t.dir, 'codesignatur'))).mode & 0o777).toBe(0o700);
        expect((await stat(join(t.dir, 'codesignatur', 'schluessel.pem'))).mode & 0o777).toBe(0o600);
      }
    } finally { await rm(t.dir, { recursive: true, force: true }); }
  });
  it('einrichten liefert ein gültiges abgelegtes Zertifikat zurück, statt ein zweites auszustellen', async () => {
    const t = await aufbau();
    try {
      await t.ablage.speichere({ schluesselPem: TEST_SCHLUESSEL_PEM, kettePem: KETTE });
      const r = await t.skill.execute({ action: 'codesignatur_einrichten', zugang: 'pkiiss01', vorlage: 'AD3033AlfredCodesignatur', erwartet_aussteller_thumbprint: TEST_CA_THUMBPRINT }, ausChange);
      expect(r.success).toBe(true);
      expect(r.display).toContain('schon eingerichtet');
    } finally { await rm(t.dir, { recursive: true, force: true }); }
  });
});

describe('Etappe 3a Codesignatur — Hochladen über SSH', () => {
  function aufbau(status: string) {
    const zug = { id: 'w1', userId: 'owner', name: 'fs01', host: '10.203.29.5', port: 22, benutzer: 'alfred', status: 'aktiv', system: 'windows', schluesselPfad: '/k', hostSchluessel: 'x', erstellt: 't', geaendert: 't' } as unknown as Fernzugang;
    const repo = { liste: async () => [zug], finde: async () => zug, hole: async () => zug, speichere: async () => zug, setzeStatus: async () => undefined, merkeErgebnis: async () => undefined, entferne: async () => true, setzeKaefig: async () => undefined } as unknown as FernzugriffRepo;
    const befehle: string[] = []; const abgelegt: string[] = [];
    const skill = new FernzugriffSkill({
      repo, owner: () => 'owner', istOwner: () => true, bestaetigung: async () => true,
      ssh: async (_z, b) => { befehle.push(b); return { code: 0, stdout: b.startsWith('(Get-AuthenticodeSignature') ? `${status}\r\n` : 'ALFRED-AD {}\n', stderr: '', hostSchluesselGeaendert: false }; },
      sftp: async (_z, inhalt) => { abgelegt.push(inhalt); return { code: 0, stdout: '', stderr: '', hostSchluesselGeaendert: false }; },
      keyscan: async () => '', schluessel: async () => ({ pfad: '/k', oeffentlich: 'x', neu: false }),
      codesignatur: { signiere: async (i) => `${i}# SIG # Begin signature block\r\n`, bewerte: (s, w) => new Codesignierer({ aktiv: async () => true, material: async () => ({ schluesselPem: '', kettePem: '' }), lokal: async () => ({ code: 0, stdout: '', stderr: '' }) }).bewerte(s, w) },
    });
    const kodiert = `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from('Write-Output 1', 'utf16le').toString('base64')}`;
    return { skill, befehle, abgelegt, kodiert };
  }
  it('signiert, prüft vor dem Start und startet dann', async () => {
    const t = aufbau('Valid');
    const r = await t.skill.windowsSkript('fs01', t.kodiert, undefined, 30_000, 'Probe');
    expect(r.code).toBe(0);
    expect(t.abgelegt[0]).toContain('# SIG # Begin signature block');
    expect(t.befehle[0]).toMatch(/^\(Get-AuthenticodeSignature -LiteralPath C:\\Windows\\Temp\\alfred-s-[0-9a-f]{16}\.ps1\)\.Status\.ToString\(\)$/);
    expect(t.befehle[1]).toMatch(/-File C:\\Windows\\Temp\\alfred-s-/);
  });
  it('HashMismatch: nicht gestartet, Datei entfernt', async () => {
    const t = aufbau('HashMismatch');
    await expect(t.skill.windowsSkript('fs01', t.kodiert, undefined, 30_000, 'Probe')).rejects.toThrow(/nach dem Signieren verändert/);
    expect(t.befehle).toHaveLength(2);
    expect(t.befehle[1]).toMatch(/^Remove-Item -LiteralPath C:\\Windows\\Temp\\alfred-s-/);
    expect(t.befehle.some(b => b.includes('-File'))).toBe(false);
  });
});

// v1847 — Realfall 13.11. Entwurf e850f204: der Planer verlangte eine Prüfung; Alfred behalf sich mit „Write-Output '{{schritt3.text}}'“
describe('v1847 Codesignatur-Bausteine prüfen sich selbst', () => {
  it('Plan ohne eigene Prüfung bei Vorlage und Zertifikat wird angenommen', async () => {
    const { pruefeChangePlan } = await import('./change-schritte.js');
    const sk = new WindowsPkiSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
    const plan = {
      titel: 'PKI 3a Codesignatur', begruendung: 'Owner 13.11.', typ: 'normal', risiko: 'mittel', ausfallMinuten: 0, betroffen: ['pkiiss01'],
      schritte: [
        { titel: 'Vorlage', art: 'aktion', skill: 'windows_pki', aktion: 'codesignatur_vorlage_anlegen', parameter: { zugang: 'pkiiss01', vorlage: 'AD3033AlfredCodesignatur', anzeige: 'AD3033 Alfred Codesignatur' }, rueckweg: { skill: 'windows_pki', aktion: 'codesignatur_vorlage_entfernen', parameter: { zugang: 'pkiiss01', vorlage: 'AD3033AlfredCodesignatur', anzeige: 'AD3033 Alfred Codesignatur' } } },
        { titel: 'Zertifikat', art: 'aktion', skill: 'windows_pki', aktion: 'codesignatur_einrichten', parameter: { zugang: 'pkiiss01', vorlage: 'AD3033AlfredCodesignatur', erwartet_aussteller_thumbprint: TEST_CA_THUMBPRINT }, rueckweg: { skill: 'windows_pki', aktion: 'codesignatur_sperren', parameter: { zugang: 'pkiiss01', seriennummer: '{{schritt2.seriennummer}}', grund: 'cessationOfOperation' } } },
      ] };
    const ctx = { skill: (n: string) => (n === 'windows_pki' ? sk as never : undefined), asset: (n: string) => ({ id: `a-${n}`, name: n }), changes: [] };
    expect(pruefeChangePlan(plan, ctx as never).fehler.filter(x => /Prüfung|pruefung/i.test(x))).toEqual([]);
  });
});

// v1848 — Realfall 13.11. e850f204 Schritt 5: Anforderung 3 ausgestellt, Abholen scheiterte (.rsp existierte), Schlüssel verloren
describe('v1848 Abholen wiederholbar, Schlüssel vor dem Einreichen abgelegt', () => {
  it('Ausstellen: -f beim Einreichen und Abholen, RequestId je Anforderung gemerkt und wiederverwendet', async () => {
    const s = ausstellenSkript({ vorlage: 'AD3033AlfredCodesignatur', csr_sha256: 'b'.repeat(64), erwartet_cn: 'Alfred Codesignatur' }).replace(/''/g, "'");
    expect(s).toContain('certreq.exe -submit -f -q');
    expect(s.match(/certreq\.exe -retrieve -f -q/g)).toHaveLength(2);
    expect(s).toContain("('codesignatur-' + $p.csr_sha256.Substring(0, 16) + '.id')");
    expect(s.indexOf('$wieder = Test-Path')).toBeLessThan(s.indexOf('certreq.exe -submit'));
  });
  it('einrichten legt Schlüssel und Anforderung ab, bevor die CA gefragt wird, und nutzt sie beim Wiederholen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'alfred-cs-test-'));
    try {
      const ablage = new CodesignaturAblage(join(dir, 'codesignatur'));
      const eingaben: string[] = [];
      let n = 0;
      const lokal: Lokal = async (befehl, args) => {
        n++;
        const { writeFile } = await import('node:fs/promises');
        if (args[0] === 'genpkey') await writeFile(args[args.indexOf('-out') + 1]!, TEST_SCHLUESSEL_PEM);
        if (args[0] === 'req') await writeFile(args[args.indexOf('-out') + 1]!, Buffer.from(`csr-${n}`));
        return { code: 0, stdout: '', stderr: '' };
      };
      const skill = new WindowsPkiSkill({
        skript: async (_z, _b, e) => { eingaben.push(e ?? ''); return { code: 1, stdout: '', stderr: 'certreq -retrieve 3: Datei existiert' }; },
        lokal, tresor: { namen: async () => new Set(['win-dc01-admin']), lies: async () => 'pw' },
        codesignatur: { ablage, zaehler: () => ({}), vergiss: () => undefined },
      });
      const p = { action: 'codesignatur_einrichten', zugang: 'pkiiss01', vorlage: 'AD3033AlfredCodesignatur', o: 'AD3033', erwartet_aussteller_thumbprint: TEST_CA_THUMBPRINT };
      expect((await skill.execute(p, { ausChange: true } as never)).success).toBe(false);
      const a = await ablage.ausstehend();
      expect(a?.schluesselPem).toBe(TEST_SCHLUESSEL_PEM);
      expect((await skill.execute(p, { ausChange: true } as never)).success).toBe(false);
      expect(n).toBe(2); // genpkey + req nur beim ersten Mal
      expect(JSON.parse(eingaben[0]!).csr_base64).toBe(JSON.parse(eingaben[1]!).csr_base64);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('Seriennummer zur Anforderung prüft den Namen', async () => {
    const { seriennummerSkript } = await import('./windows-codesignatur.js');
    const s = seriennummerSkript({ request_id: 3, erwartet_cn: 'Alfred Codesignatur' });
    expect(s).toContain("-restrict ('RequestId=' + [int]$p.request_id)");
    expect(s).toContain("gehört zu „");
  });
});
