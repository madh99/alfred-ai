import { describe, it, expect } from 'vitest';
import { auffaelligkeiten, bestandsbericht, osSupport } from './bericht.js';
import type { HostBestand } from './sammler.js';

// I1 — Bestandsbericht und feste Regeln für Auffälligkeiten
const jetzt = new Date('2026-10-22T10:00:00Z');
const host = (teil: Partial<HostBestand>): HostBestand => ({ zugang: 'dockerhost', host: '192.168.1.211', dateisysteme: [], dienste: [], ports: [], container: [], compose: [], volumes: [], fehler: [], ...teil });

describe('I1 Bestandsbericht', () => {
  it('Betriebssystem-Support (Stand 10/2026)', () => {
    expect(osSupport({ name: 'Debian 11', id: 'debian', version: '11' }, jetzt).ok).toBe(false);
    expect(osSupport({ name: 'Debian 12', id: 'debian', version: '12' }, jetzt).ok).toBe(true);
    // v1627 — RHEL-Familie und Fedora
    expect(osSupport({ name: 'Rocky Linux 9.8', id: 'rocky', version: '9.8' }, jetzt).ok).toBe(true);
    expect(osSupport({ name: 'AlmaLinux 7.9', id: 'almalinux', version: '7.9' }, jetzt).ok).toBe(false);
    expect(osSupport({ name: 'Fedora Linux 44', id: 'fedora', version: '44' }, jetzt).ok).toBe(true);
    expect(osSupport({ name: 'Fedora Linux 41', id: 'fedora', version: '41' }, jetzt).ok).toBe(false);
    expect(osSupport({ name: 'Ubuntu 20.04', id: 'ubuntu', version: '20.04' }, jetzt).ok).toBe(false);
    expect(osSupport({ name: 'Ubuntu 24.04', id: 'ubuntu', version: '24.04' }, jetzt).ok).toBe(true);
    expect(osSupport({ name: 'Ubuntu 25.04', id: 'ubuntu', version: '25.04' }, jetzt)).toMatchObject({ ok: false, text: expect.stringContaining('keine LTS') });
  });
  it('Regeln: unhealthy, Platte, Updates, Sicherung, Proxy ohne Dienst — nach Schwere sortiert', () => {
    const a = auffaelligkeiten({
      hosts: [host({
        container: [
          { name: 'noah-frontend', image: 'x', zustand: 'running', status: 'Up 8 days (unhealthy)', gesundheit: 'unhealthy', ports: '', netze: [], mounts: [] },
          { name: 'elastic_ramanujan', image: 'busybox', zustand: 'exited', status: 'Exited (255) 6 months ago', ports: '', netze: [], mounts: [] },
          { name: 'job', image: 'x', zustand: 'exited', status: 'Exited (0) 2 days ago', ports: '', netze: [], mounts: [] },
        ],
        dateisysteme: [{ mount: '/', groesse: '98G', belegt: '90G', prozent: 92 }], updates: { anzahl: 12, sicherheit: 3 },
        ports: [{ adresse: '0.0.0.0', port: 8123 }],
      })],
      vms: [{ name: 'dsc01t', typ: 'vm', status: 'active', vmid: 106 }, { name: 'workVM', typ: 'vm', status: 'active', vmid: 100 }, { name: 'alt', typ: 'vm', status: 'inactive', vmid: 200 }],
      proxy: [{ domains: ['ha.example.at'], forwardHost: '192.168.1.211', forwardPort: 8123 }, { domains: ['tot.example.at'], forwardHost: '192.168.1.211', forwardPort: 9999 }],
      backups: { jeVm: { 106: { neueste: '2026-01-10T01:10:22Z', anzahl: 1, speicher: ['backupshare'] }, 100: { anzahl: 0, speicher: [] } }, ohne: [{ vmid: 100, name: 'workVM' }, { vmid: 200, name: 'alt' }], unerreichbar: [{ speicher: 'pbs-unas', grund: 'nicht aktiv (nicht erreichbar)' }] },
    }, jetzt);
    const t = a.map(x => `${x.schwere}|${x.text}`);
    expect(t).toEqual(expect.arrayContaining([
      'hoch|Container noah-frontend ist unhealthy (Up 8 days (unhealthy))',
      'niedrig|Container elastic_ramanujan beendet mit Fehler (Exited (255) 6 months ago) — aufräumen oder reparieren',
      'mittel|/ zu 92 % belegt (90G von 98G)',
      'mittel|3 Sicherheitsupdates offen (12 Updates gesamt)',
      'hoch|Backup-Speicher pbs-unas nicht aktiv (nicht erreichbar)',
      'hoch|VM/CT 100 (workVM) hat keine Sicherung',
      'mittel|tot.example.at → 192.168.1.211:9999: auf dockerhost lauscht dort kein Dienst',
    ]));
    expect(t.some(x => x.includes('VM/CT 106') && x.includes('vor 285 Tagen'))).toBe(true);
    expect(t.some(x => x.includes('job'))).toBe(false); // sauber beendet (Exit 0)
    expect(t.some(x => x.includes('VM/CT 200'))).toBe(false); // ausgeschaltet
    expect(a[0]!.schwere).toBe('hoch');
  });
  it('Bericht enthält Überblick, Hosts mit Container-Tabelle, VMs, Netze, Proxy', () => {
    const r = bestandsbericht({
      hosts: [host({ os: { name: 'Ubuntu 24.04 LTS', id: 'ubuntu', version: '24.04' }, container: [{ name: 'synapse', image: 'matrixdotorg/synapse', zustand: 'running', status: 'Up', gesundheit: 'healthy', ports: '', netze: ['matrix'], mounts: ['synapse_data'], composeProjekt: 'matrix', composeDienst: 'synapse' }] })],
      vms: [{ name: 'docker-host', typ: 'vm', status: 'active', vmid: 120, node: 'pve', ip: '192.168.1.211' }], proxy: [{ domains: ['matrix.example.at'], forwardHost: '192.168.1.211', forwardPort: 8008 }],
      netze: [{ quelle: 'unifi', name: 'Default', subnet: '192.168.1.0/24' }, { quelle: 'pfsense', name: 'IoT', vlan: 30 }],
    }, jetzt);
    for (const s of ['# Bestandsbericht', '## Auffälligkeiten', '## Host dockerhost (192.168.1.211)', '| synapse | matrixdotorg/synapse | running (healthy) | matrix/synapse | matrix | synapse_data |', '## Proxmox VMs/Container', '**pfsense:** IoT (VLAN 30)', '| matrix.example.at | 192.168.1.211:8008 | — |']) expect(r.markdown).toContain(s);
    expect(r.kurz).toContain('1 Container');
  });
});

describe('I1 Nachschärfung nach dem ersten Lauf (22.10.)', () => {
  it('gestörte Paketverwaltung ist ein Befund; Containername „vaultwarden“ ist kein Geheimnis-Pfad', async () => {
    const a = auffaelligkeiten({ hosts: [host({ fehler: ['updates: Exit 100: E: Problem with MergeList /var/lib/apt/lists/download.docker.com_linux_ubuntu_dists_jammy_stable_binary-amd64_Packages', 'ram: Exit 1'] })], vms: [], proxy: [] }, jetzt);
    expect(a.map(x => x.text)).toEqual(expect.arrayContaining([expect.stringContaining('Paketverwaltung gestört'), 'Nicht erfasst: ram']));
    const { geheimnisGrund } = await import('../fernzugriff/kaefig.js');
    const { composeBefehl } = await import('./sammler.js');
    expect(geheimnisGrund(composeBefehl(['vaultwarden', 'mariadb-vaultwarden', 'synapse']))).toBeUndefined();
    expect(geheimnisGrund('cat /opt/vaultwarden/data/db.sqlite3')).toBeDefined();
    expect(geheimnisGrund('ls /srv/secrets/')).toBeDefined();
  });
});

describe('I8 3b-5 — Windows-Lizenz', () => {
  it('nicht aktiviert → hoch; Testversion ≤30 Tage → mittel, ≤7 → hoch; aktiviert/weit weg → kein Befund', () => {
    const w = (zugang: string, lizenz: object) => ({ ...host({ zugang }), windows: { lizenz } }) as HostBestand;
    const a = auffaelligkeiten({ hosts: [
      w('workvm', { status: 'benachrichtigung', kanal: 'Einzelhandel' }),
      w('eval20', { status: 'testversion', kanal: 'Testversion', ablauf: '2026-11-11', restTage: 20 }),
      w('eval5', { status: 'testversion', kanal: 'Testversion', ablauf: '2026-10-27', restTage: 5 }),
      w('eval148', { status: 'testversion', kanal: 'Testversion', ablauf: '2027-04-03', restTage: 148 }),
      w('dev', { status: 'aktiviert', kanal: 'Einzelhandel' }),
    ], vms: [], proxy: [] }, jetzt).filter(x => x.kategorie === 'lizenz');
    expect(a.map(x => `${x.schwere}|${x.schluessel}|${x.text}`)).toEqual(expect.arrayContaining([
      'hoch|lizenz:workvm|Windows nicht aktiviert (Einzelhandel) — Funktionen eingeschränkt',
      'mittel|lizenz:eval20|Windows-Testversion läuft in 20 Tagen ab (2026-11-11) — Lizenz per Change einspielen (Schlüssel aus dem Tresor)',
      expect.stringMatching(/^hoch\|lizenz:eval5\|/),
    ]));
    expect(a).toHaveLength(3);
  });
});

describe('I8 3b-2a — Sicherheits-Grundlinie', () => {
  it('echte Stände 9102/137: Signierung und TLS mittel; harte Verstöße hoch; LAPS nur in der Domäne', async () => {
    const { grundlinienAbweichungen } = await import('./bericht.js');
    const p9102 = { smb1: false, smbSignaturServer: false, smbSignaturClient: true, gastAnmeldung: false, rdp: { an: false, nla: true }, tls10Aus: false, tls11Aus: false,
      firewall: [{ profil: 'Domain', an: true, eingehend: 'standard' }], defender: { an: true, echtzeit: true, signaturTage: 0 } };
    expect(grundlinienAbweichungen(p9102).map(x => `${x.schwere}|${x.punkt}|${x.text}`)).toEqual([
      'mittel|smb-signatur|SMB-Signierung nicht erzwungen (Server)',
      'mittel|tls|TLS 1.0/1.1 nicht abgeschaltet',
    ]);
    const schlecht = { smb1: true, smbSignaturServer: true, smbSignaturClient: true, gastAnmeldung: true, rdp: { an: true, nla: false }, tls10Aus: true, tls11Aus: true,
      firewall: [{ profil: 'Public', an: false, eingehend: 'standard' }, { profil: 'Private', an: true, eingehend: 'zulassen' }], defender: { an: true, echtzeit: false } };
    expect(grundlinienAbweichungen(schlecht).map(x => `${x.schwere}|${x.punkt}`)).toEqual(['hoch|smb1', 'hoch|smb-gast', 'hoch|firewall', 'hoch|firewall-eingehend', 'hoch|defender', 'hoch|rdp-nla']);
    expect(grundlinienAbweichungen({ defender: { an: true, echtzeit: true, signaturTage: 9 } })).toEqual([{ punkt: 'defender-signaturen', schwere: 'mittel', text: 'Defender-Signaturen 9 Tage alt' }]);
    expect(grundlinienAbweichungen({ tls10Aus: true, tls11Aus: true }, 'ad.3033.at')).toEqual([{ punkt: 'laps', schwere: 'mittel', text: 'Windows LAPS nicht eingerichtet (Domäne ad.3033.at)' }]);
    expect(grundlinienAbweichungen({ tls10Aus: true, tls11Aus: true, laps: 'ad' }, 'ad.3033.at')).toEqual([]);
    expect(grundlinienAbweichungen(undefined)).toEqual([]);
    // I8 3b-3 — VSS
    expect(grundlinienAbweichungen({ vss: { provider: true, agent: true, dienst: true } })).toEqual([]);
    expect(grundlinienAbweichungen({ vss: { provider: false, agent: true, dienst: false } })).toEqual([{ punkt: 'vss', schwere: 'mittel', text: 'Sicherungen nicht anwendungskonsistent (QEMU-VSS-Provider fehlt, VSS-Dienst deaktiviert)' }]);
    expect(grundlinienAbweichungen({ vss: { provider: false, agent: false } })[0]!.text).toBe('Sicherungen nicht anwendungskonsistent (QEMU-Gast-Agent fehlt, QEMU-VSS-Provider fehlt)');
    // im Bericht: je Abweichung ein Befund mit Host-Schlüssel (Problems einzeln, Lösen nur bei erfasstem Host)
    const a = auffaelligkeiten({ hosts: [{ ...host({ zugang: 'probe-win25b' }), windows: { grundlinie: p9102 } } as HostBestand], vms: [], proxy: [] }, jetzt).filter(x => x.kategorie === 'grundlinie');
    expect(a.map(x => x.schluessel)).toEqual(['grundlinie:probe-win25b:smb-signatur', 'grundlinie:probe-win25b:tls']);
    expect(a[0]!.text).toBe('Grundlinie: SMB-Signierung nicht erzwungen (Server)');
  });
});

describe('I4b Teil 3 — Befunde als Problems', () => {
  it('nur hoch/mittel ohne Sicherung, ohne Doppelte, verschwundene Befunde nur bei vollständiger Erfassung lösen', async () => {
    const { befundeAlsProblems } = await import('./befund-problems.js');
    const a = auffaelligkeiten({
      hosts: [host({ container: [{ name: 'noah', image: 'x', zustand: 'running', status: 'Up (unhealthy)', gesundheit: 'unhealthy', ports: '', netze: [], mounts: [] }], dateisysteme: [{ mount: '/', groesse: '98G', belegt: '96G', prozent: 98 }], fehler: ['ram: Exit 1'] })],
      vms: [{ name: 'vm', typ: 'vm', status: 'active', vmid: 1 }], proxy: [],
      backups: { jeVm: {}, ohne: [{ vmid: 1, name: 'vm' }], unerreichbar: [] },
    }, jetzt);
    const db: Array<{ id: string; title: string; status: string; detectionMethod?: string }> = [{ id: 'p-alt', title: 'alt', status: 'logged', detectionMethod: 'infrastruktur-bestand:platte:anderer:/' }, { id: 'p-weg', title: 'weg', status: 'logged', detectionMethod: 'infrastruktur-bestand:container-unhealthy:dockerhost:alt' }];
    const geloest: string[] = [];
    const z = { liste: async () => db, anlegen: async (d: { title: string; detectionMethod: string }) => { const id = `p${db.length}`; db.push({ id, title: d.title, status: 'logged', detectionMethod: d.detectionMethod }); return id; }, loese: async (id: string) => { geloest.push(id); } };
    // dockerhost mit Erfassungsfehler → nichts von ihm als gelöst markieren
    const r1 = await befundeAlsProblems(a, z, { docId: 'd', datum: 'heute' }, { hosts: new Set(), alle: false });
    expect(r1.neu.length).toBe(2); // unhealthy + Platte; Sicherung und „Nicht erfasst“ nicht
    expect(db.filter(p => p.title.includes('Sicherung'))).toEqual([]);
    expect(geloest).toEqual([]);
    const r2 = await befundeAlsProblems(a, z, { docId: 'd', datum: 'heute' }, { hosts: new Set(['dockerhost']), alle: false });
    expect(r2).toMatchObject({ neu: [], bekannt: 2 });
    expect(geloest).toEqual(['p-weg']); // anderer Host nicht erfasst → p-alt bleibt
  });

  it('v1770 — Dubletten (Realfall 07.11.: Liste bei 1000 abgeschnitten) werden geschlossen; das älteste zählt, auch ein geschlossenes', async () => {
    const { befundeAlsProblems } = await import('./befund-problems.js');
    const a = auffaelligkeiten({ hosts: [host({ zugang: 'pve', updates: { anzahl: 45, sicherheit: 3 } })], vms: [], proxy: [] }, jetzt);
    const M = 'infrastruktur-bestand:';
    const db = [
      { id: 'u1', title: 'pve', status: 'logged', detectionMethod: `${M}updates:pve` }, { id: 'u2', title: 'pve', status: 'logged', detectionMethod: `${M}updates:pve` }, { id: 'u3', title: 'pve', status: 'logged', detectionMethod: `${M}updates:pve` },
      { id: 'g1', title: 'gl', status: 'closed', detectionMethod: `${M}grundlinie:probe-win25b:tls` }, { id: 'g2', title: 'gl', status: 'logged', detectionMethod: `${M}grundlinie:probe-win25b:tls` },
      { id: 's1', title: 'sig', status: 'logged', detectionMethod: `${M}grundlinie:probe-win25b:smb-signatur` },
    ];
    const geloest: string[] = []; const angelegt: string[] = [];
    const z = { liste: async () => db, anlegen: async (d: { detectionMethod: string }) => { angelegt.push(d.detectionMethod); return 'neu'; }, loese: async (id: string) => { geloest.push(id); } };
    const r = await befundeAlsProblems(a, z, { docId: 'd', datum: 'heute' }, { hosts: new Set(['pve', 'probe-win25b']), alle: false });
    expect(r.dubletten).toEqual(['u2', 'u3', 'g2']);
    expect(angelegt).toEqual([]); // updates:pve ist bekannt (u1), nichts neu
    expect(r.bekannt).toBe(1);
    // Grundlinie greift jetzt: s1 verschwunden → gelöst; g1 bleibt geschlossen
    expect(r.geloest).toEqual(['s1']);
  });
});

describe('Cloudflare (Owner 22.10.: öffentliche Domains)', () => {
  it('Domain ↔ DNS-Eintrag, Wildcard, außerhalb der Zonen; Befund ohne Eintrag', async () => {
    const { domainsMitDns, dnsText } = await import('./bericht.js');
    const proxy = [{ domains: ['chat.3033.at'], forwardHost: '192.168.1.211', forwardPort: 8008 }, { domains: ['neu.3033.at'], forwardHost: '192.168.1.211', forwardPort: 81 }, { domains: ['strom.dohnal.local'], forwardHost: '192.168.1.211', forwardPort: 3070 }, { domains: ['x.wild.at'], forwardHost: 'h', forwardPort: 1 }];
    const dns = [{ fqdn: 'chat.3033.at', typ: 'A', inhalt: '84.1.2.3', proxied: true, zone: '3033.at' }, { fqdn: '*.wild.at', typ: 'CNAME', inhalt: 'wild.at', proxied: false, zone: 'wild.at' }, { fqdn: '3033.at', typ: 'MX', inhalt: 'mail', zone: '3033.at' }];
    const s = domainsMitDns(proxy, dns);
    expect(s.map(dnsText)).toEqual(['Cloudflare Proxy: A 84.1.2.3', 'Cloudflare-Zone 3033.at, kein Eintrag', 'nicht in Cloudflare', 'Cloudflare nur DNS: CNAME wild.at (Wildcard)']);
    const a = auffaelligkeiten({ hosts: [], vms: [], proxy, dns }, jetzt);
    expect(a.map(x => x.text)).toEqual(['neu.3033.at: NPM-Eintrag vorhanden, aber kein DNS-Eintrag in der Cloudflare-Zone 3033.at']);
    expect(a[0]!.schluessel).toBe('proxy-dns:neu.3033.at');
  });
});

describe('I8 3b-4 Windows-Überwachung — Befunde und Problems', () => {
  it('Dienste, Ereignisse, Zertifikate: Schwellen und Selbstbeender', async () => {
    const { ueberwachungsBefunde } = await import('./bericht.js');
    const a = ueberwachungsBefunde('vm137', {
      dienste: [{ name: 'spice-agent', anzeige: 'Spice Agent', zustand: 'Stopped', exitCode: 0 }, { name: 'GoogleUpdaterService157.0.8089.0', anzeige: 'x', zustand: 'Stopped', exitCode: 0 },
        { name: 'MSSQLSERVER', anzeige: 'SQL Server (MSSQLSERVER)', zustand: 'Stopped', exitCode: 1067 }, { name: 'W32Time', anzeige: 'Windows-Zeitgeber', zustand: 'Stopped', exitCode: 0 }],
      ereignisse: [{ quelle: 'VSS', anzahl: 25, kritisch: 0, id: 8194 }, { quelle: 'Volsnap', anzahl: 1, kritisch: 0, id: 36 }, { quelle: 'Kernel-Power', anzahl: 2, kritisch: 1, id: 41 }],
      zertifikate: [{ betreff: 'CN=localhost', fingerabdruck: 'AAAA1111BBBB2222', ablauf: '2027-04-25T00:00:00.000Z' }, { betreff: 'CN=sql', fingerabdruck: 'CCCC3333DDDD4444', ablauf: '2026-10-25T00:00:00.000Z' }, { betreff: 'CN=web', fingerabdruck: 'EEEE5555FFFF6666', ablauf: '2026-11-10T00:00:00.000Z' }],
    }, jetzt);
    const m = Object.fromEntries(a.map(x => [x.schluessel, `${x.schwere}|${x.text}`]));
    expect(Object.keys(m).some(k => /spice|Google/.test(k))).toBe(false);
    expect(m['ueberwachung:vm137:dienst:MSSQLSERVER']).toBe('mittel|Dienst SQL Server (MSSQLSERVER) (MSSQLSERVER) läuft nicht (Start automatisch, Exit-Code 1067)');
    expect(m['ueberwachung:vm137:dienst:W32Time']).toMatch(/^niedrig\|/);
    expect(m['ueberwachung:vm137:ereignis:VSS']).toBe('mittel|Ereignisprotokoll: 25 Fehler von VSS in 24 h (Ereignis-ID 8194)');
    expect(m['ueberwachung:vm137:ereignis:Volsnap']).toMatch(/^niedrig\|/);
    expect(m['ueberwachung:vm137:ereignis:Kernel-Power']).toMatch(/^mittel\|Ereignisprotokoll: 1 kritische Ereignisse/);
    expect(m['ueberwachung:vm137:zertifikat:AAAA1111BBBB2222']).toBeUndefined(); // 185 Tage
    expect(m['ueberwachung:vm137:zertifikat:CCCC3333DDDD4444']).toBe('hoch|Zertifikat CN=sql läuft in 2 Tagen ab (2026-10-25, Fingerabdruck CCCC3333DDDD…)');
    expect(m['ueberwachung:vm137:zertifikat:EEEE5555FFFF6666']).toMatch(/^mittel\|Zertifikat CN=web läuft in 18 Tagen ab/);
  });
  it('wiederkehrend: gelöstes Problem blockiert nicht, geschlossenes schon; stündlicher Lauf gleicht nur seine Kategorien ab', async () => {
    const { befundeAlsProblems } = await import('./befund-problems.js');
    const { ueberwachungsBefunde } = await import('./bericht.js');
    const M = 'infrastruktur-bestand:';
    const auff = ueberwachungsBefunde('vm137', { dienste: [{ name: 'MSSQLSERVER', anzeige: 'SQL', zustand: 'Stopped', exitCode: 1067 }, { name: 'Spooler', anzeige: 'Druck', zustand: 'Stopped', exitCode: 5 }] }, jetzt);
    const db = [
      { id: 'sql-alt', title: 't', status: 'resolved', detectionMethod: `${M}ueberwachung:vm137:dienst:MSSQLSERVER` },
      { id: 'spool', title: 't', status: 'closed', detectionMethod: `${M}ueberwachung:vm137:dienst:Spooler` },
      { id: 'dns-offen', title: 't', status: 'logged', detectionMethod: `${M}ueberwachung:vm137:dienst:Dnscache` },
      { id: 'lizenz', title: 't', status: 'logged', detectionMethod: `${M}lizenz:vm137` },
    ];
    const angelegt: string[] = []; const geloest: string[] = [];
    const z = { liste: async () => db, anlegen: async (d: { detectionMethod: string }) => { angelegt.push(d.detectionMethod); return `neu${angelegt.length}`; }, loese: async (id: string) => { geloest.push(id); } };
    const r = await befundeAlsProblems(auff, z, { docId: 'stündlich', datum: 'jetzt' }, { hosts: new Set(['vm137']), alle: false, kategorien: new Set(['ueberwachung', 'platte']) });
    expect(angelegt).toEqual([`${M}ueberwachung:vm137:dienst:MSSQLSERVER`]); // wieder ausgefallen → neues Problem
    expect(r.bekannt).toBe(1); // Spooler: vom Owner geschlossen
    expect(geloest).toEqual(['dns-offen']); // lizenz:vm137 gehört nicht zum stündlichen Lauf
  });
});
