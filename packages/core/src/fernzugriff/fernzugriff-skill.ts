import { Skill } from '@alfred/skills';
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import type { Fernzugang } from '@alfred/storage';
import { Freigaben } from '../geraete/freigaben.js';
import { befehlsklasse, kuerzeMitte, fernBefehl, leseKeyscan, knownHostsZeilen, gueltigerHost, gueltigerBenutzer, einrichtungsBefehle, normalisiereBefehl, ausfuehrbarerBefehl } from './regeln.js';
import type { SshErgebnis, SshZiel } from './ssh.js';
import { betroffeneVmids } from './wiederherstellbarkeit.js';
import { geheimnisGrund, kaefigBefehl, KAEFIG_SELBSTTEST, KAEFIG_STUFEN, werteSelbsttest, kaefigGrenze, schwaerze, type KaefigModus } from './kaefig.js';
import { randomBytes } from 'node:crypto';
import { ABWAEGUNG } from './weg-wahl.js';
import { kopiere, kopiereDatenbank, datenbankInventar, volumePfad, pruefePfad, gueltigerName, type Wege, type StromErgebnis } from './uebertragung.js';

/**
 * v1539 (Owner 21.10. „ssh über cmdb plus skill fernzugriff, benutzer alfred mit sudo-rechten, er soll auch etwas machen können“).
 * Realfall 21.10.: „Hast du keinen SSH-Zugang auf den Host?“ — Alfred konnte `zpool status` auf pve nicht ausführen.
 *
 * Zugänge liegen in `fernzugaenge` (verknüpft mit dem CMDB-Eintrag); der private Schlüssel bleibt eine Datei auf dem Server.
 * Lesende Befehle (feste Liste) laufen ohne Rückfrage, alles andere nur nach dem Ja des Owners (Einmal-Freigabe, gebunden an
 * Zugang + Befehl), Zerstörerisches nie. Der Host-Schlüssel wird beim Anlegen gelesen und erst nach Bestätigung verwendet;
 * ändert er sich, wird der Zugang gesperrt.
 */
export interface FernzugriffRepo {
  liste(userId: string): Promise<Fernzugang[]>;
  finde(userId: string, nameOderHost: string): Promise<Fernzugang | null>;
  hole(userId: string, id: string): Promise<Fernzugang | null>;
  speichere(userId: string, e: { name: string; host: string; port: number; benutzer: string; schluesselPfad: string; hostSchluessel?: string; fingerabdruck?: string; cmdbAssetId?: string; status: Fernzugang['status'] }): Promise<Fernzugang>;
  setzeStatus(userId: string, id: string, status: Fernzugang['status']): Promise<void>;
  merkeErgebnis(userId: string, id: string, ok: boolean, fehler?: string): Promise<void>;
  entferne(userId: string, id: string): Promise<boolean>;
  /** v1549 — Lese-Käfig je Zugang */
  setzeKaefig?(userId: string, id: string, kaefig: NonNullable<Fernzugang['kaefig']>): Promise<void>;
}

export interface FernzugriffDeps {
  repo: FernzugriffRepo;
  owner: () => string | undefined;
  istOwner: (ctx: SkillContext) => boolean;
  /** CMDB-Eintrag zum Namen (Host aus IP/Hostname) und Rückverweis auf den Zugang */
  cmdbFinde?: (name: string) => Promise<{ id: string; name: string; host?: string } | null>;
  cmdbMarkiere?: (assetId: string, zugang: { name: string; benutzer: string; port: number } | null) => Promise<void>;
  bestaetigung: (frage: { description: string; params: Record<string, unknown> }, herkunft?: { chatId: string; platform: string }) => Promise<boolean>;
  ssh: (ziel: SshZiel, befehl: string, timeoutMs?: number) => Promise<SshErgebnis>;
  /** I4c — SSH mit Eingabe über stdin (Geheimnisse nie in der Befehlszeile); I6: `max` für große Dateilisten */
  sshEingabe?: (ziel: SshZiel, befehl: string, eingabe: string, timeoutMs?: number, max?: number) => Promise<SshErgebnis>;
  /** I6 — Strom Quelle → Server → Ziel (tar, pg_dump) */
  sshStrom?: (q: SshZiel, qBefehl: string, qEingabe: string, z: SshZiel, zBefehl: string, o: { timeoutMs: number; kbps?: number; fortschritt?: (bytes: number) => void }) => Promise<StromErgebnis & { hostSchluesselGeaendert: boolean }>;
  /** I6 (E4-G) — Geheimnis vom Quell-Host direkt in den Tresor (Wert erreicht nie das Modell) */
  tresorSetzen?: (name: string, wert: string, herkunft: string, zweck?: string) => Promise<void>;
  keyscan: (host: string, port: number) => Promise<string>;
  schluessel: () => Promise<{ pfad: string; oeffentlich: string; neu: boolean }>;
  melde?: (text: string) => void;
  protokoll?: (msg: string, daten: Record<string, unknown>) => void;
  /** v1543 (F4) — Sicherungen betroffener VMs aus allen Quellen (Proxmox-Speicher, Commvault) als Textabschnitt */
  wiederherstellbarkeit?: (vmids: number[]) => Promise<string | undefined>;
  /** v1550 (S4c) — was Fachskills zum selben Host zusätzlich können (Hinweis im Ergebnis) */
  fachskillHinweis?: (z: Fernzugang) => Promise<string | undefined>;
  /** v1550 (S4a) — Zugänge geändert (Namensmuster für den Skill-Filter neu bilden) */
  beiAenderung?: () => void;
}

/** v1542 (F3) — so viel geht ans Modell; vorher 6000 → SMART-Werte fehlten. v1548 (K1, Realfall 22.10.: `docker ps` mit 40 Containern
 *  ≈ 14 600 Zeichen, 2 673 fehlten in der Mitte) → 30 000; die Pipeline lässt für diesen Skill ebenso viel durch (FERNZUGRIFF_MAX). */
export const ANZEIGE_MAX = 30_000;
const AKTIONEN = ['liste', 'schluessel', 'anlegen', 'pruefen', 'lesen', 'ausfuehren', 'entfernen', 'seite', 'kaefig', 'zugang_bestaetigen', 'kaefig_bestaetigen', 'kopieren', 'datenbank_kopieren', 'geheim_uebernehmen', 'datenbank_inventar'] as const;
/** I6 — Datenübertragung und Geheimnis-Übernahme nur als Schritte freigegebener Changes */
const NUR_IM_CHANGE = new Set(['kopieren', 'datenbank_kopieren', 'geheim_uebernehmen']);

/** v1549 (S3) — vollständige lange Ausgaben bleiben 2 h abrufbar (höchstens 30, je 5 MB), seitenweise oder per Suche. */
const SEITEN_GUELTIG_MS = 2 * 3_600_000;
const SEITEN_MAX = 30;
const SEITE_ZEICHEN = 25_000;

/** v1548 (K1) — bei einer Kürzung sagt die Ausgabe selbst, wie es kompakter geht (Modell fragt sonst dieselbe lange Ausgabe erneut). */
export const KUERZUNG_HINWEIS = '[Ausgabe gekürzt — kompakter abfragen: z. B. docker ps --format \'{{.Names}}\\t{{.Status}}\', | head -n N, | tail -n +N, | grep <muster>; das sind Lesebefehle ohne Rückfrage]';

function kuerze(t: string, max = ANZEIGE_MAX): string {
  return t.length <= max ? t : `${kuerzeMitte(t, max - KUERZUNG_HINWEIS.length - 1)}\n${KUERZUNG_HINWEIS}`;
}

export class FernzugriffSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'fernzugriff',
    category: 'infrastructure',
    description:
      'SSH auf Hosts, die Alfred nicht selbst angelegt hat (z. B. Proxmox-Knoten pve, NAS), über hinterlegte Zugänge. ' +
      'liste: Zugänge. lesen: lesender Befehl — läuft sofort (zpool status/list/events, zfs list, pvecm status, pvesm status/list, qm list/config/listsnapshot, df -h, free -h, journalctl -u …, systemctl status …, smartctl -a /dev/… oder /dev/disk/by-id/…, smartctl --scan, nvme smart-log, lsblk -o …, ls -l /dev/disk/by-id; Docker: docker ps, docker logs --tail N <container>, docker stats --no-stream, docker inspect --format "{{…}}" <container> (auch .HostConfig.PortBindings/Binds/Links, index .Config.Labels "com.docker.compose.…"; nie Env/Cmd/Labels), docker ps --filter name=…, docker network inspect <netz>, docker volume inspect --format "{{.Mountpoint}}" <volume>, docker images, docker system df, docker compose ls; in Formatvorlagen als Trenner Leerzeichen, / oder = — nie | oder ;, die zerlegen den Befehl). Mehrere Lesebefehle mit ; oder && und Pipes zu grep/head/tail/wc/sort/uniq/cut gehen ebenfalls mit lesen — für Diagnosen immer lesen versuchen. ' +
      'ausfuehren: jeder andere Befehl (Neustart eines Dienstes, zpool scrub, apt …) — fragt den Owner, läuft nach seinem Ja als root (sudo). Zerstörerisches (mkfs, zpool destroy, dd auf Datenträger …) nie. ' +
      'pruefen: Verbindung und sudo testen. anlegen: neuen Zugang (name, host oder CMDB-Name, benutzer alfred) — Host-Schlüssel wird gelesen und vom Owner bestätigt. ' +
      'schluessel: Alfreds öffentlichen Schlüssel und die Einrichtung auf dem Host zeigen. entfernen: Zugang löschen (mit Bestätigung). ' +
      'LESE-KÄFIG: Jeder andere Befehl mit action=lesen (cat/less von Konfigs, tail/grep von Logs unter /var/log, find, du, ls, ss, sed -n, awk …) läuft ebenfalls ohne Rückfrage — in einem Käfig auf dem Host: Dateisystem schreibgeschützt, kein Docker/D-Bus/Netz. Für ALLE Analysen action=lesen nehmen; nur echte Änderungen mit ausfuehren. Ausnahme: Geheimnisse (Schlüssel, .env, Passwort-Dateien) nur mit Bestätigung. ' +
      `${ABWAEGUNG} ` +
      'seite: lange Ausgaben sind vollständig gespeichert — weitere Seiten (id, seite) oder Suche darin (id, suche=<regex>) ohne den Befehl erneut auszuführen. kaefig: Lese-Käfig eines Zugangs an/aus (an=false sofort, an=true nur mit Bestätigung). ' +
      'datenbank_inventar (name, container, art=postgres|redis): festes, nur lesendes Inventar ohne Rückfrage — Version, Datenbanken mit Größe, Tabellen und Zeilenzahl, Rollennamen, Fingerabdruck; in Changes als Vorher/Nachher-Nachweis (Prüfung erwartet {{schrittN.fingerabdruck}}).',
    riskLevel: 'write',
    version: '1.0.0',
    timeoutMs: 15 * 60_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...AKTIONEN], description: 'liste | lesen | ausfuehren | pruefen | anlegen | schluessel | entfernen' },
        name: { type: 'string', description: 'Name des Zugangs (z. B. pve) oder sein Host' },
        befehl: { type: 'string', description: 'Shell-Befehl auf dem Host (lesen/ausfuehren)' },
        als_root: { type: 'boolean', description: 'ausfuehren: über sudo als root (Standard ja)' },
        host: { type: 'string', description: 'anlegen: IP oder Hostname (sonst aus dem CMDB-Eintrag)' },
        port: { type: 'number', description: 'anlegen: SSH-Port (Standard 22)' },
        benutzer: { type: 'string', description: 'anlegen: Benutzer auf dem Host (Standard alfred)' },
        timeout_s: { type: 'number', description: 'Zeitlimit in Sekunden (Standard 60, höchstens 900)' },
        id: { type: 'string', description: 'seite: Kennung der gespeicherten Ausgabe' },
        seite: { type: 'number', description: 'seite: Seitennummer (ab 1)' },
        suche: { type: 'string', description: 'seite: Suchmuster (Regex, ohne Groß/Klein) in der gespeicherten Ausgabe' },
        an: { type: 'boolean', description: 'kaefig: an (true) oder aus (false)' },
        // I6 — Datenübertragung (nur in Changes)
        quelle: { type: 'string', description: 'kopieren/datenbank_kopieren: Zugang der Quelle' },
        ziel: { type: 'string', description: 'kopieren/datenbank_kopieren: Zugang des Ziels' },
        quelle_pfad: { type: 'string', description: 'kopieren: Ordner an der Quelle (absolut)' },
        ziel_pfad: { type: 'string', description: 'kopieren: Ordner am Ziel (/srv/…, /opt/…, /data/…, /mnt/…, /home/<b>/…)' },
        quelle_volume: { type: 'string', description: 'kopieren: Docker-Volume an der Quelle statt quelle_pfad' },
        ziel_volume: { type: 'string', description: 'kopieren: Docker-Volume am Ziel (wird angelegt) statt ziel_pfad' },
        loeschen: { type: 'boolean', description: 'kopieren: am Ziel entfernen, was es an der Quelle nicht gibt (Abgleich nach dem Stoppen)' },
        pruefsumme: { type: 'boolean', description: 'kopieren: SHA-256 über alle Dateien beider Seiten vergleichen (Standard ja)' },
        kbps: { type: 'number', description: 'kopieren/datenbank_kopieren: Bandbreitengrenze in KB/s' },
        quelle_container: { type: 'string', description: 'datenbank_kopieren: PostgreSQL-Container an der Quelle' },
        ziel_container: { type: 'string', description: 'datenbank_kopieren: PostgreSQL-Container am Ziel (Datenbank muss existieren)' },
        datenbank: { type: 'string', description: 'datenbank_kopieren: Datenbankname' },
        container: { type: 'string', description: 'datenbank_inventar: Container der Datenbank' },
        art: { type: 'string', enum: ['postgres', 'redis'], description: 'datenbank_inventar: postgres oder redis' },
        db_benutzer: { type: 'string', description: 'datenbank_kopieren: Datenbank-Benutzer' },
        pfad: { type: 'string', description: 'geheim_uebernehmen: Datei mit Geheimnissen an der Quelle (z. B. /opt/app/.env)' },
        tresor_name: { type: 'string', description: 'geheim_uebernehmen: Name des Tresor-Eintrags (danach {{geheimdatei:name}} am Ziel)' },
        zweck: { type: 'string', description: 'geheim_uebernehmen: wofür' },
        quelle_entfernen: { type: 'boolean', description: 'geheim_uebernehmen: Datei danach entfernen — nur für eigene Export-Dateien unter /root/ oder /tmp/' },
      },
      required: ['action'],
    },
  };

  private readonly freigaben = new Freigaben();
  private readonly seiten = new Map<string, { name: string; befehl: string; text: string; zeit: number }>();
  /** v1551 — Käfig je Zugang nach jedem Start einmal neu prüfen (geänderte Eigenschaften, geänderter Host) */
  private readonly kaefigGeprueft = new Set<string>();
  /** v1632 — beim Selbsttest ermittelte Stufe je Zugang */
  private readonly kaefigStufe = new Map<string, KaefigModus>();

  constructor(private readonly deps: FernzugriffDeps) { super(); }

  /** v1537 — Vorschläge vor „Ausführen“ prüfen: Zugang und Befehl müssen angegeben sein. */
  pruefeEingabe(input: Record<string, unknown>): string | undefined {
    const a = String(input.action ?? '');
    // v1638 — Realfall 24.10. (026a0768 Schritt 3: geheim_uebernehmen mit „quelle“ statt „name“ hielt erst im Lauf an): auch diese Aktionen prüfen
    const zugangName = typeof input.name === 'string' && input.name.trim() ? input.name : a === 'geheim_uebernehmen' && typeof input.quelle === 'string' && input.quelle.trim() ? input.quelle : '';
    if (['lesen', 'ausfuehren', 'pruefen', 'entfernen', 'geheim_uebernehmen', 'datenbank_inventar'].includes(a) && !zugangName) return `${a} braucht name (Zugang)`;
    if (['kopieren', 'datenbank_kopieren'].includes(a) && !(typeof input.quelle === 'string' && input.quelle.trim() && typeof input.ziel === 'string' && input.ziel.trim())) return `${a} braucht quelle und ziel (Zugänge)`;
    if (a === 'datenbank_inventar' && !(typeof input.container === 'string' && input.container.trim())) return 'datenbank_inventar braucht container';
    if (['lesen', 'ausfuehren'].includes(a) && !(typeof input.befehl === 'string' && input.befehl.trim())) return `${a} braucht befehl`;
    return undefined;
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    if (!this.deps.istOwner(context)) return { success: false, error: 'Fernzugriff ist nur für den Owner.' };
    const owner = this.deps.owner();
    if (!owner) return { success: false, error: 'Kein Owner bekannt.' };
    const action = String(input.action ?? 'liste');
    const herkunft = context.chatId && context.platform ? { chatId: context.chatId, platform: String(context.platform) } : undefined;
    if (NUR_IM_CHANGE.has(action) && context.ausChange !== true) return { success: false, error: `${action} läuft nur als Schritt eines freigegebenen Changes — mit infrastruktur changes_planen planen` };
    try {
      switch (action) {
        case 'liste': return await this.liste(owner);
        case 'schluessel': return await this.schluesselZeigen();
        case 'anlegen': return await this.anlegen(owner, input, herkunft);
        case 'zugang_bestaetigen': return await this.zugangBestaetigen(owner, input);
        case 'pruefen': return await this.pruefen(owner, input);
        case 'lesen': return await this.lesen(owner, input, context);
        case 'ausfuehren': return await this.ausfuehren(owner, input, herkunft, context);
        case 'entfernen': return await this.entfernen(owner, input, herkunft);
        case 'seite': return this.seite(input);
        case 'kaefig': return await this.kaefigSchalter(owner, input, herkunft);
        case 'kaefig_bestaetigen': return await this.kaefigBestaetigen(owner, input);
        case 'kopieren': return await this.kopieren(owner, input);
        case 'datenbank_kopieren': return await this.datenbankKopieren(owner, input);
        case 'datenbank_inventar': return await this.datenbankInventarAktion(owner, input);
        case 'geheim_uebernehmen': return await this.geheimUebernehmen(owner, input);
        default: return { success: false, error: `Unbekannte Aktion „${action}“ (${AKTIONEN.filter(a => !a.endsWith('_bestaetigen')).join(', ')})` };
      }
    } catch (err) {
      return { success: false, error: (err as Error).message.slice(0, 500) };
    }
  }

  private async liste(owner: string): Promise<SkillResult> {
    const l = await this.deps.repo.liste(owner);
    if (!l.length) return { success: true, data: [], display: 'Noch kein Fernzugang hinterlegt. Mit `schluessel` zeige ich meinen öffentlichen Schlüssel und die Einrichtung auf dem Host, danach `anlegen`.' };
    const zeilen = l.map(z => `- **${z.name}** ${z.benutzer}@${z.host}${z.port !== 22 ? `:${z.port}` : ''} · ${z.status === 'aktiv' ? 'aktiv' : z.status === 'wartet' ? 'wartet auf Bestätigung des Host-Schlüssels' : 'gesperrt'}${z.kaefig ? ` · Lese-Käfig ${z.kaefig}` : ''}${z.zuletztOk ? ` · zuletzt ok ${z.zuletztOk.slice(0, 16).replace('T', ' ')}` : ''}${z.zuletztFehler ? ` · Fehler: ${z.zuletztFehler.slice(0, 120)}` : ''}`);
    return { success: true, data: l.map(({ hostSchluessel: _h, ...rest }) => rest), display: zeilen.join('\n') };
  }

  private async schluesselZeigen(): Promise<SkillResult> {
    const k = await this.deps.schluessel();
    this.deps.protokoll?.('v1539 Fernzugriff-Schlüssel angezeigt', { neu: k.neu });
    return {
      success: true, data: { oeffentlich: k.oeffentlich, neu: k.neu },
      display: `${k.neu ? 'Neuen Schlüssel erzeugt. ' : ''}Mein öffentlicher Schlüssel für den Fernzugriff:\n\n\`\`\`\n${k.oeffentlich}\n\`\`\`\n\nEinrichtung auf dem Host (als root):\n\n\`\`\`\n${einrichtungsBefehle(k.oeffentlich)}\n\`\`\`\n\nDanach: „lege den Fernzugang <name> an“.`,
    };
  }

  private async anlegen(owner: string, input: Record<string, unknown>, herkunft?: { chatId: string; platform: string }): Promise<SkillResult> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || !/^[\w.-]{1,64}$/.test(name)) return { success: false, error: 'anlegen braucht einen Namen (Buchstaben, Ziffern, . _ -)' };
    const cmdb = await this.deps.cmdbFinde?.(name).catch(() => null) ?? null;
    const host = (typeof input.host === 'string' && input.host.trim()) || cmdb?.host || '';
    if (!host) return { success: false, error: `Kein Host für „${name}“: weder angegeben noch im CMDB-Eintrag (IP/Hostname).` };
    if (!gueltigerHost(host)) return { success: false, error: `Ungültiger Host „${host}“` };
    const port = typeof input.port === 'number' && input.port > 0 && input.port < 65536 ? Math.floor(input.port) : 22;
    const benutzer = typeof input.benutzer === 'string' && input.benutzer.trim() ? input.benutzer.trim() : 'alfred';
    if (!gueltigerBenutzer(benutzer)) return { success: false, error: `Ungültiger Benutzer „${benutzer}“` };
    const k = await this.deps.schluessel();
    const schluessel = leseKeyscan(await this.deps.keyscan(host, port));
    if (!schluessel.length) return { success: false, error: `Von ${host}:${port} kam kein Host-Schlüssel (SSH nicht erreichbar?).` };
    const z = await this.deps.repo.speichere(owner, { name, host, port, benutzer, schluesselPfad: k.pfad, hostSchluessel: knownHostsZeilen(host, port, schluessel), fingerabdruck: schluessel.map(s => `${s.typ} ${s.fingerabdruck}`).join(', '), cmdbAssetId: cmdb?.id, status: 'wartet' });
    const params = { action: 'zugang_bestaetigen', name: z.name, id: z.id, fingerabdruck: z.fingerabdruck };
    const nonce = this.freigaben.erzeuge('fernzugriff', 'zugang_bestaetigen', params);
    const ed = schluessel.find(s => s.typ === 'ssh-ed25519') ?? schluessel[0]!;
    const frage = [
      `🔑 Fernzugang „${z.name}“ anlegen: ${benutzer}@${host}${port !== 22 ? `:${port}` : ''}${cmdb ? ` (CMDB: ${cmdb.name})` : ''}.`,
      `Host-Schlüssel ${ed.typ}: ${ed.fingerabdruck}`,
      `Vergleichen auf dem Host: ssh-keygen -lf /etc/ssh/ssh_host_${ed.typ === 'ssh-ed25519' ? 'ed25519' : ed.typ.startsWith('ecdsa') ? 'ecdsa' : 'rsa'}_key.pub`,
      'Nach dem Ja gilt nur dieser Schlüssel; ändert er sich, sperre ich den Zugang.',
    ].join('\n');
    const gestellt = await this.deps.bestaetigung({ description: frage, params: { ...params, freigabe: nonce } }, herkunft);
    this.deps.protokoll?.('v1539 Fernzugang angelegt, Host-Schlüssel zur Bestätigung', { name: z.name, host, port, benutzer, fingerabdruck: ed.fingerabdruck, cmdb: cmdb?.id });
    return gestellt
      ? { success: true, data: { zurBestaetigung: true, name: z.name, fingerabdruck: ed.fingerabdruck }, display: `Zugang „${z.name}“ angelegt. Den Host-Schlüssel (${ed.fingerabdruck}) habe ich dir zur Bestätigung gestellt — erst danach verbinde ich mich.` }
      : { success: false, error: 'Bestätigung konnte nicht gestellt werden' };
  }

  private async zugangBestaetigen(owner: string, input: Record<string, unknown>): Promise<SkillResult> {
    const { freigabe, ...params } = input;
    if (!this.freigaben.verbrauche(freigabe, 'fernzugriff', 'zugang_bestaetigen', params)) return { success: false, error: 'Diese Bestätigung ist ungültig oder abgelaufen — Zugang neu anlegen.' };
    const z = await this.deps.repo.hole(owner, String(params.id ?? ''));
    if (!z || z.fingerabdruck !== params.fingerabdruck) return { success: false, error: 'Zugang nicht gefunden oder inzwischen verändert.' };
    await this.deps.repo.setzeStatus(owner, z.id, 'aktiv');
    if (z.cmdbAssetId) await this.deps.cmdbMarkiere?.(z.cmdbAssetId, { name: z.name, benutzer: z.benutzer, port: z.port }).catch(() => undefined);
    this.deps.protokoll?.('v1539 Fernzugang bestätigt', { name: z.name, host: z.host });
    this.deps.beiAenderung?.();
    const p = await this.pruefen(owner, { name: z.name });
    return { success: true, display: `✅ Fernzugang „${z.name}“ ist aktiv.\n${p.display ?? p.error ?? ''}` };
  }

  private async zugang(owner: string, input: Record<string, unknown>): Promise<Fernzugang> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new Error('Welcher Zugang? (name)');
    const z = await this.deps.repo.finde(owner, name);
    if (!z) {
      const l = await this.deps.repo.liste(owner);
      throw new Error(`Kein Fernzugang „${name}“. ${l.length ? `Vorhanden: ${l.map(x => x.name).join(', ')}.` : 'Noch keiner hinterlegt — erst `schluessel`, dann `anlegen`.'}`);
    }
    if (z.status === 'wartet') throw new Error(`Der Host-Schlüssel von „${z.name}“ ist noch nicht bestätigt (offene Frage beim Owner).`);
    if (z.status === 'gesperrt') throw new Error(`Fernzugang „${z.name}“ ist gesperrt${z.zuletztFehler ? ` (${z.zuletztFehler.slice(0, 160)})` : ''} — neu anlegen, um den Host-Schlüssel erneut zu bestätigen.`);
    return z;
  }

  private async lauf(owner: string, z: Fernzugang, befehl: string, timeoutMs: number): Promise<SshErgebnis> {
    const r = await this.deps.ssh({ id: z.id, host: z.host, port: z.port, benutzer: z.benutzer, schluesselPfad: z.schluesselPfad, hostSchluessel: z.hostSchluessel }, befehl, timeoutMs);
    if (r.hostSchluesselGeaendert) {
      await this.deps.repo.setzeStatus(owner, z.id, 'gesperrt');
      await this.deps.repo.merkeErgebnis(owner, z.id, false, 'Host-Schlüssel hat sich geändert');
      this.deps.protokoll?.('v1539 Host-Schlüssel geändert — Zugang gesperrt', { name: z.name, host: z.host });
      this.deps.melde?.(`⚠️ Fernzugang „${z.name}“ (${z.host}) gesperrt: Der Host-Schlüssel hat sich geändert. Wenn der Host neu installiert wurde, den Zugang neu anlegen und den neuen Schlüssel bestätigen.`);
    } else {
      await this.deps.repo.merkeErgebnis(owner, z.id, r.code === 0, r.code === 0 ? undefined : r.stderr.trim().split('\n').slice(-2).join(' '));
    }
    return r;
  }

  private timeout(input: Record<string, unknown>): number {
    const s = typeof input.timeout_s === 'number' ? input.timeout_s : 60;
    return Math.min(Math.max(s, 5), 900) * 1000;
  }

  private ergebnis(z: Fernzugang, befehl: string, r0: SshErgebnis, zusatz = ''): SkillResult {
    // v1551 — Geheimnisse schwärzen, bevor irgendetwas davon das Modell oder die Seiten-Ablage erreicht
    const so = schwaerze(r0.stdout), se = schwaerze(r0.stderr);
    const r: SshErgebnis = { ...r0, stdout: so.text, stderr: se.text };
    if (so.anzahl + se.anzahl) { zusatz += `  [${so.anzahl + se.anzahl} Geheimnis(se) geschwärzt]`; this.deps.protokoll?.('v1551 Geheimnisse in Ausgabe geschwärzt', { name: z.name, befehl: befehl.slice(0, 120), anzahl: so.anzahl + se.anzahl }); }
    const aus = [r.stdout.trimEnd(), r.stderr.trim() ? `[stderr]\n${r.stderr.trim()}` : ''].filter(Boolean).join('\n');
    const kopf = `${z.name}$ ${befehl}${zusatz}${r.code !== 0 ? `  (Exit ${r.code})` : ''}`;
    const voll = `${kopf}\n${aus || '(keine Ausgabe)'}`;
    // v1549 (S3) — zu lang: vollständig ablegen, erste Fassung mit Anfang/Ende, Rest über action=seite (ohne erneuten Lauf)
    let text = kuerze(voll);
    if (voll.length > ANZEIGE_MAX) {
      const id = this.legeAb(z.name, befehl, voll);
      const zeilen = voll.split('\n').length, seiten = Math.ceil(voll.length / SEITE_ZEICHEN);
      const hinweis = `[Vollständig gespeichert: ${zeilen} Zeilen, ${voll.length} Zeichen, ${seiten} Seiten — action=seite, id=${id}, seite=1…${seiten}, oder suche=<regex>; kein erneuter Lauf nötig]`;
      text = `${kuerzeMitte(voll, ANZEIGE_MAX - hinweis.length - 1)}\n${hinweis}`;
    }
    const display = `\`\`\`\n${text}\n\`\`\``;
    // v1542 (F3) — Exit ≠ 0 mit Ausgabe ist ein Ergebnis, kein Fehlschlag: smartctl meldet z. B. eine Platte mit Fehlern über eine
    // Bitmaske im Exit-Code, die Werte stehen trotzdem in der Ausgabe. Ohne Ausgabe (oder bei Verbindungs-/Schlüsselproblemen) Fehler.
    const nurFehler = r.hostSchluesselGeaendert || (r.code !== 0 && !r.stdout.trim());
    return {
      success: !nurFehler, display,
      data: { name: z.name, befehl, code: r.code, stdout: r.stdout.slice(0, 200_000), stderr: r.stderr.slice(0, 20_000) },
      ...(nurFehler ? { error: r.hostSchluesselGeaendert ? 'Host-Schlüssel geändert — Zugang gesperrt' : `Exit ${r.code}: ${r.stderr.trim().slice(-1500)}` } : {}),
    };
  }

  /**
   * v1543 (F4) — feste Regel: nennt `zpool status` dauerhafte Datenfehler in VM-Volumes, werden die Sicherungen dieser VMs aus allen
   * Quellen geprüft und an das Ergebnis gehängt (das Modell muss nicht daran denken). Fehler der Prüfung brechen das Ergebnis nicht.
   */
  private async mitWiederherstellbarkeit(befehl: string, r: SshErgebnis, e: SkillResult, context?: SkillContext): Promise<SkillResult> {
    if (!this.deps.wiederherstellbarkeit || !/\bzpool status\b/.test(befehl)) return e;
    const vmids = betroffeneVmids(r.stdout);
    if (!vmids.length) return e;
    try {
      const text = await this.deps.wiederherstellbarkeit(vmids);
      if (!text) return e;
      this.deps.protokoll?.('v1543 Wiederherstellbarkeit angehängt', { vmids });
      // v1544 — der Abschnitt erreicht den Owner sicher: die Pipeline hängt ihn an, wenn das Modell ihn weglässt
      if (context?.antwortZusatz) (context.antwortZusatz.nachsaetze ??= []).push(text);
      return { ...e, display: `${e.display ?? ''}\n\n${text}`, data: { ...(e.data as Record<string, unknown>), wiederherstellbarkeit: text } };
    } catch (err) {
      return { ...e, display: `${e.display ?? ''}\n\n(Wiederherstellbarkeit nicht prüfbar: ${(err as Error).message.slice(0, 160)})` };
    }
  }

  private async pruefen(owner: string, input: Record<string, unknown>): Promise<SkillResult> {
    const z = await this.zugang(owner, input);
    const a = await this.lauf(owner, z, 'hostname', 20_000);
    if (a.code !== 0) return { success: false, error: `Verbindung zu ${z.benutzer}@${z.host} fehlgeschlagen: ${a.stderr.trim().slice(-300)}${/Permission denied/i.test(a.stderr) ? ' — Schlüssel auf dem Host noch nicht eingetragen? (`schluessel` zeigt die Einrichtung)' : ''}` };
    const s = await this.lauf(owner, z, 'sudo -n true', 20_000);
    // v1549 — Käfig mitprüfen (außer der Owner hat ihn abgeschaltet); ein früheres „fehlt“ wird neu getestet
    if (s.code === 0 && z.kaefig === 'fehlt' && this.deps.repo.setzeKaefig) { await this.deps.repo.setzeKaefig(owner, z.id, 'ungeprueft'); z.kaefig = 'ungeprueft'; }
    // v1634 — „pruefen“ testet den Käfig immer neu (geänderter Host, z. B. SELinux-Modul) und nennt die erreichte Stufe
    if (z.kaefig !== 'aus') this.kaefigGeprueft.delete(z.id);
    const k = s.code === 0 ? await this.kaefigBereit(owner, z) : { ok: false, grund: 'braucht sudo ohne Passwort' };
    return { success: true, data: { hostname: a.stdout.trim(), sudo: s.code === 0, kaefig: k, kaefigStufe: this.kaefigStufe.get(z.id) }, display: `Verbindung ok: ${a.stdout.trim()} (${z.benutzer}@${z.host}). sudo ohne Passwort: ${s.code === 0 ? 'ja' : 'nein — Befehle laufen dann ohne root'}. Lese-Käfig: ${k.ok ? `aktiv (${k.grund})` : `nicht verfügbar (${k.grund})`}.` };
  }

  /** Lesender Befehl: als root, wenn sudo ohne Passwort geht, sonst als Benutzer. */
  private async lesen(owner: string, input: Record<string, unknown>, context?: SkillContext): Promise<SkillResult> {
    const befehl = typeof input.befehl === 'string' ? normalisiereBefehl(input.befehl) : '';
    const klasse = befehlsklasse(befehl);
    if (klasse === 'nie') return { success: false, error: `„${befehl.slice(0, 120)}“ ist nie erlaubt.` };
    // v1549 (S2) — Geheimnisse nie ohne Rückfrage (die Ausgabe ginge an das Modell), auch nicht im Käfig
    const geheim = geheimnisGrund(befehl);
    if (geheim) return { success: false, error: `„${befehl.slice(0, 120)}“ berührt ${geheim} — das läuft nur mit Bestätigung des Owners (action=ausfuehren).` };
    if (klasse !== 'lesen') return this.imKaefig(owner, befehl, input, context);
    const z = await this.zugang(owner, input);
    let r = await this.lauf(owner, z, fernBefehl(befehl, true), this.timeout(input));
    if (r.code !== 0 && /sudo: (a password is required|.*not allowed|.*may not run)/i.test(r.stderr)) r = await this.lauf(owner, z, befehl, this.timeout(input));
    this.deps.protokoll?.('v1539 Fernzugriff lesen', { name: z.name, befehl: befehl.slice(0, 200), code: r.code });
    return this.mitWiederherstellbarkeit(befehl, r, await this.mitFachskill(z, this.ergebnis(z, befehl, r)), context);
  }

  /**
   * v1549 (S1) — unbekannter Befehl ohne Rückfrage im Lese-Käfig. Erst nach bestandenem Selbsttest des Käfigs auf diesem Host; ist der
   * Käfig aus oder fehlt er, bleibt es bei der Rückfrage (ausfuehren).
   */
  private async imKaefig(owner: string, befehl: string, input: Record<string, unknown>, context?: SkillContext): Promise<SkillResult> {
    const z = await this.zugang(owner, input);
    const k = await this.kaefigBereit(owner, z);
    if (!k.ok) return { success: false, error: `„${befehl.slice(0, 120)}“ ist kein Befehl der festen Leseliste, und der Lese-Käfig ist auf ${z.name} nicht verfügbar (${k.grund}) — mit action=ausfuehren stelle ich ihn dem Owner zur Bestätigung.` };
    const sek = this.timeout(input) / 1000;
    const r = await this.lauf(owner, z, kaefigBefehl(befehl, z.benutzer, sek, this.kaefigStufe.get(z.id)), (sek + 15) * 1000);
    this.deps.protokoll?.('v1549 Fernzugriff im Lese-Käfig', { name: z.name, befehl: befehl.slice(0, 200), code: r.code });
    const e = await this.mitFachskill(z, this.ergebnis(z, befehl, r, '  (Lese-Käfig)'));
    if (r.code !== 0 && kaefigGrenze(r.stderr)) {
      // v1625 — Realfall 23.10. (Erhebung Web/Tresor): „Cannot connect to the Docker daemon“ las das Modell als Sperre des ganzen Docker-Zugriffs
      const docker = /^\s*(sudo\s+)?docker\s/.test(befehl) && /Cannot connect to the Docker daemon/i.test(r.stderr);
      const hinweis = docker
        ? '\n[Dieser Docker-Befehl steht nicht auf der Docker-Leseliste und lief deshalb im Käfig ohne Docker-Socket. Ohne Rückfrage gehen: docker ps/inspect --format mit einzelnen Feldern (State, State.Health, Mounts, HostConfig.RestartPolicy/PortBindings/Binds, NetworkSettings.Networks, Config.Image/ExposedPorts/Volumes, Labels nur com.docker.compose.*), docker images --digests, docker image inspect --format mit Id/RepoTags/RepoDigests/Created/Size, docker logs --tail N. Umgebungsvariablen, Healthcheck-Befehle und andere Labels nur mit action=ausfuehren (Owner-Bestätigung), weil sie Zugangsdaten tragen können.]'
        : '\n[Der Befehl stieß an den Lese-Käfig (schreibt, spricht einen Dienst/Socket an oder braucht Netz). Für eine gewollte Änderung: action=ausfuehren — das fragt den Owner.]';
      return { ...e, display: `${e.display ?? ''}${hinweis}`, ...(e.error ? { error: `${e.error}${hinweis}` } : {}) };
    }
    return this.mitWiederherstellbarkeit(befehl, r, e, context);
  }

  /**
   * I1 (Spec Infrastruktur-Vorhaben) — für feste Sammler ohne Modell: derselbe Weg wie `lesen` (Leseliste als root mit Rückfall,
   * sonst Lese-Käfig; Geheimnisse und Nie-Befehle abgewiesen; Ausgabe geschwärzt). Liefert stdout oder wirft.
   */
  async lesenIntern(name: string, befehl: string, timeoutMs = 60_000): Promise<string> {
    const owner = this.deps.owner();
    if (!owner) throw new Error('Kein Owner bekannt.');
    const b = normalisiereBefehl(befehl);
    const klasse = befehlsklasse(b);
    if (klasse === 'nie') throw new Error('nie erlaubt');
    if (geheimnisGrund(b)) throw new Error('berührt Geheimnisse');
    const z = await this.zugang(owner, { name });
    let r: SshErgebnis;
    if (klasse === 'lesen') {
      r = await this.lauf(owner, z, fernBefehl(b, true), timeoutMs);
      if (r.code !== 0 && /sudo: (a password is required|.*not allowed|.*may not run)/i.test(r.stderr)) r = await this.lauf(owner, z, b, timeoutMs);
    } else {
      const k = await this.kaefigBereit(owner, z);
      if (!k.ok) throw new Error(`nicht auf der Leseliste, Lese-Käfig nicht verfügbar (${k.grund})`);
      r = await this.lauf(owner, z, kaefigBefehl(b, z.benutzer, timeoutMs / 1000, this.kaefigStufe.get(z.id)), timeoutMs + 15_000);
    }
    if (r.code !== 0 && !r.stdout.trim()) throw new Error(`Exit ${r.code}: ${schwaerze(r.stderr).text.trim().slice(-200)}`);
    return schwaerze(r.stdout).text;
  }

  /**
   * I4 (Spec Infrastruktur-Vorhaben) — Ausführung für den Change-Motor: die Owner-Freigabe des ganzen Changes (Fingerabdruck über
   * genau diesen Befehl) ersetzt die Einzelrückfrage. Nie-Befehle bleiben gesperrt; die Ausgabe wird geschwärzt. Nur aus dem Kern
   * aufrufbar, nicht als Skill-Aktion.
   */
  async ausfuehrenIntern(name: string, befehl: string, alsRoot: boolean, timeoutMs = 300_000): Promise<{ code: number; stdout: string; stderr: string }> {
    const owner = this.deps.owner();
    if (!owner) throw new Error('Kein Owner bekannt.');
    const b = ausfuehrbarerBefehl(befehl);
    if (befehlsklasse(b) === 'nie') throw new Error(`„${b.slice(0, 120)}“ ist nie erlaubt`);
    const z = await this.zugang(owner, { name });
    const r = await this.lauf(owner, z, fernBefehl(b, alsRoot), timeoutMs);
    this.deps.protokoll?.('I4 Fernzugriff ausgeführt (Change)', { name: z.name, befehl: b.slice(0, 200), code: r.code, root: alsRoot });
    return { code: r.code, stdout: schwaerze(r.stdout).text, stderr: schwaerze(r.stderr).text };
  }

  /** I4c — Pfad einer Geheimnis-Datei am Ziel-Host (tmpfs, nur root) */
  static readonly GEHEIM_PFAD = /^\/run\/alfred-g-[0-9a-f]{16}$/;

  /** I4c — Geheimnis per stdin in eine Datei (600, root) am Host schreiben; der Wert erscheint nie in einer Befehlszeile oder im Log. */
  async geheimDateiSchreiben(name: string, pfad: string, wert: string): Promise<void> {
    const owner = this.deps.owner();
    if (!owner || !this.deps.sshEingabe) throw new Error('Geheimnis-Übergabe nicht verfügbar');
    if (!FernzugriffSkill.GEHEIM_PFAD.test(pfad)) throw new Error('ungültiger Geheimnis-Pfad');
    const z = await this.zugang(owner, { name });
    const r = await this.deps.sshEingabe({ id: z.id, host: z.host, port: z.port, benutzer: z.benutzer, schluesselPfad: z.schluesselPfad, hostSchluessel: z.hostSchluessel }, fernBefehl(`sh -c 'umask 077; cat > ${pfad}'`, true), wert, 30_000);
    if (r.code !== 0) throw new Error(`Geheimnis-Datei nicht geschrieben (Exit ${r.code}: ${schwaerze(r.stderr).text.slice(-160)})`);
    this.deps.protokoll?.('I4c Geheimnis-Datei geschrieben', { name: z.name, pfad });
  }

  /** I4c — Geheimnis-Datei nach dem Schritt entfernen (Fehler werden gemeldet, nicht verschluckt). */
  async geheimDateiEntfernen(name: string, pfad: string): Promise<boolean> {
    const owner = this.deps.owner();
    if (!owner || !FernzugriffSkill.GEHEIM_PFAD.test(pfad)) return false;
    const z = await this.zugang(owner, { name });
    const r = await this.lauf(owner, z, fernBefehl(`rm -f ${pfad}`, true), 30_000);
    this.deps.protokoll?.('I4c Geheimnis-Datei entfernt', { name: z.name, pfad, ok: r.code === 0 });
    return r.code === 0;
  }

  // ── I6 — Daten übertragen ───────────────────────────────────────────────────────────────────────────────────
  private wege(owner: string): Wege<Fernzugang> {
    const ziel = (z: Fernzugang): SshZiel => ({ id: z.id, host: z.host, port: z.port, benutzer: z.benutzer, schluesselPfad: z.schluesselPfad, hostSchluessel: z.hostSchluessel });
    return {
      lauf: async (z, befehl, eingabe, timeoutMs, max) => {
        if (!this.deps.sshEingabe) throw new Error('SSH mit Eingabe nicht verfügbar');
        const r = await this.deps.sshEingabe(ziel(z), befehl, eingabe, timeoutMs, max);
        if (r.hostSchluesselGeaendert) { await this.deps.repo.setzeStatus(owner, z.id, 'gesperrt'); throw new Error(`Host-Schlüssel von ${z.name} hat sich geändert — Zugang gesperrt`); }
        return { code: r.code, stdout: r.stdout, stderr: schwaerze(r.stderr).text };
      },
      strom: async (q, qb, qe, z, zb, o) => {
        if (!this.deps.sshStrom) throw new Error('Übertragung nicht verfügbar');
        const r = await this.deps.sshStrom(ziel(q), qb, qe, ziel(z), zb, o);
        if (r.hostSchluesselGeaendert) throw new Error('Host-Schlüssel hat sich geändert — Übertragung abgebrochen');
        return { ...r, stderrQuelle: schwaerze(r.stderrQuelle).text, stderrZiel: schwaerze(r.stderrZiel).text };
      },
      protokoll: (m, d) => this.deps.protokoll?.(m, d),
    };
  }

  private async kopieren(owner: string, input: Record<string, unknown>): Promise<SkillResult> {
    const q = await this.zugang(owner, { name: input.quelle });
    const z = await this.zugang(owner, { name: input.ziel });
    const w = this.wege(owner);
    const qPfad = typeof input.quelle_volume === 'string' && input.quelle_volume ? await volumePfad(w, q, input.quelle_volume, false) : input.quelle_pfad;
    const zPfad = typeof input.ziel_volume === 'string' && input.ziel_volume ? await volumePfad(w, z, input.ziel_volume, true) : input.ziel_pfad;
    const f = pruefePfad(qPfad, 'quelle') ?? pruefePfad(zPfad, 'ziel');
    if (f) return { success: false, error: f };
    if (q.id === z.id && (qPfad === zPfad || String(zPfad).startsWith(`${String(qPfad)}/`) || String(qPfad).startsWith(`${String(zPfad)}/`))) return { success: false, error: 'Quelle und Ziel überlappen' };
    const kbps = typeof input.kbps === 'number' && input.kbps > 0 ? input.kbps : undefined;
    const e = await kopiere(w, q, qPfad as string, z, zPfad as string, { loeschen: input.loeschen === true, pruefsumme: input.pruefsumme !== false, timeoutMs: this.timeoutLang(input), ...(kbps ? { kbps } : {}) });
    this.deps.protokoll?.('I6 kopiert', { quelle: `${q.name}:${String(qPfad)}`, ziel: `${z.name}:${String(zPfad)}`, ...e });
    const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;
    const zeilen = [
      `${q.name}:${String(qPfad)} → ${z.name}:${String(zPfad)} in ${e.sekunden} s: ${e.neu} neu, ${e.geaendert} geändert, ${e.geloescht} am Ziel entfernt, ${mb(e.bytes)} übertragen${e.uebersprungen ? `, ${e.uebersprungen} Sonderdateien übersprungen` : ''}.`,
      `Danach noch abweichend: ${e.restUnterschiede}${e.restUnterschiede ? ' (bei laufendem Dienst normal — nach dem Stoppen erneut abgleichen)' : ''}.`,
      ...(e.summe ? [`Prüfsumme (${e.summe.dateien} Dateien): ${e.summe.gleich ? 'gleich' : `VERSCHIEDEN (Quelle ${e.summe.quelle.slice(0, 12)}…, Ziel ${e.summe.ziel.slice(0, 12)}…)`}.`] : []),
    ];
    const ok = !e.summe || e.summe.gleich;
    return { success: ok, data: { ...e, quelle_pfad: qPfad, ziel_pfad: zPfad, gleich: e.summe?.gleich ?? null }, display: zeilen.join('\n'), ...(ok ? {} : { error: zeilen.join('\n') }) };
  }

  private async datenbankKopieren(owner: string, input: Record<string, unknown>): Promise<SkillResult> {
    const q = await this.zugang(owner, { name: input.quelle });
    const z = await this.zugang(owner, { name: input.ziel });
    const kbps = typeof input.kbps === 'number' && input.kbps > 0 ? input.kbps : undefined;
    const e = await kopiereDatenbank(this.wege(owner), q, String(input.quelle_container ?? ''), z, String(input.ziel_container ?? ''), String(input.datenbank ?? ''), String(input.db_benutzer ?? ''), { timeoutMs: this.timeoutLang(input), ...(kbps ? { kbps } : {}) });
    this.deps.protokoll?.('I6 Datenbank kopiert', { quelle: q.name, ziel: z.name, datenbank: input.datenbank, bytes: e.bytes, tabellen: e.tabellen, zeilen: e.zeilen, abweichungen: e.abweichungen.length });
    const text = `PostgreSQL ${String(input.datenbank)}: ${q.name}/${String(input.quelle_container)} → ${z.name}/${String(input.ziel_container)} in ${e.sekunden} s (${(e.bytes / 1024 / 1024).toFixed(1)} MB Dump). ${e.tabellen} Tabellen, ${e.zeilen} Zeilen; ${e.abweichungen.length ? `Abweichungen: ${e.abweichungen.slice(0, 10).join('; ')}` : 'Zeilenzahl je Tabelle gleich'}.`;
    return { success: e.abweichungen.length === 0, data: e, display: text, ...(e.abweichungen.length ? { error: text } : {}) };
  }

  /** v1636 — festes, nur lesendes Inventar einer Datenbank im Container (PostgreSQL/Redis) mit Fingerabdruck für Vorher/Nachher */
  private async datenbankInventarAktion(owner: string, input: Record<string, unknown>): Promise<SkillResult> {
    const z = await this.zugang(owner, { name: input.name });
    const art = input.art === 'redis' ? 'redis' : input.art === 'postgres' ? 'postgres' : undefined;
    if (!art) return { success: false, error: 'art: postgres oder redis' };
    const inv = await datenbankInventar(this.wege(owner), z, String(input.container ?? ''), art);
    this.deps.protokoll?.('v1636 Datenbank-Inventar', { zugang: z.name, container: input.container, art, version: inv.version, datenbanken: inv.datenbanken.length, fingerabdruck: inv.fingerabdruck.slice(0, 16) });
    const zeilen = inv.datenbanken.map(d => `- ${d.name}${d.bytes !== undefined ? ` ${(d.bytes / 1024 / 1024).toFixed(1)} MB` : ''}${d.tabellen !== undefined ? `, ${d.tabellen} Tabellen, ${d.zeilen} Zeilen` : ''}${d.schluessel !== undefined ? `, ${d.schluessel} Schlüssel` : ''}`);
    const display = [`${art === 'postgres' ? 'PostgreSQL' : 'Redis'} ${inv.version} in ${String(input.container)} auf ${z.name}`, ...(zeilen.length ? zeilen : ['- keine Datenbanken/Schlüssel']), ...(inv.rollen.length ? [`Rollen: ${inv.rollen.join(', ')}`] : []), `Fingerabdruck: ${inv.fingerabdruck}`].join('\n');
    return { success: true, data: inv, display };
  }

  /** E4-G — Datei mit Geheimnissen (.env o. ä.) als root lesen und direkt in den Tresor legen; Antwort nur Name und Größe */
  private async geheimUebernehmen(owner: string, input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.deps.tresorSetzen) return { success: false, error: 'Tresor nicht verfügbar' };
    // v1638 — „quelle“ wie bei kopieren als Zugang zulassen
    const z = await this.zugang(owner, { name: input.name ?? input.quelle });
    const pfad = input.pfad;
    if (typeof pfad !== 'string' || !/^\/[A-Za-z0-9._@+\/-]+$/.test(pfad) || pfad.split('/').includes('..')) return { success: false, error: 'pfad: absoluter Dateipfad' };
    if (!gueltigerName(input.tresor_name) || !/^[a-z0-9][\w.-]{1,60}$/.test(input.tresor_name)) return { success: false, error: 'tresor_name: Kleinbuchstaben, Ziffern, . _ - (2–61 Zeichen)' };
    const r = await this.wege(owner).lauf(z, fernBefehl(`cat -- '${pfad}'`, true), '', 30_000, 64 * 1024);
    if (r.code !== 0) return { success: false, error: `${pfad} auf ${z.name} nicht lesbar (Exit ${r.code})` };
    if (!r.stdout.length) return { success: false, error: `${pfad} ist leer` };
    await this.deps.tresorSetzen(input.tresor_name, r.stdout, `${z.name}:${pfad}`, typeof input.zweck === 'string' ? input.zweck.slice(0, 200) : undefined);
    this.deps.protokoll?.('I6 Geheimnis in den Tresor übernommen', { zugang: z.name, pfad, tresor: input.tresor_name, bytes: Buffer.byteLength(r.stdout) });
    // Pilot cf82f3f2: eine eigens exportierte Datei (z. B. Umgebung eines Containers) gleich wieder entfernen — nur unter /root/ oder /tmp/
    if (input.quelle_entfernen === true) {
      if (!/^\/(root|tmp)\/[A-Za-z0-9._@+-]+$/.test(pfad)) return { success: false, error: `quelle_entfernen nur für Dateien direkt unter /root/ oder /tmp/ — ${pfad} bleibt (Tresor-Eintrag ist angelegt)` };
      const rm = await this.wege(owner).lauf(z, fernBefehl(`rm -f -- '${pfad}' && test ! -e '${pfad}'`, true), '', 30_000);
      if (rm.code !== 0) return { success: false, error: `Tresor-Eintrag angelegt, aber ${pfad} auf ${z.name} nicht entfernt (Exit ${rm.code})` };
    }
    return { success: true, data: { tresor_name: input.tresor_name, bytes: Buffer.byteLength(r.stdout), herkunft: `${z.name}:${pfad}` }, display: `${pfad} von ${z.name} als Tresor-Eintrag „${input.tresor_name}“ übernommen (${Buffer.byteLength(r.stdout)} Bytes; Inhalt bleibt am Server)${input.quelle_entfernen === true ? '; Datei an der Quelle entfernt' : ''}.` };
  }

  /** I6 — Übertragungen dürfen lange dauern (Standard 1 h, höchstens 4 h) */
  private timeoutLang(input: Record<string, unknown>): number {
    const s = typeof input.timeout_s === 'number' ? input.timeout_s : 3600;
    return Math.min(Math.max(s, 60), 4 * 3600) * 1000;
  }

  /** I5 — Snippet-Pfad am Proxmox-Knoten (nur Cloud-Init-Snippets von Alfred) */
  static readonly SNIPPET_PFAD = /^\/(var\/lib\/vz|mnt\/pve\/[\w-]+)\/snippets\/alfred-\d{3,9}-user\.yaml$/;

  /** I5 — Cloud-Init-Snippet (enthält den privaten Host-Schlüssel der neuen VM) per stdin als root mit Rechten 600 schreiben */
  async snippetSchreiben(knoten: string, pfad: string, inhalt: string): Promise<void> {
    const owner = this.deps.owner();
    if (!FernzugriffSkill.SNIPPET_PFAD.test(pfad)) throw new Error('ungültiger Snippet-Pfad');
    if (!owner || !this.deps.sshEingabe) throw new Error('Snippet-Übergabe nicht verfügbar');
    const z = await this.zugang(owner, { name: knoten });
    const r = await this.deps.sshEingabe({ id: z.id, host: z.host, port: z.port, benutzer: z.benutzer, schluesselPfad: z.schluesselPfad, hostSchluessel: z.hostSchluessel }, fernBefehl(`sh -c 'umask 077; cat > ${pfad}'`, true), inhalt, 30_000);
    if (r.code !== 0) throw new Error(`Snippet nicht geschrieben (Exit ${r.code}: ${schwaerze(r.stderr).text.slice(-160)})`);
    this.deps.protokoll?.('I5 Snippet geschrieben', { name: z.name, pfad });
  }

  async snippetEntfernen(knoten: string, pfad: string): Promise<boolean> {
    const owner = this.deps.owner();
    if (!owner || !FernzugriffSkill.SNIPPET_PFAD.test(pfad)) return false;
    const z = await this.zugang(owner, { name: knoten });
    const r = await this.lauf(owner, z, fernBefehl(`rm -f ${pfad}`, true), 30_000);
    this.deps.protokoll?.('I5 Snippet entfernt', { name: z.name, pfad, ok: r.code === 0 });
    if (r.code !== 0) throw new Error(`Snippet ${pfad} auf ${knoten} nicht entfernt (Exit ${r.code})`);
    return true;
  }

  /** I5 — Zugang einer von Alfred angelegten VM: Host-Schlüssel ist bekannt (selbst erzeugt), daher ohne Keyscan und ohne Rückfrage aktiv. */
  async zugangBereitstellen(e: { name: string; host: string; hostSchluessel: string; cmdbAssetId?: string; benutzer?: string }): Promise<Fernzugang> {
    const owner = this.deps.owner();
    if (!owner) throw new Error('Kein Owner bekannt.');
    if (!/^[\w.-]{1,64}$/.test(e.name) || !gueltigerHost(e.host)) throw new Error('ungültiger Name oder Host');
    const benutzer = e.benutzer ?? 'alfred';
    if (!gueltigerBenutzer(benutzer)) throw new Error('ungültiger Benutzer');
    if (await this.deps.repo.finde(owner, e.name)) throw new Error(`Fernzugang „${e.name}“ gibt es schon`);
    const schluessel = leseKeyscan(`${e.host} ${e.hostSchluessel}`);
    if (schluessel.length !== 1) throw new Error('Host-Schlüssel nicht lesbar');
    const k = await this.deps.schluessel();
    const z = await this.deps.repo.speichere(owner, { name: e.name, host: e.host, port: 22, benutzer, schluesselPfad: k.pfad, hostSchluessel: knownHostsZeilen(e.host, 22, schluessel), fingerabdruck: `${schluessel[0]!.typ} ${schluessel[0]!.fingerabdruck}`, ...(e.cmdbAssetId ? { cmdbAssetId: e.cmdbAssetId } : {}), status: 'aktiv' });
    if (this.deps.repo.setzeKaefig) { await this.deps.repo.setzeKaefig(owner, z.id, 'ungeprueft'); z.kaefig = 'ungeprueft'; }
    if (e.cmdbAssetId) await this.deps.cmdbMarkiere?.(e.cmdbAssetId, { name: z.name, benutzer, port: 22 }).catch(() => undefined);
    this.deps.protokoll?.('I5 Fernzugang mit eigenem Host-Schlüssel angelegt', { name: z.name, host: e.host, fingerabdruck: z.fingerabdruck });
    this.deps.beiAenderung?.();
    return z;
  }

  /** I5 — Käfig des Zugangs prüfen (Selbsttest) — nach der Bereitstellung, damit Lesebefehle ohne Rückfrage gekapselt laufen */
  async kaefigVorbereiten(name: string): Promise<{ ok: boolean; grund: string }> {
    const owner = this.deps.owner();
    if (!owner) return { ok: false, grund: 'kein Owner' };
    return this.kaefigBereit(owner, await this.zugang(owner, { name }));
  }

  /** I5 — Zugang einer entfernten VM abmelden (nur wenn Name und Host passen) */
  async zugangAbmelden(name: string, host?: string): Promise<boolean> {
    const owner = this.deps.owner();
    if (!owner) return false;
    const z = await this.deps.repo.finde(owner, name);
    if (!z || (host && z.host !== host)) return false;
    if (z.cmdbAssetId) await this.deps.cmdbMarkiere?.(z.cmdbAssetId, null).catch(() => undefined);
    const ok = await this.deps.repo.entferne(owner, z.id);
    this.deps.protokoll?.('I5 Fernzugang abgemeldet', { name, host: z.host, ok });
    this.deps.beiAenderung?.();
    return ok;
  }

  /** I1 — aktive Zugänge (Name, Host, CMDB-Verweis) für die Sammler. */
  async aktiveZugaenge(): Promise<Array<{ name: string; host: string; cmdbAssetId?: string }>> {
    const owner = this.deps.owner();
    if (!owner) return [];
    return (await this.deps.repo.liste(owner)).filter(z => z.status === 'aktiv').map(z => ({ name: z.name, host: z.host, ...(z.cmdbAssetId ? { cmdbAssetId: z.cmdbAssetId } : {}) }));
  }

  /** v1550 (S4c) — Hinweis, was Fachskills zum selben Host zusätzlich können (nur fürs Modell; Fehler stören das Ergebnis nicht). */
  private async mitFachskill(z: Fernzugang, e: SkillResult): Promise<SkillResult> {
    const h = await this.deps.fachskillHinweis?.(z).catch(() => undefined);
    if (!h) return e;
    return { ...e, display: `${e.display ?? ''}\n${h}`, ...(e.error ? { error: `${e.error}\n${h}` } : {}) };
  }

  /** v1549 — Käfig bereit? Beim ersten Mal (oder nach „an“) Selbsttest mit echten Schreib-, Kill-, Docker-, D-Bus- und Netzversuchen. */
  private async kaefigBereit(owner: string, z: Fernzugang): Promise<{ ok: boolean; grund: string }> {
    if (z.kaefig === 'aktiv' && this.kaefigGeprueft.has(z.id)) return { ok: true, grund: 'aktiv' };
    if (z.kaefig === 'aus') return { ok: false, grund: 'vom Owner abgeschaltet' };
    if (z.kaefig === 'fehlt') return { ok: false, grund: 'Selbsttest gescheitert' };
    if (!this.deps.repo.setzeKaefig) return { ok: false, grund: 'nicht eingerichtet' };
    // v1632 — stärkste Stufe zuerst; die erste, deren Selbsttest besteht, gilt (Realfall 24.10.: SELinux, Fedora ohne --pipe)
    let w = { ok: false, grund: 'kein Selbsttest' }; let r = { code: -1, stdout: '', stderr: '' } as SshErgebnis; const versucht: string[] = [];
    for (const stufe of KAEFIG_STUFEN) {
      r = await this.lauf(owner, z, kaefigBefehl(KAEFIG_SELBSTTEST, z.benutzer, 30, stufe), 45_000);
      w = werteSelbsttest(`${r.stdout}\n${r.stderr}`, r.code, stufe);
      if (w.ok) { this.kaefigStufe.set(z.id, stufe); break; }
      versucht.push(`${stufe.lesen}/${stufe.ausgabe}: ${w.grund}`);
      // Verstöße (Käfig hält nicht) nie mit einer schwächeren Stufe überspielen
      if (/Käfig hält nicht/.test(w.grund)) break;
    }
    if (!w.ok && versucht.length > 1) w = { ok: false, grund: versucht.join('; ').slice(0, 400) };
    await this.deps.repo.setzeKaefig(owner, z.id, w.ok ? 'aktiv' : 'fehlt');
    z.kaefig = w.ok ? 'aktiv' : 'fehlt';
    if (w.ok) this.kaefigGeprueft.add(z.id); else this.kaefigGeprueft.delete(z.id);
    this.deps.protokoll?.(w.ok ? 'v1549 Lese-Käfig geprüft — aktiv' : 'v1549 Lese-Käfig geprüft — nicht verfügbar', { name: z.name, grund: w.grund, code: r.code, stderr: r.stderr.trim().slice(-200) });
    return w;
  }

  private async kaefigSchalter(owner: string, input: Record<string, unknown>, herkunft?: { chatId: string; platform: string }): Promise<SkillResult> {
    const z = await this.zugang(owner, input);
    if (!this.deps.repo.setzeKaefig) return { success: false, error: 'Lese-Käfig nicht verfügbar' };
    if (input.an === false) {
      await this.deps.repo.setzeKaefig(owner, z.id, 'aus');
      this.deps.protokoll?.('v1549 Lese-Käfig abgeschaltet', { name: z.name });
      return { success: true, display: `Lese-Käfig auf ${z.name} ist aus: unbekannte Befehle fragen wieder den Owner.` };
    }
    const gebunden = { action: 'kaefig_bestaetigen', name: z.name };
    const nonce = this.freigaben.erzeuge('fernzugriff', 'kaefig_bestaetigen', gebunden);
    const gestellt = await this.deps.bestaetigung({ description: `🔒 Lese-Käfig auf ${z.name} (${z.host}) einschalten? Unbekannte lesende Befehle laufen dann ohne Rückfrage, schreibgeschützt und ohne Netz/Docker/D-Bus. Vorher prüfe ich ihn mit echten Schreibversuchen.`, params: { ...gebunden, freigabe: nonce } }, herkunft);
    return gestellt ? { success: true, data: { zurBestaetigung: true }, display: `Einschalten des Lese-Käfigs auf ${z.name} zur Bestätigung gestellt.` } : { success: false, error: 'Bestätigung konnte nicht gestellt werden' };
  }

  private async kaefigBestaetigen(owner: string, input: Record<string, unknown>): Promise<SkillResult> {
    const { freigabe, ...params } = input;
    if (!this.freigaben.verbrauche(freigabe, 'fernzugriff', 'kaefig_bestaetigen', params)) return { success: false, error: 'Diese Freigabe ist ungültig oder abgelaufen.' };
    const z = await this.zugang(owner, params);
    await this.deps.repo.setzeKaefig!(owner, z.id, 'ungeprueft');
    z.kaefig = 'ungeprueft';
    const k = await this.kaefigBereit(owner, z);
    return k.ok ? { success: true, display: `✅ Lese-Käfig auf ${z.name} ist an (${k.grund}).` } : { success: false, error: `Lese-Käfig auf ${z.name} nicht verfügbar: ${k.grund}` };
  }

  private legeAb(name: string, befehl: string, text: string): string {
    const jetzt = Date.now();
    for (const [k, v] of this.seiten) if (jetzt - v.zeit > SEITEN_GUELTIG_MS) this.seiten.delete(k);
    while (this.seiten.size >= SEITEN_MAX) this.seiten.delete(this.seiten.keys().next().value!);
    const id = randomBytes(4).toString('hex');
    this.seiten.set(id, { name, befehl, text: text.slice(0, 5 * 1024 * 1024), zeit: jetzt });
    return id;
  }

  /** v1549 (S3) — gespeicherte Ausgabe: Seite N (≈ 25 000 Zeichen, an Zeilengrenzen) oder Treffer einer Suche mit Zeilennummern. */
  private seite(input: Record<string, unknown>): SkillResult {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    const a = this.seiten.get(id);
    if (!a || Date.now() - a.zeit > SEITEN_GUELTIG_MS) return { success: false, error: `Keine gespeicherte Ausgabe „${id}“ (gelten 2 Stunden) — Befehl erneut ausführen.` };
    const zeilen = a.text.split('\n');
    if (typeof input.suche === 'string' && input.suche.trim()) {
      let re: RegExp;
      try { re = new RegExp(input.suche.slice(0, 200), 'i'); } catch { return { success: false, error: 'Ungültiges Suchmuster' }; }
      const treffer: string[] = [];
      let laenge = 0;
      for (let i = 0; i < zeilen.length && laenge < SEITE_ZEICHEN; i++) {
        if (re.test(zeilen[i]!)) { const t = `${i + 1}: ${zeilen[i]}`; treffer.push(t); laenge += t.length + 1; }
      }
      return { success: true, data: { id, treffer: treffer.length }, display: `\`\`\`\n${a.name}$ ${a.befehl}  — Suche „${input.suche.slice(0, 80)}“: ${treffer.length} Treffer${laenge >= SEITE_ZEICHEN ? ' (weitere — Muster enger fassen)' : ''}\n${treffer.join('\n') || '(keine)'}\n\`\`\`` };
    }
    const seiten: string[] = [];
    let akt = '';
    for (const z of zeilen) { if (akt.length + z.length + 1 > SEITE_ZEICHEN && akt) { seiten.push(akt); akt = ''; } akt += `${z}\n`; }
    if (akt) seiten.push(akt);
    const n = Math.min(Math.max(Math.floor(Number(input.seite) || 1), 1), seiten.length);
    return { success: true, data: { id, seite: n, seiten: seiten.length }, display: `\`\`\`\n[${a.name}$ ${a.befehl} — Seite ${n}/${seiten.length}]\n${seiten[n - 1]!.slice(0, SEITE_ZEICHEN + 2000)}\`\`\`` };
  }

  private async ausfuehren(owner: string, input: Record<string, unknown>, herkunft?: { chatId: string; platform: string }, context?: SkillContext): Promise<SkillResult> {
    const { freigabe, ...params } = input;
    const befehl = typeof params.befehl === 'string' ? ausfuehrbarerBefehl(params.befehl) : '';
    if (!befehl) return { success: false, error: 'ausfuehren braucht befehl' };
    const klasse = befehlsklasse(befehl);
    if (klasse === 'nie') {
      this.deps.protokoll?.('v1539 Fernzugriff abgewiesen (nie)', { name: params.name, befehl: befehl.slice(0, 200) });
      return { success: false, error: `„${befehl.slice(0, 120)}“ ist nie erlaubt (zerstört Datenträger, Pools oder das System). Das muss der Owner selbst am Host tun.` };
    }
    if (klasse === 'lesen') return this.lesen(owner, params, context);
    const z = await this.zugang(owner, params);
    const alsRoot = params.als_root !== false;
    const gebunden = { action: 'ausfuehren', name: z.name, befehl, als_root: alsRoot, ...(typeof params.timeout_s === 'number' ? { timeout_s: params.timeout_s } : {}) };
    if (freigabe !== undefined) {
      if (!this.freigaben.verbrauche(freigabe, 'fernzugriff', 'ausfuehren', gebunden)) return { success: false, error: 'Diese Freigabe ist ungültig, abgelaufen oder gehört zu einem anderen Befehl.' };
      const r = await this.lauf(owner, z, fernBefehl(befehl, alsRoot), this.timeout(params));
      this.deps.protokoll?.('v1539 Fernzugriff ausgeführt (bestätigt)', { name: z.name, befehl: befehl.slice(0, 200), code: r.code, root: alsRoot });
      return this.mitWiederherstellbarkeit(befehl, r, this.ergebnis(z, befehl, r), context);
    }
    const nonce = this.freigaben.erzeuge('fernzugriff', 'ausfuehren', gebunden);
    const frage = `🖥 Auf ${z.name} (${z.host}) ${alsRoot ? 'als root ' : ''}ausführen?\n\n${befehl.slice(0, 1500)}`;
    const gestellt = await this.deps.bestaetigung({ description: frage, params: { ...gebunden, freigabe: nonce } }, herkunft);
    this.deps.protokoll?.('v1539 Fernzugriff zur Bestätigung', { name: z.name, befehl: befehl.slice(0, 200), root: alsRoot });
    return gestellt
      ? { success: true, data: { zurBestaetigung: true, name: z.name, befehl }, display: `Zur Bestätigung an den Owner gestellt: \`${befehl.slice(0, 200)}\` auf ${z.name}. Nach dem Ja führe ich es aus und melde das Ergebnis.` }
      : { success: false, error: 'Bestätigung konnte nicht gestellt werden' };
  }

  private async entfernen(owner: string, input: Record<string, unknown>, herkunft?: { chatId: string; platform: string }): Promise<SkillResult> {
    const { freigabe, ...params } = input;
    const name = typeof params.name === 'string' ? params.name.trim() : '';
    const z = name ? await this.deps.repo.finde(owner, name) : null;
    if (!z) return { success: false, error: `Kein Fernzugang „${name}“.` };
    const gebunden = { action: 'entfernen', name: z.name };
    if (freigabe !== undefined) {
      if (!this.freigaben.verbrauche(freigabe, 'fernzugriff', 'entfernen', gebunden)) return { success: false, error: 'Diese Freigabe ist ungültig oder abgelaufen.' };
      await this.deps.repo.entferne(owner, z.id);
      if (z.cmdbAssetId) await this.deps.cmdbMarkiere?.(z.cmdbAssetId, null).catch(() => undefined);
      this.deps.protokoll?.('v1539 Fernzugang entfernt', { name: z.name });
      this.deps.beiAenderung?.();
      return { success: true, display: `Fernzugang „${z.name}“ entfernt. Auf dem Host bleibt der Benutzer ${z.benutzer} samt Schlüssel, bis du ihn dort löschst.` };
    }
    const nonce = this.freigaben.erzeuge('fernzugriff', 'entfernen', gebunden);
    const gestellt = await this.deps.bestaetigung({ description: `Fernzugang „${z.name}“ (${z.benutzer}@${z.host}) entfernen?`, params: { ...gebunden, freigabe: nonce } }, herkunft);
    return gestellt ? { success: true, data: { zurBestaetigung: true }, display: `Entfernen von „${z.name}“ zur Bestätigung gestellt.` } : { success: false, error: 'Bestätigung konnte nicht gestellt werden' };
  }
}
