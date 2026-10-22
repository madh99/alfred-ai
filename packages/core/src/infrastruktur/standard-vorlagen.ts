/**
 * Spec Infrastruktur-Vorhaben, I4b Teil 4 (Owner 22.10.2026: Standard-Changes „wie vorgeschlagen“, 5b-11 a–g) — vorab freigegebene
 * Vorlagen. Der Owner gibt jede Vorlage EINMAL frei (Button, an Schlüssel+Version gebunden, einzeln widerrufbar); danach darf Alfred
 * daraus innerhalb fester Grenzen Changes ohne Einzel-Ja anlegen. Jeder so erzeugte Change durchläuft dieselbe Planprüfung und
 * denselben Motor (Wartungsfenster, Sperrzeiten, Ankündigung). Die Grenzen prüft die Vorlage selbst, ohne Modell.
 *
 * Nie Standard (5b-11): Firewall/DNS/Netz/VLAN, Datenbanken, Datenlöschung, Hauptversions-Upgrades, Migrationen, Windows-Neustarts.
 */
import { createHash } from 'node:crypto';
import { LINUX_BEFEHLE } from './sammler.js';

export interface StandardKontext {
  vm(nameOderId: string): Promise<{ assetId: string; vmid: number; node: string; name: string } | { fehler: string }>;
  /** Proxmox-VM, auf der ein Fernzugang läuft (gleiche IP) */
  vmFuerZugang(zugang: string): Promise<{ assetId: string; vmid: number; node: string; name: string } | undefined>;
  zugangAsset(zugang: string): Promise<string | undefined>;
  container(zugang: string, name: string): { image: string; gesundheit?: string; zustand: string; composeProjekt?: string; composeDienst?: string; composeDatei?: string } | undefined;
  snapshots(vmid: number, node: string): Promise<Array<{ name: string }>>;
  /** Schalter „Sicherheitsupdates automatisch“ je Fernzugang (5b-8) */
  updatesAn(zugang: string): Promise<boolean>;
  /** Anzahl Standard-Changes dieser Vorlage mit diesem Merkmal seit `seit` */
  anzahl(vorlage: string, merkmal: string, seit: number): Promise<number>;
  jetzt: Date;
}

export interface Vorlage {
  key: string; version: number; titel: string;
  /** Was die Vorlage tut und welche Grenzen gelten (steht in der Freigabe-Frage) */
  beschreibung: string;
  parameter: Record<string, string>;
  verfuegbar: boolean; folgt?: string;
  erzeuge?(p: Record<string, unknown>, k: StandardKontext): Promise<{ plan: Record<string, unknown>; merkmal: string } | { fehler: string }>;
}

const DB_ODER_HA = /(postgres|mysql|mariadb|mongo|redis|valkey|influx|timescale|clickhouse|elasticsearch|opensearch|cassandra|home-?assistant|homeassistant|zigbee2mqtt|mosquitto)/i;
const NAME = /^[\w.-]{1,80}$/;
const PFAD = /^\/[\w./-]{1,200}$/;
const tag = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
const txt = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Snapshot-Name der Vorlage a: alfred_JJJJMMTT_<Tage>d (Proxmox erlaubt Buchstaben, Ziffern, _ und -) */
export function snapshotName(d: Date, tage: number): string { return `alfred_${tag(d)}_${tage}d`; }
export function snapshotAbgelaufen(name: string, jetzt: Date): boolean {
  const m = /^alfred_(\d{4})(\d{2})(\d{2})_(\d{1,2})d$/.exec(name);
  if (!m) return false;
  const ende = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + Number(m[4]) * 86_400_000;
  return jetzt.getTime() >= ende;
}
/** Tag mit festgelegter Hauptversion (z. B. 2, 2.3, 16-alpine, v1.4) — nicht latest/leer */
export function hauptversionFest(image: string): boolean {
  const t = image.replace(/@sha256:.*$/, '').split('/').pop()!.split(':')[1];
  return !!t && t !== 'latest' && /^v?\d+/.test(t);
}

export const VORLAGEN: Vorlage[] = [
  {
    key: 'snapshot_anlegen', version: 1, titel: '(a) Snapshot anlegen',
    beschreibung: 'Proxmox-Snapshot einer VM mit Namen alfred_JJJJMMTT_<Tage>d anlegen und prüfen. Haltbarkeit 1–14 Tage; abgelaufene löscht die Vorlage „snapshot_aufraeumen“. Kein Ausfall.',
    parameter: { vm: 'VM-Name oder VM-Nummer', tage: 'Haltbarkeit 1–14 (Standard 7)' }, verfuegbar: true,
    async erzeuge(p, k) {
      const vm = await k.vm(txt(p.vm) || String(p.vm ?? '')); if ('fehler' in vm) return vm;
      const tage = Number(p.tage ?? 7);
      if (!Number.isInteger(tage) || tage < 1 || tage > 14) return { fehler: 'tage 1–14' };
      const name = snapshotName(k.jetzt, tage);
      return { merkmal: `${vm.vmid}`, plan: {
        titel: `Standard: Snapshot ${name} für ${vm.name}`, begruendung: `Standard-Change (a) — Sicherungspunkt für ${vm.name}, haltbar ${tage} Tage.`, typ: 'normal', risiko: 'niedrig', ausfallMinuten: 0, betroffen: [vm.assetId],
        schritte: [
          { titel: 'VM-Zustand lesen', art: 'aktion', skill: 'proxmox', aktion: 'vm_status', parameter: { vmid: vm.vmid, node: vm.node } },
          { titel: `Snapshot ${name} anlegen`, art: 'aktion', skill: 'proxmox', aktion: 'create_snapshot', parameter: { vmid: vm.vmid, node: vm.node, name, description: `Alfred Standard-Change, haltbar ${tage} Tage` }, pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'list_snapshots', parameter: { vmid: vm.vmid, node: vm.node }, erwartet: name }, rueckweg: { skill: 'proxmox', aktion: 'delete_snapshot', parameter: { vmid: vm.vmid, node: vm.node, name } } },
        ] } };
    },
  },
  {
    key: 'snapshot_aufraeumen', version: 1, titel: '(a) Eigene abgelaufene Snapshots löschen',
    beschreibung: 'Löscht auf einer VM nur Snapshots, die Alfred selbst angelegt hat (Name alfred_JJJJMMTT_<Tage>d) und deren Haltbarkeit abgelaufen ist. Fremde Snapshots werden nie berührt. Kein Ausfall.',
    parameter: { vm: 'VM-Name oder VM-Nummer' }, verfuegbar: true,
    async erzeuge(p, k) {
      const vm = await k.vm(txt(p.vm) || String(p.vm ?? '')); if ('fehler' in vm) return vm;
      const alt = (await k.snapshots(vm.vmid, vm.node)).map(s => s.name).filter(n => snapshotAbgelaufen(n, k.jetzt));
      if (!alt.length) return { fehler: `Keine abgelaufenen Alfred-Snapshots auf ${vm.name}` };
      return { merkmal: `${vm.vmid}`, plan: {
        titel: `Standard: abgelaufene Alfred-Snapshots auf ${vm.name} löschen`, begruendung: `Standard-Change (a) — ${alt.length} eigene Snapshots abgelaufen: ${alt.join(', ')}.`, typ: 'normal', risiko: 'niedrig', ausfallMinuten: 0, betroffen: [vm.assetId],
        ohneSicherungGrund: 'löscht nur eigene, abgelaufene Snapshots',
        schritte: alt.map(n => ({ titel: `Snapshot ${n} löschen`, art: 'aktion', skill: 'proxmox', aktion: 'delete_snapshot', parameter: { vmid: vm.vmid, node: vm.node, name: n }, pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'list_snapshots', parameter: { vmid: vm.vmid, node: vm.node }, nichtEnthalten: n }, rueckweg: { keiner: 'abgelaufener Alfred-Snapshot' } })),
      } };
    },
  },
  { key: 'vorlage_neu_bauen', version: 1, titel: '(b) Vorlage neu bauen', beschreibung: 'Cloud-Init-Vorlage neu bauen.', parameter: {}, verfuegbar: false, folgt: 'mit I5 (Vorlagen-Fabrik)' },
  {
    key: 'sicherheitsupdates', version: 1, titel: '(c) Sicherheitsupdates einspielen',
    beschreibung: 'Nur für Hosts mit Schalter „Sicherheitsupdates an“, die als Proxmox-VM laufen: Snapshot (3 Tage) → apt-get update → unattended-upgrade (nur Sicherheitsquellen) → Prüfung, dass keine Sicherheitsupdates offen sind, und Erreichbarkeit. Rückweg: Snapshot zurücksetzen. Im Wartungsfenster. Kein Neustart.',
    parameter: { zugang: 'Fernzugang-Name' }, verfuegbar: true,
    async erzeuge(p, k) {
      const z = txt(p.zugang);
      if (!NAME.test(z)) return { fehler: 'zugang fehlt' };
      if (!(await k.updatesAn(z))) return { fehler: `Schalter „Sicherheitsupdates“ ist für ${z} aus — nur Info (Owner 22.10.)` };
      const vm = await k.vmFuerZugang(z);
      if (!vm) return { fehler: `${z} läuft nicht als Proxmox-VM — ohne Snapshot kein Standard-Change (Proxmox-Knoten nur als Normal-Change)` };
      const snap = snapshotName(k.jetzt, 3);
      const rueck = { skill: 'proxmox', aktion: 'rollback_snapshot', parameter: { vmid: vm.vmid, node: vm.node, name: snap } };
      return { merkmal: z, plan: {
        titel: `Standard: Sicherheitsupdates ${z}`, begruendung: `Standard-Change (c) — Sicherheitsupdates auf ${z} (VM ${vm.vmid}), Snapshot ${snap} als Rückweg.`, typ: 'normal', risiko: 'mittel', ausfallMinuten: 5, betroffen: [vm.assetId, ...((await k.zugangAsset(z)) ? [(await k.zugangAsset(z))!] : [])],
        schritte: [
          { titel: `Snapshot ${snap}`, art: 'aktion', skill: 'proxmox', aktion: 'create_snapshot', parameter: { vmid: vm.vmid, node: vm.node, name: snap, description: 'Alfred Standard-Change Sicherheitsupdates, haltbar 3 Tage' }, pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'list_snapshots', parameter: { vmid: vm.vmid, node: vm.node }, erwartet: snap }, rueckweg: { skill: 'proxmox', aktion: 'delete_snapshot', parameter: { vmid: vm.vmid, node: vm.node, name: snap } } },
          { titel: 'Paketlisten aktualisieren', art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: z, befehl: 'apt-get update' }, pruefung: { typ: 'befehl', zugang: z, befehl: 'apt list --upgradable' }, rueckweg: rueck, zeitlimitS: 600 },
          { titel: 'Sicherheitsupdates einspielen', art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: z, befehl: 'unattended-upgrade -v' }, pruefung: { typ: 'befehl', zugang: z, befehl: 'apt list --upgradable', nichtEnthalten: '-security' }, rueckweg: rueck, zeitlimitS: 3600 },
          { titel: 'Host erreichbar', art: 'pruefung', pruefung: { typ: 'befehl', zugang: z, befehl: 'uptime' } },
        ] } };
    },
  },
  {
    key: 'image_aktualisieren', version: 1, titel: '(d) Container-Image derselben Hauptversion aktualisieren',
    beschreibung: 'Nur Compose-Dienste mit Healthcheck und festgelegter Hauptversion im Tag (nicht latest), nie Datenbanken oder Home Assistant: altes Image merken → pull + up -d des Dienstes → warten bis healthy. Rückweg: altes Image zurücktaggen und den Dienst neu starten.',
    parameter: { zugang: 'Fernzugang-Name', container: 'Containername' }, verfuegbar: true,
    async erzeuge(p, k) {
      const z = txt(p.zugang), name = txt(p.container);
      if (!NAME.test(z) || !NAME.test(name)) return { fehler: 'zugang und container angeben' };
      const c = k.container(z, name);
      if (!c) return { fehler: `Container ${name} auf ${z} nicht im Bestand` };
      if (DB_ODER_HA.test(c.image) || DB_ODER_HA.test(name)) return { fehler: 'Datenbanken und Home Assistant sind nie Standard-Changes' };
      if (!c.gesundheit) return { fehler: `${name} hat keinen Healthcheck — ohne Prüfung kein Standard-Change` };
      if (!hauptversionFest(c.image)) return { fehler: `Image ${c.image} hat keine festgelegte Hauptversion (latest) — als Normal-Change planen` };
      if (!c.composeProjekt || !c.composeDienst || !c.composeDatei || !PFAD.test(c.composeDatei) || !NAME.test(c.composeProjekt) || !NAME.test(c.composeDienst)) return { fehler: `${name} ist kein Compose-Dienst mit bekannter Datei` };
      const dc = `docker compose -f ${c.composeDatei} -p ${c.composeProjekt}`;
      const bild = c.image.replace(/@sha256:.*$/, '');
      return { merkmal: `${z}:${name}`, plan: {
        titel: `Standard: Image ${bild} für ${name} aktualisieren`, begruendung: `Standard-Change (d) — gleiche Hauptversion (${bild}), Rückweg über das alte Image.`, typ: 'normal', risiko: 'niedrig', ausfallMinuten: 2,
        betroffen: [...((await k.zugangAsset(z)) ? [(await k.zugangAsset(z))!] : [])], ohneSicherungGrund: 'das alte Image bleibt lokal erhalten (Rückweg per docker tag)',
        schritte: [
          { titel: 'Altes Image merken', art: 'aktion', skill: 'fernzugriff', aktion: 'lesen', parameter: { name: z, befehl: `docker inspect --format "{{.Image}}" ${name}` } },
          { titel: 'Image holen und Dienst neu erstellen', art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: z, befehl: `${dc} pull ${c.composeDienst} && ${dc} up -d ${c.composeDienst}` }, pruefung: { typ: 'befehl', zugang: z, befehl: LINUX_BEFEHLE.docker, erwartet: name }, rueckweg: { skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: z, befehl: `docker tag {{schritt1.ausgabe}} ${bild} && ${dc} up -d ${c.composeDienst}` } }, zeitlimitS: 900, beiFehler: 'rueckweg' },
          { titel: 'Warten bis healthy', art: 'warten', pruefung: { typ: 'container_healthy', zugang: z, container: name }, zeitlimitS: 300 },
        ] } };
    },
  },
  {
    key: 'neustart_unhealthy', version: 1, titel: '(e) Container bei „unhealthy“ neu starten',
    beschreibung: 'Nur wenn der Container laut letztem Bestand unhealthy ist, höchstens 1× je Tag und Container, nie Datenbanken oder Home Assistant: docker restart → warten bis healthy (5 min). Kein Rückweg nötig.',
    parameter: { zugang: 'Fernzugang-Name', container: 'Containername' }, verfuegbar: true,
    async erzeuge(p, k) {
      const z = txt(p.zugang), name = txt(p.container);
      if (!NAME.test(z) || !NAME.test(name)) return { fehler: 'zugang und container angeben' };
      const c = k.container(z, name);
      if (!c) return { fehler: `Container ${name} auf ${z} nicht im Bestand` };
      if (DB_ODER_HA.test(c.image) || DB_ODER_HA.test(name)) return { fehler: 'Datenbanken und Home Assistant sind nie Standard-Changes' };
      if (c.gesundheit !== 'unhealthy') return { fehler: `${name} ist laut Bestand nicht unhealthy (${c.gesundheit ?? 'ohne Healthcheck'})` };
      if ((await k.anzahl('neustart_unhealthy', `${z}:${name}`, k.jetzt.getTime() - 24 * 3_600_000)) > 0) return { fehler: `${name} wurde in den letzten 24 h schon neu gestartet — höchstens 1× je Tag` };
      return { merkmal: `${z}:${name}`, plan: {
        titel: `Standard: ${name} neu starten (unhealthy)`, begruendung: `Standard-Change (e) — ${name} auf ${z} meldet unhealthy.`, typ: 'normal', risiko: 'niedrig', ausfallMinuten: 1,
        betroffen: [...((await k.zugangAsset(z)) ? [(await k.zugangAsset(z))!] : [])], ohneSicherungGrund: 'Neustart verändert keine Daten',
        schritte: [
          { titel: 'Container neu starten', art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: z, befehl: `docker restart ${name}` }, pruefung: { typ: 'befehl', zugang: z, befehl: LINUX_BEFEHLE.docker, erwartet: name }, rueckweg: { keiner: 'Neustart hat keinen Rückweg' } },
          { titel: 'Warten bis healthy', art: 'warten', pruefung: { typ: 'container_healthy', zugang: z, container: name }, zeitlimitS: 300 },
        ] } };
    },
  },
  { key: 'zertifikat_erneuern', version: 1, titel: '(f) NPM-Zertifikat erneuern', beschreibung: 'Let’s-Encrypt-Zertifikat in NPM erneuern.', parameter: {}, verfuegbar: false, folgt: 'mit I7 (der NPM-Skill hat noch keine Erneuern-Aktion)' },
  { key: 'testvm', version: 1, titel: '(g) Test-VM anlegen und nach Ablauf löschen', beschreibung: 'Wegwerf-VM aus Vorlage im Test-VLAN (2 vCPU/4 GB/32 GB, höchstens 3).', parameter: {}, verfuegbar: false, folgt: 'mit I5 (der Proxmox-Skill kann VMs noch nicht löschen)' },
];

/** Fingerabdruck einer Vorlage (Schlüssel, Version, Beschreibung inkl. Grenzen) — ändert sich die Vorlage, verfällt ihre Freigabe. */
export function vorlagenAbdruck(v: Vorlage): string { return createHash('sha256').update(`${v.key}\n${v.version}\n${v.beschreibung}`).digest('hex'); }
