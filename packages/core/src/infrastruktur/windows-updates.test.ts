import { describe, it, expect } from 'vitest';
import { StandardChanges } from './standard-changes.js';
import { VORLAGEN, vorlagenAbdruck, type StandardKontext } from './standard-vorlagen.js';
import { pruefeChangePlan, type PruefKontext } from './change-schritte.js';
import { winInstallSkript, winUpdateOrdner } from './windows-updates.js';

// I8b Teil 3 — Standard-Vorlage (i) Windows-Updates (Spec I8 3b-1)
const skill = (name: string, aktionen: string[]) => ({ metadata: { name, inputSchema: { type: 'object', properties: { action: { type: 'string', enum: aktionen }, vmid: { type: 'number' } }, required: ['action'] } } });
const SKILLS: Record<string, unknown> = {
  proxmox: skill('proxmox', ['vm_status', 'list_snapshots', 'create_snapshot', 'delete_snapshot', 'rollback_snapshot', 'agent_status']),
  fernzugriff: skill('fernzugriff', ['lesen', 'ausfuehren']),
};
const pctx: PruefKontext = { skill: n => SKILLS[n] as never, asset: k => ({ id: k, name: k }), changes: [] };
const WIN = new Set(['win1', 'win2']);
const kontext = (o: Partial<StandardKontext> = {}): StandardKontext => ({
  jetzt: new Date('2026-11-03T10:00:00Z'),
  vm: async k => ({ fehler: `VM „${k}“ nicht gefunden` }),
  vmFuerZugang: async z => ({ assetId: `a-${z}`, vmid: z === 'win2' ? 9102 : 9101, node: 'pve3', name: z }),
  zugangAsset: async z => `za-${z}`,
  container: () => undefined,
  snapshots: async () => [],
  updatesAn: async () => true,
  istWindows: z => WIN.has(z),
  anzahl: async () => 0,
  ...o,
});
const V = (k: string) => VORLAGEN.find(v => v.key === k)!;
const dekodiere = (b: string) => Buffer.from(/-EncodedCommand (\S+)$/.exec(b)![1]!, 'base64').toString('utf16le');

describe('I8b Vorlage (i) Windows-Updates', () => {
  it('Plan besteht die Planprüfung: Snapshot zuerst, Fenster, Neustart nur bei Bedarf, Nachher-Vergleich, Rückweg Snapshot', async () => {
    const e = await V('windows_updates').erzeuge!({ zugang: 'win1' }, kontext());
    expect('plan' in e, 'fehler' in e ? e.fehler : '').toBe(true);
    if (!('plan' in e)) return;
    expect(pruefeChangePlan(e.plan, pctx).fehler).toEqual([]);
    const s = e.plan.schritte as Array<{ titel: string; aktion?: string; parameter?: { befehl?: string }; rueckweg?: { aktion?: string } }>;
    expect(s[0]!.aktion).toBe('create_snapshot');
    expect(s.map(x => x.titel.split(' ')[0])).toEqual(['Snapshot', 'Vorher:', 'Windows-Updates', 'Neustart', 'Anlaufzeit', 'VM', 'Gast-Agent', 'SSH', 'Windows-Wartung', 'Ruhezeit', 'Windows-Wartung', 'Nachher:']);
    const vorher = dekodiere(s[1]!.parameter!.befehl!), install = dekodiere(s[2]!.parameter!.befehl!), neu = dekodiere(s[3]!.parameter!.befehl!);
    expect(vorher).toContain("$n -lt '00:30' -or $n -ge '02:00'");
    expect(install).toContain("-User 'SYSTEM'");
    const job = Buffer.from(/-EncodedCommand ([A-Za-z0-9+/=]+)'/.exec(install)![1]!, 'base64').toString('utf16le');
    expect(job).toContain("contains 'Upgrades'");
    expect(job).toContain("Type='Software'");
    expect(vorher).toMatch(/Remove-Item -LiteralPath .* -Recurse -Force/);
    expect(install).toContain("Unregister-ScheduledTask -TaskName 'Alfred-WindowsUpdate'");
    expect(neu).toContain("'WINUPD_KEIN_NEUSTART'; exit 0");
    expect(neu).toContain("$n -ge '02:15'");
    expect(s[11]!.rueckweg!.aktion).toBe('rollback_snapshot');
    expect(JSON.stringify(e.plan.schritte)).not.toMatch(/2026-11-/);
    expect(e.plan.geplantAb).toBe("2026-11-04T00:30:00+01:00"); // v1748 — 11:00 Wien liegt außerhalb → nächster Fensterbeginn
  });
  it('Aufgabe ohne Skriptdatei (Job als -EncodedCommand), Arbeitsordner geschützt, Ordnername bereinigt', () => {
    const t = dekodiere(winInstallSkript(winUpdateOrdner('alfred_20261103_7d'), '00:30', '02:00', 5400));
    expect(t).not.toMatch(/wu\.ps1|-File /);
    const job = Buffer.from(/-EncodedCommand ([A-Za-z0-9+/=]+)'/.exec(t)![1]!, 'base64').toString('utf16le');
    expect(job).toContain("contains 'Upgrades'");
    expect(t).toContain("/inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'");
    expect(t).toContain("/setowner '*S-1-5-32-544'");
    expect(winUpdateOrdner('a b;c')).toBe('C:\\ProgramData\\Alfred\\winupd-a-b-c');
  });
  it('Grenzen: nur Windows, nur mit Schalter, 1× je Tag; Linux-Vorlagen weisen Windows ab', async () => {
    expect(await V('windows_updates').erzeuge!({ zugang: 'linux1' }, kontext())).toEqual({ fehler: expect.stringContaining('kein Windows-System') });
    expect(await V('windows_updates').erzeuge!({ zugang: 'win1' }, kontext({ updatesAn: async () => false }))).toEqual({ fehler: expect.stringContaining('ist für win1 aus') });
    expect(await V('windows_updates').erzeuge!({ zugang: 'win1' }, kontext({ anzahl: async () => 1 }))).toEqual({ fehler: 'win1: höchstens 1× je Tag' });
    expect(await V('os_updates').erzeuge!({ zugang: 'win1' }, kontext())).toEqual({ fehler: expect.stringContaining('Vorlage (i)') });
    expect(await V('sicherheitsupdates').erzeuge!({ zugang: 'win1' }, kontext())).toEqual({ fehler: expect.stringContaining('Vorlage (i)') });
  });
  it('Serie wählt Hosts nach System; ohne Windows-Host keine Freigabe-Prüfung und Fehler „keine Hosts“', async () => {
    const v = V('windows_updates');
    const db = new Map([[v.key, { vorlage: v.key, abdruck: vorlagenAbdruck(v), status: 'freigegeben', freigegebenAt: '2026-11-02T00:00:00Z' }]]);
    let geplant: Array<Record<string, unknown>> = []; let hosts = ['linux1', 'win1', 'win2'];
    const st = new StandardChanges({
      stand: async () => [...db.values()], setze: async () => undefined,
      kontext: async () => kontext({ zugaengeMitUpdates: async () => hosts }),
      speichere: async () => ({ ok: false, fehler: ['nicht für Serien'] }),
      pruefe: async () => ({ ok: true, text: 'ok' }),
      planeSerie: async (_o, pl) => { geplant = pl; return { ok: true, ids: pl.map((_, i) => `id${i + 1}`) }; },
      freigabeAnfragen: async () => 'Freigabe-Frage gestellt.',
      jetzt: () => Date.parse('2026-11-03T10:00:00Z'),
    });
    const r = await st.serie('o', 'windows_updates', {});
    expect(r.ok && r.text).toContain('win1 → win2');
    expect(geplant).toHaveLength(2);
    hosts = ['linux1'];
    db.clear(); // nicht freigegeben — ohne Windows-Host kommt die Serie gar nicht bis zur Freigabe-Prüfung
    const k = await st.serie('o', 'windows_updates', {});
    expect(!k.ok && k.fehler[0]).toMatch(/^keine Hosts — kein Windows-Fernzugang/);
  });
});

// v1748 — Realfall 01.11. 23:20 (d0a4aa66): einzeln angelegter Update-Change startete sofort außerhalb des Fensters
describe('fensterStart', () => {
  const f = { von: '00:30', bis: '02:45' };
  it('außerhalb: nächster Fensterbeginn (heute oder morgen), im Startbereich: sofort', async () => {
    const { fensterStart } = await import('./os-updates.js');
    expect(fensterStart(new Date('2026-11-01T22:20:00Z'), f)).toBe('2026-11-02T00:30:00+01:00'); // 23:20 Wien → heute Nacht
    expect(fensterStart(new Date('2026-11-01T23:10:00Z'), f)).toBe('2026-11-02T00:30:00+01:00'); // 00:10 Wien → gleich heute
    expect(fensterStart(new Date('2026-11-01T23:40:00Z'), f)).toBeUndefined(); // 00:40 Wien → im Startbereich
    expect(fensterStart(new Date('2026-11-02T01:10:00Z'), f)).toBe('2026-11-03T00:30:00+01:00'); // 02:10 Wien → Startbereich vorbei
    expect(fensterStart(new Date('2026-10-22T10:00:00Z'), f)).toBe('2026-10-23T00:30:00+02:00'); // Sommerzeit
  });
});

// v1751 — Realfall 02.11. 00:40 (6a669184): Snapshot-Name vom abgebrochenen Change desselben Tages schon belegt
describe('freier Snapshot-Name', () => {
  it('belegter Name bekommt eine laufende Nummer, die Aufräum-Vorlage erkennt ihn', async () => {
    const { snapshotAbgelaufen } = await import('./standard-vorlagen.js');
    const e = await V('windows_updates').erzeuge!({ zugang: 'win1' }, kontext({ snapshots: async () => [{ name: 'alfred_20261103_7d' }] }));
    expect('plan' in e && (e.plan.schritte as Array<{ parameter?: { name?: string } }>)[0]!.parameter!.name).toBe('alfred_20261103_7d_2');
    expect(snapshotAbgelaufen('alfred_20261103_7d_2', new Date('2026-11-10T00:00:00Z'))).toBe(true);
    expect(snapshotAbgelaufen('alfred_20261103_7d_2', new Date('2026-11-09T00:00:00Z'))).toBe(false);
  });
});

// I8 3b-1 — ausstehende Windows-Updates im Anwendungs-Update-Bericht (nur suchen)
describe('Windows im Anwendungs-Update-Bericht', () => {
  it('Such-Skript sucht nur; Parser und Berichtsabschnitt', async () => {
    const { WIN_UPDATE_SUCHE, leseWinUpdates } = await import('./windows-updates.js');
    const { berichtText } = await import('./anwendungs-updates.js');
    const skript = dekodiere(WIN_UPDATE_SUCHE);
    expect(skript).toContain('CreateUpdateSearcher().Search(');
    expect(skript).not.toMatch(/CreateUpdateDownloader|CreateUpdateInstaller|\.Download\(|\.Install\(|AcceptEula|ScheduledTask|shutdown/i);
    // Ausgabe wie auf probe-win25b am 02.11. gelesen
    const l = leseWinUpdates('ANZAHL=1\r\nUPDATE Security Intelligence Update for Microsoft Defender Antivirus - KB2267602 (Version 1.463.84.0) - Current Channel (Broad) | Definition Updates/Microsoft Defender Antivirus | 0\r\n');
    expect(l!.anzahl).toBe(1);
    expect(l!.updates).toEqual([{ titel: 'Security Intelligence Update for Microsoft Defender Antivirus - KB2267602 (Version 1.463.84.0) - Current Channel (Broad)', kategorie: 'Definition Updates/Microsoft Defender Antivirus', neustart: false }]);
    expect(leseWinUpdates('FEHLER: Zugriff verweigert')).toBeUndefined();
    const t = berichtText([], [], new Date('2026-11-02T12:00:00Z'), [{ host: 'probe-win25b', updatesSchalter: true, updates: l!.updates }, { host: 'win-x', updatesSchalter: false, updates: [], fehler: 'Exit 255' }]);
    expect(t).toContain('## Windows-Updates');
    expect(t).toContain('- **probe-win25b** (wöchentliche Windows-Updates an, Vorlage i): 1 ausstehend');
    expect(t).toContain('- **win-x**: nicht gelesen (Exit 255)');
    expect(berichtText([], [], new Date())).not.toContain('Windows-Updates'); // ohne Windows-Hosts kein Abschnitt
  });
  it('Sicherheitsprüfung 02.11.: Host-Text ohne Markdown/Links, Anzahl-Abgleich, Zeilenumbrüche im Skript entfernt', async () => {
    const { WIN_UPDATE_SUCHE, leseWinUpdates } = await import('./windows-updates.js');
    const { berichtText, hostText } = await import('./anwendungs-updates.js');
    expect(dekodiere(WIN_UPDATE_SUCHE)).toContain('$u.Title -replace');
    expect(hostText('Update **dringend** [hier](https://boese.example/x) `code`\nZeile2')).toBe('Update dringend hier[Link entfernt] code Zeile2');
    // gemeldet 2, gelesen 1 → unvollständig erkennbar
    const l = leseWinUpdates('ANZAHL=2\nUPDATE A | Kat | 0\n')!;
    expect([l.updates.length, l.anzahl]).toEqual([1, 2]);
    const t = berichtText([], [], new Date(), [{ host: 'w', updatesSchalter: false, updates: [{ titel: '[Klick](http://x)', kategorie: 'K', neustart: true }], fehler: 'Liste unvollständig: 1 von 2 gelesen' }]);
    expect(t).toContain('1 ausstehend, davon 1 mit Neustart — Liste unvollständig: 1 von 2 gelesen');
    expect(t).not.toMatch(/\]\(|http:/);
  });
});
