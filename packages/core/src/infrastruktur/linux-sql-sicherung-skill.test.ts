import { describe, it, expect } from 'vitest';
import { LinuxSqlSkill, linuxSqlStatusText, linuxSqlSicherungenText, type LinuxSqlStatus } from './linux-sql-skill.js';
import { LINUX_SQL_SICHERUNG_BAUSTEINE } from './linux-sql-sicherung.js';
import { PRUEFDATEN_SHA256, PRUEFDATEN_ZEILEN } from './linux-sql.js';
import { aktionsArt, pruefeChangePlan, FESTE_AUSGABEN } from './change-schritte.js';

// I8e Task 4 — Skill linux_sql: sicherung_einrichten, sicherung_jetzt, sicherungen, wiederherstellen_pruefen

interface Aufruf { zugang: string; baustein: string; parameter: unknown; eingabe?: string; timeoutMs: number; zweck: string }
const imChange = { ausChange: true } as never;
const SA = 'Sa-Geheim-1234567890!';
const FS = 'Al-FsGeheimFsGeheimFsGeheim9a';
const TRESOR = { 'sqllnx-sqllnx01-sa': SA, 'ad-svc-sqllnx-backup': FS };

function welt(antworten: Record<string, Array<Record<string, unknown>>>, tresorDa: Record<string, string> = TRESOR) {
  const aufrufe: Aufruf[] = [];
  const tresor = new Map<string, string>(Object.entries(tresorDa));
  const skill = new LinuxSqlSkill({
    skript: async (zugang, baustein, parameter, eingabe, timeoutMs, zweck) => {
      aufrufe.push({ zugang, baustein, parameter, ...(eingabe !== undefined ? { eingabe } : {}), timeoutMs, zweck });
      const liste = antworten[baustein] ?? [];
      const a = liste.length > 1 ? liste.shift()! : liste[0];
      if (!a) return { code: 1, stdout: '', stderr: `kein Stub für ${baustein}` };
      return { code: a.zustand === 'fehler' ? 1 : 0, stdout: `ALFRED-SQL ${JSON.stringify(a)}\n`, stderr: '' };
    },
    tresor: { namen: async () => new Set(tresor.keys()), lies: async n => tresor.get(n)!, setze: async (n, w) => { tresor.set(n, w); } },
  });
  return { skill, aufrufe };
}
const EINRICHTEN = { action: 'sicherung_einrichten', zugang: 'sqllnx01', ziel_freigabe: '\\\\fs01.ad.3033.at\\SQLLinuxBackup$', konto_tresor: 'ad-svc-sqllnx-backup', budget_gib: 64 };
const VERIFIZIERT = { zustand: 'geaendert', ergebnis: 'RESTORE_VERIFIED', datenbank: 'pruefdb01', ziel: 'alfred_wh_pruefdb01', kette: '20261116003000', diff: true, logs: 3, checkdb: 'ohne Befund', zeilen: PRUEFDATEN_ZEILEN, pruefsumme: PRUEFDATEN_SHA256, entfernt: true };

describe('I8e Task 4 — Skill: Sicherung', () => {
  it('ändernde Sicherungs-Aktionen nur im Change (ohne Fernaufruf); sicherungen liest auch außerhalb', async () => {
    const w = welt({ [LINUX_SQL_SICHERUNG_BAUSTEINE.liste]: [{ zustand: 'gelesen', datenbanken: {} }] });
    for (const action of ['sicherung_einrichten', 'sicherung_jetzt', 'wiederherstellen_pruefen']) {
      const r = await w.skill.execute({ ...EINRICHTEN, action, art: 'full', datenbank: 'pruefdb01' }, {} as never);
      expect(r.error, action).toContain('nur als Schritt eines freigegebenen Changes');
    }
    expect(w.aufrufe).toEqual([]);
    // Fix-Runde 1 (Sicherheit): sicherungen liest keinen Tresor — auch ohne jeden Tresor-Eintrag, ohne Eingabe
    const leer = welt({ [LINUX_SQL_SICHERUNG_BAUSTEINE.liste]: [{ zustand: 'gelesen', datenbanken: {} }] }, {});
    const s = await leer.skill.execute({ action: 'sicherungen', zugang: 'sqllnx01' }, {} as never);
    expect(s.success, s.error).toBe(true);
    expect(leer.aufrufe[0]!.eingabe).toBeUndefined();
    expect(leer.aufrufe[0]!.parameter).toEqual({});
  });
  it('sicherung_einrichten: Ziel, Konto und Domäne aus ziel_freigabe/konto_tresor; Kennwörter nur über stdin', async () => {
    const w = welt({ [LINUX_SQL_SICHERUNG_BAUSTEINE.einrichten]: [{ zustand: 'geaendert', jobs: 3, agent: 1, timer: 'aktiv', zugangsdatei: 'vorhanden (0600)', ziel: '//fs01.ad.3033.at/SQLLinuxBackup$', budgetBytes: 64 * 2 ** 30, belegtBytes: 300 }] });
    const r = await w.skill.execute(EINRICHTEN, imChange);
    expect(r.error).toBeUndefined();
    const a = w.aufrufe[0]!;
    expect(a.baustein).toBe(LINUX_SQL_SICHERUNG_BAUSTEINE.einrichten);
    expect(a.parameter).toEqual({ server: 'fs01.ad.3033.at', freigabe: 'SQLLinuxBackup$', konto: 'svc-sqllnx-backup', domaene: 'ad.3033.at', budgetGiB: 64 });
    expect(JSON.parse(a.eingabe!)).toEqual({ sa: SA, kennwort: FS });
    expect(JSON.stringify(a.parameter) + a.zweck).not.toContain(FS);
    expect(r.display).toContain('Zugangsdatei vorhanden (0600)');
    expect(r.display).toContain('3 Agent-Jobs');
    expect(JSON.stringify(r)).not.toContain(FS);
    // ausdrückliches Konto mit NetBIOS-Domäne
    const w2 = welt({ [LINUX_SQL_SICHERUNG_BAUSTEINE.einrichten]: [{ zustand: 'schon', jobs: 3, timer: 'aktiv', zugangsdatei: 'vorhanden (0600)' }] });
    const r2 = await w2.skill.execute({ ...EINRICHTEN, konto: 'AD3033\\svc-sqllnx-backup' }, imChange);
    expect(w2.aufrufe[0]!.parameter).toMatchObject({ konto: 'svc-sqllnx-backup', domaene: 'AD3033' });
    expect(r2.display).toContain('nichts zu tun');
    // Fix-Runde 2: Standard-Budget 63 GiB — 1 GiB unter dem harten FSRM-Kontingent von 64 GiB
    const w3 = welt({ [LINUX_SQL_SICHERUNG_BAUSTEINE.einrichten]: [{ zustand: 'schon', jobs: 3, timer: 'aktiv', zugangsdatei: 'vorhanden (0600)' }] });
    const { budget_gib: _b, ...ohneBudget } = EINRICHTEN;
    await w3.skill.execute(ohneBudget, imChange);
    expect(w3.aufrufe[0]!.parameter).toMatchObject({ budgetGiB: 63 });
  });
  it('Fix-Runde 1 (Sicherheit): nur fs01 als Ziel, konto_tresor nur ad-svc-sqllnx-…, passend zum Konto — Fehler vor jedem Aufruf', async () => {
    const w = welt({});
    for (const zf of ['\\\\fs02.ad.3033.at\\SQLLinuxBackup$', '\\\\boese.example.com\\x$', '\\\\10.0.0.5\\SQLLinuxBackup$', '\\\\fs01\\SQLLinuxBackup$']) {
      const r = await w.skill.execute({ ...EINRICHTEN, ziel_freigabe: zf }, imChange);
      expect(r.error, zf).toContain('fs01.ad.3033.at');
      expect(w.skill.pruefeEingabe({ ...EINRICHTEN, ziel_freigabe: zf }), zf).toContain('fs01.ad.3033.at');
    }
    for (const kt of ['win-dc01-admin', 'sqllnx-sqllnx01-sa', 'ad-administrator', 'ad-svc-sqllnx-']) {
      expect((await w.skill.execute({ ...EINRICHTEN, konto_tresor: kt }, imChange)).error, kt).toContain('konto_tresor');
      expect((await w.skill.execute({ action: 'wiederherstellen_pruefen', zugang: 'sqllnx01', datenbank: 'pruefdb01', konto_tresor: kt }, imChange)).error, kt).toContain('konto_tresor');
    }
    expect((await w.skill.execute({ ...EINRICHTEN, konto: 'AD3033\\svc-sqllnx-andere' }, imChange)).error).toContain('ad-svc-sqllnx-andere');
    expect(w.aufrufe).toEqual([]);
  });
  it('sicherung_einrichten: fehlender Tresor-Eintrag des Dienstkontos → klarer Fehler ohne Fernaufruf', async () => {
    const w = welt({}, { 'sqllnx-sqllnx01-sa': SA });
    const r = await w.skill.execute(EINRICHTEN, imChange);
    expect(r.error).toContain('ad-svc-sqllnx-backup');
    expect(r.error).toContain('dienstkonto_anlegen');
    expect(w.aufrufe).toEqual([]);
  });
  it('Einschleusversuche in ziel_freigabe, konto, konto_tresor, budget_gib, art, datenbank, ziel_name → Fehler vor jedem Aufruf', async () => {
    const w = welt({});
    const boese = ['; rm -rf /', '$(id)', '`id`', 'a\nb', "x'y", 'a b', 'a"b'];
    for (const b of boese) {
      for (const p of [{ ziel_freigabe: `\\\\fs01.ad.3033.at\\S${b}` }, { ziel_freigabe: `\\\\fs01${b}.ad.3033.at\\S` }, { konto: `AD3033\\svc${b}` }, { konto_tresor: `ad-x${b}` }]) {
        const r = await w.skill.execute({ ...EINRICHTEN, ...p }, imChange);
        expect(r.success, `${JSON.stringify(p)}`).toBe(false);
      }
      expect((await w.skill.execute({ action: 'sicherung_jetzt', zugang: 'sqllnx01', art: 'full', datenbank: `db${b}` }, imChange)).success).toBe(false);
      expect((await w.skill.execute({ action: 'wiederherstellen_pruefen', zugang: 'sqllnx01', datenbank: 'pruefdb01', ziel_name: `alfred_wh_x${b}` }, imChange)).success).toBe(false);
    }
    for (const g of [0, 2000, 'viel', '64; id']) expect((await w.skill.execute({ ...EINRICHTEN, budget_gib: g }, imChange)).error).toContain('budget');
    expect((await w.skill.execute({ action: 'sicherung_jetzt', zugang: 'sqllnx01', art: 'voll', datenbank: 'pruefdb01' }, imChange)).error).toContain('art');
    expect((await w.skill.execute({ action: 'wiederherstellen_pruefen', zugang: 'sqllnx01', datenbank: 'pruefdb01', ziel_name: 'pruefdb01' }, imChange)).error).toContain('ziel');
    expect(w.aufrufe).toEqual([]);
  });
  it('sicherung_jetzt: art klein → groß, nur sa über stdin, Datei und Bestätigung auf fs01 im Text', async () => {
    const datei = '/var/opt/mssql/backup/pruefdb01/pruefdb01_FULL_20261116120000.bak';
    const w = welt({ [LINUX_SQL_SICHERUNG_BAUSTEINE.jetzt]: [{ zustand: 'geaendert', art: 'FULL', datenbank: 'pruefdb01', datei, sha256: 'ab'.repeat(32), fs01: true }] });
    const r = await w.skill.execute({ action: 'sicherung_jetzt', zugang: 'sqllnx01', art: 'full', datenbank: 'pruefdb01' }, imChange);
    expect(r.error).toBeUndefined();
    expect(w.aufrufe[0]!.parameter).toEqual({ art: 'FULL', datenbank: 'pruefdb01' });
    expect(JSON.parse(w.aufrufe[0]!.eingabe!)).toEqual({ sa: SA });
    expect(r.display).toContain(datei);
    expect(r.display).toContain('auf fs01 geprüft');
    const nein = welt({ [LINUX_SQL_SICHERUNG_BAUSTEINE.jetzt]: [{ zustand: 'geaendert', art: 'FULL', datenbank: 'pruefdb01', datei, fs01: false }] });
    expect((await nein.skill.execute({ action: 'sicherung_jetzt', zugang: 'sqllnx01', art: 'full', datenbank: 'pruefdb01' }, imChange)).success).toBe(false);
  });
  it('wiederherstellen_pruefen: Ziel standardmäßig alfred_wh_<db>; Erfolg nur mit RESTORE_VERIFIED und den Soll-Prüfdaten', async () => {
    const w = welt({ [LINUX_SQL_SICHERUNG_BAUSTEINE.wiederherstellen]: [VERIFIZIERT] });
    const r = await w.skill.execute({ action: 'wiederherstellen_pruefen', zugang: 'sqllnx01', datenbank: 'pruefdb01' }, imChange);
    expect(r.error).toBeUndefined();
    expect(w.aufrufe[0]!.parameter).toEqual({ datenbank: 'pruefdb01', ziel: 'alfred_wh_pruefdb01' });
    expect(JSON.parse(w.aufrufe[0]!.eingabe!)).toEqual({ sa: SA, kennwort: FS });
    expect(r.display).toMatch(/^✅ RESTORE_VERIFIED/);
    for (const falsch of [{ ...VERIFIZIERT, ergebnis: 'FAIL' }, { ...VERIFIZIERT, zeilen: 999 }, { ...VERIFIZIERT, pruefsumme: 'A'.repeat(64) }, { ...VERIFIZIERT, entfernt: false }, { ...VERIFIZIERT, checkdb: 'Fehler' }]) {
      const f = welt({ [LINUX_SQL_SICHERUNG_BAUSTEINE.wiederherstellen]: [falsch] });
      const x = await f.skill.execute({ action: 'wiederherstellen_pruefen', zugang: 'sqllnx01', datenbank: 'pruefdb01' }, imChange);
      expect(x.success, JSON.stringify(falsch)).toBe(false);
      expect(x.display ?? '').not.toContain('RESTORE_VERIFIED');
    }
  });
  it('Fehlermeldungen der Bausteine werden geschwärzt (sa- und fs01-Kennwort)', async () => {
    const w = welt({ [LINUX_SQL_SICHERUNG_BAUSTEINE.wiederherstellen]: [{ zustand: 'fehler', fehler: `mount error mit ${FS} und ${SA}` }] });
    const r = await w.skill.execute({ action: 'wiederherstellen_pruefen', zugang: 'sqllnx01', datenbank: 'pruefdb01' }, imChange);
    expect(r.error).toContain('[geschwärzt]');
    expect(r.error).not.toContain(FS);
    expect(r.error).not.toContain(SA);
  });
});

describe('I8e Task 4 — Wortlaut sicherungen und status', () => {
  const LISTE = {
    zustand: 'gelesen', host: 'sqllnx01', ziel: '//fs01.ad.3033.at/SQLLinuxBackup$', budgetBytes: 64 * 2 ** 30, belegtBytes: 3 * 2 ** 30,
    status: { zeit: '2026-11-16T12:07:00Z', ok: true, fehler: null, befunde: [], frisch: true, alterMin: 5 }, timer: 'active', zugangsdatei: 'vorhanden (0600)',
    datenbanken: { pruefdb01: { ketten: [{ full: '20261115003000', diffs: 3, logs: 96, vollstaendig: true, fehler: [] }, { full: '20261116003000', diffs: 1, logs: 40, vollstaendig: true, fehler: [] }], waisen: [], fs01Dateien: 142, fs01Bytes: 2 ** 30, fehlend: 0, lokalDateien: 142, lokalBytes: 2 ** 30, ausstehend: 0 } },
  };
  it('sicherungen: fester Wortlaut mit Ziel, Budget, letzter Kopie, Zugangsdatei, Timer, Ketten und Hash-Status', () => {
    const t = linuxSqlSicherungenText('sqllnx01', LISTE as never);
    expect(t).toBe('sqllnx01: Sicherung nach //fs01.ad.3033.at/SQLLinuxBackup$ (belegt 3.0 GiB von 64 GiB); Kopie zuletzt 2026-11-16T12:07:00Z ok; Zugangsdatei vorhanden (0600); Kopie-Timer aktiv; '
      // I8e Paket 2 Task 7: Rolle je Datenbank; fehlt sie (ältere Ausgabe), heißt sie „unbekannt“ — nie PRIMARY
      + 'pruefdb01: Rolle unbekannt, 2 Ketten (2 vollständig), letzte FULL 20261116003000, lokal 142, fs01 142, Hash ok — pruefdb01: vollständig auf fs01');
    const kaputt = linuxSqlSicherungenText('sqllnx01', { ...LISTE, status: { zeit: 'x', ok: false, fehler: 'Budget überschritten' }, datenbanken: { pruefdb01: { ...LISTE.datenbanken.pruefdb01, ketten: [{ ...LISTE.datenbanken.pruefdb01.ketten[0]!, vollstaendig: false }] } } } as never);
    expect(kaputt).toContain('FEHLER: Budget überschritten');
    expect(kaputt).toContain('Hash unbekannt (letzter Kopierlauf fehlgeschlagen)');
    expect(kaputt).toContain('1 Ketten (0 vollständig)');
    expect(kaputt).not.toContain('vollständig auf fs01');
    // Fix-Runde 1 (Medium c): „Hash ok“ nur mit Dateien auf fs01 und ohne Ausstehendes
    const d0 = LISTE.datenbanken.pruefdb01;
    const tx = (d: Record<string, unknown>) => linuxSqlSicherungenText('sqllnx01', { ...LISTE, datenbanken: { pruefdb01: { ...d0, ...d } } } as never);
    expect(tx({ fs01Dateien: 0, ketten: [] })).toContain('Hash unbekannt (nichts auf fs01)');
    expect(tx({ ausstehend: 3 })).toContain('ausstehend: 3');
    expect(tx({ ausstehend: 3 })).not.toContain('Hash ok');
    expect(tx({ fehlend: 1 })).toContain('FEHLT auf fs01: 1');
    expect(tx({ ketten: [{ ...d0.ketten[0]!, vollstaendig: false }] })).toContain('Hash ok, Ketten unvollständig');
    expect(linuxSqlSicherungenText('sqllnx01', { ...LISTE, status: null } as never)).toContain('Hash unbekannt (kein Kopierlauf)');
    // Fix-Runde 2 (Sicherheit): Bericht nur frisch (≤ 45 min) und mit aktivem Timer; sonst nie „vollständig auf fs01“
    const alt = linuxSqlSicherungenText('sqllnx01', { ...LISTE, status: { ...LISTE.status, frisch: false, alterMin: 130 } } as never);
    expect(alt).toContain('Hash unbekannt (Kopierlauf zu alt: 2026-11-16T12:07:00Z)');
    expect(alt).not.toContain('vollständig auf fs01');
    expect(alt).not.toContain('Hash ok');
    const ohneFrisch = linuxSqlSicherungenText('sqllnx01', { ...LISTE, status: { zeit: '2026-11-16T12:07:00Z', ok: true } } as never);
    expect(ohneFrisch).toContain('Kopierlauf zu alt');
    const timerAus = linuxSqlSicherungenText('sqllnx01', { ...LISTE, timer: 'inactive' } as never);
    expect(timerAus).toContain('Hash unbekannt (Kopie-Timer nicht aktiv)');
    expect(timerAus).not.toContain('vollständig auf fs01');
  });
  it('FESTE_AUSGABEN: sicherungen und status (mit Sicherungsteil) passen auf genau eine Vorlage; feste Stücke bestehen die Planprüfung', () => {
    const alsMuster = (v: string) => new RegExp(`^${v.split(/\{[a-z]+\}/).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+?')}$`);
    const sv = FESTE_AUSGABEN['linux_sql.sicherungen']!.split(' | ');
    expect(sv.filter(v => alsMuster(v).test(linuxSqlSicherungenText('sqllnx01', LISTE as never)))).toHaveLength(1);
    for (const e of ['Zugangsdatei vorhanden (0600)', 'Kopie-Timer aktiv', 'vollständig auf fs01']) expect(FESTE_AUSGABEN['linux_sql.sicherungen']).toContain(e);
    const st: LinuxSqlStatus = { zustand: 'gelesen', installiert: false, platz: [], sicherung: { zugangsdatei: 'vorhanden (0600)', timer: 'active', letzteKopie: { zeit: '2026-11-16T12:07:00Z', ok: true, fehler: '', alterMin: 5 } } };
    // Fix-Runde 2: zu alter Kopierlauf (oder Alter unbekannt) heißt „ZU ALT“, nie „ok“
    for (const alterMin of [130, undefined]) {
      const t2 = linuxSqlStatusText('sqllnx01', { ...st, sicherung: { ...st.sicherung!, letzteKopie: { zeit: '2026-11-16T10:00:00Z', ok: true, fehler: '', ...(alterMin === undefined ? {} : { alterMin }) } } });
      expect(t2).toContain('letzte Kopie 2026-11-16T10:00:00Z ZU ALT');
      expect(t2).not.toMatch(/letzte Kopie \S+ ok/);
    }
    const text = linuxSqlStatusText('sqllnx01', st);
    expect(text).toBe('sqllnx01: SQL Server nicht installiert; eingehängt: keine Plattenziele; Sicherung: Zugangsdatei vorhanden (0600), Kopie-Timer aktiv, letzte Kopie 2026-11-16T12:07:00Z ok; Zeit unbekannt');
    const vorlagen = FESTE_AUSGABEN['linux_sql.status']!.split(' | ');
    expect(vorlagen.filter(v => alsMuster(v).test(text))).toHaveLength(1);
    expect(linuxSqlStatusText('x', { zustand: 'gelesen', installiert: false, platz: [] })).toBe('x: SQL Server nicht installiert; eingehängt: keine Plattenziele; Sicherung: nicht eingerichtet; Zeit unbekannt');
    for (const e of ['Zugangsdatei vorhanden (0600)', 'Kopie-Timer aktiv']) expect(FESTE_AUSGABEN['linux_sql.status']).toContain(e);
  });
});

describe('I8e Task 4 — Planregeln', () => {
  const skill = new LinuxSqlSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const proxmox = { metadata: { name: 'proxmox', inputSchema: { type: 'object', properties: {
    action: { type: 'string', enum: ['provision_vm', 'delete_vm', 'create_snapshot', 'rollback_snapshot', 'agent_status'] }, hostname: { type: 'string' }, vmid: { type: 'number' }, name: { type: 'string' },
  }, required: ['action'] } } };
  const cmdb = new Set(['sqllnx01']);
  const ctx = { skill: (n: string) => (n === 'linux_sql' ? skill : n === 'proxmox' ? proxmox : undefined) as never, asset: (n: string) => (cmdb.has(n.toLowerCase()) ? { id: `a-${n}`, name: n } : undefined), changes: [] };
  const snap = { titel: 'Snapshot', art: 'aktion', skill: 'proxmox', aktion: 'create_snapshot', parameter: { vmid: 160, name: 'vor_sicherung' }, pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'agent_status', parameter: { vmid: 160 } } };
  const keiner = { keiner: 'additiv' };
  const sch = (aktion: string, parameter: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ titel: aktion, art: 'aktion', skill: 'linux_sql', aktion, parameter: { zugang: 'sqllnx01', ...parameter }, zeitlimitS: 3600, rueckweg: keiner, ...extra });
  const plan = (schritte: unknown[]) => ({ titel: 'Sicherung sqllnx01', begruendung: 'I8e Task 4', typ: 'normal', risiko: 'medium', ausfallMinuten: 0, betroffen: ['sqllnx01'], schritte });

  it('Einordnung: sicherungen liest, die übrigen ändern', () => {
    expect(aktionsArt('linux_sql', 'sicherungen')).toBe('lesen');
    for (const a of ['sicherung_einrichten', 'sicherung_jetzt', 'wiederherstellen_pruefen']) expect(aktionsArt('linux_sql', a)).toBe('aendern');
  });
  it('bestehende VM: sicherung_jetzt und wiederherstellen_pruefen ohne Rückweg (additiv, prüfen sich selbst); sicherung_einrichten braucht Rückweg', () => {
    const ok = pruefeChangePlan(plan([snap, sch('sicherung_jetzt', { art: 'full', datenbank: 'pruefdb01' }), sch('sicherung_jetzt', { art: 'log', datenbank: 'pruefdb01' }), sch('wiederherstellen_pruefen', { datenbank: 'pruefdb01' })]), ctx).fehler;
    expect(ok).toEqual([]);
    const f = pruefeChangePlan(plan([snap, sch('sicherung_einrichten', { ziel_freigabe: '\\\\fs01.ad.3033.at\\SQLLinuxBackup$' })]), ctx).fehler;
    expect(f.some(x => x.startsWith('Schritt 2:') && x.includes('ohne Rückweg nur beim Neuaufbau'))).toBe(true);
    const mitRueck = pruefeChangePlan(plan([snap, sch('sicherung_einrichten', { ziel_freigabe: '\\\\fs01.ad.3033.at\\SQLLinuxBackup$' }, { rueckweg: { skill: 'proxmox', aktion: 'rollback_snapshot', parameter: { vmid: 160, name: 'vor_sicherung' } } })]), ctx).fehler;
    expect(mitRueck).toEqual([]);
  });
  it('Planprüfung weist ungültige Parameter schon beim Planen ab', () => {
    const f = pruefeChangePlan(plan([snap, sch('wiederherstellen_pruefen', { datenbank: 'pruefdb01', ziel_name: 'pruefdb01' })]), ctx).fehler;
    expect(f.join(' | ')).toContain('ziel');
    const g = pruefeChangePlan(plan([snap, sch('sicherung_einrichten', { ziel_freigabe: 'fs01:SQLLinuxBackup' }, { rueckweg: { skill: 'proxmox', aktion: 'rollback_snapshot', parameter: { vmid: 160, name: 'vor_sicherung' } } })]), ctx).fehler;
    expect(g.join(' | ')).toContain('ziel_freigabe');
  });
  it('sicherungen als Prüfung: erwartet nur aus dem festen Wortlaut', () => {
    const pr = (erwartet: string) => ({ titel: 'Prüfen', art: 'pruefung', pruefung: { typ: 'skill', skill: 'linux_sql', aktion: 'sicherungen', parameter: { zugang: 'sqllnx01' }, erwartet } });
    expect(pruefeChangePlan(plan([pr('pruefdb01: vollständig auf fs01')]), ctx).fehler).toEqual([]);
    expect(pruefeChangePlan(plan([pr('vollständig auf fs01')]), ctx).fehler.join(' ')).toContain('kommt in der Antwort');
    expect(pruefeChangePlan(plan([pr('Hash ok')]), ctx).fehler.join(' ')).toContain('kommt in der Antwort');
    expect(pruefeChangePlan(plan([pr('alles bestens gesichert')]), ctx).fehler.join(' ')).toContain('kommt in der Antwort');
  });
});

describe('I8e Paket 2 Task 7 — Rolle je Datenbank und erzwungene FULL im Wortlaut', () => {
  const D = { ketten: [{ full: '20261116003000', diffs: 1, logs: 40, vollstaendig: true, fehler: [] }], waisen: [], fs01Dateien: 42, fehlend: 0, lokalDateien: 42, ausstehend: 0 };
  const L = { zustand: 'gelesen', ziel: '//fs01.ad.3033.at/SQLLinuxBackup$', budgetBytes: 64 * 2 ** 30, belegtBytes: 2 ** 30, status: { zeit: '2026-11-17T12:07:00Z', ok: true, frisch: true, alterMin: 5 }, timer: 'active', zugangsdatei: 'vorhanden (0600)' };
  it('sicherungen nennt die Rolle je Datenbank; Datenbanken ohne Sicherung auf diesem Rechner erscheinen mit Rolle; Lesefehler sichtbar', () => {
    const t = linuxSqlSicherungenText('sqllnx02', { ...L, datenbanken: { pruefdb01: { ...D, rolle: 'SECONDARY' } }, ohneSicherung: { neudb01: 'PRIMARY' } } as never);
    expect(t).toContain('pruefdb01: Rolle SECONDARY, 1 Ketten (1 vollständig)');
    expect(t).toContain('; neudb01: Rolle PRIMARY, keine Sicherungen auf diesem Rechner');
    const leer = linuxSqlSicherungenText('sqllnx02', { ...L, datenbanken: {}, ohneSicherung: { pruefdb01: 'SECONDARY' } } as never);
    expect(leer).toContain('pruefdb01: Rolle SECONDARY, keine Sicherungen auf diesem Rechner');
    expect(leer).not.toContain('keine Datenbanken gesichert');
    const f = linuxSqlSicherungenText('sqllnx02', { ...L, datenbanken: { pruefdb01: { ...D, rolle: 'unbekannt' } }, rollenFehler: 'Login failed' } as never);
    expect(f).toContain('pruefdb01: Rolle unbekannt');
    expect(f).toContain('Rolle nicht lesbar: Login failed');
    // fail-closed im Text: unbekannte Werte werden nie als PRIMARY gezeigt
    expect(linuxSqlSicherungenText('x', { ...L, datenbanken: { pruefdb01: { ...D, rolle: 'MASTER' } } } as never)).toContain('pruefdb01: Rolle unbekannt');
    // Vorlage: genau eine passt weiterhin
    const alsMuster = (v: string) => new RegExp(`^${v.split(/\{[a-z]+\}/).map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+?')}$`);
    expect(FESTE_AUSGABEN['linux_sql.sicherungen']!.split(' | ').filter(v => alsMuster(v).test(t))).toHaveLength(1);
  });
  it('Prüfstück „<db>: Rolle PRIMARY/SECONDARY“ besteht die Planprüfung', () => {
    const skill = new LinuxSqlSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
    const ctx = { skill: (n: string) => (n === 'linux_sql' ? skill : undefined) as never, asset: (n: string) => ({ id: `a-${n}`, name: n }), changes: [] };
    const plan = (erwartet: string) => ({ titel: 'Rolle prüfen', begruendung: 'I8e Paket 2 Task 7', typ: 'normal', risiko: 'low', ausfallMinuten: 0, betroffen: ['sqllnx01'],
      schritte: [{ titel: 'Prüfen', art: 'pruefung', pruefung: { typ: 'skill', skill: 'linux_sql', aktion: 'sicherungen', parameter: { zugang: 'sqllnx01' }, erwartet } }] });
    for (const e of ['pruefdb01: Rolle PRIMARY', 'pruefdb01: Rolle SECONDARY']) expect(pruefeChangePlan(plan(e), ctx).fehler, e).toEqual([]);
    expect(pruefeChangePlan(plan('Rolle PRIMARY überall'), ctx).fehler.join(' ')).toContain('kommt in der Antwort');
  });
  it('sicherung_jetzt: erzwungene FULL steht mit Grund im Text', async () => {
    const datei = '/var/opt/mssql/backup/pruefdb01/pruefdb01_FULL_20261117120000.bak';
    const w = welt({ [LINUX_SQL_SICHERUNG_BAUSTEINE.jetzt]: [{ zustand: 'geaendert', art: 'FULL', angefordert: 'LOG', erzwungen: 'FULL statt LOG: Protokollkette auf diesem Rechner unterbrochen (Rollenwechsel)', datenbank: 'pruefdb01', datei, sha256: 'ab'.repeat(32), fs01: true }] });
    const r = await w.skill.execute({ action: 'sicherung_jetzt', zugang: 'sqllnx01', art: 'log', datenbank: 'pruefdb01' }, imChange);
    expect(r.error).toBeUndefined();
    expect(r.display).toContain('Sicherung FULL von pruefdb01');
    expect(r.display).toContain('angefordert LOG — FULL statt LOG: Protokollkette auf diesem Rechner unterbrochen (Rollenwechsel)');
  });
});
