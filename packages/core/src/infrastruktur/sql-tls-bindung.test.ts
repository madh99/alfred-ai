import { describe, it, expect } from 'vitest';
import { pruefeBindung, bindenSkript, bindungWiederherstellenSkript, pruefeNeustart, engineNeustartSkript, pruefeWiederanlauf, engineWiederanlaufSkript, pruefeTlsTest, tlsTestSkript, bewerteTlsTest, sqlTlsStatusSkript, sqlTlsStatusText, TDS_PROBE, type TlsBefund, type SqlTlsStatus } from './sql-tls-bindung.js';
import { anforderungListeSkript, anforderungEntfernenSkript } from './windows-sqltls.js';
import { SqlServerSkill } from './sql-server-skill.js';
import { WindowsPkiSkill } from './windows-pki-skill.js';
import { aktionsArt } from './change-schritte.js';

// PKI Etappe 4 — Spec 252217f3 Pos. 21–25 (und Pos. 12: ungesendete Anforderung abbrechen)
const T1 = '4E073ED074CAB15E515ECD4471B0820C45E440E1';
const T2 = '690EC1B8649EBBC07870DE2C6AA74ED1B7E6A745';
const ad = (o: unknown) => ({ code: 0, stdout: `ALFRED-AD ${JSON.stringify(o)}\n`, stderr: '' });
const imChange = { ausChange: true } as never;
const ungeschuetzt = (s: string) => s.replace(/''/g, "'");

describe('Etappe 4 Bausteine', () => {
  it('Bindung: Thumbprint geprüft, ForceEncryption Standard an, Gates vor dem Schreiben, Zustand davor gemerkt, kein Neustart', () => {
    expect(pruefeBindung({ thumbprint: 'xyz' })).toContain('thumbprint');
    expect(pruefeBindung({ thumbprint: T1.toLowerCase() })).toEqual({ thumbprint: T1, force_encryption: true });
    expect(pruefeBindung({ thumbprint: T1, force_encryption: 'ja' })).toContain('force_encryption');
    expect(pruefeBindung({ thumbprint: T1, erwarteter_vorher_hash: 'abc' })).toContain('64 Hex');
    const s = bindenSkript(pruefeBindung({ thumbprint: T1 }) as never);
    expect(s.indexOf('ZertGruende $p.thumbprint')).toBeLessThan(s.indexOf("Set-ItemProperty -LiteralPath $nk -Name 'Certificate'"));
    expect(s.indexOf('[IO.File]::WriteAllText($merk')).toBeLessThan(s.indexOf("Set-ItemProperty -LiteralPath $nk -Name 'Certificate'"));
    expect(s).toContain("$zustand = 'schon gebunden'");
    expect(s).not.toMatch(/Restart-Service|Stop-Service/);
    // Gates: My, privater Schlüssel, Laufzeit, ServerAuth, eigener FQDN, Kette online, Engine-Konto liest
    for (const g of ['HasPrivateKey', "'1.3.6.1.5.5.7.3.1'", 'Fqdn', "RevocationMode = 'Online'", 'darf den Schlüssel nicht lesen']) expect(s).toContain(g);
  });
  it('Wiederherstellen: genau der gemerkte Zustand (auch leer), ohne Neustart; ohne Merkdatei Fehler', () => {
    const s = bindungWiederherstellenSkript();
    expect(s).toContain('kein gemerkter Zustand');
    expect(s).toContain('[string]$m.vorher.zertifikat');
    expect(s).toContain("-Name 'ForceEncryption' -Value $ziel.force");
    expect(s).not.toMatch(/Restart-Service/);
  });
  it('Neustart nur sekundär, gesund, synchron, Quorum normal — nie Failover; wartet und prüft geladenes Zertifikat', () => {
    expect(pruefeNeustart({ ag: 'ag01; DROP' })).toContain('ag');
    expect(pruefeNeustart({ ag: 'ag01', zeitlimit_s: 30 })).toContain('zeitlimit_s');
    expect(pruefeNeustart({ ag: 'ag01' })).toEqual({ ag: 'ag01', zeitlimit_s: 900 });
    const s = engineNeustartSkript(pruefeNeustart({ ag: 'ag01', erwarteter_primaer: 'sql01', erwarteter_thumbprint: T2 }) as never);
    const vorNeustart = s.slice(0, s.indexOf('Restart-Service'));
    for (const g of ["-ne 'SECONDARY'", "-ne 'CONNECTED'", "-ne 'HEALTHY'", "-ne 'SYNCHRONIZED'", 'NORMAL_QUORUM', "member_state_desc <> 'UP'", '$p.erwarteter_primaer']) expect(vorNeustart).toContain(g);
    expect(s).not.toMatch(/ALTER AVAILABILITY GROUP|ALLOW_DATA_LOSS|Move-ClusterGroup|Restart-Computer|shutdown\.exe/i);
    expect(s).toContain("'ROLLE: nach dem Neustart PRIMARY");
    expect(s).toContain('$g.thumbprint -ne $p.erwarteter_thumbprint');
    // Alias „start“ = Start-Process darf die Funktion nicht verdecken
    expect(s).not.toMatch(/function Start \{/);
  });
  it('v1857 Wiederanlauf: Gates über den Cluster (Primär erwartet, nie dieser Knoten), Bindung = gemerkter Zustand, nie Failover', () => {
    expect(pruefeWiederanlauf({ ag: 'ag01' })).toContain('erwarteter_primaer');
    expect(pruefeWiederanlauf({ ag: 'ag01', erwarteter_primaer: 'sql01' })).toEqual({ ag: 'ag01', erwarteter_primaer: 'SQL01', zeitlimit_s: 900 });
    const s = engineWiederanlaufSkript(pruefeWiederanlauf({ ag: 'ag01', erwarteter_primaer: 'SQL01' }) as never);
    const vor = s.slice(0, s.indexOf('Restart-Service'));
    for (const g of ['$primKnoten -ieq $env:COMPUTERNAME', 'Get-ClusterGroup -Name $p.ag', "[string]$_.State -ne 'Up'", 'QuorumResource.State', 'erst zertifikat_bindung_wiederherstellen', "ROLLE: dieser Knoten ist PRIMARY"]) expect(vor).toContain(g);
    expect(s).toContain("Start-Service -Name $svc");
    expect(s).toContain("statt selbst erzeugtem Ersatzzertifikat");
    expect(s).not.toMatch(/ALTER AVAILABILITY GROUP|ALLOW_DATA_LOSS|Move-ClusterGroup|Restart-Computer/i);
  });
  it('v1857 Rückweg mit ag: Wiederherstellen und danach Wiederanlauf in einem Schritt', async () => {
    const antworten = [
      { zustand: 'wiederhergestellt', rechner: 'SQL02', instanz: 'MSSQLSERVER', vorher: { zertifikat: T2, force: 1 }, nachher: { zertifikat: '', force: 0 } },
      { rechner: 'SQL02', ag: 'ag01', primaer: 'SQL01', agZustand: 'Online', vorherStart: 'nicht erreichbar', start: '2026-11-14T01:00:00', sekunden: 40, datenbanken: ['i8d_ag01 SYNCHRONIZED'], agent: 'Running', konfiguriert: '', force: 0, geladen: { art: 'selbsterzeugt', thumbprint: '' } },
    ];
    const befehle: string[] = [];
    const skill = new SqlServerSkill({ skript: async (_z, b) => { befehle.push(Buffer.from(b.split(' ').pop()!, 'base64').toString('utf16le')); return ad(antworten.shift()); } });
    const r = await skill.execute({ action: 'zertifikat_bindung_wiederherstellen', zugang: 'sql02', ag: 'ag01', erwarteter_primaer: 'SQL01' }, imChange);
    expect(r.display).toMatch(/SQL_TLS_BINDING_RESTORED .*SQL_SECONDARY_RECOVERED_AND_SYNCED SQL02 .*Primär SQL01 \(Online\) unberührt/);
    expect(befehle).toHaveLength(2);
    expect((await skill.execute({ action: 'engine_wiederanlauf', zugang: 'sql02', ag: 'ag01' }, imChange)).error).toContain('erwarteter_primaer');
    expect(aktionsArt('sql_server', 'engine_wiederanlauf')).toBe('aendern');
  });
  it('TLS-Test: TDS-Probe + Anmeldung nur mit TrustServerCertificate=False', () => {
    expect(pruefeTlsTest({ ziel: 'sqlag01' })).toContain('DNS-Name');
    expect(pruefeTlsTest({ ziel: 'sqlag01.ad.3033.at', erwartete_rolle: 'x' })).toContain('erwartete_rolle');
    const t = pruefeTlsTest({ ziel: 'SQLAG01.ad.3033.at', erwarteter_thumbprint: T1, erzwungen: true });
    expect(t).toEqual({ ziel: 'sqlag01.ad.3033.at', port: 1433, erwarteter_thumbprint: T1, erzwungen: true });
    const s = ungeschuetzt(tlsTestSkript(t as never));
    expect(s).toContain('TrustServerCertificate=False');
    expect(s).not.toContain('TrustServerCertificate=True');
    expect(s).toContain('[AlfredTdsProbe]::Verschluesselung($p.ziel, $p.port, 0, 20000)');
    expect(TDS_PROBE.join('\n')).toContain('p[0] = 0x12');
    expect(s).toContain("ApplicationPolicy.Add((New-Object Security.Cryptography.Oid '1.3.6.1.5.5.7.3.1'))");
  });
  it('TLS-Abnahme: Thumbprint, Name, Kette online, Erzwingen und Kerberos — sonst Befund', () => {
    const t = pruefeTlsTest({ ziel: 'sqlag01.ad.3033.at', erwarteter_thumbprint: T1, erwarteter_server: 'SQL01', erwartete_rolle: 'PRIMARY', erzwungen: true }) as never;
    const gut: TlsBefund = { probe: { thumbprint: T1, subjekt: 'CN=sql01.ad.3033.at', aussteller: 'CN=AD3033 Issuing CA 01', sans: ['sql01.ad.3033.at', 'sqlag01.ad.3033.at'], von: '2026-11-13', bis: '2027-11-13', kette: true, kettenStatus: [], antwortUnverschluesselt: 3, zeit: 'x' }, anmeldung: { server: 'SQL01', rolle: 'PRIMARY', anmeldung: 'KERBEROS', konto: 'AD3033\\alfred', verschluesselt: true } };
    expect(bewerteTlsTest(t, gut)).toEqual({ ok: true, gruende: [] });
    const f = (b: Partial<TlsBefund['probe']>, a: Partial<TlsBefund['anmeldung']> = {}) => bewerteTlsTest(t, { probe: { ...gut.probe, ...b }, anmeldung: { ...gut.anmeldung, ...a } }).gruende.join(' ');
    expect(f({ thumbprint: 'BC3FAC56D2FB27863A0218CDD8E5D16B587570F1', subjekt: 'CN=SSL_Self_Signed_Fallback', sans: [] })).toMatch(/vorgelegt BC3F.*nicht im SAN/);
    expect(f({ kette: false, kettenStatus: ['RevocationStatusUnknown', 'OfflineRevocation'] })).toContain('OfflineRevocation');
    expect(f({ antwortUnverschluesselt: 0 })).toContain('erzwingt NICHT');
    expect(f({}, { anmeldung: 'NTLM' })).toContain('statt KERBEROS');
    expect(f({}, { rolle: 'SECONDARY' })).toContain('Rolle SECONDARY statt PRIMARY');
    expect(bewerteTlsTest(t, { probe: gut.probe, anmeldung: { fehler: 'The certificate chain was issued by an authority that is not trusted.' } }).ok).toBe(false);
  });
  it('Status trennt konfiguriert und geladen; Text nennt Neustart ausstehend', () => {
    const s = sqlTlsStatusSkript();
    expect(s).toContain("'loaded for encryption'");
    expect(s).toContain('Cert Hash\\(sha1\\)');
    const st: SqlTlsStatus = { rechner: 'SQL02', instanz: 'MSSQLSERVER', konfiguriert: T2, force: 1, strikt: null, geladen: { art: 'selbsterzeugt', thumbprint: '', zeile: '' }, start: '2026-11-12T08:52:49', engineKonto: 'AD3033\\gmsa-sqleng$', neustartAusstehend: true, gemerkt: null, geaendert: '', zertifikat: { thumbprint: T2, subjekt: 'CN=sql02.ad.3033.at', bis: '2027-11-13', gruende: [] }, bindungsHash: 'h' };
    expect(sqlTlsStatusText(st)).toMatch(/^SQL_TLS_STATUS SQL02\\MSSQLSERVER: konfiguriert 690E.*geladen selbst erzeugtes Ersatzzertifikat.*Neustart AUSSTEHEND/);
  });
  it('Anforderung entfernen: nur ohne Benutzung in My, Subject muss passen, Speicher und Schlüsseldatei werden nachgeprüft', () => {
    expect(anforderungListeSkript()).toContain('Cert:\\LocalMachine\\REQUEST');
    const s = anforderungEntfernenSkript({ thumbprint: T1, subjekt: 'CN=sql01.ad.3033.at' });
    expect(s.indexOf('in LocalMachine\\\\My benutzt')).toBeLessThan(s.indexOf('$rsa.Clear()'));
    expect(s).toContain('$c.Subject -ne $p.subjekt');
    expect(s).toContain('Schlüsseldatei nach dem Entfernen noch vorhanden');
    expect(s).not.toMatch(/Cert:\\LocalMachine\\My\\' \+ \$p\.thumbprint\)[^\n]*Remove/);
  });
});

describe('Etappe 4 Skills', () => {
  it('sql_server: ändernde Etappe-4-Aktionen nur im Change; Lesen ist lesend eingeordnet', async () => {
    const skill = new SqlServerSkill({ skript: async () => ad({}) });
    for (const a of ['zertifikat_binden', 'zertifikat_bindung_wiederherstellen', 'engine_neustart']) {
      expect((await skill.execute({ action: a, zugang: 'sql02', thumbprint: T2, ag: 'ag01' }, {} as never)).error).toContain('nur als Schritt');
      expect(aktionsArt('sql_server', a)).toBe('aendern');
    }
    expect(aktionsArt('sql_server', 'zertifikat_status')).toBe('lesen');
    expect(aktionsArt('sql_server', 'tls_testen')).toBe('lesen');
    expect(aktionsArt('windows_pki', 'anforderung_liste')).toBe('lesen');
    expect(aktionsArt('windows_pki', 'anforderung_entfernen')).toBe('aendern');
  });
  it('sql_server binden meldet restart_required und keinen TLS-Erfolg; tls_testen scheitert bei Befund', async () => {
    const antworten = [
      { zustand: 'gebunden', rechner: 'SQL02', instanz: 'MSSQLSERVER', vorher: { zertifikat: '', force: 0 }, nachher: { zertifikat: T2, force: 1 }, vorherHash: 'a', nachherHash: 'b', geladen: { art: 'selbsterzeugt', thumbprint: '' } },
      { probe: { thumbprint: 'BC3FAC56D2FB27863A0218CDD8E5D16B587570F1', subjekt: 'CN=SSL_Self_Signed_Fallback', aussteller: 'CN=SSL_Self_Signed_Fallback', sans: [], von: '', bis: '', kette: false, kettenStatus: ['UntrustedRoot'], antwortUnverschluesselt: 0, zeit: 'x' }, anmeldung: { fehler: 'The certificate chain was issued by an authority that is not trusted.' } },
    ];
    const eingaben: (string | undefined)[] = [];
    const skill = new SqlServerSkill({ skript: async (_z, _b, e) => { eingaben.push(e); return ad(antworten.shift()); }, tresor: { namen: async () => new Set(['win-dc01-admin']), lies: async () => 'pw' } });
    const b = await skill.execute({ action: 'zertifikat_binden', zugang: 'sql02', thumbprint: T2 }, imChange);
    expect(b.display).toContain('SQL_TLS_BINDING_CONFIGURED');
    expect(b.display).toContain('restart_required=true');
    expect(b.display).not.toContain('SQL_TLS_VERIFIED');
    const t = await skill.execute({ action: 'tls_testen', zugang: 'sql01', ziel: 'sql02.ad.3033.at', erwarteter_thumbprint: T2, erzwungen: true, konto_tresor: 'win-dc01-admin' });
    expect(t.success).toBe(false);
    expect(t.error).toMatch(/vorgelegt BC3F.*UntrustedRoot.*erzwingt NICHT.*not trusted/);
    expect(eingaben[1]).toBe(JSON.stringify({ kennwort: 'pw' }));
  });
  it('windows_pki anforderung_entfernen nur im Change, Subject Pflicht', async () => {
    const skill = new WindowsPkiSkill({ skript: async () => ad({ zustand: 'entfernt', thumbprint: T1, subjekt: 'CN=sql01.ad.3033.at', rechner: 'SQL01', schluesselDatei: 'k', schluesselEntfernt: true, myVorher: 3, myNachher: 3 }) });
    expect((await skill.execute({ action: 'anforderung_entfernen', zugang: 'sql01', thumbprint: T1, subjekt: 'CN=sql01.ad.3033.at' }, {} as never)).success).toBe(false);
    expect((await skill.execute({ action: 'anforderung_entfernen', zugang: 'sql01', thumbprint: T1 }, imChange)).error).toContain('subjekt');
    const r = await skill.execute({ action: 'anforderung_entfernen', zugang: 'sql01', thumbprint: T1, subjekt: 'CN=sql01.ad.3033.at' }, imChange);
    expect(r.display).toContain('REQUEST_REMOVED');
    expect(r.display).toContain('3/3');
  });
});
