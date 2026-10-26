/**
 * Spec Infrastruktur-Vorhaben, I3 (Owner 22.10.2026 „I3 wie vorgeschlagen umsetzen“) — ITSM-Changes mit Schritten.
 *
 * Das Modell plant Changes als Struktur; Prüfung, Fingerabdruck und die lesbaren Pläne sind deterministisch. Ein Change ist nur
 * freigebbar, wenn die Prüfung ohne Fehler ist. Die Freigabe gilt genau für den Fingerabdruck (Schritte, Parameter, Rückwege,
 * Abhängigkeiten, betroffene Assets) — ändert sich etwas, verfällt sie. Ausgeführt wird erst in I4 (Ausführungsmotor).
 *
 * Schritt-Arten:
 *   aktion   — Skill-Aktion mit Parametern, eigener Prüfung danach und Rückweg (bei ändernden Aktionen Pflicht)
 *   pruefung — eigenständige Prüfung (http, port, dns, ping, container_healthy, datei, befehl, skill)
 *   warten   — feste Zeit oder bis eine Prüfung erfüllt ist
 *   owner    — Handgriff oder Entscheidung des Owners mitten im Change (z. B. solange eine Skill-Aktion fehlt)
 */
import { createHash } from 'node:crypto';
import { befehlsklasse } from '../fernzugriff/regeln.js';
import { nurMetadaten, geheimnisGrund } from '../fernzugriff/kaefig.js';
import { pruefePfad } from '../fernzugriff/uebertragung.js';
import { eingabeFehler, type PruefbarerSkill } from '../vorgaenge/vorschlag.js';

export type AktionsArt = 'lesen' | 'sicherung' | 'aendern' | 'loeschen';
export type PruefTyp = 'http' | 'port' | 'dns' | 'ping' | 'container_healthy' | 'datei' | 'befehl' | 'skill';
export interface Pruefung { typ: PruefTyp; ziel?: string; port?: number; erwartet?: string; /** Ausgabe darf das nicht enthalten (z. B. „Snapshot existiert schon“) */ nichtEnthalten?: string; zugang?: string; container?: string; pfad?: string; befehl?: string; skill?: string; aktion?: string; parameter?: Record<string, unknown> }
export interface Rueckweg { skill?: string; aktion?: string; parameter?: Record<string, unknown>; keiner?: string }
export interface ChangeSchritt {
  nr: number; titel: string; art: 'aktion' | 'pruefung' | 'warten' | 'owner';
  skill?: string; aktion?: string; parameter?: Record<string, unknown>;
  pruefung?: Pruefung; rueckweg?: Rueckweg;
  sekunden?: number; frage?: string;
  zeitlimitS: number; beiFehler: 'anhalten' | 'rueckweg' | 'weiter';
  /** abgeleitet: Einordnung der Aktion */
  einordnung?: AktionsArt;
}
export interface ChangePlan {
  schluessel?: string; titel: string; begruendung: string;
  typ: 'normal' | 'notfall'; risiko: 'low' | 'medium' | 'high' | 'critical';
  ausfallMinuten?: number; geplantAb?: string; betroffen: string[]; abhaengigVon: string[];
  zweck?: 'stilllegung'; ohneSicherungGrund?: string;
  schritte: ChangeSchritt[];
}

/** Verneinende Aussagen in `erwartet` (können als Textstück einer Ausgabe praktisch nie vorkommen) */
const VERNEINUNG = /(^|[^\p{L}])(nicht|kein|keine|keinen|keiner|not|no longer|fehlt|entfernt|gelöscht|geloescht|absent|missing|removed|deleted)([^\p{L}]|$)/iu;
export const PRUEF_TYPEN: readonly PruefTyp[] = ['http', 'port', 'dns', 'ping', 'container_healthy', 'datei', 'befehl', 'skill'];
export const ZEITLIMIT_STANDARD_S = 600;
export const ZEITLIMIT_MAX_S = 4 * 3600;

const LESE_MUSTER = /^(list|get|show|status|info|search|logs?$|ps$|inspect|describe|check|ping|traceroute|torch|query|read|lesen|pruefen|discover|wait_ready|agent_status|backups_vm|cluster_status|node_stats|vm_status|task_status|interfaces|traffic|resources|dhcp_leases|arp|routes|dns_cache|connections|neighbors|wireless|firewall_rules|nat_rules|stats|containers|images|grundlage|bestand|vorhaben_liste|vorhaben_zeigen|impact|topology|dashboard|api_pruefen|trunk_path)/;
const SICHERUNGS_AKTIONEN = new Set(['create_snapshot', 'backup_vm', 'backup_config', 'snapshot', 'backup', 'export_config']);
/** Endgültiges Entfernen von Bestehendem — nur in einem eigenen Stilllegungs-Change (Owner 22.10.: Altes mindestens 7 Tage) */
const LOESCH_MUSTER = /^(delete_vm|delete_backup(?!_job)|destroy|destroy_vm|delete_lxc|delete_container|remove_container|purge|wipe|format|delete_volume|remove_volume|prune|decommission)/;
/** Ändernde Aktionen, für die es keinen Rückweg geben kann (Grund ist anzugeben) */
const OHNE_RUECKWEG_MOEGLICH = new Set(['delete_snapshot', 'kopieren', 'datenbank_kopieren', 'geheim_uebernehmen', 'isolate_vm', 'image_hochladen', 'image_holen']); // v1658 Registry: zusätzliches Image, kein laufender Dienst betroffen; // v1614 isolate_vm macht eine Rettungskopie nur sicherer
/** Aktionen, die ihr Ergebnis selbst prüfen (Prüfsumme, Zeilenzahl, Größe, Datei) — eigene Prüfung optional */
const SELBST_GEPRUEFT = new Set(['kopieren', 'datenbank_kopieren', 'geheim_uebernehmen', 'image_hochladen', 'image_holen', 'export_config', 'create_backup_job', 'delete_backup_job', 'set_fixed_ip', 'clear_fixed_ip', 'create_rule', 'delete_rule', 'create_static_route', 'delete_static_route', 'restore_backup', 'isolate_vm']); // I6: schreiben nur am neuen Ziel bzw. in den Tresor, die Quelle bleibt unberührt // Übergangsjob/feste IP 22.10.: lesen selbst nach
/** Skills, die Changes nie als Schritt benutzen dürfen (Planung/Freigabe selbst, Gerätesteuerung, eigene Software) */
const NIE_SKILLS = new Set(['infrastruktur', 'itsm', 'selbstupdate', 'geraet', 'code_agent', 'claude_code']);
const VERWEIS = /\{\{\s*(schritt(\d+)\.([a-zA-Z_][\w.]*)|geheim:([a-z0-9][\w.-]{1,60})|geheimdatei:([a-z0-9][\w.-]{1,60}))\s*\}\}/g;
/** I4c — {{geheim:x}} nur als ganzer Wert in Feldern, die die Skill-Sandbox im Log schwärzt (oberste Ebene, exakte Schreibweise) */
const GEHEIM_FELDER = /^(password|secret|token|git_token|apiKey|api_key|accessToken|refreshToken|clientSecret)$/;
/** Vergessene Platzhalter („<host-id>“, „{{host_id}}“) — nicht Verweise und nicht Go-Template-Felder von Docker („{{.Image}}“, „{{json .State}}“) */
const PLATZHALTER = /<[^<>\n]{2,40}>|\{\{(?!\s*(schritt\d+\.[a-zA-Z_]|geheim:[a-z0-9][\w.-]{1,60}\s*\}\}|geheimdatei:[a-z0-9][\w.-]{1,60}\s*\}\}|\.|json \.|(range|with|if|index|println|printf|print|join|len|lower|upper|title|else|end)\b))[^}]*\}\}/i; // Go-Templates von docker --format (Pilot cf82f3f2: {{range .Config.Env}}…{{end}})

/** v1664 — Befehle, die einen Dienst anhalten bzw. wieder starten (für die Regel „nach dem Stopp nur mit Rückweg“) */
export const DIENST_STOPP = /\b(docker(\s+compose)?(\s+-\S+(\s+\S+)?)*\s+(stop|kill|down|pause)|docker\s+container\s+(stop|kill)|systemctl\s+(stop|kill)|service\s+\S+\s+stop)\b/;
export const DIENST_START = /\b(docker(\s+compose)?(\s+-\S+(\s+\S+)?)*\s+(start|up|restart|unpause)|docker\s+container\s+(start|restart)|systemctl\s+(start|restart)|service\s+\S+\s+(start|restart))\b/;

/**
 * v1673 — Realfall 25.10. (pgsql-p01, peer-Zeile): der Validator wies `ls -l …`, `head -n 1 /etc/…/pg_hba.conf` und `ps -eo … | grep`
 * als „kein reiner Lesebefehl“ ab, obwohl der Motor Prüfbefehle über lesenIntern ausführt — dort läuft alles außerhalb der Leseliste im
 * Lese-Käfig (Dateisystem schreibgeschützt, kein Netz, keine Sockets; liest mit CAP_DAC_READ_SEARCH auch Root-Dateien). Gleiche Regel wie
 * zur Laufzeit: nie-Befehle, mehrzeilige Befehle und Geheimnis-Pfade (außer reinen Metadaten) bleiben abgewiesen.
 */
// Am Anfang eines Befehls (auch nach ;, &&, ||, |, sudo): Werkzeuge, die schreiben, löschen, Dienste steuern oder Pakete ändern; dazu Umleitungen
const VERAENDERND = /(^|[;&|]\s*|\bsudo\s+(-\S+\s+)*)(rm|rmdir|mv|cp|tee|touch|truncate|mkdir|ln|install|chmod|chown|chgrp|dd|kill|pkill|killall|reboot|shutdown|halt|poweroff|useradd|userdel|usermod|passwd|apt|apt-get|dnf|yum|pip|npm|systemctl\s+(?!(status|is-active|is-enabled|is-failed|show|cat|list-\S+)\b)\S+|service|docker\s+(?!(ps|logs|inspect|images|image\s+(ls|inspect)|network\s+(ls|inspect)|volume\s+(ls|inspect)|version|info|stats|top|port|compose\s+(ls|ps|version|images))\b)\S+|sed\s+(-\S+\s+)*-i|crontab|mount|umount|psql|mysql|redis-cli)\b|>\s*[^&]|>>/;
export function pruefbefehlFehler(befehl: string): string | undefined {
  const k = befehlsklasse(befehl);
  if (k === 'nie') return 'ist nie erlaubt';
  if (k === 'lesen' || nurMetadaten(befehl)) return undefined;
  if (/[\r\n]/.test(befehl.trim())) return 'ist mehrzeilig — Prüfbefehle einzeilig';
  if (VERAENDERND.test(befehl)) return 'ist kein reiner Lesebefehl (verändert etwas)';
  const g = geheimnisGrund(befehl);
  if (g) return `berührt ${g} — als Prüfung nicht zulässig`;
  // v1678 — Review 26.10. (Matrix F3/I13/J27, J8): im Lese-Käfig gibt es kein Netz, keine Unix-Sockets und kein D-Bus — Netzproben per
  // python-socket/curl/wget und systemctl außer status/is-active/is-failed scheitern dort immer
  if (/\b(socket|urllib|requests|http\.client|ssl\.|wget|openssl\s+s_client|telnet)\b|\bcurl\b|\bnc\b|\bdocker\b|\bsystemctl\b/.test(befehl)) return 'läuft im Lese-Käfig ohne Netz, Docker-Socket und D-Bus und kann so nie bestehen — Netzprobe mit „nc -z -w 5 <host> <port>“ oder „curl … http://localhost…“ (Leseliste), Dienste mit „systemctl is-active <dienst>“, Container mit „docker ps …“/„docker inspect --format …“; alles andere als eigenen ausfuehren-Schritt mit Marker-Ausgabe';
  return undefined; // läuft im Lese-Käfig
}

export function aktionsArt(skill: string, aktion: string, parameter?: Record<string, unknown>): AktionsArt {
  // v1628 — pruefen (Verbindung, sudo, Käfig-Selbsttest) und liste ändern am Host nichts (Realfall 24.10.: Vorlagen-Beweis)
  if (skill === 'fernzugriff') return aktion === 'lesen' || aktion === 'pruefen' || aktion === 'liste' || aktion === 'datenbank_inventar' || (aktion === 'ausfuehren' && befehlsklasse(String(parameter?.befehl ?? '')) === 'lesen') ? 'lesen' : 'aendern';
  // v1676 — Realfall 26.10. (Matrix E): der GitLab-Skill liest nur (Projekte, Registry-Tags mit Digest) — „gitlab.registry ist nicht lesend“
  if (skill === 'gitlab') return 'lesen';
  if (SICHERUNGS_AKTIONEN.has(aktion)) return 'sicherung';
  if (LOESCH_MUSTER.test(aktion)) return 'loeschen';
  return LESE_MUSTER.test(aktion) ? 'lesen' : 'aendern';
}

export interface PruefKontext {
  /** Skill nach Namen (Schema + optionale eigene Eingabeprüfung) */
  skill: (name: string) => (PruefbarerSkill & { metadata: { name: string } }) | undefined;
  /** CMDB-Assets nach Name oder ID auflösen */
  asset: (nameOderId: string) => { id: string; name: string } | { mehrdeutig: string[] } | undefined;
  /** I4c — Namen im Tresor (fehlt die Angabe, wird nur die Form geprüft) */
  tresorNamen?: Set<string>;
  /** v1684 — Namen der Fernzugänge (klein geschrieben); fehlt die Angabe, wird nicht geprüft */
  zugaenge?: Set<string>;
  /** vorhandene Changes (für Abhängigkeiten und Zyklen) */
  changes: Array<{ id: string; abhaengigVon: string[]; status: string }>;
  jetzt?: Date;
}

const txt = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const zahl = (v: unknown): number | undefined => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN; return Number.isFinite(n) ? n : undefined; };
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);

/** Aktionen eines Skills aus seinem Eingabeschema (action.enum). */
export function skillAktionen(s: PruefbarerSkill): string[] {
  const p = (s.metadata.inputSchema as { properties?: { action?: { enum?: unknown[] } } }).properties?.action?.enum;
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * v1676 — Realfall 26.10. (Matrix E): „registry…/matrix-sydent@{{schritt1.digest}}“ wurde ganz zu „verweis“ — die Image-Prüfung (v1659)
 * sah den Digest nie. Nur den Verweis selbst ersetzen; ein Digest-Verweis wird zu einem gültigen Platzhalter-Digest.
 * v1679 — auch für Prüfbefehle: „docker image inspect … @{{schritt3.digest}}“ steht nach dem Auflösen auf der Leseliste.
 */
export function ersetzeVerweise(s: string): string {
  const r = s.replace(new RegExp(VERWEIS.source, 'g'), (m) => (/\.digest\s*\}\}$/.test(m) ? `sha256:${'0'.repeat(64)}` : 'verweis'));
  return r.trim() === 'verweis' ? 'verweis' : r;
}

/** Verweise in Parametern prüfen; liefert Fehler und eine Kopie mit Ersatzwerten für die Schemaprüfung. */
function verweise(parameter: Record<string, unknown>, nr: number, aktionsNummern: Set<number>, f: string[], wo: string, schema?: Record<string, { type?: string }>, geheim?: { befehlErlaubt: boolean; namen?: Set<string> }): Record<string, unknown> {
  const kopie: Record<string, unknown> = {};
  for (const [k, w] of Object.entries(parameter)) {
    const text = typeof w === 'string' ? w : JSON.stringify(w ?? null);
    if (PLATZHALTER.test(text)) f.push(`${wo}: Parameter „${k}“ enthält einen Platzhalter statt eines Werts (${text.slice(0, 40)})`);
    let ersetzt = false;
    for (const m of text.matchAll(VERWEIS)) {
      ersetzt = true;
      if (m[2]) { const n = Number(m[2]); if (n >= nr || !aktionsNummern.has(n)) f.push(`${wo}: Verweis {{${m[1]}}} zeigt nicht auf eine frühere Aktion`); }
      if (m[4]) {
        if (!GEHEIM_FELDER.test(k) || typeof w !== 'string' || w.trim() !== m[0]) f.push(`${wo}: {{geheim:${m[4]}}} nur als ganzer Wert in einem Feld wie password/secret/token — in Befehlen {{geheimdatei:${m[4]}}} verwenden`);
        if (geheim?.namen && !geheim.namen.has(m[4])) f.push(`${wo}: Tresor-Eintrag „${m[4]}“ gibt es nicht`);
      }
      if (m[5]) {
        if (!geheim?.befehlErlaubt || k !== 'befehl') f.push(`${wo}: {{geheimdatei:${m[5]}}} nur im Befehl eines Fernzugriff-Schritts`);
        if (geheim?.namen && !geheim.namen.has(m[5])) f.push(`${wo}: Tresor-Eintrag „${m[5]}“ gibt es nicht`);
      }
    }
    kopie[k] = ersetzt && typeof w === 'string' ? (schema?.[k]?.type === 'number' || schema?.[k]?.type === 'integer' ? 1 : ersetzeVerweise(w)) : w;
  }
  return kopie;
}

function pruefePruefung(p0: unknown, wo: string, f: string[], ctx: PruefKontext): Pruefung | undefined {
  const p = obj(p0);
  if (!p) { f.push(`${wo}: pruefung fehlt`); return undefined; }
  const typ = txt(p.typ) as PruefTyp;
  if (!PRUEF_TYPEN.includes(typ)) { f.push(`${wo}: pruefung.typ muss ${PRUEF_TYPEN.join('/')} sein`); return undefined; }
  const aus: Pruefung = { typ };
  for (const k of ['ziel', 'erwartet', 'nichtEnthalten', 'zugang', 'container', 'pfad', 'befehl', 'skill', 'aktion'] as const) if (txt(p[k])) aus[k] = txt(p[k]);
  if (aus.nichtEnthalten && !['http', 'befehl', 'skill'].includes(typ)) f.push(`${wo}: nichtEnthalten gibt es nur bei http-, befehl- und skill-Prüfungen`);
  // v1675 — Realfall 26.10. (5b7dc0f9 Schritt 9): erwartet „lvmthin: data2-pve3“, nichtEnthalten „lvmthin: data2“ — steckt im erwarteten
  // Text, die Prüfung hätte nie bestanden und den Change nach dem letzten Umbau angehalten
  if (aus.nichtEnthalten && aus.erwartet && !aus.erwartet.startsWith('{{') && aus.erwartet.includes(aus.nichtEnthalten)) f.push(`${wo}: nichtEnthalten „${aus.nichtEnthalten.slice(0, 60)}“ steckt in erwartet „${aus.erwartet.slice(0, 60)}“ — die Prüfung kann nie bestehen (genauer formulieren, z. B. mit Zählung: grep -c '^… $' → erwartet 0)`);
  // I4 (Realfall 22.10.: erwartet „Snapshot i3probe ist nicht vorhanden“ — kein Textstück der Ausgabe, Prüfung unerfüllbar)
  if (aus.erwartet && VERNEINUNG.test(aus.erwartet)) f.push(`${wo}: erwartet „${aus.erwartet.slice(0, 60)}“ ist eine Aussage — erwartet ist ein Textstück, das in der Ausgabe vorkommen muss; für „ist nicht (mehr) da“ nichtEnthalten mit dem Namen verwenden`);
  const port = zahl(p.port); if (port !== undefined) aus.port = port;
  if (obj(p.parameter)) aus.parameter = obj(p.parameter)!;
  const fehlt = (felder: Array<keyof Pruefung>) => { for (const k of felder) if (aus[k] === undefined) f.push(`${wo}: pruefung ${typ} braucht ${String(k)}`); };
  if (typ === 'http') { fehlt(['ziel']); if (aus.ziel && !/^https?:\/\//.test(aus.ziel)) f.push(`${wo}: http-Prüfung braucht eine URL`); }
  if (typ === 'port') { fehlt(['ziel', 'port']); if (aus.port !== undefined && (aus.port < 1 || aus.port > 65535)) f.push(`${wo}: Port ungültig`); }
  if (typ === 'dns' || typ === 'ping') fehlt(['ziel']);
  // v1684 — Realfall 26.10. (Matrix J1 Schritt 1): Prüfung auf Zugang „udm“, den es nicht gibt — der Lauf wäre sicher angehalten
  if (aus.zugang && ctx.zugaenge && !ctx.zugaenge.has(aus.zugang.toLowerCase()) && ['befehl', 'container_healthy', 'datei'].includes(typ)) f.push(`${wo}: Fernzugang „${aus.zugang}“ gibt es nicht (vorhanden: ${[...ctx.zugaenge].sort().join(', ')})`);
  if (typ === 'container_healthy') fehlt(['zugang', 'container']);
  if (typ === 'datei') { fehlt(['zugang', 'pfad']); if (aus.pfad && !/^\/[\w./-]+$/.test(aus.pfad)) f.push(`${wo}: pfad muss ein einfacher absoluter Pfad sein`); }
  if (typ === 'befehl') { fehlt(['zugang', 'befehl']); const g = aus.befehl ? pruefbefehlFehler(ersetzeVerweise(aus.befehl)) : undefined; if (g) f.push(`${wo}: Prüfbefehl „${aus.befehl!.slice(0, 60)}“ ${g}`); }
  if (typ === 'skill') {
    fehlt(['skill', 'aktion']);
    const s = aus.skill ? ctx.skill(aus.skill) : undefined;
    if (aus.skill && !s) f.push(`${wo}: Prüf-Skill ${aus.skill} gibt es nicht`);
    else if (s && aus.aktion && aktionsArt(aus.skill!, aus.aktion, aus.parameter) !== 'lesen') f.push(`${wo}: Prüf-Aktion ${aus.skill}.${aus.aktion} ist nicht lesend`);
  }
  return aus;
}

/**
 * Prüft einen Plan (ein Change) — reine Regeln. `fehler` → nicht freigebbar; `hinweise` → stehen im Change.
 * `alleSchluessel` sind die Schlüssel der im selben Paket geplanten Changes (Abhängigkeiten innerhalb des Pakets).
 */
export function pruefeChangePlan(roh: unknown, ctx: PruefKontext, alleSchluessel: string[] = []): { fehler: string[]; hinweise: string[]; plan: ChangePlan; betroffeneIds: string[] } {
  const f: string[] = []; const h: string[] = [];
  const r = obj(roh) ?? {};
  const typ = txt(r.typ) || 'normal';
  const plan: ChangePlan = {
    titel: txt(r.titel), begruendung: txt(r.begruendung), typ: typ === 'notfall' ? 'notfall' : 'normal',
    risiko: (['low', 'medium', 'high', 'critical'] as const).find(x => x === ({ niedrig: 'low', mittel: 'medium', hoch: 'high', kritisch: 'critical' } as Record<string, string>)[txt(r.risiko)] || x === txt(r.risiko)) ?? 'medium',
    betroffen: [], abhaengigVon: [], schritte: [],
  };
  if (txt(r.schluessel)) plan.schluessel = txt(r.schluessel);
  if (plan.titel.length < 5) f.push('titel fehlt');
  if (plan.begruendung.length < 10) f.push('begruendung fehlt (warum dieser Change)');
  if (typ === 'standard') f.push('Standard-Changes (vorab freigegebene Vorlagen) folgen in I4b — als normal planen');
  else if (!['normal', 'notfall'].includes(typ)) f.push('typ muss normal oder notfall sein');
  if (!txt(r.risiko)) f.push('risiko fehlt (niedrig/mittel/hoch/kritisch)');
  const ausfall = zahl(r.ausfallMinuten);
  if (ausfall === undefined || ausfall < 0) f.push('ausfallMinuten fehlt (erwartete Ausfallzeit, 0 wenn keine)'); else plan.ausfallMinuten = ausfall;
  if (txt(r.geplantAb)) { const t = Date.parse(txt(r.geplantAb)); if (Number.isNaN(t)) f.push('geplantAb ist kein Zeitpunkt'); else { plan.geplantAb = new Date(t).toISOString(); if (t < (ctx.jetzt ?? new Date()).getTime()) h.push('geplantAb liegt in der Vergangenheit'); } }
  if (txt(r.zweck) === 'stilllegung') plan.zweck = 'stilllegung';
  if (txt(r.ohneSicherungGrund)) plan.ohneSicherungGrund = txt(r.ohneSicherungGrund);

  // Betroffene Assets aus der CMDB
  const betroffeneIds: string[] = [];
  for (const b of Array.isArray(r.betroffen) ? r.betroffen : []) {
    const a = ctx.asset(txt(b));
    if (!a) f.push(`betroffen: „${txt(b)}“ ist kein CMDB-Asset`);
    else if ('mehrdeutig' in a) f.push(`betroffen: „${txt(b)}“ ist mehrdeutig: ${a.mehrdeutig.slice(0, 5).join('; ')} — die passende volle ID oder Quelle (z. B. pve3:142) angeben`);
    else if (!betroffeneIds.includes(a.id)) { betroffeneIds.push(a.id); plan.betroffen.push(a.name); }
  }
  if (!betroffeneIds.length) f.push('betroffen fehlt (CMDB-Assets, die der Change berührt oder neu anlegt — bei neuen VMs den Proxmox-Knoten)');

  // Abhängigkeiten: Schlüssel im Paket oder vorhandene Change-IDs
  for (const d0 of Array.isArray(r.abhaengigVon) ? r.abhaengigVon : []) {
    const d = txt(d0);
    if (alleSchluessel.includes(d)) { if (d === plan.schluessel) f.push('abhaengigVon: ein Change kann nicht von sich selbst abhängen'); else plan.abhaengigVon.push(d); continue; }
    const c = ctx.changes.find(x => x.id === d || (d.length >= 8 && x.id.startsWith(d)));
    if (!c) f.push(`abhaengigVon: Change „${d}“ unbekannt`);
    else if (['cancelled', 'failed', 'rolled_back'].includes(c.status)) f.push(`abhaengigVon: Change ${c.id.slice(0, 8)} ist ${c.status}`);
    else plan.abhaengigVon.push(c.id);
  }

  // Schritte
  const roheSchritte = Array.isArray(r.schritte) ? r.schritte : [];
  if (!roheSchritte.length) f.push('schritte fehlen');
  const aktionsNummern = new Set<number>();
  // v1684 — Zugänge, die dieser Plan selbst anlegt (VM-Fabrik legt den Fernzugang mit dem VM-Namen an, fernzugriff anlegen), gelten als vorhanden
  const neueZugaenge = new Set<string>();
  if (ctx.zugaenge) {
    for (const s0 of roheSchritte) {
      const p = obj(obj(s0)?.parameter) ?? {};
      for (const k of ['name', 'hostname', 'vm_name', 'vmname'] as const) { const v = p[k]; if (typeof v === 'string' && v.trim() && obj(s0)?.skill !== 'fernzugriff') neueZugaenge.add(v.trim().toLowerCase()); }
    }
    ctx = { ...ctx, zugaenge: new Set([...ctx.zugaenge, ...neueZugaenge]) };
  }
  // I6 — Tresor-Einträge, die ein früherer Schritt dieses Plans per geheim_uebernehmen anlegt, gelten für spätere Schritte als vorhanden
  const tresorNamen = ctx.tresorNamen ? new Set(ctx.tresorNamen) : undefined;
  let ersteAenderung: number | undefined; let ersteSicherung: number | undefined;
  for (const [i, s0] of roheSchritte.entries()) {
    const s = obj(s0) ?? {};
    const nr = i + 1;
    const wo = `Schritt ${nr}`;
    const art = txt(s.art) as ChangeSchritt['art'];
    const zl = zahl(s.zeitlimitS);
    const schritt: ChangeSchritt = {
      nr, titel: txt(s.titel), art, zeitlimitS: zl ?? ZEITLIMIT_STANDARD_S,
      beiFehler: (['anhalten', 'rueckweg', 'weiter'] as const).find(x => x === txt(s.beiFehler)) ?? 'anhalten',
    };
    if (!schritt.titel) f.push(`${wo}: titel fehlt`);
    if (zl !== undefined && (zl < 5 || zl > ZEITLIMIT_MAX_S)) f.push(`${wo}: zeitlimitS 5–${ZEITLIMIT_MAX_S}`);
    if (txt(s.beiFehler) && !['anhalten', 'rueckweg', 'weiter'].includes(txt(s.beiFehler))) f.push(`${wo}: beiFehler muss anhalten, rueckweg oder weiter sein`);
    if (art === 'aktion') {
      schritt.skill = txt(s.skill); schritt.aktion = txt(s.aktion); schritt.parameter = obj(s.parameter) ?? {};
      const sk = ctx.skill(schritt.skill);
      if (!sk) { f.push(`${wo}: Skill „${schritt.skill}“ gibt es nicht`); plan.schritte.push(schritt); continue; }
      if (NIE_SKILLS.has(schritt.skill)) { f.push(`${wo}: Skill ${schritt.skill} ist in Changes nicht erlaubt`); plan.schritte.push(schritt); continue; }
      const aktionen = skillAktionen(sk);
      if (!aktionen.includes(schritt.aktion)) { f.push(`${wo}: ${schritt.skill} kennt die Aktion „${schritt.aktion}“ nicht${aktionen.length ? ` (${aktionen.slice(0, 30).join(', ')})` : ''} — fehlt eine Fähigkeit, als owner-Schritt planen`); plan.schritte.push(schritt); continue; }
      const schema = (sk.metadata.inputSchema as { properties?: Record<string, { type?: string }> }).properties;
      const ersatz = verweise(schritt.parameter, nr, aktionsNummern, f, wo, schema, { befehlErlaubt: schritt.skill === 'fernzugriff' && schritt.aktion === 'ausfuehren', ...(tresorNamen ? { namen: tresorNamen } : {}) });
      const fe = eingabeFehler(sk, { ...ersatz, action: schritt.aktion });
      if (fe) f.push(`${wo}: ${fe}`);
      const einordnung = aktionsArt(schritt.skill, schritt.aktion, schritt.parameter);
      schritt.einordnung = einordnung;
      if (schritt.skill === 'fernzugriff' && schritt.aktion === 'ausfuehren' && befehlsklasse(String(schritt.parameter.befehl ?? '')) === 'nie') f.push(`${wo}: Befehl steht auf der Nie-Liste des Fernzugriffs`);
      // v1684 — Fernzugriff-Schritte nur mit vorhandenen Zugängen (Verweise {{…}} und neu angelegte Zugänge ausgenommen)
      if (schritt.skill === 'fernzugriff' && schritt.aktion !== 'anlegen' && ctx.zugaenge) {
        for (const k of ['name', 'quelle', 'ziel'] as const) {
          const v = schritt.parameter[k];
          if (typeof v === 'string' && v.trim() && !v.includes('{{') && !ctx.zugaenge.has(v.trim().toLowerCase()) && !(k === 'name' && neueZugaenge.has(v.trim().toLowerCase()))) f.push(`${wo}: Fernzugang „${v}“ gibt es nicht (vorhanden: ${[...ctx.zugaenge].sort().join(', ')})`);
        }
      }
      if (schritt.skill === 'fernzugriff' && schritt.aktion === 'anlegen' && typeof schritt.parameter.name === 'string') neueZugaenge.add(schritt.parameter.name.trim().toLowerCase());
      // v1610 — Realfall 23.10. (dea4b9cd, Schritt 5): quelle_pfad /root/… wurde erst im Lauf abgewiesen — dieselbe Pfadregel schon beim Planen
      if (schritt.skill === 'fernzugriff' && schritt.aktion === 'kopieren') {
        for (const [feld, art] of [['quelle_pfad', 'quelle'], ['ziel_pfad', 'ziel']] as const) {
          const w = schritt.parameter[feld];
          if (w !== undefined) { const fehler = pruefePfad(w, art); if (fehler) f.push(`${wo}: ${fehler} (für Hilfsdateien z. B. /srv/<vorhaben>-export verwenden)`); }
        }
      }
      if (einordnung === 'loeschen' && plan.zweck !== 'stilllegung') f.push(`${wo}: ${schritt.skill}.${schritt.aktion} entfernt Bestehendes endgültig — nur in einem eigenen Change mit zweck stilllegung`);
      if (einordnung === 'sicherung' && ersteSicherung === undefined) ersteSicherung = nr;
      if ((einordnung === 'aendern' || einordnung === 'loeschen') && ersteAenderung === undefined) ersteAenderung = nr;
      // Prüfung je Aktion (außer reinen Lese-Schritten)
      if (einordnung !== 'lesen' && !(SELBST_GEPRUEFT.has(schritt.aktion) && !s.pruefung)) { const p = pruefePruefung(s.pruefung, wo, f, ctx); if (p) schritt.pruefung = p; }
      else if (s.pruefung) { const p = pruefePruefung(s.pruefung, wo, f, ctx); if (p) schritt.pruefung = p; }
      // Rückweg für ändernde Aktionen
      if (einordnung === 'aendern' || einordnung === 'loeschen') {
        const rw = obj(s.rueckweg);
        if (!rw) f.push(`${wo}: rueckweg fehlt (ändernde Aktion)`);
        else if (txt(rw.keiner)) {
          const neustart = schritt.skill === 'fernzugriff' && /^docker restart [\w.-]+$/.test(String(schritt.parameter.befehl ?? '').trim());
          // v1622 — Realfall 23.10. (Restwirkung b85e56af): im Stilllegungs-Change ist Entfernen per Fernzugriff (rm) gewollt endgültig —
          // ein erfundener Rückweg wäre schlechter als keiner
          const entfernen = plan.zweck === 'stilllegung' && schritt.skill === 'fernzugriff' && schritt.aktion === 'ausfuehren' && /^rm\s/.test(String(schritt.parameter.befehl ?? '').trim());
          if (!OHNE_RUECKWEG_MOEGLICH.has(schritt.aktion) && einordnung !== 'loeschen' && !neustart && !entfernen) f.push(`${wo}: ohne Rückweg nur bei ${[...OHNE_RUECKWEG_MOEGLICH].join(', ')} oder Stilllegung — sonst rueckweg mit skill/aktion angeben`);
          schritt.rueckweg = { keiner: txt(rw.keiner) };
        } else {
          const rs = ctx.skill(txt(rw.skill));
          const rueck: Rueckweg = { skill: txt(rw.skill), aktion: txt(rw.aktion), parameter: obj(rw.parameter) ?? {} };
          if (!rs) f.push(`${wo}: Rückweg-Skill „${rueck.skill}“ gibt es nicht`);
          else if (!skillAktionen(rs).includes(rueck.aktion!)) f.push(`${wo}: Rückweg-Aktion ${rueck.skill}.${rueck.aktion} gibt es nicht`);
          else {
            const ersatzR = verweise(rueck.parameter!, nr + 1, new Set([...aktionsNummern, nr]), f, `${wo} (Rückweg)`, (rs.metadata.inputSchema as { properties?: Record<string, { type?: string }> }).properties, { befehlErlaubt: rueck.skill === 'fernzugriff' && rueck.aktion === 'ausfuehren', ...(tresorNamen ? { namen: tresorNamen } : {}) });
            const feR = eingabeFehler(rs, { ...ersatzR, action: rueck.aktion });
            if (feR) f.push(`${wo} (Rückweg): ${feR}`);
            // v1677 — Realfall 26.10. (Matrix I): Rückwege mit fernzugriff.kopieren haben keinen Befehl; der leere Befehl galt als „nie“
            if (rueck.skill === 'fernzugriff' && rueck.aktion === 'ausfuehren' && befehlsklasse(String(rueck.parameter!.befehl ?? '')) === 'nie') f.push(`${wo} (Rückweg): Befehl steht auf der Nie-Liste`);
            // v1678 — Review 26.10. (Matrix I4–I7): Rückweg kopierte mit loeschen:true vom Ziel zurück auf den ORIGINALPFAD der Quelle. Bricht
            // die Hin-Kopie mittendrin ab, schneidet der Rückweg das Original auf den unvollständigen Zielstand zurück. Rückkopien gehören
            // in ein eigenes Verzeichnis (Staging) oder ohne loeschen.
            const rp = rueck.parameter!; const hp = schritt.parameter;
            if (rueck.skill === 'fernzugriff' && rueck.aktion === 'kopieren' && schritt.skill === 'fernzugriff' && schritt.aktion === 'kopieren' && rp.loeschen === true
              && txt(rp.ziel) === txt(hp.quelle) && txt(rp.ziel_pfad).replace(/\/+$/, '') === txt(hp.quelle_pfad).replace(/\/+$/, '')) {
              f.push(`${wo} (Rückweg): kopiert mit loeschen zurück auf den Originalpfad ${txt(hp.quelle)}:${txt(hp.quelle_pfad)} — bei abgebrochener Hin-Kopie ginge das Original verloren; in ein eigenes Verzeichnis zurückkopieren oder ohne loeschen`);
            }
          }
          schritt.rueckweg = rueck;
        }
      }
      if (schritt.skill === 'fernzugriff' && schritt.aktion === 'geheim_uebernehmen' && typeof schritt.parameter.tresor_name === 'string') tresorNamen?.add(schritt.parameter.tresor_name);
      aktionsNummern.add(nr);
    } else if (art === 'pruefung') {
      const p = pruefePruefung(s.pruefung, wo, f, ctx); if (p) schritt.pruefung = p;
    } else if (art === 'warten') {
      const sek = zahl(s.sekunden);
      if (sek !== undefined) { if (sek < 1 || sek > ZEITLIMIT_MAX_S) f.push(`${wo}: sekunden 1–${ZEITLIMIT_MAX_S}`); schritt.sekunden = sek; }
      if (s.pruefung) { const p = pruefePruefung(s.pruefung, wo, f, ctx); if (p) schritt.pruefung = p; }
      if (sek === undefined && !s.pruefung) f.push(`${wo}: warten braucht sekunden oder eine pruefung (warten bis …)`);
    } else if (art === 'owner') {
      schritt.frage = txt(s.frage);
      if (schritt.frage.length < 5) f.push(`${wo}: owner-Schritt braucht frage (was der Owner tun oder entscheiden soll)`);
    } else f.push(`${wo}: art muss aktion, pruefung, warten oder owner sein`);
    plan.schritte.push(schritt);
  }
  // Erst sichern, dann ändern (Spec Grundsatz 4) — außer der Change legt nur Neues an und sagt das
  if (ersteAenderung !== undefined && (ersteSicherung === undefined || ersteSicherung > ersteAenderung) && !plan.ohneSicherungGrund) {
    f.push(`Vor der ersten ändernden Aktion (Schritt ${ersteAenderung}) fehlt eine Sicherung (z. B. proxmox create_snapshot/backup_vm, mikrotik backup_config) — oder ohneSicherungGrund angeben, wenn nur Neues entsteht`);
  }
  if (plan.ohneSicherungGrund) h.push(`Ohne Sicherung geplant: ${plan.ohneSicherungGrund}`);
  // v1664 — Realfall 25.10. (cb3fd65c): nach „Backend stoppen“ hielt Schritt 5 bei einem Fehler nur an — der Dienst blieb aus (API 502), bis der
  // Owner den Rückweg drückte. Ab einem Dienst-Stopp bis zum Wiederstart muss jeder Schritt bei Fehler den Rückweg nehmen.
  {
    let gestopptIn: number | undefined;
    for (const s of plan.schritte) {
      const b = s.skill === 'fernzugriff' && s.aktion === 'ausfuehren' ? String(s.parameter?.befehl ?? '') : '';
      if (b && DIENST_STOPP.test(b)) gestopptIn ??= s.nr;
      if (gestopptIn !== undefined && s.beiFehler !== 'rueckweg') f.push(`Schritt ${s.nr}: nach dem Dienst-Stopp in Schritt ${gestopptIn} muss beiFehler „rueckweg“ sein — sonst bleibt der Dienst bei einem Fehler aus`);
      if (b && gestopptIn !== undefined && s.nr > gestopptIn && DIENST_START.test(b) && !DIENST_STOPP.test(b)) gestopptIn = undefined;
    }
  }
  if (plan.schritte.length && !plan.schritte.some(s => s.art === 'pruefung' || (s.art === 'warten' && s.pruefung))) h.push('Keine Abschlussprüfung als eigener Schritt — nur die Prüfungen der Aktionen');
  if (plan.schritte.some(s => s.art === 'owner')) h.push('Enthält Owner-Schritte — der Ablauf wartet dort auf dich');
  if (/\{\{geheim(datei)?:/.test(JSON.stringify(roheSchritte))) h.push('Verwendet Tresor-Einträge — Werte setzt erst der Motor ein, das Modell sieht sie nie');
  if (plan.zweck === 'stilllegung') h.push('Stilllegung: frühestens 7 Tage nach erfolgreicher Migration (Owner 22.10.)');
  if (plan.typ === 'notfall') h.push('Notfall-Change: nachträgliche Prüfung (PIR) Pflicht');
  return { fehler: f, hinweise: h, plan, betroffeneIds };
}

/** Zyklen über Abhängigkeiten (Paket-Schlüssel und vorhandene Changes). */
export function zyklus(kanten: Map<string, string[]>): string[] | undefined {
  const stand = new Map<string, 1 | 2>();
  const pfad: string[] = [];
  const besuche = (k: string): string[] | undefined => {
    if (stand.get(k) === 2) return undefined;
    if (stand.get(k) === 1) return [...pfad.slice(pfad.indexOf(k)), k];
    stand.set(k, 1); pfad.push(k);
    for (const n of kanten.get(k) ?? []) { const z = besuche(n); if (z) return z; }
    pfad.pop(); stand.set(k, 2);
    return undefined;
  };
  for (const k of kanten.keys()) { const z = besuche(k); if (z) return z; }
  return undefined;
}

/** Fingerabdruck über alles, was die Freigabe deckt (Reihenfolge der Objekt-Schlüssel egal). */
export function changeFingerabdruck(plan: ChangePlan, betroffeneIds: string[], abhaengigIds: string[]): string {
  const sortiert = (v: unknown): unknown => Array.isArray(v) ? v.map(sortiert) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, sortiert((v as Record<string, unknown>)[k])])) : v;
  const inhalt = { titel: plan.titel, typ: plan.typ, risiko: plan.risiko, zweck: plan.zweck ?? null, geplantAb: plan.geplantAb ?? null, betroffen: [...betroffeneIds].sort(), abhaengig: [...abhaengigIds].sort(), schritte: plan.schritte.map(({ einordnung: _e, ...s }) => s) };
  return createHash('sha256').update(JSON.stringify(sortiert(inhalt))).digest('hex');
}

const param = (p?: Record<string, unknown>) => (p && Object.keys(p).length ? ` (${Object.entries(p).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')})` : '');
export function pruefText(p?: Pruefung): string {
  if (!p) return '—';
  switch (p.typ) {
    case 'http': return `HTTP ${p.ziel}${p.erwartet ? ` → ${p.erwartet}` : ''}${p.nichtEnthalten ? `, ohne „${p.nichtEnthalten}“` : ''}`;
    case 'port': return `Port ${p.ziel}:${p.port} offen`;
    case 'dns': return `DNS ${p.ziel}${p.erwartet ? ` → ${p.erwartet}` : ''}`;
    case 'ping': return `Ping ${p.ziel}`;
    case 'container_healthy': return `Container ${p.container} auf ${p.zugang} läuft/healthy`;
    case 'datei': return `Datei ${p.pfad} auf ${p.zugang}`;
    case 'befehl': return `Befehl auf ${p.zugang}: ${p.befehl}${p.erwartet ? ` → ${p.erwartet}` : ''}${p.nichtEnthalten ? `, ohne „${p.nichtEnthalten}“` : ''}`;
    case 'skill': return `${p.skill}.${p.aktion}${param(p.parameter)}${p.erwartet ? ` → enthält „${p.erwartet}“` : ''}${p.nichtEnthalten ? ` → enthält nicht „${p.nichtEnthalten}“` : ''}`;
  }
}
export function schrittText(s: ChangeSchritt): string {
  switch (s.art) {
    case 'aktion': return `${s.skill}.${s.aktion}${param(s.parameter)}`;
    case 'pruefung': return `Prüfung: ${pruefText(s.pruefung)}`;
    case 'warten': return `Warten${s.sekunden ? ` ${s.sekunden} s` : ''}${s.pruefung ? ` bis ${pruefText(s.pruefung)}` : ''}`;
    case 'owner': return `Owner: ${s.frage}`;
  }
}

/** Lesbare Pläne aus den Schritten (die Schritte bleiben die Quelle). */
export function plaeneAusSchritten(plan: ChangePlan): { umsetzung: string; rueckweg: string; test: string } {
  const umsetzung = plan.schritte.map(s => `${s.nr}. ${s.titel} — ${schrittText(s)}${s.einordnung && s.einordnung !== 'lesen' ? ` [${s.einordnung}]` : ''}${s.pruefung && s.art === 'aktion' ? `\n   Prüfung: ${pruefText(s.pruefung)}` : ''}${s.beiFehler !== 'anhalten' ? `\n   Bei Fehler: ${s.beiFehler}` : ''}`).join('\n');
  const rw = [...plan.schritte].reverse().filter(s => s.rueckweg).map(s => `- zu Schritt ${s.nr} (${s.titel}): ${s.rueckweg!.keiner ? `kein Rückweg — ${s.rueckweg!.keiner}` : `${s.rueckweg!.skill}.${s.rueckweg!.aktion}${param(s.rueckweg!.parameter)}`}`);
  const test = plan.schritte.filter(s => s.pruefung).map(s => `- Schritt ${s.nr}: ${pruefText(s.pruefung)}`);
  return { umsetzung, rueckweg: rw.length ? `In umgekehrter Reihenfolge der erledigten Schritte:\n${rw.join('\n')}` : 'Keine ändernden Schritte.', test: test.join('\n') || '—' };
}

/** Kurzfassung für die Freigabe-Frage an den Owner. */
export function freigabeText(c: { id: string; titel: string; risiko: string; typ: string; ausfallMinuten?: number; geplantAb?: string; schritte: ChangeSchritt[]; auswirkung?: Auswirkung; hinweise: string[]; fingerabdruck: string }): string {
  const aend = c.schritte.filter(s => s.einordnung === 'aendern' || s.einordnung === 'loeschen' || s.art === 'owner');
  const z = [
    `**${c.titel}** (${c.id.slice(0, 8)}) — ${c.typ}, Risiko ${c.risiko}, Ausfall ${c.ausfallMinuten ?? '?'} min${c.geplantAb ? `, ab ${c.geplantAb.slice(0, 16).replace('T', ' ')} UTC` : ''}`,
    `${c.schritte.length} Schritte, davon ${aend.length} mit Wirkung:`,
    ...aend.slice(0, 8).map(s => `  ${s.nr}. ${s.titel}`), ...(aend.length > 8 ? [`  … ${aend.length - 8} weitere`] : []),
  ];
  if (c.auswirkung) z.push(`Betroffen: ${c.auswirkung.assets.slice(0, 6).join(', ')}${c.auswirkung.services.length ? `; Services: ${c.auswirkung.services.map(s => `${s.name} (${s.kritikalitaet})`).slice(0, 5).join(', ')}` : ''}`);
  if (c.hinweise.length) z.push(`Hinweise: ${c.hinweise.slice(0, 3).join('; ')}`);
  z.push(`Freigabe gilt genau für Plan ${c.fingerabdruck.slice(0, 12)} — jede Änderung braucht eine neue Freigabe.`);
  return z.join('\n');
}

export interface Auswirkung { assets: string[]; abhaengige: string[]; services: Array<{ name: string; kritikalitaet: string }>; kritisch: boolean; offeneIncidents: string[]; ueberschneidungen: string[] }
