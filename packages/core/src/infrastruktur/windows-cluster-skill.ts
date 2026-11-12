/**
 * I8d — Skill „windows_cluster“: Failover-Cluster und Vorbereitung für SQL Server über feste Bausteine (windows-cluster.ts). Alles außer
 * status/gmsa_pruefen nur als Schritt eines freigegebenen Changes. Kennwörter liest der Skill im Tresor und gibt sie nur über die
 * Standardeingabe weiter.
 */
import { Skill } from '@alfred/skills';
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { kodiert, adErgebnis, clixmlFehler, KONTO_FREI } from './windows-ad.js';
import {
  firewallLesenSkript, firewallLesenText, type FirewallLesen, pruefeSamKonto, spnLesenSkript, pruefePfad, verzeichnisLesenSkript, verzeichnisText,
  pruefeDiagnose, diagnoseEntfernenSkript, pruefeFilter, firewallFilterSkript, pruefeAktiv, firewallAktivSkript,
  defenderStatusSkript, type DefenderStatus, haengendeBeendenSkript, pruefeHaengend, defenderAgentAusnahmeSkript, QEMU_GA_PROZESSE, QEMU_GA_PFADE, defenderProtokollSkript, type DefenderProtokoll, pruefeMuster, pruefeFehlalarm, defenderAusnahmeSkript, DEFENDER_FEHLALARME,
  ereignisseSkript, type ClusterEreignisse, pruefeEreignisIds, stabilMessSkript, stabilitaetBewerten, type StabilMessung,
  clusterStatusSkript, clusterStatusText, gmsaPruefenSkript, pruefePlatten, plattenSkript, pruefeFeatures, featuresSkript, pruefeFirewall, firewallSkript,
  firewallEntfernenSkript, pruefeFreigabe, freigabeSkript, freigabeEntfernenSkript, pruefeGmsa, gmsaSkript, gmsaEntfernenSkript, pruefeComputerobjekt,
  computerobjektSkript, computerobjektEntfernenSkript, pruefeSpn, spnSkript, pruefeKnoten, validierenSkript, pruefeCluster, clusterAnlegenSkript,
  clusterEntfernenSkript, pruefeZeuge, zeugeSkript, systemplatteSkript, pruefeVerbindung, verbindungSkript, verbindungText, FEATURES, type ClusterStatus, type Platte,
} from './windows-cluster.js';

export interface WindowsClusterDeps {
  skript: (zugang: string, befehl: string, eingabe: string | undefined, timeoutMs: number, zweck: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  tresor?: { namen: () => Promise<Set<string>>; lies: (name: string, wofuer: string) => Promise<string> };
  /** v1814 — netzlose VMs (Offline-Root) über den QEMU-Gastagenten des Proxmox-Skills */
  gast?: (vmid: number, vmName: string, skript: string, eingabe: string | undefined, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;
  protokoll?: (msg: string, daten: Record<string, unknown>) => void;
  schlafe?: (ms: number) => Promise<void>;
}

/** lesend, auch außerhalb eines Changes */
export const CLUSTER_LESEND = new Set(['status', 'gmsa_pruefen', 'verbindung_pruefen', 'firewall_lesen', 'spn_lesen', 'verzeichnis_lesen', 'ereignisse_status', 'stabilitaet_pruefen', 'defender_status', 'defender_protokoll']);
const NUR_IM_CHANGE = new Set(['systemplatte_erweitern', 'platten_einrichten', 'features_installieren', 'firewall_regel', 'firewall_regel_entfernen', 'freigabe_anlegen', 'freigabe_entfernen',
  'gmsa_anlegen', 'gmsa_entfernen', 'computerobjekt_vorbereiten', 'computerobjekt_entfernen', 'spn_setzen', 'spn_entfernen', 'cluster_validieren', 'cluster_anlegen',
  'cluster_entfernen', 'zeuge_setzen', 'firewall_filter_setzen', 'firewall_regel_aktiv', 'diagnose_entfernen', 'defender_fehlalarm_zulassen', 'defender_fehlalarm_entfernen', 'defender_agent_ausnahme_setzen', 'defender_agent_ausnahme_entfernen', 'haengende_bausteine_beenden']);
/** am DC mit dem Domänen-Administrator (Tresor Standard win-<zugang>-admin, wie windows_ad grundstruktur) */
const AM_DC = new Set(['gmsa_anlegen', 'gmsa_entfernen', 'computerobjekt_vorbereiten', 'computerobjekt_entfernen', 'spn_setzen', 'spn_entfernen']);
/** als Domänenkonto <NETBIOS>\alfred mit Kennwort-Anmeldung (Doppel-Hop) — konto_tresor ist Pflicht */
const ALS_ALFRED = new Set(['cluster_validieren', 'cluster_anlegen', 'cluster_entfernen', 'zeuge_setzen']);
const ZUGANG = /^[a-z0-9][a-z0-9.-]{0,62}$/i;
/** v1814 — diese Aktionen auch für netzlose VMs über den Gastagenten (vmid + vm_name statt zugang) */
const GAST_ERLAUBT = new Set(['status', 'platten_einrichten', 'systemplatte_erweitern', 'defender_status', 'defender_protokoll', 'defender_fehlalarm_zulassen', 'defender_fehlalarm_entfernen', 'defender_agent_ausnahme_setzen', 'defender_agent_ausnahme_entfernen']);

export class WindowsClusterSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'windows_cluster',
    category: 'infrastructure',
    description:
      'Windows-Failover-Cluster und Vorbereitung für SQL Server (I8d) über feste PowerShell-Bausteine auf Windows-Fernzugängen (zugang = Name des Fernzugangs). '
      + 'NETZLOSE VMs (v1814, z. B. Offline-Root pkiroot01): status, platten_einrichten und systemplatte_erweitern auch mit vmid + vm_name statt zugang — über den QEMU-Gastagenten, ohne Netz. '
      + 'status (lesend, auch außerhalb von Changes): Features, Volumes mit Blockgröße, SMB-Freigaben, Cluster mit Knoten, Quorum/Zeuge und Ressourcen — als Prüfung z. B. erwartet „Cluster sqlcl01“, „sql02 Up“, „FileShareWitness“, „L: SQL-Log 20 GB (64 KB)“, „SQLBackup$=S:\\SQLBackup“. '
      + 'verbindung_pruefen (lesend, auch außerhalb von Changes; zugang, ziel = Hostname/IPv4, port Standard 443, url optional = https-Adresse auf diesem ziel für eine HEAD-Anfrage) — DNS, TCP (8 s) und HTTPS vom Windows-Rechner aus; Ergebnis „Verbindung <ziel>:<port> ok (…)“ bzw. „NICHT erreichbar: …“ — als Prüfung eines warten-Schritts mit erwartet „ok“, z. B. nach dem Öffnen einer Firewall-Freigabe (das Gateway übernimmt neue Regeln mit Verzögerung). '
      + 'gmsa_pruefen (lesend; zugang = Mitglied, name) — Test-ADServiceAccount als Computerkonto, Ergebnis „gMSA <name> nutzbar“. '
      + 'ereignisse_status (lesend; zugang, event_ids Standard [1650], minuten optional) — Cluster-Ereignisse mit RecordId. '
      + 'stabilitaet_pruefen (lesend; zugaenge = alle Knoten z. B. [sql01, sql02], dauer_s Standard 900 (300–1800), intervall_s Standard 60, ag optional z. B. ag01, event_ids Standard [1650]) — beobachtet die volle Dauer: je Messung neue Ereignisse seit Beginn, Knoten Up, alle Ressourcen Online, lokal AG HEALTHY/CONNECTED und Datenbanken SYNCHRONIZED; Ergebnis „CLUSTER_STABLE“ nur ohne neues Ereignis und ohne Lücke, sonst „FAIL“ bzw. „UNKNOWN“ (Pflicht nach Firewall-/Netzänderungen an Clustern; Schritt-zeitlimitS ≥ dauer_s + 300). '
      + 'NUR im Change, NUR netzlose VMs (vmid + vm_name): defender_agent_ausnahme_setzen ↔ defender_agent_ausnahme_entfernen — befristete Defender-Ausnahme für den QEMU-Gastagenten (Prozesse qemu-ga.exe + gspawn-win64-helper.exe, Pfad nur Helfer-Datei; feste Einträge, Echtzeitschutz bleibt an; Owner-Entscheidung 12.11., weil Defender die Baustein-Befehlszeilen trotz ThreatID-Allow blockiert). '
      + 'NUR im Change: haengende_bausteine_beenden (zugang, minuten Standard 60, mindestens 30) — beendet nur powershell.exe des eigenen Kontos mit Alfred-Baustein-Befehlszeile (alfred-s-…ps1 oder -EncodedCommand), die älter sind (ohne Rückweg). '
      + 'defender_protokoll (lesend; zugang oder vmid + vm_name, muster optional = Regex) — Treffer aus Defenders Diagnoseprotokoll MPLog (letzte 4000 Zeilen; zeigt auch Blockaden ohne Ereignis). '
      + 'defender_status (lesend; zugang oder vmid + vm_name) — Echtzeitschutz, Signaturstand, gesetzte Erkennungs-Ausnahmen, Erkennungen 1116/1117 der letzten 7 Tage, Defender-Protokoll der letzten 2 Tage (Verhalten, ASR, Blockaden, Konfiguration) und Defenders Bedrohungsliste. '
      + `defender_fehlalarm_zulassen (zugang oder vmid + vm_name, threat_id NUR ${Object.keys(DEFENDER_FEHLALARME).join('/')} = Fehlalarm auf Alfreds Baustein-Befehlszeilen, Owner-Entscheidung 12.11.) — Aktion Allow für genau diese Erkennung (wird weiter protokolliert), Echtzeitschutz bleibt an; Rückweg defender_fehlalarm_entfernen (gleiche Parameter). `
      + 'firewall_lesen (lesend; zugang, nur_any optional true) — alle aktiven eingehenden Erlauben-Regeln mit regel (Name/InstanceID), Anzeige, Gruppe, Protokoll, lokalen Ports und Gegenstellen (von). '
      + 'spn_lesen (lesend; zugang = Mitglied oder DC, konto = sAMAccountName z. B. gmsa-sqleng$) — servicePrincipalName des Kontos (als Computerkonto gelesen). '
      + 'verzeichnis_lesen (lesend; zugang, pfad = lokaler Pfad z. B. S:\\SQLBackup) — Dateien rekursiv mit Größe/Zeit (neueste 500) und Summe. '
      + 'NUR als Schritte freigegebener Changes: systemplatte_erweitern (zugang) — C: auf die volle Plattengröße in Proxmox; liegt die Wiederherstellungspartition dahinter, wandert WinRE nach C: und nur diese Partition wird entfernt (ohne Rückweg; Ergebnis „C: … 63 → 100 GB“). platten_einrichten (zugang, platten [{groesse_gb, laufwerk, name, block_kb 4|64}] — rohe Platten über die Größe zugeordnet, Größen verschieden; SQL-Daten/Log/TempDB 64 KB; ein CD-Laufwerk auf dem Buchstaben weicht aus; ohne Rückweg). '
      + `features_installieren (zugang, features aus ${[...FEATURES].join(', ')}; Neustart falls nötig, wartet bis 20 min; ohne Rückweg). `
      + 'firewall_regel (zugang, name, protokoll TCP|UDP|ICMPv4, ports, von = exakte IPv4/Netze) ↔ firewall_regel_entfernen (zugang, name) — eingehend, Profil Any, Name „Alfred <name>“. '
      + 'freigabe_anlegen (zugang, name z. B. Witness$, pfad z. B. W:\\Witness, vollzugriff/aendern = Konten NETBIOS\\name, Computer/gMSA mit $) ↔ freigabe_entfernen (zugang, name; Ordner und Daten bleiben) — NTFS ohne Vererbung, nur SYSTEM, Administratoren und die Konten. '
      + 'Am DC mit dem Domänen-Administrator (konto_tresor optional, Standard win-<zugang>-admin): gmsa_anlegen (zugang = DC, name ≤14 ohne $, berechtigte = Computer, ou Standard Dienstkonten) ↔ gmsa_entfernen; '
      + 'computerobjekt_vorbereiten (zugang = DC, name = CNO/VCO, ou Standard Server, vollzugriff = sAMAccountNames mit Vollzugriff nur auf DIESES Objekt, z. B. CNO sqlcl01$ für den Listener-VCO) — deaktiviert vorab angelegt ↔ computerobjekt_entfernen (nur deaktivierte, von Alfred angelegte); '
      + 'spn_setzen (zugang = DC, konto = sAMAccountName z. B. gmsa-sqleng$, spns z. B. MSSQLSvc/sql01.ad.3033.at:1433) ↔ spn_entfernen — bricht ab, wenn ein SPN an einem anderen Konto hängt. '
      + 'Als Domänenkonto <NETBIOS>\\alfred per Kennwort-Anmeldung (geplante Aufgabe, löst den Doppel-Hop; konto_tresor Pflicht = Tresor-Eintrag mit dem Kennwort des Domänenkontos alfred, z. B. win-dc01-admin): '
      + 'cluster_validieren (zugang = ein Knoten, knoten) — Test-Cluster Inventory/Network/System Configuration, Ergebnis „Validierung bestanden|Warnungen|fehlgeschlagen“ (ohne Rückweg); '
      + 'cluster_anlegen (zugang = ein Knoten, name = CNO, knoten, ip) — ohne Speicher, AD+DNS ↔ cluster_entfernen (zugang, name; CNO bleibt deaktiviert im AD); '
      + 'zeuge_setzen (zugang = Knoten, freigabe = UNC \\\\fs01.ad.3033.at\\Witness$ oder ohne_zeuge true) — Ergebnis nennt den vorherigen Zustand (Rückweg: zeuge_setzen mit dem vorherigen Pfad bzw. ohne_zeuge). '
      + 'firewall_filter_setzen (zugang, regel = Name aus firewall_lesen, von = IPv4/Netze) — Gegenstellen einer BESTEHENDEN eingehenden Regel einschränken; Ergebnis nennt „vorher“ (Rückweg: firewall_filter_setzen mit von = vorher, „Any“ nur dafür). '
      + 'firewall_regel_aktiv (zugang, regel = Name aus firewall_lesen, aktiv true|false) — bestehende Regel ein-/ausschalten (Core Networking ausgeschlossen); Ergebnis nennt „vorher“ (Rückweg: firewall_regel_aktiv mit aktiv = vorher). '
      + 'diagnose_entfernen (zugang, pfad = C:\\Windows\\Temp\\alfred-<name>) — von Alfred angelegten Diagnoseordner löschen (ohne Rückweg). '
      + 'Ausführungskonto optional wählbar: ausfuehrungskonto („name“ oder „NETBIOS\\name“) mit konto_tresor (fremde Domäne, umbenannter Administrator). '
      + 'Reihenfolge Cluster: Features (Failover-Clustering, RSAT-Clustering-PowerShell) auf allen Knoten → Firewall-Regeln zwischen den Knoten → CNO vorab (vollzugriff alfred) → cluster_validieren → cluster_anlegen → Zeugen-Freigabe auf fs01 mit vollzugriff <NETBIOS>\\<CNO>$ → zeuge_setzen.',
    riskLevel: 'admin',
    version: '1.0.0',
    // v1811 — Realfall 12.11.: stabilitaet_pruefen (bis 1800 s) brach bei direkten Aufrufen am Standard von 30 s ab
    timeoutMs: 2_400_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...CLUSTER_LESEND, ...NUR_IM_CHANGE] },
        zugang: { type: 'string', description: 'Name des Windows-Fernzugangs (z. B. sql01, fs01, dc01)' },
        platten: { type: 'array', items: { type: 'object', properties: { groesse_gb: { type: 'number' }, laufwerk: { type: 'string' }, name: { type: 'string' }, block_kb: { type: 'number' } } } },
        features: { type: 'array', items: { type: 'string' } },
        name: { type: 'string', description: 'Regel-, Freigabe-, gMSA-, Computer- oder Clustername' },
        protokoll: { type: 'string' }, ports: { type: 'array', items: { type: 'string' } }, von: { type: 'array', items: { type: 'string' } },
        pfad: { type: 'string' }, vollzugriff: { type: 'array', items: { type: 'string' } }, aendern: { type: 'array', items: { type: 'string' } },
        berechtigte: { type: 'array', items: { type: 'string' } }, ou: { type: 'string' },
        konto: { type: 'string' }, spns: { type: 'array', items: { type: 'string' } },
        knoten: { type: 'array', items: { type: 'string' } }, ip: { type: 'string' },
        regel: { type: 'string', description: 'firewall_filter_setzen: Regelname (Name/InstanceID aus firewall_lesen)' }, nur_any: { type: 'boolean' }, zugaenge: { type: 'array', items: { type: 'string' } }, event_ids: { type: 'array', items: { type: 'number' } }, minuten: { type: 'number' }, dauer_s: { type: 'number' }, intervall_s: { type: 'number' }, ag: { type: 'string' }, aktiv: { type: 'boolean', description: 'firewall_regel_aktiv: Zielzustand' },
        freigabe: { type: 'string' }, ohne_zeuge: { type: 'boolean' }, ziel: { type: 'string' }, url: { type: 'string' },
        konto_tresor: { type: 'string', description: 'Tresor-Eintrag mit dem Kennwort (DC: Domänen-Administrator, Cluster: Domänenkonto alfred)' },
        threat_id: { type: 'string', description: 'defender_fehlalarm_*: nur die fest hinterlegte Fehlalarm-ID 2147942983' },
        vmid: { type: 'number', description: 'netzlose VM (Offline-Root): VMID statt zugang — nur status, platten_einrichten, systemplatte_erweitern' }, vm_name: { type: 'string' },
        ausfuehrungskonto: { type: 'string', description: 'optional: Ausführungskonto „name“ oder „NETBIOS\\name“ (Standard am DC Administrator, für Cluster alfred) — z. B. fremde Domäne' },
      },
      required: ['action'],
    },
  };

  constructor(private readonly d: WindowsClusterDeps) { super(); }

  async execute(input: Record<string, unknown>, context?: SkillContext): Promise<SkillResult> {
    const action = String(input.action ?? '');
    let zugang = String(input.zugang ?? '').trim().toLowerCase();
    if (!CLUSTER_LESEND.has(action) && !NUR_IM_CHANGE.has(action)) return { success: false, error: `Unbekannte Aktion ${action}` };
    if (NUR_IM_CHANGE.has(action) && (context as { ausChange?: boolean } | undefined)?.ausChange !== true) return { success: false, error: `${action} läuft nur als Schritt eines freigegebenen Changes` };
    if (input.vmid !== undefined) {
      if (zugang) return { success: false, error: 'entweder zugang ODER vmid + vm_name' };
      if (!GAST_ERLAUBT.has(action)) return { success: false, error: `${action} nur über einen Fernzugang; über den Gastagenten gehen nur ${[...GAST_ERLAUBT].join(', ')}` };
      const vmid = Number(input.vmid); const name = String(input.vm_name ?? '').trim();
      if (!Number.isInteger(vmid) || vmid < 100 || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) return { success: false, error: 'vmid und vm_name der netzlosen VM angeben' };
      zugang = `gast:${vmid}:${name}`;
    } else if (!ZUGANG.test(zugang)) return { success: false, error: 'zugang: Name des Windows-Fernzugangs' };
    try {
      const kw = AM_DC.has(action) ? await this.kennwort(input.konto_tresor ?? `win-${zugang}-admin`, `${action} auf ${zugang} (Domänen-Administrator)`)
        : ALS_ALFRED.has(action) ? await this.kennwort(input.konto_tresor, `${action} auf ${zugang} (Domänenkonto alfred)`) : undefined;
      const ein = kw ? { kennwort: kw } : undefined;
      // v1789 — optionales Ausführungskonto; wird nur bei Aktionen mit Kennwort in die Skriptparameter übernommen
      const k = String(input.ausfuehrungskonto ?? '').trim();
      if (k && !KONTO_FREI.test(k)) throw new Error('ausfuehrungskonto: „name“ oder „NETBIOS\\name“');
      const mk = <T extends object>(p: T): T => (k && kw ? Object.assign({}, p, { ausKonto: k }) : p);
      const fehler = (f: unknown) => { if (typeof f === 'string') throw new Error(f); return f; };
      switch (action) {
        case 'status': { const s = await this.status(zugang); return { success: true, data: s, display: clusterStatusText(s) }; }
        case 'verbindung_pruefen': {
          const p = fehler(pruefeVerbindung(input)) as Parameters<typeof verbindungSkript>[0];
          const r = await this.lauf<Parameters<typeof verbindungText>[0]>(zugang, verbindungSkript(p), 'Verbindung prüfen', 50_000);
          return { success: true, data: r, display: verbindungText(r) };
        }
        case 'gmsa_pruefen': {
          const g = fehler(pruefeGmsa({ name: input.name, berechtigte: 'x' })) as { name: string };
          const r = await this.lauf<{ name: string; nutzbar: boolean }>(zugang, gmsaPruefenSkript({ name: g.name }), 'gMSA prüfen', 240_000);
          return { success: true, data: r, display: r.nutzbar ? `gMSA ${r.name} nutzbar auf ${zugang}` : `gMSA ${r.name} auf ${zugang} NICHT nutzbar (Kennwort nicht abrufbar)` };
        }
        case 'ereignisse_status': {
          const ids = fehler(pruefeEreignisIds(input.event_ids)) as number[];
          const min = input.minuten === undefined ? 60 : Number(input.minuten);
          if (!Number.isInteger(min) || min < 1 || min > 10080) throw new Error('minuten: 1–10080');
          const r = await this.lauf<ClusterEreignisse>(zugang, ereignisseSkript({ ids, minuten: min }), 'Cluster-Ereignisse', 120_000);
          return { success: true, data: r, display: `${r.rechner}: ${r.anzahl} Ereignisse ${ids.join(',')} in ${min} min (bis ${r.jetzt})${r.ereignisse.length ? `:\n${r.ereignisse.slice(0, 20).map(e => `${e.zeit} ${e.id} ${e.text}`).join('\n')}` : ''}` };
        }
        case 'stabilitaet_pruefen': return await this.stabilitaet(input);
        case 'defender_agent_ausnahme_setzen': case 'defender_agent_ausnahme_entfernen': {
          if (!zugang.startsWith('gast:')) return { success: false, error: 'nur für netzlose VMs über den Gastagenten (vmid + vm_name) — Owner-Entscheidung 12.11.' };
          const weg = action === 'defender_agent_ausnahme_entfernen';
          const r = await this.lauf<{ rechner: string; vorher: { prozesse: string[]; pfade: string[] }; nachher: { prozesse: string[]; pfade: string[] } }>(zugang, defenderAgentAusnahmeSkript({ entfernen: weg }), weg ? 'Defender-Agent-Ausnahme entfernen' : 'Defender-Agent-Ausnahme setzen', 180_000);
          return { success: true, data: r, display: `✅ ${r.rechner}: Defender-Ausnahme für den QEMU-Gastagenten ${weg ? 'entfernt' : 'gesetzt'} (Prozesse ${QEMU_GA_PROZESSE.join(', ')}; Pfad ${QEMU_GA_PFADE.join(', ')}); nachher Prozesse ${r.nachher.prozesse.join(', ') || 'keine'}, Pfade ${r.nachher.pfade.join(', ') || 'keine'}; Echtzeitschutz an${weg ? '' : ' — Rückweg defender_agent_ausnahme_entfernen'}` };
        }
        case 'defender_protokoll': {
          const m = fehler(pruefeMuster(input.muster)) as { muster?: string };
          const r = await this.lauf<DefenderProtokoll>(zugang, defenderProtokollSkript(m), 'Defender-Diagnoseprotokoll', 120_000);
          return { success: true, data: r, display: `${r.rechner}: ${r.datei || 'kein MPLog'}${r.geaendert ? ` (geändert ${r.geaendert}, ${r.zeilen} Zeilen)` : ''}; Treffer ${r.treffer.length}:\n${r.treffer.join('\n') || '—'}` };
        }
        case 'defender_status': {
          const r = await this.lauf<DefenderStatus>(zugang, defenderStatusSkript(), 'Defender-Status', 120_000);
          return { success: true, data: r, display: `${r.rechner}: Echtzeitschutz ${r.echtzeit ? 'an' : 'AUS'}, Signaturen ${r.signaturen}; Ausnahmen ${r.ausnahmen.length ? r.ausnahmen.map(x => `${x.id}=${x.aktion}`).join(', ') : 'keine'}; Erkennungen 7 Tage: ${r.ereignisse.length ? r.ereignisse.map(x => `${x.zeit} ${x.id} ${x.name}`).join(' | ') : 'keine'}`
            + `\nDefender-Protokoll 2 Tage (Erkennung/Verhalten/ASR/Blockade/Konfiguration): ${r.verlauf?.length ? r.verlauf.map(x => `${x.zeit} ${x.id} ${x.text}`).join(' | ') : 'nichts'}`
            + `\nBedrohungsliste: ${r.erkennungen?.length ? r.erkennungen.map(x => `${x.zeit} ${x.id} ${x.aktion} ${x.prozess} ${x.quelle}`).join(' | ') : 'leer'}` };
        }
        case 'defender_fehlalarm_zulassen': case 'defender_fehlalarm_entfernen': {
          const f = fehler(pruefeFehlalarm(input.threat_id)) as { id: string };
          const weg = action === 'defender_fehlalarm_entfernen';
          const r = await this.lauf<{ rechner: string; id: string; vorher: string[]; nachher: string[] }>(zugang, defenderAusnahmeSkript({ id: f.id, entfernen: weg }), weg ? 'Defender-Ausnahme entfernen' : 'Defender-Ausnahme setzen', 180_000);
          return { success: true, data: r, display: `✅ ${r.rechner}: Defender ${DEFENDER_FEHLALARME[f.id]} (${f.id}) ${weg ? 'Ausnahme entfernt' : 'auf Allow (wird weiter protokolliert)'}; vorher ${r.vorher.join(', ') || 'keine'} → nachher ${r.nachher.join(', ') || 'keine'}; Echtzeitschutz an${weg ? '' : ` — Rückweg defender_fehlalarm_entfernen threat_id ${f.id}`}` };
        }
        case 'firewall_lesen': {
          const nurAny = input.nur_any === true;
          const r = await this.lauf<FirewallLesen>(zugang, firewallLesenSkript(nurAny ? { nur_any: true } : {}), 'Firewall lesen', 180_000);
          return { success: true, data: r, display: firewallLesenText(r, nurAny) };
        }
        case 'spn_lesen': {
          const p = fehler(pruefeSamKonto(input.konto)) as { konto: string };
          const r = await this.lauf<{ konto: string; dn: string; spns: string[] }>(zugang, spnLesenSkript(p), 'SPN lesen', 180_000);
          return { success: true, data: r, display: `SPNs ${r.konto} (${r.dn}): ${r.spns.length ? r.spns.join(', ') : 'keine'}` };
        }
        case 'verzeichnis_lesen': {
          const p = fehler(pruefePfad(input.pfad)) as { pfad: string };
          const r = await this.lauf<Parameters<typeof verzeichnisText>[1]>(zugang, verzeichnisLesenSkript(p), 'Verzeichnis lesen', 180_000);
          return { success: true, data: r, display: verzeichnisText(zugang, r) };
        }
        case 'firewall_filter_setzen': {
          const p = fehler(pruefeFilter(input)) as { regel: string; von: string[] };
          const r = await this.lauf<{ regel: string; anzeige: string; vorher: string; nachher: string }>(zugang, firewallFilterSkript(p), 'Firewall-Filter setzen', 120_000);
          return { success: true, data: r, display: `✅ Firewall ${zugang}: ${r.anzeige} [${r.regel}] von ${r.vorher} → ${r.nachher} — Rückweg firewall_filter_setzen regel ${r.regel} von ${r.vorher}` };
        }
        case 'firewall_regel_aktiv': {
          const p = fehler(pruefeAktiv(input)) as { regel: string; aktiv: boolean };
          const r = await this.lauf<{ regel: string; anzeige: string; gruppe: string; vorher: boolean; nachher: boolean }>(zugang, firewallAktivSkript(p), 'Firewall-Regel schalten', 120_000);
          const w = (b: boolean) => (b ? 'aktiv' : 'inaktiv');
          return { success: true, data: r, display: `✅ Firewall ${zugang}: ${r.anzeige} [${r.regel}] ${w(r.vorher)} → ${w(r.nachher)} — Rückweg firewall_regel_aktiv regel ${r.regel} aktiv ${r.vorher}` };
        }
        case 'haengende_bausteine_beenden': {
          const h = fehler(pruefeHaengend(input.minuten)) as { minuten: number };
          const r = await this.lauf<{ rechner: string; konto: string; beendet: { pid: number; start: string; befehl: string }[] }>(zugang, haengendeBeendenSkript(h), 'Hängende Baustein-Prozesse beenden', 120_000);
          return { success: true, data: r, display: `✅ ${r.rechner}: ${r.beendet.length ? `${r.beendet.length} hängende Baustein-Prozesse von ${r.konto} beendet: ${r.beendet.map(x => `PID ${x.pid} seit ${x.start}`).join(', ')}` : 'keine hängenden Baustein-Prozesse'} (älter als ${h.minuten} min)` };
        }
        case 'diagnose_entfernen': {
          const p = fehler(pruefeDiagnose(input.pfad)) as { pfad: string };
          const r = await this.lauf<{ pfad: string; zustand: string; mb?: number }>(zugang, diagnoseEntfernenSkript(p), 'Diagnoseordner entfernen', 120_000);
          return { success: true, data: r, display: `✅ ${zugang}: ${r.pfad} ${r.zustand}${r.mb !== undefined ? ` (${r.mb} MB)` : ''}` };
        }
        case 'platten_einrichten': {
          const platten = fehler(pruefePlatten(input.platten)) as Platte[];
          const r = await this.lauf<{ platten: Array<{ laufwerk: string; zustand: string; groesseGb: number; blockKb?: number }> }>(zugang, plattenSkript({ platten }), 'Platten einrichten', 900_000);
          return { success: true, data: r, display: `✅ Platten auf ${zugang}: ${r.platten.map(x => `${x.laufwerk}: ${x.zustand} ${x.groesseGb} GB${x.blockKb ? ` (${x.blockKb} KB)` : ''}`).join(', ')}` };
        }
        case 'systemplatte_erweitern': {
          const r = await this.lauf<{ vorherGb: number; nachherGb: number; freiGb: number; zustand: string; winre: string }>(zugang, systemplatteSkript(), 'Systemplatte erweitern', 600_000);
          return { success: true, data: r, display: `✅ C: auf ${zugang}: ${r.zustand}, ${r.vorherGb} → ${r.nachherGb} GB (${r.freiGb} GB frei); WinRE ${r.winre}` };
        }
        case 'features_installieren': {
          const features = fehler(pruefeFeatures(input.features)) as string[];
          const r = await this.lauf<{ installiert: string[]; neustart: boolean }>(zugang, featuresSkript({ features }), 'Windows-Features', 1_800_000);
          const s = r.neustart ? await this.warte(zugang, x => features.every(f => x.features?.[f]), 20 * 60_000) : await this.status(zugang);
          const fehlt = features.filter(f => !s.features?.[f]);
          if (fehlt.length) throw new Error(`nach der Installation fehlt: ${fehlt.join(', ')}`);
          return { success: true, data: { ...r, status: s }, display: `✅ Features auf ${zugang} installiert: ${features.join(', ')}${r.neustart ? ' (mit Neustart)' : ''}` };
        }
        case 'firewall_regel': {
          const p = fehler(pruefeFirewall(input)) as Parameters<typeof firewallSkript>[0];
          const r = await this.lauf<{ regel: string; zustand: string }>(zugang, firewallSkript(p), 'Firewall-Regel', 120_000);
          return { success: true, data: r, display: `✅ Firewall ${zugang}: ${r.regel} ${p.protokoll}${p.ports.length ? ` ${p.ports.join(',')}` : ''} von ${p.von.join(',')} (${r.zustand}) — Rückweg firewall_regel_entfernen name ${p.name}` };
        }
        case 'firewall_regel_entfernen': {
          const p = fehler(pruefeFirewall({ name: input.name, protokoll: 'ICMPv4', ports: [], von: '127.0.0.1' })) as { name: string };
          const r = await this.lauf<{ regel: string; zustand: string }>(zugang, firewallEntfernenSkript({ name: p.name }), 'Firewall-Regel entfernen', 120_000);
          return { success: true, data: r, display: `✅ Firewall ${zugang}: ${r.regel} ${r.zustand}` };
        }
        case 'freigabe_anlegen': {
          const p = fehler(pruefeFreigabe(input)) as Parameters<typeof freigabeSkript>[0];
          const r = await this.lauf<{ unc: string; zustand: string; rechte: string[] }>(zugang, freigabeSkript(p), 'SMB-Freigabe', 180_000);
          return { success: true, data: r, display: `✅ Freigabe ${r.unc} → ${p.pfad} (${r.zustand}); Rechte ${r.rechte.join(', ')}` };
        }
        case 'freigabe_entfernen': {
          const name = String(input.name ?? '').trim();
          fehler(pruefeFreigabe({ name, pfad: 'D:\\x', vollzugriff: 'X\\y' }));
          const r = await this.lauf<{ zustand: string }>(zugang, freigabeEntfernenSkript({ name }), 'SMB-Freigabe entfernen', 120_000);
          return { success: true, data: r, display: `✅ Freigabe ${name} auf ${zugang}: ${r.zustand}` };
        }
        case 'gmsa_anlegen': {
          const p = fehler(pruefeGmsa(input)) as Parameters<typeof gmsaSkript>[0];
          const r = await this.lauf<{ name: string; zustand: string; berechtigte: string[] }>(zugang, gmsaSkript(mk(p)), 'gMSA anlegen', 180_000, ein);
          return { success: true, data: r, display: `✅ gMSA ${r.name} (${r.zustand}); Kennwort abrufen dürfen: ${r.berechtigte.join(', ')} — Rückweg gmsa_entfernen name ${p.name}` };
        }
        case 'gmsa_entfernen': {
          const g = fehler(pruefeGmsa({ name: input.name, berechtigte: 'x' })) as { name: string };
          const r = await this.lauf<{ zustand: string }>(zugang, gmsaEntfernenSkript(mk({ name: g.name })), 'gMSA entfernen', 180_000, ein);
          return { success: true, data: r, display: `✅ gMSA ${g.name}: ${r.zustand}` };
        }
        case 'computerobjekt_vorbereiten': {
          const p = fehler(pruefeComputerobjekt(input)) as Parameters<typeof computerobjektSkript>[0];
          const r = await this.lauf<{ dn: string; zustand: string; vollzugriff: string[] }>(zugang, computerobjektSkript(mk(p)), 'Computerobjekt vorab anlegen', 180_000, ein);
          return { success: true, data: r, display: `✅ Computerobjekt ${r.dn} (${r.zustand})${r.vollzugriff.length ? `; Vollzugriff ${r.vollzugriff.join(', ')}` : ''} — Rückweg computerobjekt_entfernen name ${p.name}` };
        }
        case 'computerobjekt_entfernen': {
          const p = fehler(pruefeComputerobjekt({ name: input.name })) as { name: string };
          const r = await this.lauf<{ zustand: string }>(zugang, computerobjektEntfernenSkript(mk({ name: p.name })), 'Computerobjekt entfernen', 180_000, ein);
          return { success: true, data: r, display: `✅ Computerobjekt ${p.name}: ${r.zustand}` };
        }
        case 'spn_setzen': case 'spn_entfernen': {
          const p = fehler(pruefeSpn(input)) as Parameters<typeof spnSkript>[0];
          const weg = action === 'spn_entfernen';
          const r = await this.lauf<{ neu?: string[]; entfernt?: string[]; schon?: string[]; nichtVorhanden?: string[]; spns: string[] }>(zugang, spnSkript(mk(p), weg), weg ? 'SPN entfernen' : 'SPN setzen', 180_000, ein);
          return { success: true, data: r, display: `✅ SPNs an ${p.konto}: ${weg ? `entfernt ${(r.entfernt ?? []).join(', ') || 'keine'}` : `neu ${(r.neu ?? []).join(', ') || 'keine'}, schon ${(r.schon ?? []).join(', ') || 'keine'}`}; jetzt ${(r.spns ?? []).join(', ') || 'keine'}` };
        }
        case 'cluster_validieren': {
          const knoten = fehler(pruefeKnoten(input.knoten)) as string[];
          const r = await this.lauf<{ ergebnis: string; warnungen: string[]; bericht: string }>(zugang, validierenSkript(mk({ knoten })), 'Cluster-Validierung', 2_000_000, ein);
          this.d.protokoll?.('I8d Cluster validiert', { zugang, knoten, ergebnis: r.ergebnis });
          const text = `Validierung ${r.ergebnis} (${knoten.join(', ')})${r.warnungen.length ? `; Warnungen: ${r.warnungen.join(' | ').slice(0, 900)}` : ''}; Bericht ${r.bericht}`;
          if (r.ergebnis === 'fehlgeschlagen') return { success: false, error: text, data: r };
          return { success: true, data: r, display: `✅ ${text}` };
        }
        case 'cluster_anlegen': {
          const p = fehler(pruefeCluster(input)) as Parameters<typeof clusterAnlegenSkript>[0];
          const r = await this.lauf<{ name: string; zustand: string; knoten: string[] }>(zugang, clusterAnlegenSkript(mk(p)), 'Cluster anlegen', 1_400_000, ein);
          this.d.protokoll?.('I8d Cluster angelegt', { zugang, name: p.name, zustand: r.zustand });
          return { success: true, data: r, display: `✅ Cluster ${r.name} (${r.zustand}), ${p.ip}: ${r.knoten.join(', ')} — Rückweg cluster_entfernen name ${p.name}` };
        }
        case 'cluster_entfernen': {
          const name = String(input.name ?? '').trim().toLowerCase();
          fehler(pruefeComputerobjekt({ name }));
          const r = await this.lauf<{ zustand: string }>(zugang, clusterEntfernenSkript(mk({ name })), 'Cluster auflösen', 1_100_000, ein);
          return { success: true, data: r, display: `✅ Cluster ${name}: ${r.zustand}` };
        }
        case 'zeuge_setzen': {
          const p = fehler(pruefeZeuge(input)) as { freigabe?: string };
          const r = await this.lauf<{ vorher: string; vorherFreigabe: string; nachher: string }>(zugang, zeugeSkript(mk(p)), 'Cluster-Zeuge', 800_000, ein);
          const rueck = r.vorherFreigabe ? `zeuge_setzen freigabe ${r.vorherFreigabe}` : 'zeuge_setzen ohne_zeuge true';
          return { success: true, data: r, display: `✅ Quorum ${r.nachher}${p.freigabe ? ` mit ${p.freigabe}` : ''} (vorher ${r.vorher}${r.vorherFreigabe ? ` ${r.vorherFreigabe}` : ''}) — Rückweg ${rueck}` };
        }
      }
    } catch (err) { return { success: false, error: (err as Error).message.slice(0, 900) }; }
    return { success: false, error: 'Unbekannte Aktion' };
  }

  /** v1809 — Stabilitätsfenster nach Firewall-/Netzänderungen (Lehre H dd0c0b10): volle Dauer beobachten, jede Lücke ist „UNKNOWN“ */
  private async stabilitaet(input: Record<string, unknown>): Promise<SkillResult> {
    const zugaenge = (Array.isArray(input.zugaenge) ? input.zugaenge.map(String) : String(input.zugaenge ?? '').split(',')).map(z => z.trim()).filter(Boolean);
    if (zugaenge.length < 1 || zugaenge.length > 4 || zugaenge.some(z => !ZUGANG.test(z))) return { success: false, error: 'zugaenge: 1–4 Knoten-Fernzugänge, z. B. [sql01, sql02]' };
    const ids = pruefeEreignisIds(input.event_ids); if (typeof ids === 'string') return { success: false, error: ids };
    const dauer = input.dauer_s === undefined ? 900 : Number(input.dauer_s);
    const takt = input.intervall_s === undefined ? 60 : Number(input.intervall_s);
    if (!Number.isInteger(dauer) || dauer < 300 || dauer > 1800) return { success: false, error: 'dauer_s: 300–1800 (Standard 900)' };
    if (!Number.isInteger(takt) || takt < 20 || takt > 300) return { success: false, error: 'intervall_s: 20–300 (Standard 60)' };
    const ag = input.ag === undefined ? undefined : String(input.ag).trim();
    if (ag !== undefined && !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(ag)) return { success: false, error: 'ag: Name der Verfügbarkeitsgruppe' };
    const schlafe = this.d.schlafe ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    // Ausgangsstand je Knoten: höchster Record — nur Ereignisse danach zählen als neu
    const basis = new Map<string, number>();
    for (const z of zugaenge) {
      const r = await this.lauf<ClusterEreignisse>(z, ereignisseSkript({ ids, minuten: 1 }), 'Cluster-Ereignisse (Beginn)', 120_000);
      basis.set(z, r.hoechsterRecord);
    }
    const start = Date.now(); const beginn = new Date(start).toISOString();
    const m: StabilMessung[] = [];
    for (;;) {
      for (const z of zugaenge) {
        const zeit = new Date().toISOString();
        try {
          const r = await this.lauf<{ neu: number; gesund: boolean; knoten: string[]; nichtOnline: string[]; ag?: string[]; datenbanken?: string[] }>(z, stabilMessSkript({ ids, seit_record: basis.get(z)!, ...(ag ? { ag } : {}) }), 'Stabilität messen', 120_000);
          m.push({ zeit, knoten: z, ok: true, neu: r.neu, gesund: r.gesund, detail: [r.knoten.join(', '), r.nichtOnline.length ? `nicht Online: ${r.nichtOnline.join(', ')}` : '', r.ag?.join(', ') ?? '', r.datenbanken?.join(', ') ?? ''].filter(Boolean).join('; ') });
        } catch (err) { m.push({ zeit, knoten: z, ok: false, neu: 0, fehler: (err as Error).message.slice(0, 200) }); }
      }
      const ist = (Date.now() - start) / 1000;
      if (m.some(x => x.ok && x.neu > 0) || ist >= dauer) break;
      await schlafe(takt * 1000);
    }
    const ist = (Date.now() - start) / 1000;
    const b = stabilitaetBewerten(m, zugaenge, dauer, ist);
    const letzte = zugaenge.map(z => [...m].reverse().find(x => x.knoten === z && x.ok)).filter((x): x is StabilMessung => !!x);
    const data = { ergebnis: b.ergebnis, beginn, ende: new Date().toISOString(), beobachtetS: Math.round(ist), sollS: dauer, messungen: m.length, gruende: b.gruende, letzte, verlauf: m.slice(-40) };
    const text = `${b.ergebnis === 'CLUSTER_STABLE' ? `CLUSTER_STABLE ${Math.round(ist)} s` : `${b.ergebnis} nach ${Math.round(ist)} s`} (${zugaenge.join(', ')}, ${m.length} Messungen, Ereignisse ${ids.join(',')} neu: ${m.reduce((s, x) => s + x.neu, 0)})${b.gruende.length ? ` — ${b.gruende.join('; ')}` : ''}${letzte.length ? `\nzuletzt: ${letzte.map(x => `${x.knoten}: ${x.detail}`).join(' | ')}` : ''}`;
    return b.ergebnis === 'CLUSTER_STABLE' ? { success: true, data, display: text } : { success: false, data, error: text };
  }

  private async lauf<T>(zugang: string, skript: string, zweck: string, timeoutMs: number, eingabe?: Record<string, string>): Promise<T> {
    const g = /^gast:(\d+):([a-z0-9-]+)$/.exec(zugang);
    if (g && !this.d.gast) throw new Error('Gastagent nicht verfügbar (Proxmox-Skill fehlt)');
    const r = g ? await this.d.gast!(Number(g[1]), g[2]!, skript, eingabe ? JSON.stringify(eingabe) : undefined, timeoutMs) : await this.d.skript(zugang, kodiert(skript), eingabe ? JSON.stringify(eingabe) : undefined, timeoutMs, zweck);
    const e = adErgebnis<T>(r.stdout);
    if (r.code !== 0 || !e) {
      const klar = `${r.stderr}\n${r.stdout}`.split(/\r?\n/).filter(z => z.trim() && !z.startsWith('#< CLIXML') && !z.startsWith('<Objs')).join(' ');
      const fehler = `${klar} ${clixmlFehler(`${r.stderr}\n${r.stdout}`)}`.replace(/\s+/g, ' ').trim().slice(-600);
      throw new Error(`${zweck} auf ${zugang} gescheitert (Exit ${r.code}): ${fehler || 'keine Ausgabe'}`);
    }
    return e;
  }

  private status(zugang: string): Promise<ClusterStatus> { return this.lauf<ClusterStatus>(zugang, clusterStatusSkript(), 'Cluster-Status', 180_000); }

  /** nach einem Neustart: erst 60 s, dann alle 20 s den Status lesen */
  private async warte(zugang: string, bereit: (s: ClusterStatus) => boolean, grenzeMs: number): Promise<ClusterStatus> {
    const schlafe = this.d.schlafe ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    const bis = Date.now() + grenzeMs; let letzter: ClusterStatus | undefined; let fehler = '';
    await schlafe(60_000);
    while (Date.now() < bis) {
      try { letzter = await this.status(zugang); if (bereit(letzter)) return letzter; fehler = ''; } catch (err) { fehler = (err as Error).message.slice(0, 200); }
      await schlafe(20_000);
    }
    throw new Error(`${zugang} nach ${Math.round(grenzeMs / 60_000)} min nicht bereit — zuletzt: ${letzter ? clusterStatusText(letzter) : fehler || 'kein Status'}`);
  }

  private async kennwort(name: unknown, wofuer: string): Promise<string> {
    const n = String(name ?? '').trim();
    if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(n)) throw new Error('konto_tresor: Tresor-Eintrag mit dem Kennwort (z. B. win-dc01-admin)');
    if (!this.d.tresor) throw new Error('Tresor nicht verfügbar');
    if (!(await this.d.tresor.namen()).has(n)) throw new Error(`Tresor-Eintrag ${n} gibt es nicht`);
    return this.d.tresor.lies(n, wofuer);
  }
}
