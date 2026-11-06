import { describe, it, expect } from 'vitest';
import { VORLAGEN, vorlagenAbdruck, type StandardKontext } from './standard-vorlagen.js';
import { pruefeChangePlan, type PruefKontext } from './change-schritte.js';
import { GRUNDLINIE_ERWARTET } from './windows-grundlinie.js';
import { WINDOWS_BEFEHLE } from './sammler-windows.js';
import { windowsBefehlsklasse } from '../fernzugriff/regeln.js';

// I8 3b-2b — Standard-Vorlage (j) Windows-Sicherheits-Grundlinie (Owner 07.11.)
const skill = (name: string, aktionen: string[]) => ({ metadata: { name, inputSchema: { type: 'object', properties: { action: { type: 'string', enum: aktionen }, vmid: { type: 'number' } }, required: ['action'] } } });
const SKILLS: Record<string, unknown> = {
  proxmox: skill('proxmox', ['vm_status', 'list_snapshots', 'create_snapshot', 'delete_snapshot', 'rollback_snapshot', 'agent_status']),
  fernzugriff: skill('fernzugriff', ['lesen', 'ausfuehren']),
};
const pctx: PruefKontext = { skill: n => SKILLS[n] as never, asset: k => ({ id: k, name: k }), changes: [] };
const kontext = (o: Partial<StandardKontext> = {}): StandardKontext => ({
  jetzt: new Date('2026-11-07T10:00:00Z'),
  vm: async k => ({ fehler: `VM „${k}“ nicht gefunden` }),
  vmFuerZugang: async z => (z === 'ohne-vm' ? undefined : { assetId: `a-${z}`, vmid: 9102, node: 'pve', name: z }),
  zugangAsset: async z => `za-${z}`,
  container: () => undefined,
  snapshots: async () => [],
  updatesAn: async () => false, // die Grundlinie hängt nicht am Update-Schalter
  istWindows: z => z !== 'linux1',
  anzahl: async () => 0,
  ...o,
});
const V = VORLAGEN.find(v => v.key === 'windows_grundlinie')!;
const dekodiere = (b: string) => Buffer.from(/-EncodedCommand (\S+)$/.exec(b)![1]!, 'base64').toString('utf16le');

describe('I8 3b-2b Vorlage (j) Windows-Sicherheits-Grundlinie', () => {
  it('Plan besteht die Planprüfung: Snapshot, Fenster, setzen, Neustart, Wiederanlauf, Nachher-Prüfung mit den Bestands-Lesebefehlen', async () => {
    const e = await V.erzeuge!({ zugang: 'probe-win25b' }, kontext());
    expect('plan' in e, 'fehler' in e ? e.fehler : '').toBe(true);
    if (!('plan' in e)) return;
    expect(pruefeChangePlan(e.plan, pctx).fehler).toEqual([]);
    const s = e.plan.schritte as Array<{ titel: string; art: string; aktion?: string; parameter?: { befehl?: string }; pruefung?: { befehl?: string; erwartet?: string }; rueckweg?: { aktion?: string }; zeitlimitS?: number }>;
    expect(s.map(x => x.titel.split(' ')[0])).toEqual(['Snapshot', 'Vorher:', 'Grundlinie', 'Neustart', 'Anlaufzeit', 'VM', 'Gast-Agent', 'SSH', 'Nachher:', 'Nachher:', 'Nachher:', 'Nachher:']);
    const setzen = dekodiere(s[2]!.parameter!.befehl!), neu = dekodiere(s[3]!.parameter!.befehl!);
    expect(dekodiere(s[1]!.parameter!.befehl!)).toContain("$n -lt '00:30' -or $n -ge '02:00'");
    expect(setzen).toContain("$n -lt '00:30' -or $n -ge '02:00'");
    expect(setzen).toContain('Set-SmbServerConfiguration -RequireSecuritySignature $true');
    expect(setzen).toContain('Set-SmbClientConfiguration -RequireSecuritySignature $true');
    expect(setzen).toContain("@('TLS 1.0', 'TLS 1.1')");
    expect(setzen).toContain("@('Server', 'Client')");
    // vorhandene SCHANNEL-Schlüssel nie mit New-Item -Force neu anlegen (löschte ihre Werte)
    expect(setzen).toContain('if (-not (Test-Path -LiteralPath $p)) { New-Item -Path $p -Force | Out-Null }');
    expect(neu).toContain("$n -ge '02:15'");
    expect(neu).toContain('shutdown.exe /r /t 60');
    expect(s[6]!.zeitlimitS).toBe(1800);
    expect(s[8]!.rueckweg!.aktion).toBe('rollback_snapshot');
    expect(s.slice(9).map(x => [x.pruefung!.befehl, x.pruefung!.erwartet])).toEqual([
      [WINDOWS_BEFEHLE.smbServer, GRUNDLINIE_ERWARTET.signatur], [WINDOWS_BEFEHLE.smbClient, GRUNDLINIE_ERWARTET.signatur], [WINDOWS_BEFEHLE.registry, GRUNDLINIE_ERWARTET.tls],
    ]);
    // die Prüfbefehle laufen ohne Rückfrage (Leseliste)
    for (const x of s.slice(9)) expect(windowsBefehlsklasse(x.pruefung!.befehl!)).toBe('lesen');
    expect(e.plan.geplantAb).toBe('2026-11-08T00:30:00+01:00');
  });

  it('erwartete Texte passen zur echten Ausgabe nach dem Setzen (Format wie probe-win25b)', () => {
    expect('{"RequireSecuritySignature":true,"EnableInsecureGuestLogons":false}').toContain(GRUNDLINIE_ERWARTET.signatur);
    expect('{"EnableSMB1Protocol":false,"RequireSecuritySignature":true,"EncryptData":false}').toContain(GRUNDLINIE_ERWARTET.signatur);
    expect('{"RdpAus":1,"Nla":1,"Tls10":0,"Tls11":0,"LapsCsp":null,"LapsGpo":null,"LapsLokal":null}').toContain(GRUNDLINIE_ERWARTET.tls);
    expect('{"RdpAus":1,"Nla":1,"Tls10":null,"Tls11":null,"LapsCsp":null,"LapsGpo":null,"LapsLokal":null}').not.toContain(GRUNDLINIE_ERWARTET.tls);
  });

  it('Grenzen: nur Windows, nur Proxmox-VM, 1× je Tag; Beschreibung nennt Folgen und Ausnahmen (Teil der Freigabe)', async () => {
    expect(await V.erzeuge!({ zugang: 'linux1' }, kontext())).toEqual({ fehler: expect.stringContaining('kein Windows-System') });
    expect(await V.erzeuge!({ zugang: 'ohne-vm' }, kontext())).toEqual({ fehler: expect.stringContaining('ohne Snapshot') });
    expect(await V.erzeuge!({ zugang: 'probe-win25b' }, kontext({ anzahl: async () => 1 }))).toEqual({ fehler: 'probe-win25b: höchstens 1× je Tag' });
    expect(V.system).toBe('windows');
    expect(V.beschreibung).toContain('Neustart (immer');
    expect(V.beschreibung).toContain('scheitern danach');
    expect(V.beschreibung).toContain('Nicht enthalten: Windows LAPS');
    expect(vorlagenAbdruck(V)).toMatch(/^[0-9a-f]{64}$/);
  });
});
