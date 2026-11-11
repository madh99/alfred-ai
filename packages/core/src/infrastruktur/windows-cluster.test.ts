import { describe, it, expect } from 'vitest';
import {
  pruefePlatten, plattenSkript, pruefeFeatures, pruefeFirewall, firewallSkript, pruefeFreigabe, freigabeSkript, pruefeGmsa, gmsaSkript, pruefeComputerobjekt,
  computerobjektSkript, pruefeSpn, spnSkript, pruefeKnoten, pruefeCluster, pruefeZeuge, validierenSkript, clusterAnlegenSkript, zeugeSkript, gmsaPruefenSkript,
  clusterStatusText, innenSkript, MIT_KONTO, type ClusterStatus,
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
    expect(v).toContain("MitKonto ($nb + '\\alfred') $e.kennwort");
    expect(v).toContain('Unregister-ScheduledTask');
    expect(v).toContain('Remove-Item -LiteralPath $skript, $aus');
    expect(MIT_KONTO).toContain("'S-1-5-18', 'S-1-5-32-544'"); // Skriptordner nur SYSTEM + Administratoren
    expect(clusterAnlegenSkript({ name: 'sqlcl01', knoten: ['sql01', 'sql02'], ip: '10.203.30.4' })).toContain('-NoStorage -AdministrativeAccessPoint ActiveDirectoryAndDns');
    expect(zeugeSkript({ freigabe: '\\\\fs01\\Witness$' })).toContain('Set-ClusterQuorum -FileShareWitness $p.freigabe');
    expect(gmsaPruefenSkript({ name: 'gmsa-sqleng' })).toContain("MitKonto 'SYSTEM' ''");
    // das innere Skript sieht nie das Kennwort
    expect(innenSkript({ a: 1 }, ['1'])).not.toContain('kennwort');
  });
  it('Statustext im prüfbaren Wortlaut', () => {
    const s: ClusterStatus = { rechner: 'SQL01', domaene: 'ad.3033.at', features: { 'Failover-Clustering': true, 'FS-FileServer': false },
      volumes: [{ laufwerk: 'C', name: '', groesseGb: 100, freiGb: 70, blockKb: 4 }, { laufwerk: 'L', name: 'SQL-Log', groesseGb: 20, freiGb: 20, blockKb: 64 }], freigaben: [],
      cluster: { name: 'sqlcl01', knoten: [{ name: 'sql01', zustand: 'Up' }, { name: 'sql02', zustand: 'Up' }], quorum: 'NodeAndFileShareMajority', zeuge: '\\\\fs01.ad.3033.at\\Witness$ Online', ressourcen: [{ name: 'Cluster IP Address', typ: 'IP Address', zustand: 'Online', gruppe: 'Cluster Group' }] } };
    expect(clusterStatusText(s)).toBe('SQL01 (ad.3033.at): Features Failover-Clustering; Volumes L: SQL-Log 20 GB (64 KB); Freigaben keine; Cluster sqlcl01: Knoten sql01 Up, sql02 Up; Quorum NodeAndFileShareMajority, Zeuge \\\\fs01.ad.3033.at\\Witness$ Online; Ressourcen Cluster IP Address Online');
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
