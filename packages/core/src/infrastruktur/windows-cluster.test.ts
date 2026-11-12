import { describe, it, expect } from 'vitest';
import {
  pruefePlatten, plattenSkript, pruefeFeatures, pruefeFirewall, firewallSkript, pruefeFreigabe, freigabeSkript, pruefeGmsa, gmsaSkript, pruefeComputerobjekt,
  computerobjektSkript, pruefeSpn, spnSkript, pruefeKnoten, pruefeCluster, pruefeZeuge, validierenSkript, clusterAnlegenSkript, zeugeSkript, gmsaPruefenSkript,
  clusterStatusText, clusterStatusSkript, innenSkript, MIT_KONTO, type ClusterStatus,
} from './windows-cluster.js';
import { WindowsClusterSkill } from './windows-cluster-skill.js';
import { aktionsArt, pruefeChangePlan } from './change-schritte.js';

// I8d (Architektur 3ca3873e v3, Owner 10.11.) — Cluster- und SQL-Vorbereitung über feste Bausteine
const skriptAus = (befehl: string) => Buffer.from(befehl.split(' ').pop()!, 'base64').toString('utf16le');

describe('I8d Bausteine windows_cluster', () => {
  it('Platten: SQL-Architektur D/L/T/B mit 64 KB; Größen verschieden, Buchstaben D–Z', () => {
    const sql = pruefePlatten([{ groesse_gb: 50, laufwerk: 'd', name: 'SQL-Daten', block_kb: 64 }, { groesse_gb: 20, laufwerk: 'L', name: 'SQL-Log', block_kb: 64 }, { groesse_gb: 15, laufwerk: 'T', name: 'SQL-TempDB', block_kb: 64 }, { groesse_gb: 30, laufwerk: 'B', name: 'SQL-Sicherung' }]);
    expect(Array.isArray(sql) && sql.map(p => `${p.laufwerk}${p.block_kb}`)).toEqual(['D64', 'L64', 'T64', 'B4']);
    expect(pruefePlatten([{ groesse_gb: 50, laufwerk: 'C', name: 'x' }])).toContain('B oder D–Z');
    expect(pruefePlatten([{ groesse_gb: 20, laufwerk: 'D', name: 'a' }, { groesse_gb: 20, laufwerk: 'E', name: 'b' }])).toContain('verschieden');
    expect(pruefePlatten([{ groesse_gb: 20, laufwerk: 'D', name: 'a', block_kb: 8 }])).toContain('block_kb');
    const s = plattenSkript({ platten: sql as never });
    expect(s).toContain("$_.Number -ne 0 -and $_.PartitionStyle -eq 'RAW'");
    expect(s).toContain('-AllocationUnitSize ([int]$x.block_kb * 1024)');
    expect(s).toContain('DriveType -eq 5'); // CD-Laufwerk weicht aus
  });
  it('Features nur aus der Erlaubnisliste; Firewall nur exakte Gegenstellen', () => {
    expect(pruefeFeatures(['Failover-Clustering', 'RSAT-Clustering-PowerShell'])).toEqual(['Failover-Clustering', 'RSAT-Clustering-PowerShell']);
    expect(pruefeFeatures(['Web-Server'])).toContain('Auswahl');
    const r = pruefeFirewall({ name: 'WSFC Peer', protokoll: 'tcp', ports: ['3343', '135', '445', '49152-65535', '5022'], von: ['10.203.30.3'] });
    expect(r).toEqual({ name: 'WSFC Peer', protokoll: 'TCP', ports: ['3343', '135', '445', '49152-65535', '5022'], von: ['10.203.30.3'] });
    expect(pruefeFirewall({ name: 'x', protokoll: 'TCP', ports: ['1433'], von: ['Any'] })).toContain('exakte');
    expect(pruefeFirewall({ name: 'x', protokoll: 'TCP', ports: ['70000'], von: ['10.0.0.1'] })).toContain('ports');
    expect(pruefeFirewall({ name: 'ping', protokoll: 'icmpv4', ports: [], von: ['10.203.30.3'] })).toMatchObject({ protokoll: 'ICMPv4' });
    expect(firewallSkript(r as never)).toContain("Name = $id; DisplayName = ('Alfred ' + $p.name); Direction = 'Inbound'");
  });
  it('Freigabe: Konten NETBIOS\\name, nie C:, NTFS ohne Vererbung', () => {
    const f = pruefeFreigabe({ name: 'Witness$', pfad: 'W:\\Witness', vollzugriff: ['AD3033\\SQLCL01$'] });
    expect(f).toEqual({ name: 'Witness$', pfad: 'W:\\Witness', vollzugriff: ['AD3033\\SQLCL01$'], aendern: [] });
    expect(pruefeFreigabe({ name: 'x', pfad: 'C:\\Windows', vollzugriff: ['AD3033\\a'] })).toContain('pfad');
    expect(pruefeFreigabe({ name: 'x', pfad: 'S:\\..\\x', vollzugriff: ['AD3033\\a'] })).toContain('pfad');
    expect(pruefeFreigabe({ name: 'x', pfad: 'S:\\x', vollzugriff: ['Jeder'] })).toContain('NETBIOS');
    const s = freigabeSkript(f as never);
    expect(s).toContain('$acl.SetAccessRuleProtection($true, $false)');
    expect(s).toContain("FolderEnumerationMode = 'AccessBased'");
  });
  it('AD: gMSA mit Berechtigten, CNO/VCO deaktiviert und objektgenau, SPN-Dubletten brechen ab — alles mit dem Domänen-Administrator', () => {
    expect(pruefeGmsa({ name: 'gmsa-sqleng$', berechtigte: ['sql01', 'sql02$'] })).toEqual({ name: 'gmsa-sqleng', ou: 'Dienstkonten', berechtigte: ['sql01', 'sql02'] });
    expect(pruefeGmsa({ name: 'gmsa-viel-zu-lang', berechtigte: ['sql01'] })).toContain('14');
    const g = gmsaSkript({ name: 'gmsa-sqleng', ou: 'Dienstkonten', berechtigte: ['sql01', 'sql02'] });
    expect(g).toContain('-PrincipalsAllowedToRetrieveManagedPassword $wer');
    expect(g).toContain('[Console]::In.ReadToEnd()');
    expect(pruefeComputerobjekt({ name: 'sqlag01', vollzugriff: ['sqlcl01$'] })).toEqual({ name: 'sqlag01', ou: 'Server', vollzugriff: ['sqlcl01$'] });
    const c = computerobjektSkript({ name: 'sqlcl01', ou: 'Server', vollzugriff: ['alfred'] });
    expect(c).toContain('-Enabled $false');
    expect(c).toContain("ActiveDirectoryAccessRule($sid, 'GenericAll', 'Allow')");
    expect(c).not.toMatch(/OU=.*GenericAll/); // keine OU-weiten Rechte
    // v1793 Realfall 11.11. D 29b174b5: DirectoryEntry-Eigenschaften in PowerShell nur über psbase (Adapter liefert LDAP-Attribute)
    expect(c).toContain('$de.psbase.ObjectSecurity.AddAccessRule');
    expect(c).toContain('$de.psbase.CommitChanges()');
    expect(c).not.toMatch(/\$de\.(Options|ObjectSecurity|CommitChanges)/);
    expect(pruefeSpn({ konto: 'gmsa-sqleng$', spns: ['MSSQLSvc/sql01.ad.3033.at:1433', 'MSSQLSvc/sql01.ad.3033.at'] })).toMatchObject({ konto: 'gmsa-sqleng$' });
    expect(pruefeSpn({ konto: 'gmsa-sqleng$', spns: ['kein spn'] })).toContain('spns');
    expect(spnSkript({ konto: 'gmsa-sqleng$', spns: ['MSSQLSvc/sql01.ad.3033.at:1433'] })).toContain("throw ('SPN ' + $s + ' hängt schon an '");
    for (const s of [g, c, spnSkript({ konto: 'a$', spns: ['HTTP/x.y.at'] }, true)]) expect(s.split('\n').filter(z => /\b(New|Set|Remove)-AD\w+ /.test(z)).every(z => z.includes('-Credential $c'))).toBe(true);
  });
  it('Cluster: Doppel-Hop über eine Aufgabe mit Kennwort-Anmeldung — Kennwort nur über die Standardeingabe, Aufgabe und Dateien werden entfernt', () => {
    expect(pruefeKnoten(['sql01', 'SQL02'])).toEqual(['sql01', 'sql02']);
    expect(pruefeKnoten(['sql01'])).toContain('2–4');
    expect(pruefeCluster({ name: 'sqlcl01', knoten: ['sql01', 'sql02'], ip: '10.203.30.4' })).toEqual({ name: 'sqlcl01', knoten: ['sql01', 'sql02'], ip: '10.203.30.4' });
    expect(pruefeZeuge({ freigabe: '\\\\fs01.ad.3033.at\\Witness$' })).toEqual({ freigabe: '\\\\fs01.ad.3033.at\\Witness$' });
    expect(pruefeZeuge({ ohne_zeuge: true })).toEqual({});
    expect(pruefeZeuge({ freigabe: 'C:\\x' })).toContain('UNC');
    const v = validierenSkript({ knoten: ['sql01', 'sql02'] });
    expect(v).toContain(MIT_KONTO);
    expect(v).toContain("elseif ($p.ausKonto) { $nb + '\\' + [string]$p.ausKonto } else { $nb + '\\alfred' })) $e.kennwort");
    expect(v).toContain('Unregister-ScheduledTask');
    expect(v).toContain('Remove-Item -LiteralPath $skript, $aus');
    expect(MIT_KONTO).toContain("'S-1-5-18', 'S-1-5-32-544'"); // Skriptordner nur SYSTEM + Administratoren
    expect(clusterAnlegenSkript({ name: 'sqlcl01', knoten: ['sql01', 'sql02'], ip: '10.203.30.4' })).toContain('-NoStorage -AdministrativeAccessPoint ActiveDirectoryAndDns');
    // v1797 Realfall F1 229965b1: direkt nach New-Cluster ist der Clustername noch nicht öffnbar — Knoten lokal abfragen
    expect(clusterAnlegenSkript({ name: 'sqlcl01', knoten: ['sql01', 'sql02'], ip: '10.203.30.4' })).not.toContain('Get-ClusterNode -Cluster');
    // v1798 Realfall F1: Zeugentyp im Status
    expect(clusterStatusSkript()).toContain("$typ = ([string]$q.QuorumResource.ResourceType) -replace ' ', ''");
    expect(zeugeSkript({ freigabe: '\\\\fs01\\Witness$' })).toContain('Set-ClusterQuorum -FileShareWitness $p.freigabe');
    expect(gmsaPruefenSkript({ name: 'gmsa-sqleng' })).toContain("MitKonto 'SYSTEM' ''");
    // das innere Skript sieht nie das Kennwort
    expect(innenSkript({ a: 1 }, ['1'])).not.toContain('kennwort');
  });
  it('Statustext im prüfbaren Wortlaut', () => {
    const s: ClusterStatus = { rechner: 'SQL01', domaene: 'ad.3033.at', features: { 'Failover-Clustering': true, 'FS-FileServer': false },
      volumes: [{ laufwerk: 'C', name: '', groesseGb: 100, freiGb: 70, blockKb: 4 }, { laufwerk: 'L', name: 'SQL-Log', groesseGb: 20, freiGb: 20, blockKb: 64 }], freigaben: [],
      cluster: { name: 'sqlcl01', knoten: [{ name: 'sql01', zustand: 'Up' }, { name: 'sql02', zustand: 'Up' }], quorum: 'NodeAndFileShareMajority', zeuge: '\\\\fs01.ad.3033.at\\Witness$ Online', ressourcen: [{ name: 'Cluster IP Address', typ: 'IP Address', zustand: 'Online', gruppe: 'Cluster Group' }] } };
    expect(clusterStatusText(s)).toBe('SQL01 (ad.3033.at): Features Failover-Clustering; Volumes C: — 100 GB (4 KB), L: SQL-Log 20 GB (64 KB); Freigaben keine; Cluster sqlcl01: Knoten sql01 Up, sql02 Up; Quorum NodeAndFileShareMajority, Zeuge \\\\fs01.ad.3033.at\\Witness$ Online; Ressourcen Cluster IP Address Online');
  });
});

describe('I8d Skill windows_cluster', () => {
  function welt(antworten: object[], tresorDa: string[] = ['win-dc01-admin']) {
    const aufrufe: Array<{ zugang: string; befehl: string; eingabe?: string }> = [];
    const skill = new WindowsClusterSkill({
      skript: async (zugang, befehl, eingabe) => { aufrufe.push({ zugang, befehl, ...(eingabe !== undefined ? { eingabe } : {}) }); return { code: 0, stdout: `ALFRED-AD ${JSON.stringify(antworten.shift() ?? {})}`, stderr: '' }; },
      tresor: { namen: async () => new Set(tresorDa), lies: async n => `geheim-${n}` },
      schlafe: async () => undefined,
    });
    return { skill, aufrufe };
  }
  const imChange = { ausChange: true } as never;

  it('ändernde Aktionen nur im Change, status auch außerhalb', async () => {
    const { skill } = welt([{ rechner: 'SQL01', features: {}, volumes: [], freigaben: [] }]);
    expect((await skill.execute({ action: 'cluster_anlegen', zugang: 'sql01', name: 'sqlcl01', knoten: ['sql01', 'sql02'], ip: '10.203.30.4', konto_tresor: 'win-dc01-admin' }, {} as never)).error).toContain('nur als Schritt');
    const s = await skill.execute({ action: 'status', zugang: 'sql01' }, {} as never);
    expect(s.success).toBe(true);
    expect(s.display).toContain('kein Cluster');
  });
  it('Cluster-Aktionen brauchen konto_tresor; Kennwort nur in der Standardeingabe, nie im Befehl', async () => {
    const { skill, aufrufe } = welt([{ name: 'sqlcl01', zustand: 'neu', knoten: ['sql01 Up', 'sql02 Up'] }]);
    expect((await skill.execute({ action: 'cluster_anlegen', zugang: 'sql01', name: 'sqlcl01', knoten: ['sql01', 'sql02'], ip: '10.203.30.4' }, imChange)).error).toContain('konto_tresor');
    const r = await skill.execute({ action: 'cluster_anlegen', zugang: 'sql01', name: 'sqlcl01', knoten: ['sql01', 'sql02'], ip: '10.203.30.4', konto_tresor: 'win-dc01-admin' }, imChange);
    expect(r.display).toContain('Rückweg cluster_entfernen name sqlcl01');
    expect(aufrufe[0]!.eingabe).toBe('{"kennwort":"geheim-win-dc01-admin"}');
    expect(skriptAus(aufrufe[0]!.befehl)).not.toContain('geheim-');
  });
  it('AD-Aktionen am DC nehmen standardmäßig win-<zugang>-admin; Validierung „fehlgeschlagen“ ist ein Fehler', async () => {
    const { skill, aufrufe } = welt([{ name: 'AD3033\\gmsa-sqleng$', zustand: 'neu', berechtigte: ['SQL01', 'SQL02'] }, { ergebnis: 'fehlgeschlagen', warnungen: ['Network: failed'], bericht: 'C:\\x.htm' }]);
    const g = await skill.execute({ action: 'gmsa_anlegen', zugang: 'dc01', name: 'gmsa-sqleng', berechtigte: ['sql01', 'sql02'] }, imChange);
    expect(g.display).toContain('Kennwort abrufen dürfen: SQL01, SQL02');
    expect(aufrufe[0]!.eingabe).toContain('geheim-win-dc01-admin');
    const v = await skill.execute({ action: 'cluster_validieren', zugang: 'sql01', knoten: ['sql01', 'sql02'], konto_tresor: 'win-dc01-admin' }, imChange);
    expect(v.success).toBe(false);
    expect(v.error).toContain('Validierung fehlgeschlagen');
  });
  it('Features: nach dem Neustart wird gewartet, bis alle installiert sind', async () => {
    const { skill, aufrufe } = welt([{ installiert: ['Failover-Clustering'], neustart: true }, { rechner: 'SQL01', features: { 'Failover-Clustering': false }, volumes: [], freigaben: [] }, { rechner: 'SQL01', features: { 'Failover-Clustering': true }, volumes: [], freigaben: [] }]);
    const r = await skill.execute({ action: 'features_installieren', zugang: 'sql01', features: ['Failover-Clustering'] }, imChange);
    expect(r.display).toContain('(mit Neustart)');
    expect(aufrufe).toHaveLength(3);
  });
  it('Change-Plan: status lesend; Platten/Features/Validierung ohne Rückweg zulässig, Cluster nur mit Rückweg', () => {
    expect(aktionsArt('windows_cluster', 'status')).toBe('lesen');
    expect(aktionsArt('windows_cluster', 'gmsa_pruefen')).toBe('lesen');
    expect(aktionsArt('windows_cluster', 'freigabe_entfernen')).toBe('aendern');
    const sk = new WindowsClusterSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
    const pr = { typ: 'skill', skill: 'windows_cluster', aktion: 'status', parameter: { zugang: 'sql01' }, erwartet: 'Cluster sqlcl01' };
    const plan = (rueckweg: object) => ({ titel: 'sql01 Platten und Cluster', begruendung: 'I8d Architektur 3ca3873e v3', typ: 'normal', risiko: 'mittel', ausfallMinuten: 0, betroffen: ['sql01'],
      schritte: [
        { titel: 'Platten einrichten', art: 'aktion', skill: 'windows_cluster', aktion: 'platten_einrichten', parameter: { zugang: 'sql01', platten: [{ groesse_gb: 50, laufwerk: 'D', name: 'SQL-Daten', block_kb: 64 }] }, rueckweg: { keiner: 'additiv, Platte war leer' }, pruefung: { ...pr, erwartet: 'D: SQL-Daten' } },
        { titel: 'Cluster anlegen', art: 'aktion', skill: 'windows_cluster', aktion: 'cluster_anlegen', parameter: { zugang: 'sql01', name: 'sqlcl01', knoten: ['sql01', 'sql02'], ip: '10.203.30.4', konto_tresor: 'win-dc01-admin' }, rueckweg, pruefung: pr },
      ] });
    const ctx = { skill: (n: string) => (n === 'windows_cluster' ? sk as never : undefined), asset: (n: string) => ({ id: `a-${n}`, name: n }), changes: [] };
    expect(pruefeChangePlan(plan({ skill: 'windows_cluster', aktion: 'cluster_entfernen', parameter: { zugang: 'sql01', name: 'sqlcl01', konto_tresor: 'win-dc01-admin' } }), ctx).fehler.filter(x => /Rückweg|windows_cluster|rueckweg/.test(x))).toEqual([]);
    expect(pruefeChangePlan(plan({ keiner: 'egal' }), ctx).fehler.some(x => x.includes('Schritt 2') && x.includes('ohne Rückweg nur bei'))).toBe(true);
  });
});

// v1789 — Owner 11.11.: Ausführungskonto wählbar (fremde Domäne), benannte Instanzen
describe('v1789 Ausführungskonto wählbar', () => {
  it('ausfuehrungskonto landet als ausKonto im Skript; spn_setzen behält sein Zielkonto', async () => {
    const aufrufe: string[] = [];
    const skill = new WindowsClusterSkill({
      skript: async (_z, befehl) => { aufrufe.push(Buffer.from(befehl.split(' ').pop()!, 'base64').toString('utf16le')); return { code: 0, stdout: 'ALFRED-AD {"konto":"gmsa-sqleng$","neu":[],"schon":[],"spns":[]}', stderr: '' }; },
      tresor: { namen: async () => new Set(['fremd-admin']), lies: async () => 'x' },
    });
    const r = await skill.execute({ action: 'spn_setzen', zugang: 'dc01', konto: 'gmsa-sqleng$', spns: ['MSSQLSvc/a.b.at:1433'], ausfuehrungskonto: 'FREMD\\adm-sql', konto_tresor: 'fremd-admin' }, { ausChange: true } as never);
    expect(r.success).toBe(true);
    expect(aufrufe[0]).toContain('"konto":"gmsa-sqleng$"');
    expect(aufrufe[0]).toContain('"ausKonto":"FREMD\\\\adm-sql"');
    expect((await skill.execute({ action: 'gmsa_anlegen', zugang: 'dc01', name: 'g', berechtigte: ['a'], ausfuehrungskonto: 'a;b', konto_tresor: 'fremd-admin' }, { ausChange: true } as never)).error).toContain('ausfuehrungskonto');
  });
});

// v1791 — Realfall 11.11. fs01: C: 63 statt 100 GB (Wiederherstellungspartition hinter C:)
describe('v1791 systemplatte_erweitern', () => {
  it('WinRE erst nach C:, nur eine Recovery-Partition hinter C: entfernen, sonst Abbruch ohne Änderung', async () => {
    const { systemplatteSkript } = await import('./windows-cluster.js');
    const s = systemplatteSkript();
    expect(s.indexOf('reagentc.exe /disable')).toBeGreaterThan(-1);
    expect(s.indexOf('reagentc.exe /disable')).toBeLessThan(s.indexOf('Remove-Partition'));
    expect(s).toContain("$hinter.Count -ne 1 -or $hinter[0].Type -ne 'Recovery'");
    expect(s).toContain("Test-Path 'C:\\Windows\\System32\\Recovery\\winre.wim'");
    expect(s).toContain("if ($frei -lt 1GB) { $r.zustand = 'schon voll' }");
    const skill = new WindowsClusterSkill({ skript: async () => ({ code: 0, stdout: 'ALFRED-AD {"vorherGb":63,"nachherGb":99.1,"freiGb":91.6,"zustand":"vergrößert (Wiederherstellungspartition entfernt, WinRE auf C:)","winre":"Enabled"}', stderr: '' }) });
    expect((await skill.execute({ action: 'systemplatte_erweitern', zugang: 'fs01' }, {} as never)).error).toContain('nur als Schritt');
    expect((await skill.execute({ action: 'systemplatte_erweitern', zugang: 'fs01' }, { ausChange: true } as never)).display).toBe('✅ C: auf fs01: vergrößert (Wiederherstellungspartition entfernt, WinRE auf C:), 63 → 99.1 GB (91.6 GB frei); WinRE Enabled');
    expect(aktionsArt('windows_cluster', 'systemplatte_erweitern')).toBe('aendern');
  });
});

// v1794 — Realfall 11.11. E 1d741562: Download Sekunden nach dem Öffnen der Firewall gescheitert; Umlaute verstümmelt
describe('v1794 verbindung_pruefen und Umlaute', () => {
  it('lesend, prüft Ziel/URL, Text als Prüfung nutzbar', async () => {
    const { pruefeVerbindung, verbindungText } = await import('./windows-cluster.js');
    expect(pruefeVerbindung({ ziel: 'download.microsoft.com', url: 'https://download.microsoft.com/x.exe' })).toEqual({ ziel: 'download.microsoft.com', port: 443, url: 'https://download.microsoft.com/x.exe' });
    expect(pruefeVerbindung({ ziel: 'download.microsoft.com', url: 'https://evil.example/x' })).toContain('url');
    expect(pruefeVerbindung({ ziel: 'a b' })).toContain('ziel');
    expect(verbindungText({ ziel: 'download.microsoft.com', port: 443, tcp: true, ip: '2.18.69.191', ms: 16, https: 200 })).toBe('Verbindung download.microsoft.com:443 ok (2.18.69.191, 16 ms, HTTPS 200)');
    expect(verbindungText({ ziel: 'x.at', port: 443, tcp: false, ip: '1.2.3.4', fehler: 'TCP: keine Verbindung in 8 s' })).toBe('Verbindung x.at:443 NICHT erreichbar (1.2.3.4): TCP: keine Verbindung in 8 s');
    expect(aktionsArt('windows_cluster', 'verbindung_pruefen')).toBe('lesen');
    const skill = new WindowsClusterSkill({ skript: async () => ({ code: 0, stdout: 'ALFRED-AD {"ziel":"download.microsoft.com","port":443,"tcp":true,"ip":"2.18.69.191","ms":16}', stderr: '' }) });
    expect((await skill.execute({ action: 'verbindung_pruefen', zugang: 'sql01', ziel: 'download.microsoft.com' }, {} as never)).display).toContain(' ok (');
  });
  it('Ergebnis gibt Nicht-ASCII als \\uXXXX aus; der Parser liest es zurück', async () => {
    const { kopf, adErgebnis } = await import('./windows-ad.js');
    expect(kopf({}, false).join('\n')).toContain("[regex]::Replace($j, '[^\\x00-\\x7F]'");
    expect(adErgebnis<{ zustand: string }>('ALFRED-AD {"zustand":"vergr\\u00f6\\u00dfert"}')?.zustand).toBe('vergrößert');
  });
});

// v1806 — Nachpflege I8d: lesende Erhebung (Firewall, SPN, Verzeichnis) + eng begrenzte Änderungen
describe('v1806 Nachpflege-Bausteine', () => {
  it('firewall_lesen verbindet Port- und Adressfilter über die InstanceID', async () => {
    const m = await import('./windows-cluster.js');
    const s = m.firewallLesenSkript({ nur_any: true });
    expect(s).toContain('Get-NetFirewallAddressFilter -All');
    expect(s).toContain("if ($p.nur_any -and $ra -ne 'Any') { continue }");
  });
  it('spn_lesen läuft als SYSTEM, Konto wird geprüft', async () => {
    const m = await import('./windows-cluster.js');
    expect(m.spnLesenSkript({ konto: 'gmsa-sqleng$' })).toContain("MitKonto 'SYSTEM'");
    expect(m.pruefeSamKonto('gmsa-sqleng$')).toEqual({ konto: 'gmsa-sqleng$' });
    expect(typeof m.pruefeSamKonto('x)(cn=*')).toBe('string');
  });
  it('Pfade: verzeichnis_lesen nur lokal, diagnose_entfernen nur C:\\Windows\\Temp\\alfred-*', async () => {
    const m = await import('./windows-cluster.js');
    expect(m.pruefePfad('S:\\SQLBackup')).toEqual({ pfad: 'S:\\SQLBackup' });
    expect(typeof m.pruefePfad('\\\\fs01\\x')).toBe('string');
    expect(typeof m.pruefePfad('C:\\x\\..\\y')).toBe('string');
    expect(m.pruefeDiagnose('C:\\Windows\\Temp\\alfred-clusterlog')).toEqual({ pfad: 'C:\\Windows\\Temp\\alfred-clusterlog' });
    expect(typeof m.pruefeDiagnose('C:\\Windows\\Temp')).toBe('string');
    expect(typeof m.pruefeDiagnose('C:\\Windows\\System32')).toBe('string');
    expect(m.diagnoseEntfernenSkript({ pfad: 'C:\\Windows\\Temp\\alfred-x' })).toContain('Remove-Item -LiteralPath $p.pfad -Recurse -Force');
  });
  it('firewall_filter_setzen nennt den vorherigen Wert, Any nur allein', async () => {
    const m = await import('./windows-cluster.js');
    expect(m.pruefeFilter({ regel: 'MSSQLSERVER', von: ['10.203.30.0/24', '192.168.1.223'] })).toEqual({ regel: 'MSSQLSERVER', von: ['10.203.30.0/24', '192.168.1.223'] });
    expect(m.pruefeFilter({ regel: 'X', von: 'Any' })).toEqual({ regel: 'X', von: ['Any'] });
    expect(typeof m.pruefeFilter({ regel: 'X', von: ['Any', '10.0.0.1'] })).toBe('string');
    expect(typeof m.pruefeFilter({ regel: "x'; Remove", von: ['10.0.0.1'] })).toBe('string');
    const s = m.firewallFilterSkript({ regel: 'X', von: ['10.0.0.1'] });
    expect(s.indexOf('$vorher =')).toBeLessThan(s.indexOf('Set-NetFirewallRule'));
  });
});

describe('v1807 firewall_regel_aktiv', () => {
  it('schaltet bestehende Regeln mit vorher-Zustand, Core Networking ausgeschlossen', async () => {
    const m = await import('./windows-cluster.js');
    expect(m.pruefeAktiv({ regel: '{6A75FC77-3480-4DC0-A7A2-F9E1B7C51777}', aktiv: false })).toEqual({ regel: '{6A75FC77-3480-4DC0-A7A2-F9E1B7C51777}', aktiv: false });
    expect(typeof m.pruefeAktiv({ regel: 'CoreNet-DHCP-In', aktiv: false })).toBe('string');
    expect(typeof m.pruefeAktiv({ regel: 'X', aktiv: 'nein' })).toBe('string');
    const s = m.firewallAktivSkript({ regel: 'X', aktiv: false });
    expect(s).toContain("[string]$r.DisplayGroup -like '*Core Networking*'");
    expect(s.indexOf('$vorher =')).toBeLessThan(s.indexOf('Set-NetFirewallRule'));
  });
});

// v1808 — Sicherheitsprüfung: Platzhalter in -Name, fehlende Richtung/Aktion/Quelle, übersetzter Anzeigetext
describe('v1808 Firewall-Bausteine gehärtet', () => {
  it('lehnt Platzhalter ab und löst exakt genau eine lokale eingehende Erlauben-Regel auf', async () => {
    const m = await import('./windows-cluster.js');
    for (const r of ['*', 'File*', 'a?b', '[a]*']) {
      expect(typeof m.pruefeAktiv({ regel: r, aktiv: false })).toBe('string');
      expect(typeof m.pruefeFilter({ regel: r, von: ['10.0.0.1'] })).toBe('string');
    }
    expect(m.pruefeAktiv({ regel: '{CA16D5CF-6633-498E-B75E-A30076E6AA37}', aktiv: false })).toEqual({ regel: '{CA16D5CF-6633-498E-B75E-A30076E6AA37}', aktiv: false });
    expect(m.pruefeFilter({ regel: 'FailoverClustering-ClusSvc-TCP-In', von: ['10.203.30.3'] })).toEqual({ regel: 'FailoverClustering-ClusSvc-TCP-In', von: ['10.203.30.3'] });
    for (const s of [m.firewallAktivSkript({ regel: 'X', aktiv: false }), m.firewallFilterSkript({ regel: 'X', von: ['10.0.0.1'] })]) {
      expect(s).toContain('Where-Object { [string]$_.Name -ceq $p.regel }');
      expect(s).toContain('if ($r.Count -ne 1)');
      expect(s).toContain("if ([string]$r.Action -ne 'Allow')");
      expect(s).toContain("if ([string]$r.PolicyStoreSourceType -ne 'Local')");
      expect(s).toContain('-InputObject $r');
      expect(s).not.toContain('-Name $p.regel');
    }
    expect(m.firewallAktivSkript({ regel: 'X', aktiv: false })).toContain("[string]$r.Name -like 'CoreNet-*'");
  });
});

// v1809 — Lehre aus H dd0c0b10: Stabilitätsfenster mit Ereignis 1650 auf beiden Knoten
describe('v1809 Stabilitätsfenster', () => {
  it('bewertet nur volle, lückenlose, ereignisfreie und gesunde Beobachtung als stabil', async () => {
    const { stabilitaetBewerten } = await import('./windows-cluster.js');
    const ok = (knoten: string, neu = 0, gesund = true) => ({ zeit: 't', knoten, ok: true, neu, gesund });
    expect(stabilitaetBewerten([ok('sql01'), ok('sql02')], ['sql01', 'sql02'], 900, 905).ergebnis).toBe('CLUSTER_STABLE');
    expect(stabilitaetBewerten([ok('sql01'), ok('sql02')], ['sql01', 'sql02'], 900, 600).ergebnis).toBe('UNKNOWN');
    expect(stabilitaetBewerten([ok('sql01')], ['sql01', 'sql02'], 900, 905).ergebnis).toBe('UNKNOWN');
    expect(stabilitaetBewerten([ok('sql01'), { zeit: 't', knoten: 'sql02', ok: false, neu: 0, fehler: 'ssh' }], ['sql01', 'sql02'], 900, 905).ergebnis).toBe('UNKNOWN');
    expect(stabilitaetBewerten([ok('sql01'), ok('sql02', 1)], ['sql01', 'sql02'], 900, 120).ergebnis).toBe('FAIL');
    expect(stabilitaetBewerten([ok('sql01'), ok('sql02', 0, false)], ['sql01', 'sql02'], 900, 905).ergebnis).toBe('FAIL');
  });
  it('Messskript zählt nur Records nach dem Ausgangsstand und prüft AG lokal', async () => {
    const { stabilMessSkript, ereignisseSkript, pruefeEreignisIds } = await import('./windows-cluster.js');
    const s = stabilMessSkript({ ids: [1650], seit_record: 42, ag: 'ag01' });
    expect(s).toContain('$_.RecordId -gt [long]$p.seit_record');
    expect(s).toContain("AddWithValue('@ag', [string]$p.ag)");
    expect(ereignisseSkript({ ids: [1650], minuten: 5 })).toContain('hoechsterRecord');
    expect(pruefeEreignisIds(undefined)).toEqual([1650]);
    expect(typeof pruefeEreignisIds(['x'])).toBe('string');
  });
});
