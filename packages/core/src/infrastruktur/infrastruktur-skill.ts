import { networkInterfaces } from 'node:os';
import { Skill } from '@alfred/skills';
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { bestandsbericht, type BackupStand, type NetzEintrag, type ProxyEintrag, type VmEintrag } from './bericht.js';
import type { HostBestand } from './sammler.js';
import { architekturDokument, grundlageText, planungsGrundlage, pruefeArchitektur, mitAenderungen, bisherigeFassung, DISTRIBUTIONEN, type KnotenStand, type PlanungsGrundlage, type SpeicherStand } from './architektur.js';
import { changeAnzeige, planAusChange, planMitSchrittAenderungen, type ChangePlanung } from './change-planung.js';
import type { ChangeMotor } from './change-motor.js';
import type { StandardChanges } from './standard-changes.js';
import { KANAELE, ZEITPUNKTE, regelFehler, regelText, type Empfaenger, type Kanal, type KalenderEintrag, type BenachrichtigungsRegel, type Zeitpunkt } from './wartung.js';
import { erreichbar } from './wartung-dienst.js';
import { PRUEF_TYPEN } from './change-schritte.js';

/** Ausschnitt des VorhabenRepository (@alfred/storage), damit der Skill ohne DB testbar bleibt. */
export interface VorhabenSpeicher {
  liste(userId: string, nurOffen?: boolean): Promise<VorhabenDaten[]>;
  finde(userId: string, schluessel: string): Promise<VorhabenDaten | null>;
  anlegen(userId: string, e: { titel: string; ziel: string; hosts: string[]; bestandDocId?: string }): Promise<VorhabenDaten>;
  setzeArchitektur(userId: string, id: string, architektur: unknown, docId: string, bestandDocId?: string): Promise<VorhabenDaten>;
  entscheide(userId: string, id: string, e: { entscheidung: 'annehmen' | 'ablehnen' | 'ueberarbeiten'; wortlaut: string; architekturVersion: number }, status: VorhabenDaten['status']): Promise<VorhabenDaten>;
  fuegeChangesHinzu?(userId: string, id: string, changeIds: string[]): Promise<void>;
}
export interface VorhabenDaten {
  id: string; titel: string; ziel: string; hosts: string[];
  status: 'entwurf' | 'architektur_vorgeschlagen' | 'angenommen' | 'verworfen';
  bestandDocId?: string; architekturDocId?: string; architekturVersion: number; architektur?: unknown;
  entscheidungen: Array<{ zeit: string; entscheidung: string; wortlaut: string; architekturVersion: number }>;
  changeIds: string[]; erstellt: string;
}

/**
 * Spec Infrastruktur-Vorhaben — Skill `infrastruktur`.
 * I1 (Owner 22.10.2026): `bestand` — Bestandsaufnahme nur lesend (CMDB-Discovery, Sicherungen, Bestandsbericht als CMDB-Dokument).
 * I2 (Owner 22.10.2026 „I2 wie vorgeschlagen umsetzen“): Vorhaben und Zielarchitektur — `vorhaben_anlegen`, `grundlage`,
 * `architektur_vorschlagen` (Struktur wird deterministisch geprüft, Dokument nach fester Vorlage), `entscheiden`,
 * `vorhaben_liste`, `vorhaben_zeigen`. Nichts davon verändert die Infrastruktur.
 */
export interface InfrastrukturDeps {
  istOwner: (ctx: SkillContext) => boolean;
  /** CMDB-Quellen der Reihe nach entdecken; liefert je Quelle eine Zeile (Assets/Relationen oder Fehler) */
  entdecke: (quellen: string[]) => Promise<string[]>;
  /** Host-Bestände der letzten Fernzugriff-Discovery */
  hosts: () => HostBestand[];
  vms: () => Promise<VmEintrag[]>;
  proxy: () => Promise<ProxyEintrag[]>;
  netze: () => Promise<NetzEintrag[]>;
  /** Öffentliche DNS-Einträge (Cloudflare) aus der CMDB */
  dns?: () => Promise<import('./bericht.js').DnsEintrag[]>;
  /** CMDB-Beziehungen DNS-Eintrag → Proxy-Eintrag (resolves_to) */
  verknuepfeDns?: (paare: Array<{ dnsAssetId: string; proxyAssetId: string }>) => Promise<number>;
  backups?: () => Promise<BackupStand | undefined>;
  speichereBericht: (titel: string, markdown: string) => Promise<string>;
  /** I4b Teil 3 — Befunde als ITSM-Problems (ohne Doppelte, ohne Sicherung) */
  problems?: (auff: import('./bericht.js').Auffaelligkeit[], bericht: { docId: string; datum: string }, erfassung: { hosts: Set<string>; alle: boolean }) => Promise<{ neu: string[]; bekannt: number; geloest: string[] }>;
  protokoll?: (msg: string, daten: Record<string, unknown>) => void;
  // ── I2 ──
  ownerId?: () => string | undefined;
  vorhaben?: VorhabenSpeicher;
  aktiveZugaenge?: () => Promise<string[]>;
  knoten?: () => Promise<KnotenStand[]>;
  speicher?: () => Promise<SpeicherStand[]>;
  letzterBestandDocId?: () => Promise<string | undefined>;
  speichereArchitektur?: (vorhabenId: string, titel: string, markdown: string) => Promise<string>;
  // ── I3 ──
  changes?: ChangePlanung;
  // ── I4 ──
  motor?: ChangeMotor;
  // ── I4b ──
  wartung?: {
    kalender(o: string): Promise<KalenderEintrag[]>;
    regeln(o: string): Promise<BenachrichtigungsRegel[]>;
    kalenderAnlegen(o: string, e: { art: 'fenster' | 'sperre'; name: string; geltung: unknown; regel: unknown; notiz?: string }): Promise<string>;
    regelAnlegen(o: string, e: { name: string; geltung: unknown; empfaenger: unknown[]; kanaele: string[]; zeitpunkte: string[] }): Promise<string>;
    entferne(o: string, id: string): Promise<boolean>;
  };
  // ── I4b Teil 4 ──
  standard?: StandardChanges;
  // ── I4b Teil 5 — Soll/Ist ──
  sollIst?: { planen(o: string, v: VorhabenDaten): Promise<number>; abgleich(o: string, v: VorhabenDaten): Promise<{ text: string; erfuellt: number; gesamt: number; abweichungen: string[] }> };
  // ── v1707 — Anwendungs-Update-Bericht (nur lesend) ──
  anwendungsUpdates?: () => Promise<string>;
  // ── I4c — Tresor (ohne Werte) ──
  tresor?: { liste(o: string): Promise<Array<{ name: string; herkunft: string; zweck?: string; geaendert: string }>>; erzeuge(o: string, name: string, laenge?: number, zweck?: string): Promise<void>; entferne(o: string, name: string): Promise<boolean> };
  // ── Einwand ──
  einwand?: import('./einwand.js').EinwandDienst;
  updatesSchalter?: { liste(o: string): Promise<Record<string, string>>; setze(o: string, name: string, an: boolean): Promise<boolean> };
  /** Alfred-Benutzer (Familie) nach Name auflösen → Telegram-ID */
  nutzerAufloesen?: (name: string) => Promise<{ userId: string; name: string; konten: Record<string, string> } | { unbekannt: string[] } | undefined>;
}

export const BESTAND_QUELLEN = ['fernzugriff', 'proxmox', 'nginx_proxy_manager', 'cloudflare_dns', 'unifi', 'pfsense', 'mikrotik'];
/** Host-Bestände älter als das werden für die Planung neu erfasst */
export const GRUNDLAGE_MAX_ALTER_MS = 6 * 3_600_000;

/** Adresse des Alfred-Servers für Firewall-Regeln (Zone „alfred“ der Architektur) */
const ALFRED_IP = (() => { try { for (const l of Object.values(networkInterfaces())) for (const a of l ?? []) if (a.family === 'IPv4' && !a.internal && /^(10|172|192)\./.test(a.address) && !/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) return a.address; } catch { /* keine Netzinfo */ } return 'unbekannt'; })();
/** v1695 (K5) — Aktionen, die nie aus einem Unteragenten laufen */
export const NUR_HAUPTGESPRAECH = new Set(['vorhaben_anlegen', 'architektur_vorschlagen', 'entscheiden', 'changes_planen', 'change_aendern', 'freigabe_anfragen', 'freigeben', 'change_steuern', 'owner_schritt_erledigt', 'rueckweg_ausfuehren', 'fenster_anlegen', 'sperre_anlegen', 'benachrichtigung_anlegen', 'wartung_entfernen', 'standard_freigabe_anfragen', 'standard_freigeben', 'standard_widerrufen', 'standard_change', 'standard_serie', 'updates_schalter', 'einwand', 'tresor_erzeugen', 'tresor_entfernen']);
const AKTIONEN = ['bestand', 'vorhaben_anlegen', 'vorhaben_liste', 'vorhaben_zeigen', 'grundlage', 'architektur_vorschlagen', 'entscheiden', 'changes_planen', 'changes_liste', 'change_zeigen', 'change_aendern', 'freigabe_anfragen', 'freigeben', 'change_steuern', 'owner_schritt_erledigt', 'rueckweg_ausfuehren', 'wartung_liste', 'fenster_anlegen', 'sperre_anlegen', 'benachrichtigung_anlegen', 'wartung_entfernen', 'standard_liste', 'standard_freigabe_anfragen', 'standard_freigeben', 'standard_widerrufen', 'standard_change', 'standard_serie', 'updates_schalter', 'einwand', 'einwaende', 'soll_ist', 'anwendungs_updates', 'tresor_liste', 'tresor_erzeugen', 'tresor_entfernen'] as const;

const STATUS_TEXT: Record<VorhabenDaten['status'], string> = {
  entwurf: 'Entwurf (noch keine geprüfte Architektur)',
  architektur_vorgeschlagen: 'Architektur vorgeschlagen — Owner entscheidet',
  angenommen: 'Architektur angenommen',
  verworfen: 'verworfen',
};

export class InfrastrukturSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'infrastruktur',
    category: 'infrastructure',
    description:
      'Infrastruktur-Vorhaben (Spec 2026-10-22). Ändert nichts an der Infrastruktur. '
      + 'bestand: vollständige Bestandsaufnahme NUR LESEND — aktualisiert die CMDB aus Fernzugriff (Hosts: OS, Ressourcen, Updates, Dienste, Ports, Container, Compose, Volumes), Proxmox, NPM, UniFi, pfSense, MikroTik, liest die Sicherungen aller VMs und erstellt den Bestandsbericht mit Auffälligkeiten (als CMDB-Dokument). '
      + 'Für ein Ziel wie „dockerhost aufteilen“, „neue Architektur vorschlagen“, „auf neue VMs migrieren“: '
      + '1) vorhaben_anlegen (titel, ziel in den Worten des Owners, hosts = Fernzugang-Namen); '
      + '2) grundlage (vorhaben) — Einheiten (Compose-Projekte, einzelne Container, Host) mit gemessenem RAM, Daten, Ports, Proxy-Domains, dazu Proxmox-Knoten, Speicher, Netze; '
      + '3) architektur_vorschlagen (vorhaben, architektur) — JEDE Einheit genau einer Gruppe zuordnen (ziel vm|lxc|bleibt|stilllegen; vm/lxc mit vmName, knoten, vcpu, ramGb, diskGb, distribution + distributionBegruendung, netz), '
      + 'netze (neu/vorhanden, geraet unifi|pfsense|mikrotik, vlan, subnetz ohne Überschneidung), firewall (je Regel eine Zone von/nach: Netz, Gruppe oder internet/vpn/proxy/alle; protokoll, ports), proxyDns, sicherung, updates, reihenfolge (jede neue VM/LXC), risiken, offeneEntscheidungen. Wird geprüft; bei Fehlern nachbessern und erneut senden. '
      + 'Kleine Überarbeitung einer gespeicherten Fassung: architektur_vorschlagen mit aenderungen statt architektur (nur das Neue senden). '
      + 'Ergebnis: Architektur-Dokument (CMDB). 4) entscheiden NUR auf ausdrückliche Aussage des Owners (annehmen|ueberarbeiten|ablehnen, wortlaut = seine Worte). '
      + 'UNTERAGENT (delegate): nur für umfangreiche LESE-Erhebungen; Planen, Ändern, Freigaben und Steuern von Changes und Architektur laufen nie im Unteragenten (dort gesperrt). Meldet delegate „TEILERGEBNIS“, das Ergebnis selbst nachprüfen (z. B. changes_liste). '
      + 'vorhaben_liste / vorhaben_zeigen: Stand der Vorhaben; die gespeicherte Zielarchitektur abschnittsweise vollständig mit abschnitt (+ von/bis bei Listen) statt das Dokument zu lesen oder zu delegieren. '
      + 'CHANGES (I3, nichts wird ausgeführt): changes_planen (vorhaben optional — nur mit angenommener Architektur; changes = Liste von Plänen: schluessel, titel, begruendung, typ normal|notfall, risiko niedrig|mittel|hoch|kritisch, ausfallMinuten, geplantAb, betroffen = CMDB-Assets, abhaengigVon = Schlüssel/Change-IDs, zweck stilllegung nur für Löschen, ohneSicherungGrund wenn nur Neues entsteht, schritte). '
      + 'Schritt: art aktion (skill, aktion, parameter, pruefung, rueckweg {skill,aktion,parameter} — Pflicht bei ändernden Aktionen; vor der ersten Änderung eine Sicherung, z. B. proxmox create_snapshot), pruefung (pruefung), warten (sekunden oder pruefung), owner (frage — für Handgriffe, solange eine Skill-Aktion fehlt). '
      + 'Verweise: {{schrittN.feld}} auf frühere Aktionen, {{geheim:name}} für Tresor-Werte. Ein Paket mit Fehlern wird nicht gespeichert — nachbessern. '
      + 'NEUE VMs (I5 Vorlagen-Fabrik): zuerst proxmox list_cloud_images (lesen) — url/checksum/filename daraus wörtlich übernehmen; dann proxmox download_image (node, storage mit Inhalt import z. B. backupshare; rueckweg delete_image volid {{schrittN.volid}}) → create_template (node, storage gemeinsam z. B. nvme-cs001, image {{schrittN.volid}}, hostname = Vorlagenname; rueckweg delete_vm vmid {{schrittN.vmid}}, vm_name, force_stop true) → provision_vm (template {{schrittN.vmid}}, hostname, node, storage, ip CIDR fest, gateway, nameserver, memory, cores, disk_size; zeitlimitS 1800; rueckweg delete_vm mit force_stop true). Benutzer alfred, Host-Schlüssel von Alfred, Fernzugang + CMDB entstehen dabei; ohneSicherungGrund, weil nur Neues entsteht. delete_vm sonst nur in einem Stilllegungs-Change. '
      + `NETZ/FIREWALL auf der UniFi (Zonen-Firewall): zuerst unifi export_config (Sicherung) → create_network (vlan, subnet, dhcp; rueckweg delete_network) → create_zone (zone_name = Netzname, networks [Netz]; rueckweg delete_zone) → je Firewall-Regel der Architektur unifi create_firewall_policy mit policy_action ALLOW, allow_return_traffic true, rueckweg delete_firewall_policy policy_id {{schrittN.id}}. Zonen: eigene Gruppe/Netz = deren Zone; alfred = source_zone Internal + source_ip ${ALFRED_IP}; gateway = destination_zone Gateway; internet = destination_zone External; vpn = source_zone Vpn; Ports destination_port, policy_protocol TCP/UDP. Danach BLOCK-Policies ohne Ports NUR dort, wo die UDM standardmäßig erlaubt: eigene Zone→External und eigene Zone→Gateway (ALLOWs stehen davor). KEINE eigene Sperre zwischen eigener Zone und Internal/Vpn/anderen Zonen — die UDM sperrt dort selbst, und eine eigene BLOCK-Regel stünde vor den Rückverkehr-Regeln und verwürfe die Antworten erlaubter Verbindungen (Realfall 22.10.). Löschen geht nur in umgekehrter Reihenfolge (erst Policies, dann Zone, dann Netz). Netzschritte brauchen keinen owner-Schritt. TRUNK: Beim Planen eines neuen VLANs unifi trunk_path (client_ip = Proxmox-Knoten der künftigen VM, network_name) lesen und für jeden gesperrten Port nach create_network einen Schritt unifi allow_network_on_port (device, switch_port, network_name; rueckweg exclude_network_on_port) einplanen — sonst erreicht das VLAN die UDM nicht. `
      + 'MIGRATION (I6): Daten nur mit fernzugriff kopieren (quelle, quelle_pfad oder quelle_volume, ziel, ziel_pfad oder ziel_volume; überträgt nur Unterschiede, Prüfsumme danach) — Ablauf: vorkopieren bei laufendem Dienst → Dienst an der Quelle stoppen (docker stop/compose stop) → kopieren mit loeschen true (Abgleich, Prüfsumme muss gleich sein) → am Ziel starten → prüfen (http/port/container_healthy) → Proxy/DNS umstellen → prüfen. Rückweg-Kette: Proxy zurück, Quelle wieder starten. PostgreSQL mit fernzugriff datenbank_kopieren (Zeilenzahl je Tabelle wird verglichen). Geheimnisdateien (.env) mit fernzugriff geheim_uebernehmen (pfad, tresor_name) in den Tresor und am Ziel per {{geheimdatei:name}} schreiben — nie Werte in Parameter. kopieren/datenbank_kopieren/geheim_uebernehmen brauchen rueckweg keiner (Quelle bleibt unberührt). Die Quelle wird nie gelöscht — das ist ein eigener Stilllegungs-Change. IMAGES: am Ziel exakt dasselbe Image per Registry-Digest ziehen (docker image inspect --format "{{json .RepoDigests}}" an der Quelle → image: name@sha256:… in der Compose) — kein docker save/load (Realfall 23.10.: Docker 29 mit containerd-Speicher vergibt andere Image-IDs, das Archiv war am Ziel nicht auffindbar); Hilfsdateien nie unter /root, sondern z. B. /srv/<vorhaben>-export. '
      + 'NEUE ZONEN/NETZE (v1647, Realfälle 24.10.): Prüfungen auf Dienste im neuen Netz IMMER lokal auf der Ziel-VM (befehl über ihren Fernzugang, z. B. curl -s -m 5 -o /dev/null -w "%{http_code}" http://127.0.0.1:PORT/) — der Alfred-Server darf dort meist nur SSH; die Vorkopie bei laufender Quelle mit pruefsumme false; Dienste, die NPM öffentlich macht, laufen über die pfSense (NPM 172.17.0.10 im pfSense-LAN, SNAT auf 192.168.1.139): für jedes neue Zielnetz braucht die pfSense eine statische Route über MAIN_LAN_DHCP (Vorbild eb72dc07) und UniFi eine Freigabe pfSense 192.168.1.139 → Ziel:Port; Vorbedingungen nie an Rechner knüpfen, die nur bei Bedarf laufen. '
      + 'CONTAINER-NACHBAU (v1653, Realfall 65db5bbc 25.10.): Docker-Netze originalgetreu anlegen — Treiber und IPAM (Subnetz, Gateway, IP-Bereich) aus `docker network inspect` der Quelle übernehmen, und je Container NetworkingConfig.EndpointsConfig vollständig (Aliases UND IPAMConfig mit fester IPv4Address), nicht nur die Aliase; Apps verweisen oft per fester IP auf ihre Datenbank (Vaultwarden: DATABASE_URL auf 192.168.250.20). Vorher prüfen, dass das Subnetz am Ziel frei ist. '
      + 'LOKAL GEBAUTE IMAGES (v1658, Owner 25.10.): nie neu bauen und nie docker save/load — mit gitlab projekte den Registry-Pfad des passenden Projekts finden, im Change fernzugriff image_hochladen an der Quelle (registry_ziel = <Pfad>/<dienst>:migration-<datum>, liefert {{schrittN.digest}}), am Ziel fernzugriff image_holen mit <Pfad>/<dienst>@{{schrittN.digest}} und den Container mit genau dieser Referenz nachbauen. Identität nie über die Image-Id vergleichen (Docker mit containerd-Speicher zeigt am Ziel den Manifest-Digest, die Quelle den Config-Digest — Realfall 0cd5c0a4), sondern über RepoDigests bzw. den Digest aus image_holen. '
      + 'changes_liste, change_zeigen (change; große Pläne zeigt die Übersicht gekürzt — einzelne Schritte vollständig mit nur_schritte=[nr…], nie dafür delegieren), change_aendern (change, plan — Freigabe verfällt; bei großen Plänen statt plan gezielt schritte_ersetzen [{nr, schritt}] bzw. schritte_einfuegen [{nach, schritt}] bzw. für kleine Korrekturen text_ersetzen [{suchen, durch, schritte:[nr…]}] (exakter Text, ohne die Schritte neu zu schreiben), neuer Termin mit geplant_ab (auch allein), nie einen Code-Agenten dafür; ein ANGEHALTENER Change, der schon gewirkt hat, ist ab dem Haltepunkt korrigierbar: vollständige Schrittliste mit gleicher Nummerierung senden, die gelaufenen Schritte bleiben unverändert, danach freigabe_anfragen — nach dem Ja macht der Motor am Haltepunkt weiter, kein Abbrechen oder Rückweg nötig), freigabe_anfragen (ids = Change-IDs; stellt dem Owner die Freigabe-Frage per Button). freigeben NIE selbst aufrufen — kommt nur über das Ja des Owners. '
      + 'WARTUNG (I4b): wartung_liste; fenster_anlegen / sperre_anlegen (name, regel {art einmalig, von, bis (ISO)} oder {art woechentlich, tage [0=So…6=Sa], von, bis "HH:MM" Wiener Zeit}, fuer = Asset-Namen oder leer = global, notiz); '
      + 'benachrichtigung_anlegen (name, fuer, empfaenger [{art owner|nutzer|kontakt, name, email, haDienst}], kanaele push|telegram|email|homeassistant, zeitpunkte 24h_vorher|1h_vorher|start|ende|stoerung); wartung_entfernen (id). Der Motor startet ändernde Changes nur im geltenden Fenster, nie in Sperrzeiten (außer Notfall) und erst nach der verlangten Ankündigung. '
      + 'STANDARD-CHANGES (I4b): standard_liste; standard_freigabe_anfragen (vorlage) — der Owner gibt eine Vorlage EINMAL per Button frei; standard_change (vorlage, parameter) legt daraus ohne Einzel-Ja einen Change an (Grenzen prüft die Vorlage, Eingangskontrolle der Annahmen vor dem Anlegen und als erste Schritte, Start nach Zeitplan; weicht die Eingangskontrolle ab, den Fall einzeln mit changes_planen planen; eine nach Halt/Rückweg oder 2 Monaten ohne Lauf gesperrte Vorlage (überprüfen) braucht eine neue Freigabe); standard_widerrufen (vorlage, wortlaut); standard_serie (vorlage, optional zugaenge [Liste; sonst alle Hosts mit Schalter „Updates an“, unkritische zuerst], optional parameter, geplant_ab) legt die Vorlage für mehrere Hosts als verkettetes Paket an und stellt EINE Freigabe-Frage (Owner: ein Ja je Serie) — für wöchentliche Betriebssystem-Updates Vorlage os_updates; updates_schalter (zugang, an true|false, wortlaut) nur auf ausdrücklichen Wunsch des Owners. standard_freigeben NIE selbst aufrufen. '
      + 'ANWENDUNGS-UPDATES: anwendungs_updates (ohne Parameter) — nur lesend, alle Hosts mit Fernzugang: native Pakete (apt, auch Datenbanken wie PostgreSQL, neue Hauptversionen wie postgresql-18) und Container-Images gegen die Registry (neuer Build desselben Tags, neuere Versionen); je Eintrag die Art (Datenbank/mit Daten/zustandslos). Ändert nichts; Updates nur als eigener Change. '
      + 'SOLL/IST (I4b): soll_ist (vorhaben) — Abgleich der angenommenen Zielarchitektur mit dem Ist (VMs, Netze, Dienste am neuen Host, Proxy-Ziele), Fortschritt und Abweichungen; nach jedem abgeschlossenen Change des Vorhabens automatisch. '
      + 'TRESOR (I4c): tresor_liste (nur Namen), tresor_erzeugen (name, laenge, zweck — Zufallspasswort am Server, der Wert wird nie gezeigt), tresor_entfernen (name, wortlaut). Werte setzt der Owner auf der Tresor-Seite im Web; NIE nach Passwörtern im Chat fragen. In Change-Schritten: {{geheimdatei:name}} im Befehl eines Fernzugriff-Schritts (Datei 600 am Host, z. B. --env-file) oder {{geheim:name}} als ganzer Wert in password/secret/token/api_key. '
      + 'EINWAND: einwand (change ODER vorhaben, bezug z. B. „Schritt 4“ oder „Netze“, text = Einwand des Owners in seinen Worten, wortlaut) — nimmt dem Change die Freigabe bzw. setzt das Vorhaben in den Entwurf; einwaende (change|vorhaben) listet sie. Beim Überarbeiten (change_aendern bzw. architektur_vorschlagen) JEDEN offenen Einwand beantworten: antworten [{einwand: ID, art umgesetzt|abgelehnt, text}]. '
      + 'AUSFÜHRUNG (I4): freigegebene Changes startet der Ausführungsmotor selbst (sofort oder ab geplantAb). change_steuern (change, wahl wiederholen|abbrechen|rueckweg|ueberspringen, wortlaut = Worte des Owners; ueberspringen nur für einen angehaltenen lesenden/prüfenden Schritt) nur bei einem angehaltenen Change (rueckweg auch nach einer Störung; abbrechen verwirft auch einen nie gestarteten Change in Planung/zur Freigabe/freigegeben) auf ausdrücklichen Wunsch des Owners — „Rückweg ausführen“ = wahl rueckweg. owner_schritt_erledigt und rueckweg_ausfuehren NIE selbst aufrufen.',
    riskLevel: 'read',
    version: '2.0.0',
    timeoutMs: 15 * 60_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...AKTIONEN] },
        quellen: { type: 'array', items: { type: 'string' }, description: `bestand: optional nur diese CMDB-Quellen (Standard: ${BESTAND_QUELLEN.join(', ')})` },
        vorhaben: { type: 'string', description: 'ID (oder ID-Anfang) oder Titel des Vorhabens' },
        titel: { type: 'string', description: 'vorhaben_anlegen: kurzer Titel' },
        ziel: { type: 'string', description: 'vorhaben_anlegen: Ziel in den Worten des Owners' },
        hosts: { type: 'array', items: { type: 'string' }, description: 'vorhaben_anlegen: Fernzugang-Namen, um die es geht (z. B. dockerhost)' },
        architektur: {
          type: 'object',
          description: 'architektur_vorschlagen: die Zielarchitektur',
          properties: {
            zusammenfassung: { type: 'string' },
            gruppen: { type: 'array', items: { type: 'object', properties: {
              name: { type: 'string' }, zweck: { type: 'string' }, begruendung: { type: 'string' },
              einheiten: { type: 'array', items: { type: 'string' } },
              ziel: { type: 'string', enum: ['vm', 'lxc', 'bleibt', 'stilllegen'] },
              vmName: { type: 'string' }, knoten: { type: 'string' }, vcpu: { type: 'number' }, ramGb: { type: 'number' }, diskGb: { type: 'number' }, speicher: { type: 'string' },
              distribution: { type: 'string', enum: [...DISTRIBUTIONEN] }, distributionBegruendung: { type: 'string' },
              netz: { type: 'string' }, verwaltung: { type: 'string', enum: ['fernzugriff', 'satellit'] },
            } } },
            netze: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, vlan: { type: 'number' }, subnetz: { type: 'string' }, geraet: { type: 'string', enum: ['unifi', 'pfsense', 'mikrotik'] }, zweck: { type: 'string' }, neu: { type: 'boolean' } } } },
            firewall: { type: 'array', description: 'je Regel EINE Zone von/nach: Netzname, Gruppenname oder internet/vpn/proxy/alle; alles andere gilt als gesperrt', items: { type: 'object', properties: { von: { type: 'string' }, nach: { type: 'string' }, protokoll: { type: 'string', enum: ['tcp', 'udp', 'tcp+udp', 'icmp', 'alle'] }, ports: { type: 'string', description: '443 | 8008,8448 | 10000-20000 | alle' }, begruendung: { type: 'string' } } } },
            proxyDns: { type: 'string' }, sicherung: { type: 'string' }, updates: { type: 'string' },
            reihenfolge: { type: 'array', items: { type: 'object', properties: { gruppe: { type: 'string' }, ausfallMinuten: { type: 'number' }, voraussetzung: { type: 'string' } } } },
            risiken: { type: 'array', items: { type: 'object', properties: { risiko: { type: 'string' }, massnahme: { type: 'string' } } } },
            offeneEntscheidungen: { type: 'array', items: { type: 'string' } },
          },
        },
        entscheidung: { type: 'string', enum: ['annehmen', 'ueberarbeiten', 'ablehnen'], description: 'entscheiden: nur was der Owner ausdrücklich gesagt hat' },
        changes: {
          type: 'array', description: 'changes_planen: Pläne',
          items: { type: 'object', properties: {
            schluessel: { type: 'string' }, titel: { type: 'string' }, begruendung: { type: 'string' }, typ: { type: 'string', enum: ['normal', 'notfall'] },
            risiko: { type: 'string', enum: ['niedrig', 'mittel', 'hoch', 'kritisch'] }, ausfallMinuten: { type: 'number' }, geplantAb: { type: 'string' },
            betroffen: { type: 'array', items: { type: 'string' } }, abhaengigVon: { type: 'array', items: { type: 'string' } },
            zweck: { type: 'string', enum: ['stilllegung'] }, ohneSicherungGrund: { type: 'string' },
            schritte: { type: 'array', items: { type: 'object', properties: {
              titel: { type: 'string' }, art: { type: 'string', enum: ['aktion', 'pruefung', 'warten', 'owner'] }, skill: { type: 'string' }, aktion: { type: 'string' }, parameter: { type: 'object' },
              pruefung: { type: 'object', properties: { typ: { type: 'string', enum: [...PRUEF_TYPEN] }, ziel: { type: 'string' }, port: { type: 'number' }, erwartet: { type: 'string', description: 'Ausgabe muss das enthalten' }, nichtEnthalten: { type: 'string', description: 'Ausgabe darf das nicht enthalten (http/befehl/skill)' }, abbruch: { type: 'string', description: 'Nur befehl/skill: steht dieser Text in der Ausgabe, endet ein Warten sofort als Fehler (z. B. „VERIFY_FAILED“), statt bis zum Zeitlimit weiterzuprüfen' }, zugang: { type: 'string' }, container: { type: 'string' }, pfad: { type: 'string' }, befehl: { type: 'string' }, skill: { type: 'string' }, aktion: { type: 'string' }, parameter: { type: 'object' } } },
              rueckweg: { type: 'object', properties: { skill: { type: 'string' }, aktion: { type: 'string' }, parameter: { type: 'object' }, keiner: { type: 'string' } } },
              sekunden: { type: 'number' }, frage: { type: 'string' }, zeitlimitS: { type: 'number' }, beiFehler: { type: 'string', enum: ['anhalten', 'rueckweg', 'weiter'] },
            } } },
          } },
        },
        ids: { type: 'array', items: { type: 'string' }, description: 'freigabe_anfragen: Change-IDs (ein Change oder ein Paket)' },
        change: { type: 'string', description: 'change_zeigen/change_aendern: Change-ID (oder Anfang)' },
        plan: { type: 'object', description: 'change_aendern: vollständiger neuer Plan (wie ein Element von changes) — ODER statt plan gezielt schritte_ersetzen/schritte_einfuegen' },
        schritte_ersetzen: { type: 'array', description: 'change_aendern ohne plan: [{nr, schritt}] — ersetzt genau diese Schritte, der Rest bleibt', items: { type: 'object', properties: { nr: { type: 'number' }, schritt: { type: 'object' } } } },
        nur_schritte: { type: 'array', items: { type: 'number' }, description: 'change_zeigen: nur diese Schritte VOLLSTÄNDIG als JSON (alle Parameter, Befehle, Prüfungen, Rückwege) — für große Pläne, deren Übersicht gekürzt ist' },
        abschnitt: { type: 'string', description: 'vorhaben_zeigen: nur diesen Teil der Zielarchitektur vollständig (zusammenfassung, gruppen, netze, firewall, proxyDns, sicherung, updates, reihenfolge, risiken, offeneEntscheidungen); bei Listen mit von/bis' },
        von: { type: 'number', description: 'vorhaben_zeigen mit abschnitt: erster Eintrag der Liste (ab 1)' },
        bis: { type: 'number', description: 'vorhaben_zeigen mit abschnitt: letzter Eintrag der Liste' },
        zugaenge: { type: 'array', items: { type: 'string' }, description: 'standard_serie: Fernzugänge in dieser Reihenfolge (sonst alle mit Schalter „Updates an“)' },
        geplant_ab: { type: 'string', description: 'standard_serie: geplanter Start der Serie; change_aendern ohne plan: neuer geplanter Start (ISO mit Zeitzone, z. B. 2026-10-29T00:30:00+01:00) — allein oder zusammen mit schritte_ersetzen/text_ersetzen; der Rest bleibt' },
        text_ersetzen: { type: 'array', description: 'change_aendern ohne plan: [{suchen, durch, schritte:[nr…]}] — ersetzt exakt diesen Text in allen Textfeldern der genannten Schritte (muss in jedem vorkommen), sonst bleibt alles bytegleich', items: { type: 'object', properties: { suchen: { type: 'string' }, durch: { type: 'string' }, schritte: { type: 'array', items: { type: 'number' } } } } },
        schritte_einfuegen: { type: 'array', description: 'change_aendern ohne plan: [{nach, schritt}] — fügt nach Schritt N ein (0 = vorne); folgende Schritte und ihre {{schrittK…}}-Verweise rücken automatisch nach', items: { type: 'object', properties: { nach: { type: 'number' }, schritt: { type: 'object' } } } },
        wahl: { type: 'string', enum: ['wiederholen', 'abbrechen', 'rueckweg', 'ueberspringen'], description: 'change_steuern: was der Owner gesagt hat' },
        bezug: { type: 'string', description: 'einwand: worauf er sich bezieht (Schritt N, Abschnitt, gesamt)' },
        laenge: { type: 'number', description: 'tresor_erzeugen: Länge des Zufallspassworts (16–128, Standard 32)' },
        zweck: { type: 'string', description: 'tresor_erzeugen: wofür' },
        text: { type: 'string', description: 'einwand: der Einwand des Owners' },
        aenderungen: { type: 'object', description: 'architektur_vorschlagen OHNE architektur: neue Fassung = gespeicherte Fassung + diese Änderungen — firewall_hinzu [{von,nach,protokoll,ports,begruendung}], firewall_entfernen [{von,nach,protokoll,ports}], einheit_verschieben [{einheit, nach_gruppe}], sonst oberste Felder ersetzen (z. B. zusammenfassung, offeneEntscheidungen). Für kleine Überarbeitungen immer so statt die ganze Architektur neu zu senden.' },
        antworten: { type: 'array', description: 'change_aendern/architektur_vorschlagen: Antwort auf jeden offenen Einwand', items: { type: 'object', properties: { einwand: { type: 'string' }, art: { type: 'string', enum: ['umgesetzt', 'abgelehnt'] }, text: { type: 'string' } } } },
        name: { type: 'string', description: 'fenster_anlegen/sperre_anlegen/benachrichtigung_anlegen: Bezeichnung' },
        regel: { type: 'object', description: 'Fenster/Sperre', properties: { art: { type: 'string', enum: ['einmalig', 'woechentlich'] }, von: { type: 'string' }, bis: { type: 'string' }, tage: { type: 'array', items: { type: 'number' } } } },
        fuer: { type: 'array', items: { type: 'string' }, description: 'Asset-Namen/IDs; leer = global' },
        notiz: { type: 'string' },
        empfaenger: { type: 'array', items: { type: 'object', properties: { art: { type: 'string', enum: ['owner', 'nutzer', 'kontakt'] }, name: { type: 'string', description: 'bei nutzer: Benutzername in Alfred (wartung_liste/Fehlermeldung nennt die vorhandenen)' }, email: { type: 'string' }, haDienst: { type: 'string', description: 'Home-Assistant notify-Ziel, z. B. mobile_app_xyz' } } } },
        kanaele: { type: 'array', items: { type: 'string', enum: [...KANAELE] } },
        zeitpunkte: { type: 'array', items: { type: 'string', enum: [...ZEITPUNKTE] } },
        id: { type: 'string', description: 'wartung_entfernen: ID des Fensters/der Sperre/der Regel' },
        vorlage: { type: 'string', description: 'Standard-Vorlage: snapshot_anlegen, snapshot_aufraeumen, sicherheitsupdates, image_aktualisieren, neustart_unhealthy' },
        parameter: { type: 'object', description: 'standard_change: Parameter der Vorlage (siehe standard_liste), z. B. {vm, tage} oder {zugang, container}' },
        zugang: { type: 'string', description: 'updates_schalter: Fernzugang-Name' },
        an: { type: 'boolean', description: 'updates_schalter: true = Sicherheitsupdates automatisch (Standard-Change c), false = nur Info' },
        wortlaut: { type: 'string', description: 'entscheiden: die Worte des Owners' },
      },
      required: ['action'],
    },
  };

  constructor(private readonly deps: InfrastrukturDeps) { super(); }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    if (!this.deps.istOwner(context)) return { success: false, error: 'Nur für den Owner.' };
    const action = String(input.action ?? '');
    if (action === 'bestand') return this.bestand(input);
    if (!(AKTIONEN as readonly string[]).includes(action)) return { success: false, error: `Unbekannte Aktion (${AKTIONEN.join(', ')})` };
    // v1695 (K5) — Realfall 27.10. (I9): der Unteragent speicherte 2 von 5 Changes und meldete Erfolg; Planen/Ändern/Freigeben braucht den Faden
    if (context.unteragent === true && NUR_HAUPTGESPRAECH.has(action)) return { success: false, error: `${action} läuft nur im Hauptgespräch, nicht im Unteragenten — Erhebungsergebnis zurückgeben, Alfred plant selbst.` };
    const owner = this.deps.ownerId?.();
    if (!owner || !this.deps.vorhaben) return { success: false, error: 'Vorhaben sind nicht verfügbar (kein Owner oder keine Datenbank).' };
    const repo = this.deps.vorhaben;
    // Realfall 22.10. (4dc47fa3): owner_schritt_erledigt/rueckweg_ausfuehren fehlten hier und landeten in der Vorhaben-Suche — das Ja des Owners verpuffte
    if (action.startsWith('change') || ['freigabe_anfragen', 'freigeben', 'owner_schritt_erledigt', 'rueckweg_ausfuehren'].includes(action)) return this.changeAktion(owner, repo, action, input);
    if (['wartung_liste', 'fenster_anlegen', 'sperre_anlegen', 'benachrichtigung_anlegen', 'wartung_entfernen'].includes(action)) return this.wartungAktion(owner, action, input);
    if (action.startsWith('standard_') || action === 'updates_schalter') return this.standardAktion(owner, action, input);
    if (action === 'anwendungs_updates') {
      if (!this.deps.anwendungsUpdates) return { success: false, error: 'Anwendungs-Update-Bericht nicht verfügbar' };
      const t = await this.deps.anwendungsUpdates();
      return { success: true, display: t };
    }
    if (action === 'einwand' || action === 'einwaende') return this.einwandAktion(owner, repo, action, input);
    if (action.startsWith('tresor_')) {
      const t = this.deps.tresor;
      if (!t) return { success: false, error: 'Tresor nicht verfügbar' };
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (action === 'tresor_liste') { const l = await t.liste(owner); return { success: true, data: l.map(e => ({ name: e.name, herkunft: e.herkunft, zweck: e.zweck })), display: l.length ? l.map(e => `- ${e.name} (${e.herkunft}${e.zweck ? `, ${e.zweck}` : ''})`).join('\n') : 'Der Tresor ist leer. Werte legt der Owner auf der Web-Seite „Tresor“ an.' }; }
      if (action === 'tresor_erzeugen') {
        try { await t.erzeuge(owner, name, typeof input.laenge === 'number' ? input.laenge : undefined, typeof input.zweck === 'string' ? input.zweck : undefined); }
        catch (err) { return { success: false, error: (err as Error).message }; }
        return { success: true, data: { name }, display: `Tresor-Eintrag ${name} mit Zufallspasswort angelegt (Wert bleibt am Server).` };
      }
      const wortlaut = typeof input.wortlaut === 'string' ? input.wortlaut.trim() : '';
      if (wortlaut.length < 2) return { success: false, error: 'wortlaut: nur auf ausdrücklichen Wunsch des Owners' };
      return (await t.entferne(owner, name)) ? { success: true, display: `Tresor-Eintrag ${name} entfernt.` } : { success: false, error: `Tresor-Eintrag ${name} nicht gefunden` };
    }
    switch (action) {
      case 'vorhaben_anlegen': return this.anlegen(owner, repo, input);
      case 'vorhaben_liste': {
        const l = await repo.liste(owner);
        if (!l.length) return { success: true, data: [], display: 'Noch keine Infrastruktur-Vorhaben.' };
        return { success: true, data: l.map(v => ({ id: v.id, titel: v.titel, status: v.status, hosts: v.hosts })), display: l.map(v => `- **${v.titel}** (${v.id.slice(0, 8)}) — ${STATUS_TEXT[v.status]}; Hosts: ${v.hosts.join(', ')}`).join('\n') };
      }
    }
    const v = await repo.finde(owner, String(input.vorhaben ?? ''));
    if (!v) return { success: false, error: `Vorhaben „${String(input.vorhaben ?? '')}“ nicht gefunden — vorhaben_liste zeigt alle.` };
    switch (action) {
      case 'vorhaben_zeigen': {
        // v1695 (K4) — Architektur abschnittsweise vollständig (statt Dokument lesen oder delegieren)
        if (typeof input.abschnitt === 'string' && input.abschnitt.trim()) {
          const a = (v.architektur ?? {}) as Record<string, unknown>;
          const k = input.abschnitt.trim();
          if (!(k in a)) return { success: false, error: `Abschnitt „${k}“ gibt es nicht — vorhanden: ${Object.keys(a).join(', ') || 'keine gespeicherte Architektur'}` };
          let teil = a[k];
          const von = Number(input.von ?? 1), bis = Number(input.bis ?? 0);
          if (Array.isArray(teil) && (input.von !== undefined || input.bis !== undefined)) teil = teil.slice(Math.max(von, 1) - 1, bis > 0 ? bis : undefined);
          const text = `Architektur Version ${v.architekturVersion} — ${k}${Array.isArray(a[k]) ? ` (${(a[k] as unknown[]).length} Einträge${Array.isArray(teil) && teil !== a[k] ? `, gezeigt ${Math.max(von, 1)}–${Math.max(von, 1) + (teil as unknown[]).length - 1}` : ''})` : ''}\n${JSON.stringify(teil, null, 1)}`;
          return { success: true, data: teil, display: text.length > 11_500 ? `${text.slice(0, 11_500)}\n[… gekürzt — mit von/bis kleinere Teile anfordern]` : text };
        }
        return { success: true, data: v, display: this.zeige(v) };
      }
      case 'soll_ist': {
        if (v.status !== 'angenommen') return { success: false, error: 'Soll/Ist gibt es erst für eine angenommene Zielarchitektur' };
        if (!this.deps.sollIst) return { success: false, error: 'Soll/Ist nicht verfügbar' };
        await this.deps.sollIst.planen(owner, v);
        const r = await this.deps.sollIst.abgleich(owner, v);
        return { success: true, data: r, display: r.text };
      }
      case 'grundlage': {
        const g = await this.grundlage(v.hosts);
        return { success: true, data: g, display: `Vorhaben **${v.titel}** — Ziel: ${v.ziel}\n\n${grundlageText(g)}` };
      }
      case 'architektur_vorschlagen': return this.vorschlagen(owner, repo, v, input.architektur, input.antworten, input.aenderungen);
      case 'entscheiden': return this.entscheiden(owner, repo, v, input);
    }
    return { success: false, error: 'Unbekannte Aktion' };
  }

  private async bestand(input: Record<string, unknown>): Promise<SkillResult> {
    const start = Date.now();
    const quellen = Array.isArray(input.quellen) && input.quellen.length ? input.quellen.filter((q): q is string => typeof q === 'string' && BESTAND_QUELLEN.includes(q)) : BESTAND_QUELLEN;
    const discovery = await this.deps.entdecke(quellen);
    const [vms, proxy, netze, backups, dns] = await Promise.all([
      this.deps.vms().catch(() => []), this.deps.proxy().catch(() => []), this.deps.netze().catch(() => []),
      this.deps.backups?.().catch(() => undefined) ?? Promise.resolve(undefined),
      this.deps.dns?.().catch(() => []) ?? Promise.resolve([]),
    ]);
    const hosts = this.deps.hosts();
    const r = bestandsbericht({ hosts, vms, proxy, netze, ...(backups ? { backups } : {}), ...(dns.length ? { dns } : {}) });
    if (dns.length && this.deps.verknuepfeDns) {
      const { domainsMitDns } = await import('./bericht.js');
      const paare = domainsMitDns(proxy, dns).filter(s => s.eintrag?.assetId && s.proxy.assetId).map(s => ({ dnsAssetId: s.eintrag!.assetId!, proxyAssetId: s.proxy.assetId! }));
      const n = await this.deps.verknuepfeDns(paare).catch(() => 0);
      this.deps.protokoll?.('I1 DNS → Proxy verknüpft', { paare: paare.length, neu: n });
    }
    const titel = `Bestandsbericht ${new Date().toLocaleDateString('de-AT', { timeZone: 'Europe/Vienna' })}`;
    const markdown = `${r.markdown}\n\n## Discovery\n\n${discovery.map(d => `- ${d}`).join('\n')}\n`;
    const docId = await this.deps.speichereBericht(titel, markdown);
    const vollstaendig = new Set(hosts.filter(h => !h.fehler.length).map(h => h.zugang));
    const pr = await this.deps.problems?.(r.auffaelligkeiten, { docId, datum: new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna', dateStyle: 'short', timeStyle: 'short' }) }, { hosts: vollstaendig, alle: vollstaendig.size === hosts.length && !discovery.some(d => /Fehler|error|nicht verfügbar/i.test(d)) }).catch(err => { this.deps.protokoll?.('I4b Problems fehlgeschlagen', { fehler: (err as Error).message }); return undefined; });
    if (pr) this.deps.protokoll?.('I4b Befunde als Problems', { neu: pr.neu.length, bekannt: pr.bekannt, geloest: pr.geloest.length });
    this.deps.protokoll?.('I1 Bestandsaufnahme fertig', { dauerS: Math.round((Date.now() - start) / 1000), hosts: hosts.length, vms: vms.length, auffaelligkeiten: r.auffaelligkeiten.length, docId });
    const top = r.auffaelligkeiten.slice(0, 25).map(a => `- **${a.schwere}** · ${a.bereich}: ${a.text}`);
    return {
      success: true,
      data: { docId, auffaelligkeiten: r.auffaelligkeiten, hosts: hosts.map(h => ({ zugang: h.zugang, container: h.container.length, fehler: h.fehler })), discovery },
      display: `## ${titel}\n\n${r.kurz}${pr ? `\n\nITSM: ${pr.neu.length} neue Problems, ${pr.bekannt} bereits bekannt, ${pr.geloest.length} als gelöst markiert (Sicherungs-Befunde ausgenommen).` : ''}\n\n### Auffälligkeiten\n${top.join('\n') || 'Keine.'}${r.auffaelligkeiten.length > 25 ? `\n… und ${r.auffaelligkeiten.length - 25} weitere im Bericht` : ''}\n\nVollständiger Bericht als CMDB-Dokument (ID ${docId}).\n\n### Discovery\n${discovery.map(d => `- ${d}`).join('\n')}`,
    };
  }

  private async anlegen(owner: string, repo: VorhabenSpeicher, input: Record<string, unknown>): Promise<SkillResult> {
    const titel = typeof input.titel === 'string' ? input.titel.trim() : '';
    const ziel = typeof input.ziel === 'string' ? input.ziel.trim() : '';
    if (titel.length < 3 || ziel.length < 10) return { success: false, error: 'titel und ziel (in den Worten des Owners) angeben' };
    const aktiv = (await this.deps.aktiveZugaenge?.()) ?? [];
    const gewuenscht = Array.isArray(input.hosts) ? input.hosts.filter((h): h is string => typeof h === 'string' && !!h.trim()) : [];
    if (!gewuenscht.length) return { success: false, error: `hosts angeben (Fernzugang-Namen: ${aktiv.join(', ') || 'keine aktiv'})` };
    const hosts: string[] = [];
    for (const h of gewuenscht) {
      const z = aktiv.find(a => a.toLowerCase() === h.trim().toLowerCase());
      if (!z) return { success: false, error: `Kein aktiver Fernzugang „${h}“ (aktiv: ${aktiv.join(', ') || 'keine'})` };
      if (!hosts.includes(z)) hosts.push(z);
    }
    const bestandDocId = await this.deps.letzterBestandDocId?.().catch(() => undefined);
    const v = await repo.anlegen(owner, { titel, ziel, hosts, ...(bestandDocId ? { bestandDocId } : {}) });
    this.deps.protokoll?.('I2 Vorhaben angelegt', { id: v.id, titel, hosts });
    return { success: true, data: { id: v.id }, display: `Vorhaben **${titel}** angelegt (${v.id.slice(0, 8)}), Hosts: ${hosts.join(', ')}.\nNächster Schritt: grundlage, dann architektur_vorschlagen.` };
  }

  /** Planungsgrundlage für die Hosts des Vorhabens; zu alte oder fehlende Host-Bestände werden vorher neu erfasst (nur lesend). */
  private async grundlage(hosts: string[]): Promise<PlanungsGrundlage> {
    const frisch = (b?: HostBestand) => !!b?.erfasst && Date.now() - Date.parse(b.erfasst) < GRUNDLAGE_MAX_ALTER_MS;
    const finde = () => hosts.map(h => this.deps.hosts().find(b => b.zugang.toLowerCase() === h.toLowerCase()));
    if (!finde().every(frisch)) await this.deps.entdecke(['fernzugriff']);
    const bestaende = finde().filter((b): b is HostBestand => !!b);
    const [knoten, speicher, netze, proxy, vms, dns] = await Promise.all([
      this.deps.knoten?.().catch(() => []) ?? Promise.resolve([]), this.deps.speicher?.().catch(() => []) ?? Promise.resolve([]),
      this.deps.netze().catch(() => []), this.deps.proxy().catch(() => []), this.deps.vms().catch(() => []),
      this.deps.dns?.().catch(() => []) ?? Promise.resolve([]),
    ]);
    return planungsGrundlage({ hosts: bestaende, knoten, speicher, netze, proxy, vms, dns });
  }

  private async vorschlagen(owner: string, repo: VorhabenSpeicher, v: VorhabenDaten, roh: unknown, antwortenRoh?: unknown, aenderungen?: unknown): Promise<SkillResult> {
    if (v.status === 'verworfen') return { success: false, error: 'Das Vorhaben ist verworfen.' };
    if (v.status === 'angenommen') return { success: false, error: 'Die Architektur ist bereits angenommen — für eine neue Fassung zuerst entscheiden(ueberarbeiten) auf Wunsch des Owners.' };
    if (!this.deps.speichereArchitektur) return { success: false, error: 'Dokumentablage nicht verfügbar' };
    const ew = this.deps.einwand ? await this.deps.einwand.pruefeAntworten(owner, 'vorhaben', v.id, antwortenRoh) : { fehler: [], antworten: [] };
    if (ew.fehler.length) return { success: false, error: `Offene Einwände des Owners zuerst beantworten:\n${ew.fehler.map(x => `- ${x}`).join('\n')}` };
    const g = await this.grundlage(v.hosts);
    if (!g.hosts.length) return { success: false, error: `Kein Bestand für ${v.hosts.join(', ')} — Fernzugriff prüfen.` };
    let quelle: unknown = typeof roh === 'string' ? (() => { try { return JSON.parse(roh); } catch { return {}; } })() : roh;
    if (aenderungen !== undefined && (quelle === undefined || quelle === null)) {
      const m = mitAenderungen(v.architektur, typeof aenderungen === 'string' ? (() => { try { return JSON.parse(aenderungen); } catch { return null; } })() : aenderungen);
      if ('fehler' in m) return { success: false, error: m.fehler };
      quelle = m.roh;
    }
    const p = pruefeArchitektur(quelle, g, bisherigeFassung(v.architektur));
    if (p.fehler.length) {
      this.deps.protokoll?.('I2 Architektur abgewiesen', { id: v.id, fehler: p.fehler.length, erste: p.fehler.slice(0, 5) });
      return { success: false, error: `Architektur nicht vollständig (${p.fehler.length} Punkte) — bitte nachbessern und erneut senden:\n${p.fehler.map(x => `- ${x}`).join('\n')}` };
    }
    const version = v.architekturVersion + 1;
    const bestandDocId = await this.deps.letzterBestandDocId?.().catch(() => undefined) ?? v.bestandDocId;
    const md = architekturDokument({ titel: v.titel, ziel: v.ziel, id: v.id, version, ...(bestandDocId ? { bestandDocId } : {}) }, p.architektur, g, p.hinweise);
    const docId = await this.deps.speichereArchitektur(v.id, `Zielarchitektur ${v.titel} v${version}`, md);
    await repo.setzeArchitektur(owner, v.id, p.architektur, docId, bestandDocId);
    if (ew.antworten.length) await this.deps.einwand!.speichereAntworten(owner, ew.antworten);
    const einwaende = this.deps.einwand ? await this.deps.einwand.antwortText(owner, 'vorhaben', v.id) : '';
    this.deps.protokoll?.('I2 Architektur vorgeschlagen', { id: v.id, version, docId, gruppen: p.architektur.gruppen.length, neueVms: p.architektur.gruppen.filter(x => x.ziel === 'vm' || x.ziel === 'lxc').length, hinweise: p.hinweise.length });
    return { success: true, data: { docId, version, hinweise: p.hinweise }, display: `${md}\n\n---\n${einwaende ? `${einwaende}\n\n` : ''}Gespeichert als CMDB-Dokument ${docId} (Vorhaben ${v.id.slice(0, 8)}, Version ${version}). Bitte den Owner entscheiden lassen.` };
  }

  private async entscheiden(owner: string, repo: VorhabenSpeicher, v: VorhabenDaten, input: Record<string, unknown>): Promise<SkillResult> {
    const e = String(input.entscheidung ?? '') as 'annehmen' | 'ueberarbeiten' | 'ablehnen';
    const wortlaut = typeof input.wortlaut === 'string' ? input.wortlaut.trim() : '';
    if (!['annehmen', 'ueberarbeiten', 'ablehnen'].includes(e)) return { success: false, error: 'entscheidung: annehmen, ueberarbeiten oder ablehnen' };
    if (wortlaut.length < 2) return { success: false, error: 'wortlaut: die Worte des Owners angeben — ohne ausdrückliche Aussage des Owners nicht entscheiden' };
    if (e === 'annehmen' && v.status !== 'architektur_vorgeschlagen') return { success: false, error: `Annehmen geht nur bei vorgeschlagener Architektur (Stand: ${STATUS_TEXT[v.status]})` };
    if (v.status === 'verworfen') return { success: false, error: 'Das Vorhaben ist bereits verworfen.' };
    const status = e === 'annehmen' ? 'angenommen' : e === 'ablehnen' ? 'verworfen' : 'entwurf';
    if (e === 'annehmen' && this.deps.einwand && (await this.deps.einwand.offen(owner, 'vorhaben', v.id)).length) return { success: false, error: 'Es gibt offene Einwände des Owners zu dieser Architektur — erst überarbeiten und beantworten' };
    const neu = await repo.entscheide(owner, v.id, { entscheidung: e, wortlaut, architekturVersion: v.architekturVersion }, status);
    if (e === 'annehmen') await this.deps.einwand?.erledigeBeantwortete(owner, 'vorhaben', v.id);
    // I4b Teil 5 — angenommene Architektur als Soll-Zustand in die CMDB (geplante VMs)
    if (e === 'annehmen') { const n = await this.deps.sollIst?.planen(owner, neu).catch(() => 0); this.deps.protokoll?.('I4b Soll angelegt', { id: v.id, geplant: n }); }
    this.deps.protokoll?.('I2 Owner-Entscheidung', { id: v.id, entscheidung: e, version: v.architekturVersion });
    const weiter = e === 'annehmen' ? 'Grundlage für die Changes (nächste Ausbaustufe I3: Changes mit Schritten, je Change eigene Freigabe).' : e === 'ueberarbeiten' ? 'Architektur nach den Hinweisen des Owners überarbeiten und erneut mit architektur_vorschlagen senden.' : 'Vorhaben beendet.';
    return { success: true, data: { status: neu.status }, display: `Vorhaben **${v.titel}**: ${STATUS_TEXT[neu.status]} („${wortlaut}“). ${weiter}` };
  }

  private async changeAktion(owner: string, repo: VorhabenSpeicher, action: string, input: Record<string, unknown>): Promise<SkillResult> {
    const ch = this.deps.changes;
    if (!ch) return { success: false, error: 'Change-Planung nicht verfügbar' };
    if (action === 'freigeben') {
      const r = await ch.freigebenNachJa(owner, input);
      return r.ok ? { success: true, display: r.text } : { success: false, error: r.text };
    }
    if (action === 'owner_schritt_erledigt' || action === 'rueckweg_ausfuehren' || action === 'change_steuern') {
      const m = this.deps.motor;
      if (!m) return { success: false, error: 'Ausführungsmotor nicht verfügbar' };
      const c = await ch.finde(owner, String(input.change ?? ''));
      if (!c) return { success: false, error: `Change „${String(input.change ?? '')}“ nicht gefunden` };
      if (action === 'owner_schritt_erledigt') { const t = await m.ownerSchrittErledigt(owner, c.id, Number(input.schritt), input.freigabe); return { success: !/ungültig|Keine offene|ist /.test(t), display: t }; }
      if (action === 'rueckweg_ausfuehren') { const t = await m.rueckwegNachJa(owner, c.id, input.freigabe); return { success: t.startsWith('Rückweg läuft'), display: t }; }
      const wahl = input.wahl === 'wiederholen' || input.wahl === 'abbrechen' || input.wahl === 'rueckweg' || input.wahl === 'ueberspringen' ? input.wahl : undefined;
      const wortlaut = typeof input.wortlaut === 'string' ? input.wortlaut.trim() : '';
      if (!wahl) return { success: false, error: 'wahl: wiederholen, abbrechen, rueckweg oder ueberspringen' };
      if (wortlaut.length < 2) return { success: false, error: 'wortlaut: die Worte des Owners — ohne ausdrückliche Aussage des Owners nicht steuern' };
      this.deps.protokoll?.('I4 Owner steuert Change', { id: c.id, wahl, wortlaut: wortlaut.slice(0, 200) });
      const t = await m.steuern(owner, c.id, wahl);
      return { success: !/nicht angehalten/.test(t), display: t };
    }
    if (action === 'changes_planen') {
      let vorhaben: VorhabenDaten | null = null;
      if (typeof input.vorhaben === 'string' && input.vorhaben.trim()) {
        vorhaben = await repo.finde(owner, input.vorhaben);
        if (!vorhaben) return { success: false, error: `Vorhaben „${input.vorhaben}“ nicht gefunden` };
      }
      const plaene = Array.isArray(input.changes) ? input.changes : typeof input.changes === 'string' ? (() => { try { const x = JSON.parse(input.changes as string); return Array.isArray(x) ? x : []; } catch { return []; } })() : [];
      const r = await ch.planen(owner, plaene, vorhaben ? { id: vorhaben.id, status: vorhaben.status, titel: vorhaben.titel } : undefined);
      if (!r.ok) {
        this.deps.protokoll?.('I3 Changes abgewiesen', { fehler: r.fehler.length, erste: r.fehler.slice(0, 5) });
        return { success: false, error: `Changes nicht gespeichert (${r.fehler.length} Punkte) — bitte nachbessern und das ganze Paket erneut senden:\n${r.fehler.map(x => `- ${x}`).join('\n')}` };
      }
      if (vorhaben) await repo.fuegeChangesHinzu?.(owner, vorhaben.id, r.changes.map(c => c.id));
      return {
        success: true, data: r.changes.map(c => ({ id: c.id, titel: c.title, fingerabdruck: c.fingerabdruck })),
        display: `${r.changes.length} Change${r.changes.length > 1 ? 's' : ''} geplant und geprüft (nichts ausgeführt):\n${r.changes.map(c => `- **${c.title}** (${c.id.slice(0, 8)}) — ${(c.schritte ?? []).length} Schritte${c.pruefung?.hinweise.length ? `; Hinweise: ${c.pruefung.hinweise.join('; ')}` : ''}`).join('\n')}\n\nZur Freigabe: freigabe_anfragen mit den IDs (der Owner bestätigt per Button). Ansicht auch im Web unter ITSM → Changes.`,
      };
    }
    if (action === 'changes_liste') {
      let l = (await ch.liste(owner)).filter(c => c.schritte?.length);
      if (typeof input.vorhaben === 'string' && input.vorhaben.trim()) { const v = await repo.finde(owner, input.vorhaben); l = l.filter(c => c.vorhabenId === v?.id); }
      return { success: true, data: l.map(c => ({ id: c.id, titel: c.title, status: c.status })), display: l.length ? l.map(c => `- **${c.title}** (${c.id.slice(0, 8)}) — ${c.status}, ${(c.schritte ?? []).length} Schritte${c.vorhabenId ? `, Vorhaben ${c.vorhabenId.slice(0, 8)}` : ''}`).join('\n') : 'Keine Changes mit Schritten.' };
    }
    if (action === 'change_zeigen') {
      const c = await ch.finde(owner, String(input.change ?? ''));
      if (!c) return { success: false, error: `Change „${String(input.change ?? '')}“ nicht gefunden` };
      // v1695 (K4) — einzelne Schritte vollständig (Realfall 27.10.: Übersicht abgeschnitten → Rückfrage „vollständige Schrittobjekte bereitstellen“)
      if (Array.isArray(input.nur_schritte)) {
        const nrn = new Set(input.nur_schritte.map(Number));
        const gefunden = ((c.schritte ?? []) as Array<{ nr: number }>).filter(x => nrn.has(x.nr));
        if (!gefunden.length) return { success: false, error: `Change ${c.id.slice(0, 8)} hat keinen der Schritte ${[...nrn].join(', ')} (1–${(c.schritte ?? []).length})` };
        const text = gefunden.map(x => `### Schritt ${x.nr}\n${JSON.stringify(x, null, 1)}`).join('\n\n');
        return { success: true, data: gefunden, display: text.length > 11_500 ? `${text.slice(0, 11_500)}\n[… gekürzt — weniger Schritte je Aufruf anfordern]` : text };
      }
      const anzeige = c.schritte?.length ? changeAnzeige(c) : `${c.title} (${c.status}) — ohne Schritte`;
      return { success: true, data: c, display: anzeige.length > 11_000 ? `${anzeige}\n\n[Hinweis: lange Übersicht — einzelne Schritte vollständig mit change_zeigen nur_schritte=[nr…]]` : anzeige };
    }
    if (action === 'change_aendern') {
      let plan: unknown = typeof input.plan === 'string' ? (() => { try { return JSON.parse(input.plan as string); } catch { return {}; } })() : input.plan;
      // v1680 — gezielte Schritt-Änderungen statt vollständigem Plan
      // v1701 — Realfall 28.10. (I9 umterminieren): geplant_ab allein ändern ging nur mit vollständigem Plan
      if (!plan && (input.schritte_ersetzen !== undefined || input.schritte_einfuegen !== undefined || input.text_ersetzen !== undefined || input.geplant_ab !== undefined)) {
        const c = await ch.finde(owner, String(input.change ?? ''));
        if (!c?.schritte?.length) return { success: false, error: `Change „${String(input.change ?? '')}“ nicht gefunden oder ohne Schritte` };
        const m = planMitSchrittAenderungen(planAusChange(c), input.schritte_ersetzen, input.schritte_einfuegen, input.text_ersetzen);
        if ('fehler' in m) return { success: false, error: `Änderung nicht gespeichert:\n${m.fehler.map(x => `- ${x}`).join('\n')}` };
        plan = m.plan;
        if (typeof input.geplant_ab === 'string' && input.geplant_ab.trim()) (plan as Record<string, unknown>).geplantAb = input.geplant_ab.trim();
      }
      const r = await ch.aendern(owner, String(input.change ?? ''), plan, input.antworten);
      if (!r.ok) return { success: false, error: `Änderung nicht gespeichert:\n${r.fehler.map(x => `- ${x}`).join('\n')}` };
      return { success: true, data: { id: r.change.id, status: r.change.status }, display: `Change **${r.change.title}** geändert (Plan ${r.change.fingerabdruck?.slice(0, 12)}).${r.freigabeVerfallen ? ' Die bisherige Freigabe ist verfallen — neue Freigabe nötig.' : ''}` };
    }
    if (action === 'freigabe_anfragen') {
      const ids = (Array.isArray(input.ids) ? input.ids : Array.isArray(input.changes) ? input.changes : typeof input.change === 'string' ? [input.change] : []).map(x => typeof x === 'string' ? x : String((x as { id?: string })?.id ?? '')).filter(Boolean);
      if (!ids.length) return { success: false, error: 'ids (Change-IDs) angeben' };
      const r = await ch.freigabeAnfragen(owner, ids);
      return r.ok ? { success: true, display: r.text } : { success: false, error: r.fehler.join('\n') };
    }
    return { success: false, error: 'Unbekannte Aktion' };
  }

  private async wartungAktion(owner: string, action: string, input: Record<string, unknown>): Promise<SkillResult> {
    const w = this.deps.wartung;
    if (!w) return { success: false, error: 'Wartungskalender nicht verfügbar' };
    const geltung = async (): Promise<{ g: { global?: boolean; assetIds?: string[] }; text: string } | string> => {
      const fuer = Array.isArray(input.fuer) ? input.fuer.filter((x): x is string => typeof x === 'string' && !!x.trim() && x.trim().toLowerCase() !== 'global') : [];
      if (!fuer.length) return { g: { global: true }, text: 'alle Changes' };
      if (!this.deps.changes) return 'Asset-Auflösung nicht verfügbar';
      const r = await this.deps.changes.loeseAssets(owner, fuer);
      return r.fehler.length ? r.fehler.join('; ') : { g: { assetIds: r.ids }, text: r.namen.join(', ') };
    };
    if (action === 'wartung_liste') {
      const [k, r] = await Promise.all([w.kalender(owner), w.regeln(owner)]);
      const z = ['### Wartungsfenster', ...k.filter(e => e.art === 'fenster').map(e => `- ${e.aktiv ? '' : '(aus) '}**${e.name}** — ${regelText(e.regel)} · ${e.geltung.global ? 'global' : `${(e.geltung.assetIds ?? []).length} Assets`} · ${e.id.slice(0, 8)}`), '', '### Sperrzeiten', ...k.filter(e => e.art === 'sperre').map(e => `- ${e.aktiv ? '' : '(aus) '}**${e.name}** — ${regelText(e.regel)} · ${e.geltung.global ? 'global' : `${(e.geltung.assetIds ?? []).length} Assets`} · ${e.id.slice(0, 8)}`), '', '### Benachrichtigungen', ...r.map(x => `- ${x.aktiv ? '' : '(aus) '}**${x.name}** — ${x.empfaenger.map(e => e.name ?? e.art).join(', ')} über ${x.kanaele.join('/')} · ${x.zeitpunkte.join(', ')} · ${x.geltung.global ? 'global' : `${(x.geltung.assetIds ?? []).length} Assets`} · ${x.id.slice(0, 8)}`)];
      if (!k.some(e => e.art === 'fenster')) z.push('', 'Ohne Wartungsfenster dürfen freigegebene Changes jederzeit starten (außer in Sperrzeiten).');
      return { success: true, data: { kalender: k, regeln: r }, display: z.join('\n') };
    }
    if (action === 'fenster_anlegen' || action === 'sperre_anlegen') {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (name.length < 2) return { success: false, error: 'name fehlt' };
      const rf = regelFehler(input.regel);
      if (rf) return { success: false, error: `regel: ${rf}` };
      const g = await geltung(); if (typeof g === 'string') return { success: false, error: g };
      const art = action === 'fenster_anlegen' ? 'fenster' : 'sperre';
      const id = await w.kalenderAnlegen(owner, { art, name, geltung: g.g, regel: input.regel, ...(typeof input.notiz === 'string' ? { notiz: input.notiz } : {}) });
      this.deps.protokoll?.('I4b Kalender angelegt', { id, art, name });
      return { success: true, data: { id }, display: `${art === 'fenster' ? 'Wartungsfenster' : 'Sperrzeit'} **${name}** angelegt: ${regelText(input.regel as never)}, gilt für ${g.text} (${id.slice(0, 8)}).` };
    }
    if (action === 'benachrichtigung_anlegen') {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      const kanaele = (Array.isArray(input.kanaele) ? input.kanaele : []).filter((k): k is Kanal => (KANAELE as readonly string[]).includes(String(k)));
      const zeitpunkte = (Array.isArray(input.zeitpunkte) ? input.zeitpunkte : []).filter((z): z is Zeitpunkt => (ZEITPUNKTE as readonly string[]).includes(String(z)));
      if (name.length < 2 || !kanaele.length || !zeitpunkte.length) return { success: false, error: `name, kanaele (${KANAELE.join('/')}) und zeitpunkte (${ZEITPUNKTE.join('/')}) angeben` };
      const empfaenger: Empfaenger[] = [];
      for (const e0 of Array.isArray(input.empfaenger) ? input.empfaenger : []) {
        const e = (e0 ?? {}) as Record<string, unknown>;
        const art = e.art === 'nutzer' || e.art === 'kontakt' ? e.art : 'owner';
        const basis: Empfaenger = { art, ...(typeof e.name === 'string' && e.name.trim() ? { name: e.name.trim() } : {}), ...(typeof e.email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.email.trim()) ? { email: e.email.trim() } : {}), ...(typeof e.haDienst === 'string' && /^[\w.]+$/.test(e.haDienst.trim()) ? { haDienst: e.haDienst.trim() } : {}) };
        if (art === 'nutzer') {
          const n = basis.name ? await this.deps.nutzerAufloesen?.(basis.name) : undefined;
          if (!n || 'unbekannt' in n) return { success: false, error: `Alfred-Benutzer „${basis.name ?? '?'}“ nicht gefunden${n && 'unbekannt' in n ? ` — vorhanden: ${n.unbekannt.join(', ')}` : ''}` };
          Object.assign(basis, { userId: n.userId, name: n.name, konten: n.konten, ...(n.konten.telegram ? { telegramId: n.konten.telegram } : {}) });
        }
        if (!erreichbar(basis, kanaele)) return { success: false, error: `${basis.name ?? art} ist über ${kanaele.join('/')} nicht erreichbar (owner: push/telegram; nutzer: telegram/matrix mit verknüpftem Konto${basis.konten ? ` — verknüpft: ${Object.keys(basis.konten).join(', ') || 'keins'}` : ''}, email, homeassistant mit haDienst; kontakt: email oder haDienst)` };
        empfaenger.push(basis);
      }
      if (!empfaenger.length) return { success: false, error: 'empfaenger fehlt' };
      const g = await geltung(); if (typeof g === 'string') return { success: false, error: g };
      const id = await w.regelAnlegen(owner, { name, geltung: g.g, empfaenger, kanaele, zeitpunkte });
      this.deps.protokoll?.('I4b Benachrichtigung angelegt', { id, name, empfaenger: empfaenger.map(e => e.name ?? e.art), kanaele, zeitpunkte });
      return { success: true, data: { id }, display: `Benachrichtigung **${name}** angelegt: ${empfaenger.map(e => e.name ?? e.art).join(', ')} über ${kanaele.join('/')} — ${zeitpunkte.join(', ')}; gilt für ${g.text} (${id.slice(0, 8)}).` };
    }
    if (action === 'wartung_entfernen') {
      const k = String(input.id ?? '').trim();
      const alle = [...(await w.kalender(owner)).map(e => e.id), ...(await w.regeln(owner)).map(r => r.id)];
      const treffer = alle.filter(x => x === k || (k.length >= 6 && x.startsWith(k)));
      if (treffer.length !== 1) return { success: false, error: `Eintrag „${k}“ nicht eindeutig gefunden` };
      await w.entferne(owner, treffer[0]!);
      return { success: true, display: `Eintrag ${treffer[0]!.slice(0, 8)} entfernt.` };
    }
    return { success: false, error: 'Unbekannte Aktion' };
  }

  private async standardAktion(owner: string, action: string, input: Record<string, unknown>): Promise<SkillResult> {
    const st = this.deps.standard;
    if (!st) return { success: false, error: 'Standard-Changes nicht verfügbar' };
    const key = typeof input.vorlage === 'string' ? input.vorlage.trim() : '';
    const wortlaut = typeof input.wortlaut === 'string' ? input.wortlaut.trim() : '';
    if (action === 'standard_liste') {
      const l = await st.liste(owner);
      const sch = await this.deps.updatesSchalter?.liste(owner).catch(() => ({})) ?? {};
      return { success: true, data: { vorlagen: l, updatesSchalter: sch }, display: [...l.map(v => `- **${v.titel}** (${v.key}) — ${v.zustand}${v.laeufe !== undefined ? ` · ${v.laeufe} erfolgreiche Läufe${v.letzterLauf ? `, zuletzt ${v.letzterLauf.slice(0, 10)}` : ''}` : ''}\n  ${v.beschreibung}${v.annahmen?.length ? `\n  Annahmen (Eingangskontrolle): ${v.annahmen.join('; ')}` : ''}${Object.keys(v.parameter).length ? `\n  Parameter: ${Object.entries(v.parameter).map(([k, t]) => `${k} = ${t}`).join('; ')}` : ''}`), '', `Sicherheitsupdates je Host: ${Object.entries(sch).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}`].join('\n') };
    }
    if (action === 'standard_freigabe_anfragen') { const t = await st.freigabeAnfragen(owner, key); return { success: t.startsWith('Freigabe-Frage'), display: t }; }
    if (action === 'standard_freigeben') { const r = await st.freigebenNachJa(owner, key, input.freigabe); return r.ok ? { success: true, display: r.text } : { success: false, error: r.text }; }
    if (action === 'standard_widerrufen') {
      if (wortlaut.length < 2) return { success: false, error: 'wortlaut: die Worte des Owners' };
      return { success: true, display: await st.widerrufen(owner, key) };
    }
    if (action === 'updates_schalter') {
      const z = typeof input.zugang === 'string' ? input.zugang.trim() : '';
      if (wortlaut.length < 2) return { success: false, error: 'wortlaut: die Worte des Owners — den Schalter stellt nur der Owner' };
      if (!z || typeof input.an !== 'boolean') return { success: false, error: 'zugang und an (true/false) angeben' };
      const ok = await this.deps.updatesSchalter?.setze(owner, z, input.an);
      this.deps.protokoll?.('I4b Updates-Schalter', { zugang: z, an: input.an, wortlaut: wortlaut.slice(0, 200) });
      return ok ? { success: true, display: `Sicherheitsupdates für ${z}: ${input.an ? 'an — Alfred darf sie als Standard-Change (c) einspielen, wenn die Vorlage freigegeben ist' : 'aus — nur Info'}.` } : { success: false, error: `Fernzugang ${z} nicht gefunden` };
    }
    if (action === 'standard_change') {
      const p = input.parameter && typeof input.parameter === 'object' ? input.parameter as Record<string, unknown> : {};
      const r = await st.anlegen(owner, key, p);
      if (!r.ok) return { success: false, error: `Kein Standard-Change: ${r.fehler.join('; ')}` };
      return { success: true, data: { id: r.change.id, status: r.change.status }, display: `Standard-Change **${r.change.title}** (${r.change.id.slice(0, 8)}) angelegt und durch die Vorlage freigegeben — der Motor startet ihn nach Zeitplan (Wartungsfenster/Sperrzeiten) und meldet das Ergebnis.` };
    }
    // S4 — Serie über mehrere Hosts mit EINER Freigabe-Frage (Owner 27.10.: ein Ja je Serie)
    if (action === 'standard_serie') {
      const p = input.parameter && typeof input.parameter === 'object' ? input.parameter as Record<string, unknown> : {};
      const zugaenge = Array.isArray(input.zugaenge) ? input.zugaenge.filter((x): x is string => typeof x === 'string' && !!x.trim()) : undefined;
      const r = await st.serie(owner, key, { ...(zugaenge?.length ? { zugaenge } : {}), parameter: p, ...(typeof input.geplant_ab === 'string' && input.geplant_ab.trim() ? { geplantAb: input.geplant_ab.trim() } : {}) });
      if (!r.ok) return { success: false, error: `Keine Serie: ${r.fehler.join('; ')}` };
      return { success: true, data: { ids: r.ids }, display: r.text };
    }
    return { success: false, error: 'Unbekannte Aktion' };
  }

  private async einwandAktion(owner: string, repo: VorhabenSpeicher, action: string, input: Record<string, unknown>): Promise<SkillResult> {
    const ew = this.deps.einwand;
    if (!ew) return { success: false, error: 'Einwände nicht verfügbar' };
    const ziel = async (): Promise<{ art: 'change' | 'vorhaben'; id: string; titel: string } | string> => {
      if (typeof input.change === 'string' && input.change.trim()) {
        const c = await this.deps.changes?.finde(owner, input.change.trim());
        return c ? { art: 'change', id: c.id, titel: c.title } : `Change „${input.change}“ nicht gefunden`;
      }
      if (typeof input.vorhaben === 'string' && input.vorhaben.trim()) {
        const v = await repo.finde(owner, input.vorhaben.trim());
        return v ? { art: 'vorhaben', id: v.id, titel: v.titel } : `Vorhaben „${input.vorhaben}“ nicht gefunden`;
      }
      return 'change oder vorhaben angeben';
    };
    const z = await ziel();
    if (typeof z === 'string') return { success: false, error: z };
    if (action === 'einwaende') {
      const l = await ew.liste(owner, z.art, z.id);
      return { success: true, data: l, display: l.length ? l.map(e => `- ${e.status === 'offen' ? '🟠 offen' : e.status === 'beantwortet' ? '🔵 beantwortet' : '✅ erledigt'} · ${e.bezug}: „${e.text}“${e.antwort ? ` → ${e.antwortArt}: ${e.antwort}` : ''} (${e.id.slice(0, 8)})`).join('\n') : `Keine Einwände zu ${z.titel}.` };
    }
    const text = typeof input.text === 'string' ? input.text.trim() : typeof input.wortlaut === 'string' ? input.wortlaut.trim() : '';
    const quelle = typeof input.quelle === 'string' && ['chat', 'web', 'app'].includes(input.quelle) ? input.quelle : 'chat';
    try {
      const r = await ew.erfasse(owner, { zielArt: z.art, zielId: z.id, ...(typeof input.bezug === 'string' ? { bezug: input.bezug } : {}), text, quelle });
      const folge = z.art === 'change' ? (r.folge === 'draft' ? 'Der Change ist zurück im Entwurf, eine Freigabe ist verfallen.' : `Der Change ist ${r.folge} — der Einwand ist vermerkt${r.folge === 'in_progress' ? '; zum Stoppen „abbrechen“' : ''}.`) : 'Das Vorhaben ist zurück im Entwurf.';
      return { success: true, data: { id: r.einwand.id }, display: `Einwand zu **${z.titel}** (${r.einwand.bezug}) erfasst: „${r.einwand.text}“. ${folge} Beim Überarbeiten muss Alfred ihn beantworten.` };
    } catch (err) { return { success: false, error: (err as Error).message }; }
  }

  private zeige(v: VorhabenDaten): string {
    const z = [`## ${v.titel}`, '', `**Ziel:** ${v.ziel}`, `**Status:** ${STATUS_TEXT[v.status]}`, `**Hosts:** ${v.hosts.join(', ')}`, `**ID:** ${v.id}`];
    if (v.bestandDocId) z.push(`**Bestandsbericht:** ${v.bestandDocId}`);
    if (v.architekturDocId) z.push(`**Architektur:** Version ${v.architekturVersion}, Dokument ${v.architekturDocId}`);
    if (v.entscheidungen.length) z.push('', '**Entscheidungen:**', ...v.entscheidungen.map(e => `- ${e.zeit.slice(0, 16).replace('T', ' ')} UTC · ${e.entscheidung} (Version ${e.architekturVersion}): „${e.wortlaut}“`));
    if (v.changeIds.length) z.push('', `**Changes:** ${v.changeIds.join(', ')}`);
    return z.join('\n');
  }
}
