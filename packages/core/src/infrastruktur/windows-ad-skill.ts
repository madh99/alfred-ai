/**
 * I8c — Skill „windows_ad“: Active Directory über feste Bausteine (windows-ad.ts). Alles außer „status“ nur als Schritt eines
 * freigegebenen Changes. Kennwörter erzeugt bzw. liest der Skill im Tresor und gibt sie nur über die Standardeingabe weiter.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { Skill } from '@alfred/skills';
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import {
  adStatusSkript, adStatusText, adErgebnis, dcBereit, mitgliedBereit, kodiert, pruefeWald, pruefeDns, waldSkript, dcSkript, beitrittSkript,
  grundstrukturSkript, pruefeGrundstruktur, clixmlFehler, sicherungSkript, sicherungJetztSkript, papierkorbSkript, dnsEintragSkript, dnsEintragLoeschenSkript,
  pruefeDnsEintrag, dnsClientSkript, pruefeAufloesen, dnsAufloesenSkript, aufloesenText, AD_OUS_STANDARD, NTP_STANDARD, AD_NETBIOS, KONTO_FREI, type AdStatus,
  pruefeDienstkonto, dienstkontoSkript, dienstkontoEntfernenSkript, dienstkontoTresorName, dienstkontoGehaertet, type Anmeldesperre,
} from './windows-ad.js';
import {
  pruefeSpns, pruefeKonto, spnSetzenSkript, spnEntfernenSkript, spnLesenSkript, spnLesenText, type SpnLesen, pruefeComputerkonto, joinTresorName,
  computerkontoSkript, computerkontoEntfernenSkript, pruefePtr, dnsPtrSkript, dnsPtrLoeschenSkript, pruefeGruppe, gruppeSkript, gruppeEntfernenSkript,
  pruefeSqlServer, SQL_PROBE_ZUGAENGE, SQL_PROBE_TRESOR, sqlAnmeldungSkript, sqlAnmeldungAuswerten, type SqlAnmeldung,
  pruefeAdminAnmeldung, adminAnmeldungSkript, adminAnmeldungEntfernenSkript, adminAnmeldungText, type AdminAnmeldung,
} from './windows-ad-linux.js';

export interface WindowsAdDeps {
  /** Fernzugriff: festes Skript auf einem Windows-Zugang (Geheimnisse per Standardeingabe) */
  skript: (zugang: string, befehl: string, eingabe: string | undefined, timeoutMs: number, zweck: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  tresor?: { namen: () => Promise<Set<string>>; lies: (name: string, wofuer: string) => Promise<string>; setze: (name: string, wert: string, zweck: string) => Promise<void> };
  protokoll?: (msg: string, daten: Record<string, unknown>) => void;
  /** Tests: Wartezeiten */
  schlafe?: (ms: number) => Promise<void>;
}

const NUR_IM_CHANGE = new Set(['wald_anlegen', 'dc_hinzufuegen', 'beitreten', 'grundstruktur', 'sicherung_einrichten', 'sicherung_jetzt', 'papierkorb_beweis', 'dns_eintrag', 'dns_eintrag_loeschen', 'dns_client',
  // I8e Task 4 — Domänen-Dienstkonto (z. B. svc-sqllnx-backup für die Sicherung nach fs01)
  'dienstkonto_anlegen', 'dienstkonto_entfernen',
  // I8e Etappe 3 — AD-Objekte für Kerberos der Linux-SQL-Instanzen (je mit Rückweg)
  'spn_setzen', 'spn_entfernen', 'computerkonto_vorbereiten', 'computerkonto_entfernen', 'dns_ptr', 'dns_ptr_loeschen', 'gruppe_anlegen', 'gruppe_entfernen',
  // Ruling R34 (I8e L6): Windows-Anmeldung (RDP mit NLA) der Admin-Gruppe an einem Mitgliedsrechner, mit Rückweg
  'admin_anmeldung_einrichten', 'admin_anmeldung_entfernen']);
/**
 * Fix-Runde 1 (Ruling R4) — dns_ptr wartet im Baustein bis 600 s auf die Auflösung an allen DCs; der Skill-Aufruf hat 900 s. Mindest-
 * zeitlimitS = 900 + 60 (wie LINUX_SQL_MIN_ZEITLIMIT_S), damit der Change-Schritt nicht vorher abbricht.
 */
export const WINDOWS_AD_MIN_ZEITLIMIT_S: Readonly<Record<string, number>> = { dns_ptr: 960 };
/** v1783 — lesende Aktionen (auch außerhalb eines Changes); I8e Etappe 3: spn_lesen, sql_anmeldung_pruefen */
export const LESEND = new Set(['status', 'dns_aufloesen', 'spn_lesen', 'sql_anmeldung_pruefen']);
const ZUGANG = /^[a-z0-9][a-z0-9.-]{0,62}$/i;
const KENNWORT_ZEICHEN = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
/** wie die Windows-Fabrik: erfüllt die Komplexitätsregeln (groß, klein, Ziffer, Sonderzeichen) */
export const adKennwort = () => `Al-${Array.from(randomBytes(24), x => KENNWORT_ZEICHEN[x % KENNWORT_ZEICHEN.length]).join('')}9a`;
export const dsrmName = (domaene: string, zugang: string) => `ad-${domaene}-dsrm-${zugang}`;
/** I8e Etappe 3 — Einmal-Kennwort für den Domänenbeitritt: 24 Zeichen, groß/klein/Ziffer/Sonderzeichen, ohne Anführungszeichen */
const EINMAL_ZEICHEN = `${KENNWORT_ZEICHEN}-_`;
export function einmalKennwort(): string {
  for (;;) {
    const k = Array.from({ length: 24 }, () => EINMAL_ZEICHEN[randomInt(EINMAL_ZEICHEN.length)]).join('');
    if (/[A-Z]/.test(k) && /[a-z]/.test(k) && /\d/.test(k) && /[-_]/.test(k)) return k;
  }
}

export class WindowsAdSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'windows_ad',
    category: 'infrastructure',
    description:
      'Active Directory (I8c) über feste, geprüfte PowerShell-Bausteine auf Windows-Fernzugängen (zugang = Name des Fernzugangs). '
      + 'status (lesend, auch außerhalb von Changes): Rolle, Domäne, bei DCs Dienste, PDC, DCs, Papierkorb — als Prüfung mit erwartet „Domänencontroller von <domäne>“ bzw. „Mitglied der Domäne <domäne>“. '
      + 'dns_aufloesen (lesend, auch außerhalb von Changes; zugang, fqdn, server optional = IPv4 eines DNS-Servers, sonst der eigene Resolver des Rechners, ohne_cache optional) — A-Auflösung auf dem Windows-Rechner selbst, Ergebnis „<fqdn> → <ip> (über …)“ bzw. „<fqdn>: keine A-Antwort …“; als Prüfung mit erwartet = IP (Name löst auf) bzw. nichtEnthalten = IP (Name ist weg). DNS-Proben nie als powershell-Prüfbefehl (Resolve-DnsName ist im Lese-Käfig gesperrt). '
      + 'NUR als Schritte freigegebener Changes: wald_anlegen (zugang, domaene, netbios) — neuer Wald mit DNS auf einem Server der Arbeitsgruppe, DSRM-Kennwort erzeugt Alfred im Tresor (ad-<domäne>-dsrm-<zugang>), Neustart, wartet bis die AD-Dienste laufen (bis 25 min); lokale Konten werden Domänenkonten, der Fernzugang bleibt „alfred“. '
      + 'dc_hinzufuegen (zugang, domaene, netbios, dns = IPs vorhandener DCs, konto_tresor = Tresor-Eintrag mit dem Kennwort von <NETBIOS>\\alfred, z. B. win-dc01-admin) — weiterer DC mit DNS/GC, vorher grundstruktur am ersten DC (alfred in Domänen-Admins). '
      + 'beitreten (zugang, domaene, netbios, dns, konto_tresor, ou optional z. B. Server) — Mitgliedsserver, Neustart, wartet bis beigetreten. '
      + 'grundstruktur (zugang = PDC, ous Standard Server/Clients/Dienstkonten/Admins, ntp Standard at.pool.ntp.org, weiterleiter = DNS-Weiterleiter, z. B. Gateway des AD-Netzes, konto_tresor optional, Standard win-<zugang>-admin = Kennwort des Domänen-Administrators) —OUs mit Löschschutz, AD-Papierkorb (nicht abschaltbar), alfred in Domänen-Admins, NTP am PDC, Weiterleiter, KDS-Schlüssel für gMSA; wiederholbar. '
      + 'sicherung_einrichten (zugang, laufwerk z. B. S, groesse_gb der leeren Zusatzplatte, uhrzeit z. B. 02:30) — Windows-Server-Sicherung, Platte einrichten, tägliche Systemstatus-Sicherung; sicherung_jetzt (zugang, laufwerk) — sofort sichern und Version belegen. '
      + 'papierkorb_beweis (zugang, konto_tresor optional wie grundstruktur) — Testkonto anlegen, löschen, wiederherstellen, prüfen, wieder entfernen. '
      + 'dns_eintrag (zugang = DC, zone, name, ip) / dns_eintrag_loeschen (zugang, zone, name) — A-Eintrag, z. B. frischer Name für den DNS-Ausfalltest (kein Cache kennt ihn). '
      + 'dns_client (zugang, dns = Liste, Reihenfolge = Bevorzugung) — DNS-Server eines Windows-Rechners setzen, z. B. DCs gegenseitig; Ergebnis nennt die vorherigen (Rückweg: dns_client mit diesen). '
      + 'dienstkonto_anlegen (zugang = DC, konto = sAMAccountName z. B. svc-sqllnx-backup, ou Standard Dienstkonten, konto_tresor optional wie grundstruktur) — Benutzer-Dienstkonto (Kennwort läuft nie ab, Konto kann es nicht ändern), Kennwort erzeugt Alfred im Tresor ad-<konto> und gibt es nur über die Standardeingabe weiter; wiederholbar, ein abweichendes Kennwort wird nie still zurückgesetzt; prüft Anmeldung und Flags selbst ↔ dienstkonto_entfernen (zugang, konto; nur von Alfred angelegte, Tresor-Eintrag bleibt). '
      + 'Mit haerten: true (I8e Etappe 3, z. B. svc-sqllnx) zusätzlich nur AES128+AES256 (msDS-SupportedEncryptionTypes 24), vertraulich/keine Delegierung, Mitglied von Dienstkonten-KeineAnmeldung (OU Dienstkonten; GPO „AD3033 Dienstkonten keine Anmeldung“ an der Domänenwurzel verweigert lokale und RDP-Anmeldung — Gruppe und GPO legt der Baustein bei Bedarf an und lässt sie beim Rückweg stehen); Ergebnis „DIENSTKONTO_GEHAERTET“ mit allen Flags zurückgelesen. '
      + 'I8e Etappe 3 (zugang = DC, konto_tresor optional wie grundstruktur, je mit Rückweg und Selbstprüfung): spn_setzen (konto, spns = Liste MSSQLSvc/<name>.ad.3033.at[:1433]) — wie setspn -S, Abbruch wenn ein anderes Objekt im Wald einen SPN trägt; Ergebnis „SPN_EINDEUTIG“ (jeder SPN genau einmal im Wald, am Konto) ↔ spn_entfernen (konto, spns). '
      + 'spn_lesen (lesend, auch außerhalb von Changes; zugang = DC, spns, konto optional) — Träger je SPN im Wald, „SPN_EINDEUTIG“ bzw. „SPN_PROBLEM“. '
      + 'computerkonto_vorbereiten (name z. B. sqllnx01, ou Standard Server) — Computerkonto NAME$ für den Linux-Beitritt; ein vorhandenes fremdes Konto wird nie übernommen, ein eigenes nur, solange es unbenutzt ist (keine Anmeldung, Kennwort unverändert, keine Beitritts-Attribute); Einmal-Kennwort erzeugt Alfred im Tresor ad-join-<name> (nur über die Standardeingabe, nie in der Ausgabe); „COMPUTERKONTO_BEREIT“ ↔ computerkonto_entfernen (name; nur von Alfred angelegte). '
      + 'dns_ptr (zone z. B. 30.203.10.in-addr.arpa, ip, fqdn) — Reverse-Zone AD-integriert (Wald) falls fehlt, PTR; prüft die Auflösung an allen DCs (bis 10 min; zeitlimitS mindestens 960), „PTR_OK“ ↔ dns_ptr_loeschen (zone, ip, fqdn; Zone bleibt). '
      + 'gruppe_anlegen (gruppe z. B. SQL-Linux-Admins, ou Standard Dienstkonten, mitglieder = sAMAccountNames) — globale Sicherheitsgruppe, fehlende Mitglieder ergänzt, „GRUPPE_OK“ ↔ gruppe_entfernen (gruppe; nur von Alfred angelegte). '
      + 'sql_anmeldung_pruefen (lesend; zugang nur sql01, sql02, sqladmw11 oder sqladm25 — Ruling R32: die Admin-Clients brauchen vorher sql_server ssms_installieren für sqlcmd; server = SQL-Instanz in ad.3033.at ohne Port, z. B. sqllnx01.ad.3033.at; konto_tresor nur ein Test-Konto ad-svc-<name>-test, z. B. ad-svc-sqllnx-test; konto optional, muss der Tresor-Name ohne ad- sein) — sqlcmd -E -N ohne -C als geplante Aufgabe unter dem Konto; „SQL_KERBEROS_OK“ nur bei auth_scheme KERBEROS und encrypt_option TRUE, sonst Fehler „NICHT KERBEROS“/„NICHT VERSCHLÜSSELT“. Ruling R48: auf einem frisch geklonten Windows-11-Client (z. B. sqladmw11) im Change vor dieser Probe einen owner-Schritt „einmal per RDP am Client anmelden und abmelden“ einplanen — vorher blieb die Probe-Aufgabe in der Warteschlange. '
      + 'admin_anmeldung_einrichten (Ruling R34; zugang = Mitgliedsrechner, nie DC, z. B. sqladmw11/sqladm25; gruppe nur SQL-Linux-Admins) — Remotedesktop an mit NLA, eingebaute Firewall-Regelgruppe Remotedesktop aktiv, Domänengruppe in die lokale Gruppe Remotedesktopbenutzer (SID S-1-5-32-555, sprachunabhängig; nie Administratoren); bricht ab, wenn eine GPO RDP verbietet oder NLA abschaltet; Vorzustand gemerkt; wiederholbar; Ergebnis „ADMIN_ANMELDUNG_OK <zugang>: RDP an (NLA), <DOMÄNE>\\<gruppe> in Remotedesktopbenutzer“ ↔ admin_anmeldung_entfernen (zugang, gruppe) — Gruppe raus, RDP/NLA/Regeln nur zurück, wenn dieser Baustein sie eingeschaltet hat; „ADMIN_ANMELDUNG_ENTFERNT …“. '
      + 'Ausführungskonto optional wählbar: ausfuehrungskonto („name“ oder „NETBIOS\\name“) mit konto_tresor, z. B. für eine fremde Domäne. Alle Änderungen ohne Rückweg außer dns_eintrag ↔ dns_eintrag_loeschen, dns_client, dienstkonto_anlegen ↔ dienstkonto_entfernen und den I8e-Etappe-3-Paaren oben inkl. admin_anmeldung_einrichten ↔ admin_anmeldung_entfernen (Hochstufen/Beitritt zurücknehmen ist ein eigener Change).',
    riskLevel: 'admin',
    version: '1.0.0',
    // Ruling R46 — ohne eigenes Zeitlimit brach jeder Chat-Aufruf nach 30 s ab (Standard der Sandbox); die Bausteine selbst warten
    // bis 25 min (Hochstufen), die Anmeldeprobe bis 300 s
    timeoutMs: 30 * 60_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...LESEND, ...NUR_IM_CHANGE] },
        zugang: { type: 'string', description: 'Name des Windows-Fernzugangs (z. B. dc01)' },
        domaene: { type: 'string', description: 'z. B. ad.3033.at' },
        netbios: { type: 'string', description: 'z. B. AD3033' },
        dns: { type: 'array', items: { type: 'string' }, description: 'IPv4 der Domänencontroller (DNS des Rechners)' },
        konto_tresor: { type: 'string', description: 'Tresor-Eintrag mit dem Kennwort des Ausführungskontos (z. B. win-dc01-admin)' },
        ausfuehrungskonto: { type: 'string', description: 'optional: Ausführungskonto „name“ oder „NETBIOS\\name“ (Standard: alfred für dc_hinzufuegen/beitreten, Administrator für grundstruktur/papierkorb_beweis) — z. B. für eine fremde Domäne' },
        ou: { type: 'string', description: 'beitreten: OU unterhalb der Domäne, z. B. Server' },
        ous: { type: 'array', items: { type: 'string' } },
        ntp: { type: 'array', items: { type: 'string' } },
        weiterleiter: { type: 'array', items: { type: 'string' } },
        laufwerk: { type: 'string', description: 'Laufwerksbuchstabe der Sicherungsplatte, z. B. S' },
        groesse_gb: { type: 'number' },
        uhrzeit: { type: 'string', description: 'HH:MM' },
        zone: { type: 'string' }, name: { type: 'string' }, ip: { type: 'string' },
        konto: { type: 'string', description: 'dienstkonto_anlegen/-entfernen: sAMAccountName des Dienstkontos, z. B. svc-sqllnx-backup' },
        fqdn: { type: 'string', description: 'dns_aufloesen/dns_ptr: vollständiger Name' }, server: { type: 'string', description: 'dns_aufloesen: IPv4 des DNS-Servers; sql_anmeldung_pruefen: SQL-Instanz, z. B. sqllnx01.ad.3033.at' }, ohne_cache: { type: 'boolean' },
        haerten: { type: 'boolean', description: 'dienstkonto_anlegen: nur AES, keine Delegierung, Anmeldesperre per Gruppe + GPO (I8e Etappe 3)' },
        spns: { type: 'array', items: { type: 'string' }, description: 'spn_setzen/-entfernen/-lesen: MSSQLSvc/<name>.ad.3033.at[:1433]' },
        gruppe: { type: 'string', description: 'gruppe_anlegen/-entfernen: z. B. SQL-Linux-Admins; admin_anmeldung_einrichten/-entfernen: nur SQL-Linux-Admins' },
        mitglieder: { type: 'array', items: { type: 'string' }, description: 'gruppe_anlegen: sAMAccountNames' },
      },
      required: ['action'],
    },
  };

  constructor(private readonly d: WindowsAdDeps) { super(); }

  /** Fix-Runde 1 (Ruling R4) — Mindest-zeitlimitS je Aktion für die Planprüfung (Baustein-Zeitgrenze + 60 s) */
  mindestZeitlimitS(aktion: string): number | undefined { return WINDOWS_AD_MIN_ZEITLIMIT_S[aktion]; }

  /**
   * Ruling R34 (I8e L6) — Planprüfung (rein, ohne Tresor und Fernaufruf): admin_anmeldung_* nur mit der zugelassenen Gruppe (fester Wert,
   * nie ein Verweis). Dazu dieselbe Zahlenprüfung wie eingabeFehler (die entfällt dort, sobald ein Skill selbst prüft).
   */
  pruefeEingabe(input: Record<string, unknown>): string | undefined {
    const props = (this.metadata.inputSchema as { properties?: Record<string, { type?: string }> }).properties ?? {};
    for (const [k, w] of Object.entries(input)) {
      if (props[k]?.type === 'number' && w !== undefined && w !== null && typeof w !== 'number' && !(typeof w === 'string' && /^-?\d+(\.\d+)?$/.test(w.trim()))) return `„${k}“ muss eine Zahl sein`;
    }
    const action = String(input.action ?? '');
    if (action === 'admin_anmeldung_einrichten' || action === 'admin_anmeldung_entfernen') { const p = pruefeAdminAnmeldung({ gruppe: input.gruppe }); if (typeof p === 'string') return p; }
    return undefined;
  }

  async execute(input: Record<string, unknown>, context?: SkillContext): Promise<SkillResult> {
    const action = String(input.action ?? '');
    const zugang = String(input.zugang ?? '').trim();
    if (!LESEND.has(action) && !NUR_IM_CHANGE.has(action)) return { success: false, error: `Unbekannte Aktion ${action}` };
    if (NUR_IM_CHANGE.has(action) && (context as { ausChange?: boolean } | undefined)?.ausChange !== true) return { success: false, error: `${action} läuft nur als Schritt eines freigegebenen Changes` };
    if (!ZUGANG.test(zugang)) return { success: false, error: 'zugang: Name des Windows-Fernzugangs' };
    try {
      switch (action) {
        case 'status': { const s = await this.status(zugang); return { success: true, data: s, display: adStatusText(s) }; }
        case 'wald_anlegen': return await this.wald(zugang, input);
        case 'dc_hinzufuegen': return await this.dc(zugang, input);
        case 'beitreten': return await this.beitritt(zugang, input);
        case 'grundstruktur': return await this.grundstruktur(zugang, input);
        case 'sicherung_einrichten': return await this.sicherung(zugang, input);
        case 'sicherung_jetzt': return await this.sicherungJetzt(zugang, input);
        case 'papierkorb_beweis': return await this.papierkorb(zugang, input);
        case 'dns_eintrag': case 'dns_eintrag_loeschen': return await this.dnsEintrag(zugang, action, input);
        case 'dienstkonto_anlegen': return await this.dienstkonto(zugang, input);
        case 'dienstkonto_entfernen': {
          const p = pruefeDienstkonto({ konto: input.konto }); if (typeof p === 'string') throw new Error(p);
          const kennwort = await this.kontoKennwort({ konto_tresor: input.konto_tresor ?? `win-${zugang}-admin` }, `Dienstkonto ${p.konto} entfernen (Domänen-Administrator)`);
          const r = await this.lauf<{ zustand: string }>(zugang, dienstkontoEntfernenSkript({ konto: p.konto, ...this.konto(input) }), 'Dienstkonto entfernen', 180_000, { kennwort });
          return { success: true, data: r, display: `✅ Dienstkonto ${p.konto}: ${r.zustand} (Tresor-Eintrag ${dienstkontoTresorName(p.konto)} bleibt)` };
        }
        case 'spn_setzen': case 'spn_entfernen': case 'spn_lesen': return await this.spn(zugang, action, input);
        case 'computerkonto_vorbereiten': return await this.computerkonto(zugang, input);
        case 'computerkonto_entfernen': {
          const p = pruefeComputerkonto({ name: input.name }); if (typeof p === 'string') throw new Error(p);
          const kennwort = await this.adminKennwort(zugang, input, `Computerkonto ${p.name}$ entfernen (Domänen-Administrator)`);
          const r = await this.lauf<{ zustand: string }>(zugang, computerkontoEntfernenSkript({ name: p.name, ...this.konto(input) }), 'Computerkonto entfernen', 180_000, { kennwort });
          return { success: true, data: r, display: `✅ Computerkonto ${p.name}$: ${r.zustand} (Tresor-Eintrag ${joinTresorName(p.name)} bleibt, falls vorhanden)` };
        }
        case 'dns_ptr': case 'dns_ptr_loeschen': return await this.dnsPtr(zugang, action, input);
        case 'gruppe_anlegen': return await this.gruppe(zugang, input);
        case 'gruppe_entfernen': {
          const p = pruefeGruppe({ gruppe: input.gruppe }); if (typeof p === 'string') throw new Error(p);
          const kennwort = await this.adminKennwort(zugang, input, `Gruppe ${p.gruppe} entfernen (Domänen-Administrator)`);
          const r = await this.lauf<{ zustand: string }>(zugang, gruppeEntfernenSkript({ gruppe: p.gruppe, ...this.konto(input) }), 'Gruppe entfernen', 180_000, { kennwort });
          return { success: true, data: r, display: `✅ Gruppe ${p.gruppe}: ${r.zustand}` };
        }
        case 'sql_anmeldung_pruefen': return await this.sqlAnmeldung(zugang, input);
        // Ruling R34 (I8e L6) — Windows-Anmeldung der Admin-Gruppe; lokal, ohne Kennwort (das SSH-Token ist lokaler Administrator)
        case 'admin_anmeldung_einrichten': {
          const p = pruefeAdminAnmeldung({ gruppe: input.gruppe }); if (typeof p === 'string') throw new Error(p);
          const r = await this.lauf<AdminAnmeldung>(zugang, adminAnmeldungSkript(p), 'Admin-Anmeldung einrichten', 180_000);
          const t = adminAnmeldungText(zugang, r, p.gruppe);
          this.d.protokoll?.('I8e L6 Admin-Anmeldung', { zugang, gruppe: p.gruppe, zustand: r.zustand, geaendert: r.geaendert });
          return t.ok ? { success: true, data: r, display: t.text } : { success: false, data: r, error: t.text };
        }
        case 'admin_anmeldung_entfernen': {
          const p = pruefeAdminAnmeldung({ gruppe: input.gruppe }); if (typeof p === 'string') throw new Error(p);
          const r = await this.lauf<{ konto: string; zustand: string; rdp: string; mitglied: boolean }>(zugang, adminAnmeldungEntfernenSkript(p), 'Admin-Anmeldung entfernen', 180_000);
          return { success: true, data: r, display: `ADMIN_ANMELDUNG_ENTFERNT ${zugang}: ${r.konto} ${r.mitglied ? 'bleibt in Remotedesktopbenutzer (war vorher schon Mitglied)' : 'nicht mehr in Remotedesktopbenutzer'}; RDP ${r.rdp}` };
        }
        case 'dns_aufloesen': {
          const p = { fqdn: String(input.fqdn ?? '').trim().toLowerCase().replace(/\.$/, ''), ...(input.server ? { server: String(input.server).trim() } : {}) };
          const f = pruefeAufloesen(p); if (f) throw new Error(f);
          const r = await this.lauf<{ adressen?: string[]; fehler?: string }>(zugang, dnsAufloesenSkript({ ...p, ohneCache: input.ohne_cache === true }), 'DNS-Auflösung', 60_000);
          return { success: true, data: { ...p, ...r }, display: aufloesenText(p, r) };
        }
        case 'dns_client': {
          const dns = pruefeDns(input.dns); if (typeof dns === 'string') throw new Error(dns);
          const r = await this.lauf<{ vorher: string[]; nachher: string[] }>(zugang, dnsClientSkript({ dns }), 'DNS-Server setzen', 120_000);
          return { success: true, data: r, display: `✅ DNS-Server auf ${zugang}: ${r.nachher.join(', ')} (vorher ${r.vorher.join(', ') || 'keine'}) — Rückweg: dns_client mit dns ${JSON.stringify(r.vorher)}` };
        }
      }
    } catch (err) { return { success: false, error: (err as Error).message.slice(0, 800) }; }
    return { success: false, error: 'Unbekannte Aktion' };
  }

  private async lauf<T>(zugang: string, skript: string, zweck: string, timeoutMs: number, eingabe?: Record<string, string>): Promise<T> {
    const r = await this.d.skript(zugang, kodiert(skript), eingabe ? JSON.stringify(eingabe) : undefined, timeoutMs, zweck);
    const e = adErgebnis<T>(r.stdout);
    if (r.code !== 0 || !e) {
      const klar = `${r.stderr}\n${r.stdout}`.split(/\r?\n/).filter(z => z.trim() && !z.startsWith('#< CLIXML') && !z.startsWith('<Objs')).join(' ');
      const fehler = `${klar} ${clixmlFehler(`${r.stderr}\n${r.stdout}`)}`.replace(/\s+/g, ' ').trim().slice(-500);
      throw new Error(`${zweck} auf ${zugang} gescheitert (Exit ${r.code}): ${fehler || 'keine Ausgabe'}`);
    }
    return e;
  }

  private status(zugang: string): Promise<AdStatus> { return this.lauf<AdStatus>(zugang, adStatusSkript(), 'AD-Status', 120_000); }

  /** Nach dem Neustart: erst 60 s, dann alle 20 s den Status lesen (SSH ist dazwischen weg) */
  private async warte(zugang: string, bereit: (s: AdStatus) => boolean, grenzeMs: number): Promise<AdStatus> {
    const schlafe = this.d.schlafe ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    const bis = Date.now() + grenzeMs; let letzter: AdStatus | undefined; let fehler = '';
    await schlafe(60_000);
    while (Date.now() < bis) {
      try { letzter = await this.status(zugang); if (bereit(letzter)) return letzter; fehler = ''; } catch (err) { fehler = (err as Error).message.slice(0, 200); }
      await schlafe(20_000);
    }
    throw new Error(`${zugang} nach ${Math.round(grenzeMs / 60_000)} min nicht bereit — zuletzt: ${letzter ? adStatusText(letzter) : fehler || 'kein Status'}`);
  }

  /** v1789 — optionales Ausführungskonto (fremde Domäne, umbenannter Administrator) */
  private konto(input: Record<string, unknown>): { ausKonto?: string } {
    const k = String(input.ausfuehrungskonto ?? '').trim();
    if (!k) return {};
    if (!KONTO_FREI.test(k)) throw new Error('ausfuehrungskonto: „name“ oder „NETBIOS\\name“');
    return { ausKonto: k };
  }

  private tresor() { if (!this.d.tresor) throw new Error('Tresor nicht verfügbar'); return this.d.tresor; }

  private domaeneUndNetbios(input: Record<string, unknown>): { domaene: string; netbios: string } {
    const p = { domaene: String(input.domaene ?? '').trim().toLowerCase(), netbios: String(input.netbios ?? '').trim().toUpperCase() };
    const f = pruefeWald(p); if (f) throw new Error(f);
    return p;
  }

  private async kontoKennwort(input: Record<string, unknown>, wofuer: string): Promise<string> {
    const n = String(input.konto_tresor ?? '').trim();
    if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(n)) throw new Error('konto_tresor: Tresor-Eintrag mit dem Kennwort des Domänenkontos alfred (z. B. win-dc01-admin)');
    if (!(await this.tresor().namen()).has(n)) throw new Error(`Tresor-Eintrag ${n} gibt es nicht`);
    return this.tresor().lies(n, wofuer);
  }

  private async dsrm(domaene: string, zugang: string): Promise<{ name: string; wert: string }> {
    const t = this.tresor(); const name = dsrmName(domaene, zugang);
    if ((await t.namen()).has(name)) return { name, wert: await t.lies(name, `DSRM-Kennwort für ${zugang}`) };
    const wert = adKennwort();
    await t.setze(name, wert, `DSRM-Kennwort (Wiederherstellungsmodus) des Domänencontrollers ${zugang} in ${domaene}`);
    return { name, wert };
  }

  private async wald(zugang: string, input: Record<string, unknown>): Promise<SkillResult> {
    const p = this.domaeneUndNetbios(input);
    const vorher = await this.status(zugang);
    if (dcBereit(vorher, p.domaene)) return { success: true, data: vorher, display: `${adStatusText(vorher)} — nichts zu tun` };
    const k = await this.dsrm(p.domaene, zugang);
    const r = await this.lauf<{ zustand: string }>(zugang, waldSkript(p), 'Neuer Wald', 1_800_000, { dsrm: k.wert });
    this.d.protokoll?.('I8c Wald angelegt', { zugang, domaene: p.domaene, zustand: r.zustand });
    const s = r.zustand === 'schon' ? await this.status(zugang) : await this.warte(zugang, x => dcBereit(x, p.domaene), 25 * 60_000);
    return { success: true, data: { ...s, dsrmTresor: k.name }, display: `✅ Wald ${p.domaene} (${p.netbios}) angelegt — ${adStatusText(s)}. DSRM-Kennwort im Tresor (${k.name}).` };
  }

  private async dc(zugang: string, input: Record<string, unknown>): Promise<SkillResult> {
    const p = this.domaeneUndNetbios(input);
    const dns = pruefeDns(input.dns); if (typeof dns === 'string') throw new Error(dns);
    const vorher = await this.status(zugang);
    if (dcBereit(vorher, p.domaene)) return { success: true, data: vorher, display: `${adStatusText(vorher)} — nichts zu tun` };
    const kennwort = await this.kontoKennwort(input, `weiterer Domänencontroller ${zugang}`);
    const k = await this.dsrm(p.domaene, zugang);
    const r = await this.lauf<{ zustand: string }>(zugang, dcSkript({ ...p, dns, ...this.konto(input) }), 'Weiterer Domänencontroller', 1_800_000, { dsrm: k.wert, kennwort });
    this.d.protokoll?.('I8c DC hinzugefügt', { zugang, domaene: p.domaene, zustand: r.zustand });
    const s = r.zustand === 'schon' ? await this.status(zugang) : await this.warte(zugang, x => dcBereit(x, p.domaene), 25 * 60_000);
    return { success: true, data: { ...s, dsrmTresor: k.name }, display: `✅ ${zugang} ist weiterer Domänencontroller — ${adStatusText(s)}. DSRM-Kennwort im Tresor (${k.name}).` };
  }

  private async beitritt(zugang: string, input: Record<string, unknown>): Promise<SkillResult> {
    const p = this.domaeneUndNetbios(input);
    const dns = pruefeDns(input.dns); if (typeof dns === 'string') throw new Error(dns);
    const ou = typeof input.ou === 'string' && input.ou.trim() ? input.ou.trim() : undefined;
    if (ou && !/^[\p{L}\p{N} ._-]{1,60}$/u.test(ou)) throw new Error('ou: Name einer OU direkt unter der Domäne');
    const vorher = await this.status(zugang);
    if (mitgliedBereit(vorher, p.domaene)) return { success: true, data: vorher, display: `${adStatusText(vorher)} — nichts zu tun` };
    const kennwort = await this.kontoKennwort(input, `Domänenbeitritt ${zugang}`);
    const r = await this.lauf<{ zustand: string }>(zugang, beitrittSkript({ ...p, dns, ...(ou ? { ou } : {}), ...this.konto(input) }), 'Domänenbeitritt', 600_000, { kennwort });
    const s = r.zustand === 'schon' ? await this.status(zugang) : await this.warte(zugang, x => mitgliedBereit(x, p.domaene), 15 * 60_000);
    return { success: true, data: s, display: `✅ ${adStatusText(s)}${ou ? ` (OU ${ou})` : ''}` };
  }

  private async grundstruktur(zugang: string, input: Record<string, unknown>): Promise<SkillResult> {
    const liste = (x: unknown, std: string[]) => (Array.isArray(x) && x.length ? x.map(String) : typeof x === 'string' && x.trim() ? x.split(',').map(s => s.trim()) : std);
    const p = { ous: liste(input.ous, AD_OUS_STANDARD), ntp: liste(input.ntp, NTP_STANDARD), weiterleiter: liste(input.weiterleiter, []) };
    const f = pruefeGrundstruktur(p); if (f) throw new Error(f);
    // Domänen-Administrator für Papierkorb und Domänen-Admins: provision_windows_vm legt das Kennwort von alfred und Administrator
    // gemeinsam als win-<zugang>-admin ab; nach dem Hochstufen gilt es für den Domänen-Administrator
    const kennwort = await this.kontoKennwort({ konto_tresor: input.konto_tresor ?? `win-${zugang}-admin` }, `AD-Grundstruktur ${zugang} (Domänen-Administrator)`);
    const r = await this.lauf<Record<string, unknown>>(zugang, grundstrukturSkript({ ...p, ...this.konto(input) }), 'AD-Grundstruktur', 600_000, { kennwort });
    if (r.papierkorb !== true) throw new Error('AD-Papierkorb nach dem Einschalten nicht aktiv');
    return { success: true, data: r, display: `✅ Grundstruktur auf ${zugang}: OUs ${p.ous.join(', ')}${(r.ous as string[] | undefined)?.length ? ` (neu: ${(r.ous as string[]).join(', ')})` : ' (vorhanden)'}, AD-Papierkorb an, alfred in Domänen-Admins (${String(r.alfredAdmin)}), NTP ${p.ntp.join(', ')}${p.weiterleiter.length ? `, DNS-Weiterleiter ${(r.weiterleiter as string[] | undefined)?.join(', ')}` : ''}, KDS-Schlüssel ${String(r.kds)}` };
  }

  private async sicherung(zugang: string, input: Record<string, unknown>): Promise<SkillResult> {
    const laufwerk = String(input.laufwerk ?? '').trim().toUpperCase(); const groesseGb = Number(input.groesse_gb); const uhrzeit = String(input.uhrzeit ?? '02:30').trim();
    if (!/^[D-Z]$/.test(laufwerk)) throw new Error('laufwerk: ein Buchstabe D–Z');
    if (!Number.isFinite(groesseGb) || groesseGb < 16 || groesseGb > 4096) throw new Error('groesse_gb: Größe der leeren Zusatzplatte (16–4096)');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(uhrzeit)) throw new Error('uhrzeit: HH:MM');
    const r = await this.lauf<Record<string, unknown>>(zugang, sicherungSkript({ laufwerk, groesseGb, uhrzeit }), 'Systemstatus-Sicherung einrichten', 900_000);
    return { success: true, data: r, display: `✅ Systemstatus-Sicherung auf ${zugang}: Laufwerk ${laufwerk}: (${String(r.groesseGb)} GB, ${String(r.freiGb)} GB frei), täglich ${uhrzeit}, Aufgabe ${String(r.aufgabe)}` };
  }

  private async sicherungJetzt(zugang: string, input: Record<string, unknown>): Promise<SkillResult> {
    const laufwerk = String(input.laufwerk ?? '').trim().toUpperCase();
    if (!/^[D-Z]$/.test(laufwerk)) throw new Error('laufwerk: ein Buchstabe D–Z');
    const r = await this.lauf<Record<string, unknown>>(zugang, sicherungJetztSkript({ laufwerk }), 'Systemstatus-Sicherung', 3_600_000);
    return { success: true, data: r, display: `✅ Systemstatus gesichert auf ${zugang} ${laufwerk}: — ${String(r.versionen)} Version(en), neueste ${String(r.neueste)}, ${String(r.freiGb)} GB frei` };
  }

  private async papierkorb(zugang: string, input: Record<string, unknown>): Promise<SkillResult> {
    const kennung = Date.now().toString(36);
    const kennwort = await this.kontoKennwort({ konto_tresor: input.konto_tresor ?? `win-${zugang}-admin` }, `Papierkorb-Beweis ${zugang} (Domänen-Administrator)`);
    const r = await this.lauf<Record<string, unknown>>(zugang, papierkorbSkript({ kennung, ...this.konto(input) }), 'Papierkorb-Beweis', 300_000, { kennwort });
    return { success: true, data: r, display: `✅ AD-Papierkorb belegt: Testkonto ${String(r.konto)} gelöscht, aus dem Papierkorb wiederhergestellt, geprüft und wieder entfernt` };
  }

  /** I8e Task 4 — Dienstkonto am DC; Kennwort einmalig erzeugt (ad-<konto>), nur über die Standardeingabe */
  private async dienstkonto(zugang: string, input: Record<string, unknown>): Promise<SkillResult> {
    const p = pruefeDienstkonto({ konto: input.konto, ...(input.ou !== undefined ? { ou: input.ou } : {}) }); if (typeof p === 'string') throw new Error(p);
    const ausKonto = this.konto(input);
    const kennwort = await this.kontoKennwort({ konto_tresor: input.konto_tresor ?? `win-${zugang}-admin` }, `Dienstkonto ${p.konto} anlegen (Domänen-Administrator)`);
    const t = this.tresor(); const name = dienstkontoTresorName(p.konto);
    let dienstkennwort: string; let neu = false;
    if ((await t.namen()).has(name)) dienstkennwort = await t.lies(name, `Dienstkonto ${p.konto}`);
    else { dienstkennwort = adKennwort(); await t.setze(name, dienstkennwort, `Kennwort des Domänen-Dienstkontos ${p.konto} (läuft nie ab)`); neu = true; }
    const haerten = input.haerten === true;
    const r = await this.lauf<{ zustand: string; konto: string; dn: string; aktiv: boolean; laeuftNieAb: boolean; kannNichtAendern: boolean; inOu?: boolean; anmeldung: boolean; verschluesselung?: number; keineDelegierung?: boolean; anmeldesperre?: Anmeldesperre | null }>(zugang, dienstkontoSkript({ ...p, ...ausKonto, ...(haerten ? { haerten: true } : {}) }), 'Dienstkonto anlegen', 300_000, { kennwort, dienstkennwort });
    if (!(r.aktiv && r.laeuftNieAb && r.kannNichtAendern && r.anmeldung && r.inOu === true)) {
      throw new Error(`Dienstkonto ${p.konto}: Nachprüfung fehlgeschlagen (aktiv ${r.aktiv}, Kennwort läuft nie ab ${r.laeuftNieAb}, nicht änderbar ${r.kannNichtAendern}, Anmeldung ${r.anmeldung}, in OU ${r.inOu ?? '?'})`);
    }
    // I8e Etappe 3 — Härtung aus dem Zurückgelesenen prüfen
    const mangel = haerten ? dienstkontoGehaertet(r) : undefined;
    if (mangel) throw new Error(`Dienstkonto ${p.konto}: Nachprüfung der Härtung fehlgeschlagen — ${mangel}`);
    this.d.protokoll?.('I8e Dienstkonto', { zugang, konto: p.konto, zustand: r.zustand, kennwortNeu: neu, haerten });
    const text = `${haerten ? 'DIENSTKONTO_GEHAERTET ' : ''}Dienstkonto ${r.konto} (${r.dn}): aktiv, Kennwort läuft nie ab, Anmeldung geprüft${haerten ? `, nur AES (${r.verschluesselung}), keine Delegierung, keine lokale/RDP-Anmeldung (Gruppe ${r.anmeldesperre?.gruppe}, GPO „${r.anmeldesperre?.gpo}“ verknüpft)` : ''}; Kennwort im Tresor (${name})`;
    return { success: true, data: { ...r, tresor: name }, display: r.zustand === 'schon' ? `${text} — nichts zu tun` : `✅ ${text} — ${r.zustand} — Rückweg dienstkonto_entfernen konto ${p.konto}` };
  }

  /** Domänen-Administrator am DC: Tresor konto_tresor, Standard win-<zugang>-admin (wie grundstruktur) */
  private adminKennwort(zugang: string, input: Record<string, unknown>, wofuer: string): Promise<string> {
    return this.kontoKennwort({ konto_tresor: input.konto_tresor ?? `win-${zugang}-admin` }, wofuer);
  }

  /** I8e Etappe 3 — SPNs am Dienstkonto (setzen/entfernen im Change, lesen auch außerhalb) */
  private async spn(zugang: string, action: string, input: Record<string, unknown>): Promise<SkillResult> {
    const spns = pruefeSpns(input.spns); if (typeof spns === 'string') throw new Error(spns);
    const ausKonto = this.konto(input);
    if (action === 'spn_lesen') {
      const k = input.konto === undefined ? undefined : pruefeKonto(input.konto);
      if (typeof k === 'string') throw new Error(k);
      const kennwort = await this.adminKennwort(zugang, input, 'SPNs lesen (Domänen-Administrator)');
      const r = await this.lauf<SpnLesen>(zugang, spnLesenSkript({ spns, ...ausKonto }), 'SPNs lesen', 180_000, { kennwort });
      const t = spnLesenText(r, k?.konto);
      return { success: true, data: { ...r, eindeutig: t.eindeutig }, display: t.text };
    }
    const k = pruefeKonto(input.konto); if (typeof k === 'string') throw new Error(k);
    const kennwort = await this.adminKennwort(zugang, input, `SPNs am Konto ${k.konto} (Domänen-Administrator)`);
    if (action === 'spn_entfernen') {
      const r = await this.lauf<{ zustand: string; entfernt: string[] }>(zugang, spnEntfernenSkript({ konto: k.konto, spns, ...ausKonto }), 'SPNs entfernen', 180_000, { kennwort });
      return { success: true, data: r, display: `✅ SPNs am Konto ${k.konto}: ${r.zustand}${r.entfernt?.length ? ` (${r.entfernt.join(', ')})` : ''}` };
    }
    const r = await this.lauf<{ konto: string; dn: string; neu: string[]; spns: Array<{ spn: string; traeger: number; amKonto: boolean }> }>(zugang, spnSetzenSkript({ konto: k.konto, spns, ...ausKonto }), 'SPNs setzen', 300_000, { kennwort });
    const falsch = spns.filter(s => !r.spns?.some(x => x.spn.toLowerCase() === s.toLowerCase() && x.traeger === 1 && x.amKonto));
    if (falsch.length) throw new Error(`SPNs am Konto ${k.konto}: Nachprüfung fehlgeschlagen — nicht genau einmal im Wald am Konto: ${falsch.map(s => `${s} (${r.spns?.find(x => x.spn.toLowerCase() === s.toLowerCase())?.traeger ?? 0} Träger)`).join(', ')}`);
    const text = `SPN_EINDEUTIG — ${spns.length} SPN(s) genau einmal im Wald, am Konto ${k.konto} (${r.dn})`;
    return { success: true, data: r, display: r.neu?.length ? `✅ ${text} — neu: ${r.neu.join(', ')} — Rückweg spn_entfernen konto ${k.konto} spns ${JSON.stringify(r.neu)}` : `${text} — nichts zu tun` };
  }

  /** I8e Etappe 3 — Computerkonto für den Linux-Beitritt; Einmal-Kennwort nur Tresor + Standardeingabe */
  private async computerkonto(zugang: string, input: Record<string, unknown>): Promise<SkillResult> {
    const p = pruefeComputerkonto({ name: input.name, ...(input.ou !== undefined ? { ou: input.ou } : {}) }); if (typeof p === 'string') throw new Error(p);
    const ausKonto = this.konto(input);
    const kennwort = await this.adminKennwort(zugang, input, `Computerkonto ${p.name}$ vorbereiten (Domänen-Administrator)`);
    const t = this.tresor(); const name = joinTresorName(p.name);
    let einmal: string; let neu = false;
    if ((await t.namen()).has(name)) einmal = await t.lies(name, `Einmal-Kennwort Computerkonto ${p.name}$`);
    else { einmal = einmalKennwort(); await t.setze(name, einmal, `Einmal-Kennwort für den Domänenbeitritt von ${p.name} (Computerkonto ${p.name}$, verbraucht linux_sql ad_beitreten)`); neu = true; }
    const r = await this.lauf<{ zustand: string; konto: string; dn: string; aktiv: boolean; inOu: boolean; einmalBereit: boolean; ohneAnmeldung: boolean }>(zugang, computerkontoSkript({ ...p, ...(neu ? { neu: true } : {}), ...ausKonto }), 'Computerkonto vorbereiten', 300_000, { kennwort, einmal });
    if (!(r.aktiv && r.inOu && r.einmalBereit)) throw new Error(`Computerkonto ${p.name}$: Nachprüfung fehlgeschlagen (aktiv ${r.aktiv}, in OU ${r.inOu}, Kennwort gesetzt ${r.einmalBereit})`);
    this.d.protokoll?.('I8e Computerkonto', { zugang, name: p.name, zustand: r.zustand, kennwortNeu: neu });
    return {
      success: true, data: { ...r, tresor: name },
      display: r.zustand === 'schon' ? `COMPUTERKONTO_BEREIT ${r.konto} (${r.dn}) — aktiv, unbenutzt, Einmal-Kennwort unverändert im Tresor (${name}) — nichts zu tun` : `✅ COMPUTERKONTO_BEREIT ${r.konto} (${r.dn}) — ${r.zustand}, aktiv, Einmal-Kennwort gesetzt; im Tresor (${name}) — Rückweg computerkonto_entfernen name ${p.name}`,
    };
  }

  /** I8e Etappe 3 — Reverse-DNS (Zone + PTR), Auflösung an allen DCs geprüft */
  private async dnsPtr(zugang: string, action: string, input: Record<string, unknown>): Promise<SkillResult> {
    const p = pruefePtr(input); if (typeof p === 'string') throw new Error(p);
    const kennwort = await this.adminKennwort(zugang, input, `PTR ${p.ip} (Domänen-Administrator)`);
    if (action === 'dns_ptr_loeschen') {
      const r = await this.lauf<{ zustand: string }>(zugang, dnsPtrLoeschenSkript({ ...p, ...this.konto(input) }), 'PTR löschen', 180_000, { kennwort });
      return { success: true, data: r, display: `✅ PTR ${p.ip} → ${p.fqdn}: ${r.zustand} (Zone ${p.zone} bleibt)` };
    }
    const r = await this.lauf<{ zone: string; ptr: string; dcs: Array<{ name: string; ip: string; antwort: string }>; offen: string[] }>(zugang, dnsPtrSkript({ ...p, ...this.konto(input) }), 'PTR anlegen', 900_000, { kennwort });
    const dcs = (r.dcs ?? []).map(x => `${x.name} (${x.ip}): ${x.antwort || 'keine Antwort'}`).join('; ');
    if (r.offen?.length || !r.dcs?.length) throw new Error(`PTR ${p.ip} → ${p.fqdn}: Nachprüfung fehlgeschlagen — ${r.offen?.length ? `nach 10 min nicht aufgelöst an ${r.offen.join(', ')}` : 'keine DCs gefunden'} (${dcs})`);
    const text = `PTR_OK ${p.ip} → ${p.fqdn} (Zone ${p.zone}: ${r.zone}, PTR: ${r.ptr}) — aufgelöst an ${dcs}`;
    return { success: true, data: { ...r, ...p }, display: r.zone === 'schon' && r.ptr === 'schon' ? `${text} — nichts zu tun` : `✅ ${text} — Rückweg dns_ptr_loeschen zone ${p.zone} ip ${p.ip} fqdn ${p.fqdn}` };
  }

  /** I8e Etappe 3 — globale Sicherheitsgruppe mit Mitgliedern */
  private async gruppe(zugang: string, input: Record<string, unknown>): Promise<SkillResult> {
    const p = pruefeGruppe({ gruppe: input.gruppe, mitglieder: input.mitglieder, ...(input.ou !== undefined ? { ou: input.ou } : {}) }); if (typeof p === 'string') throw new Error(p);
    const kennwort = await this.adminKennwort(zugang, input, `Gruppe ${p.gruppe} (Domänen-Administrator)`);
    const r = await this.lauf<{ zustand: string; gruppe: string; dn: string; inOu: boolean; global?: boolean; mitglieder: string[]; neu: string[]; fehlt: string[] }>(zugang, gruppeSkript({ ...p, ...this.konto(input) }), 'Gruppe anlegen', 300_000, { kennwort });
    if (!r.inOu || r.fehlt?.length) throw new Error(`Gruppe ${p.gruppe}: Nachprüfung fehlgeschlagen (in OU ${r.inOu}${r.fehlt?.length ? `, fehlende Mitglieder ${r.fehlt.join(', ')}` : ''})`);
    const weitere = (r.mitglieder ?? []).filter(m => !p.mitglieder.some(x => x.toLowerCase() === m.toLowerCase()));
    const text = `GRUPPE_OK ${r.gruppe} (${r.dn}) — Mitglieder ${(r.mitglieder ?? []).join(', ') || 'keine'}${weitere.length ? ` (davon nicht verlangt: ${weitere.join(', ')})` : ''}`;
    return { success: true, data: r, display: r.zustand === 'schon' ? `${text} — nichts zu tun` : `✅ ${text} — ${r.zustand} — Rückweg gruppe_entfernen gruppe ${p.gruppe}` };
  }

  /** I8e Etappe 3 — Anmeldeprobe Kerberos + TLS von einem Windows-Domänenmitglied (sql01) unter dem Test-Konto */
  private async sqlAnmeldung(zugang: string, input: Record<string, unknown>): Promise<SkillResult> {
    // Fix-Runde 1 (Ruling R5): nur sql01/sql02, nur Test-Konten ad-svc-…-test, konto = Tresor-Name ohne „ad-“, nur Instanzen in ad.3033.at
    if (!SQL_PROBE_ZUGAENGE.has(zugang.toLowerCase())) throw new Error(`zugang: die Anmeldeprobe läuft nur auf ${[...SQL_PROBE_ZUGAENGE].join(' oder ')}`);
    const s = pruefeSqlServer(input.server); if (typeof s === 'string') throw new Error(s);
    const tresorName = String(input.konto_tresor ?? '').trim();
    if (!SQL_PROBE_TRESOR.test(tresorName)) throw new Error('konto_tresor: nur ein Test-Konto ad-svc-<name>-test (z. B. ad-svc-sqllnx-test) — nie ein Administrator- oder Dienstkonto');
    const k = pruefeKonto(tresorName.replace(/^ad-/, '')); if (typeof k === 'string') throw new Error(k);
    if (input.konto !== undefined && String(input.konto).trim() !== k.konto) throw new Error(`konto: muss ${k.konto} sein (Tresor-Name ohne „ad-“)`);
    const kennwort = await this.kontoKennwort({ konto_tresor: tresorName }, `Anmeldeprobe ${s.server} als ${k.konto}`);
    const r = await this.lauf<SqlAnmeldung>(zugang, sqlAnmeldungSkript({ server: s.server, konto: k.konto }), 'SQL-Anmeldeprobe', 300_000, { kennwort });
    const a = sqlAnmeldungAuswerten(r, s.server);
    const data = { server: s.server, konto: k.konto, sqlcmd: r.sqlcmd, exit: r.exit, auth: a.auth, verschluesselt: a.verschluesselt, servername: a.servername };
    return a.ok ? { success: true, data, display: a.text } : { success: false, data, error: a.text };
  }

  private async dnsEintrag(zugang: string, action: string, input: Record<string, unknown>): Promise<SkillResult> {
    const p = { zone: String(input.zone ?? '').trim().toLowerCase(), name: String(input.name ?? '').trim().toLowerCase(), ...(action === 'dns_eintrag' ? { ip: String(input.ip ?? '').trim() } : {}) };
    const f = pruefeDnsEintrag(p); if (f) throw new Error(f);
    if (action === 'dns_eintrag') {
      const r = await this.lauf<{ zustand: string }>(zugang, dnsEintragSkript(p as { zone: string; name: string; ip: string }), 'DNS-Eintrag', 120_000);
      return { success: true, data: { ...r, fqdn: `${p.name}.${p.zone}`, ip: p.ip }, display: `✅ ${p.name}.${p.zone} → ${p.ip} (${r.zustand})` };
    }
    const r = await this.lauf<{ zustand: string }>(zugang, dnsEintragLoeschenSkript(p), 'DNS-Eintrag löschen', 120_000);
    return { success: true, data: r, display: `✅ ${p.name}.${p.zone} ${r.zustand}` };
  }
}

export { AD_NETBIOS };
