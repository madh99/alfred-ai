/**
 * I8d — Skill „sql_server“: SQL Server auf Windows über feste Bausteine (sql-server.ts). Lesend (status, pruefdaten_lesen) auch außerhalb
 * von Changes, alles andere nur als Schritt eines freigegebenen Changes. Kein freies T-SQL.
 */
import { Skill } from '@alfred/skills';
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { kodiert, adErgebnis, clixmlFehler } from './windows-ad.js';
import {
  sqlStatusSkript, sqlStatusText, pruefdatenLesenSkript, pruefeMedien, medienSkript, pruefeInstallation, installierenSkript, pruefeKonfiguration, konfigurierenSkript,
  hadrSkript, ressourcentypSkript, endpunktSkript, endpunktEntfernenSkript, pruefeAg, agAnlegenSkript, agBeitretenSkript, agEntfernenSkript, pruefeListener, listenerSkript, listenerEntfernenSkript,
  failoverSkript, datenbankSkript, datenbankEntfernenSkript, pruefdatenSchreibenSkript, pruefeSicherung, sicherungSkript, pruefeJobs, jobsSkript, jobsEntfernenSkript,
  pruefeWiederherstellung, wiederherstellungSkript, BEZEICHNER, INSTANZ, listenerTestSkript, listenerTestText, type SqlStatus, type ListenerTest,
} from './sql-server.js';
import { KONTO } from './windows-cluster.js';
import { KONTO_FREI } from './windows-ad.js';

export interface SqlServerDeps {
  skript: (zugang: string, befehl: string, eingabe: string | undefined, timeoutMs: number, zweck: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  tresor?: { namen: () => Promise<Set<string>>; lies: (name: string, wofuer: string) => Promise<string> };
  protokoll?: (msg: string, daten: Record<string, unknown>) => void;
  schlafe?: (ms: number) => Promise<void>;
}

export const SQL_LESEND = new Set(['status', 'pruefdaten_lesen', 'listener_testen']);
const NUR_IM_CHANGE = new Set(['sql_medien_laden', 'sql_installieren', 'konfigurieren', 'hadr_aktivieren', 'endpunkt_anlegen', 'endpunkt_entfernen', 'ag_anlegen', 'ag_beitreten',
  'ag_entfernen', 'listener_anlegen', 'listener_entfernen', 'failover', 'datenbank_anlegen', 'datenbank_entfernen', 'pruefdaten_schreiben', 'sql_sicherung',
  'sicherungsjobs_einrichten', 'sicherungsjobs_entfernen', 'wiederherstellung_testen']);
const ZUGANG = /^[a-z0-9][a-z0-9.-]{0,62}$/i;

export class SqlServerSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'sql_server',
    category: 'infrastructure',
    description:
      'SQL Server auf Windows (I8d) über feste Bausteine auf Windows-Fernzugängen (zugang = Name des Fernzugangs), kein freies T-SQL. '
      + 'status (lesend, auch außerhalb von Changes): Version/CU/Edition, HADR, max Speicher, MAXDOP, Kostenschwelle, TempDB-Dateien, IFI, Dienste mit Konten, Datenbanken, AG-Replikate mit Rolle/Gesundheit, AG-Datenbanken mit Synchronisierung, Listener — als Prüfung z. B. erwartet „HADR an“, „SQL02 SECONDARY HEALTHY“, „alfredtest@SQL02 SYNCHRONIZED“, „Listener sqlag01:1433“, „SQL01 PRIMARY“. '
      + 'Alle Aktionen nehmen optional instanz (benannte Instanz, Standard MSSQLSERVER; bei AG-Replikaten server SQL01\\INSTANZ und je Instanz eigener Endpunkt-Port). '
      + 'listener_testen (lesend, auch außerhalb von Changes; zugang = Client-Rechner in der Domäne, z. B. probe-win25b oder ein Knoten, listener = FQDN, port 1433, konto_tresor = Kennwort des Domänenkontos alfred, ausfuehrungskonto optional) — echte Anmeldung über den Listener per TCP, verschlüsselt; Ergebnis „Listener … → SQL01 (PRIMARY), Anmeldung AD3033\\alfred über KERBEROS, verschlüsselt …“ — als Prüfung erwartet „über KERBEROS“ bzw. „SQL02 (PRIMARY)“. '
      + 'pruefdaten_lesen (lesend; zugang, datenbank) — Zeilen/letzte Id der Prüftabelle dbo.alfred_pruef. '
      + 'NUR als Schritte freigegebener Changes: sql_medien_laden (zugang, url = Microsoft-Download: SSEI-Downloader/ISO bzw. CU, art installation|cu, sha256 optional) — Signatur Microsoft geprüft, nach C:\\SQLMedia (braucht befristeten Internetzugang; ohne Rückweg). '
      + 'sql_installieren (zugang, engine_konto/agent_konto = gMSA NETBIOS\\name$, sysadmins, daten D:\\SQLData, log L:\\SQLLog, tempdb T:\\TempDB, sicherung B:\\SQLBackup, tempdb_dateien 4, tempdb_mb 1024, tempdb_log_mb 2048, max_speicher_mb 12288, maxdop 4, pid optional, konto_tresor Pflicht = Kennwort des Domänenkontos alfred, z. B. win-dc01-admin; zeitlimitS 5400–7200) — als Domänenkonto per Kennwort-Anmeldung, CU aus C:\\SQLMedia\\CU per Slipstream, Neustart bei Bedarf (ohne Rückweg; Deinstallation = eigener Change). '
      + 'konfigurieren (zugang, max_speicher_mb, maxdop, kostenschwelle) — Ergebnis nennt die vorherigen Werte (Rückweg: konfigurieren mit diesen). '
      + 'hadr_aktivieren (zugang, konto_tresor = Kennwort des Domänenkontos alfred — nötig, falls der Cluster-Ressourcentyp „SQL Server Availability Group“ fehlt, dann Registrierung per Kennwort-Anmeldung; erst nach windows_cluster cluster_anlegen) — Clusterzugriff, Dienstneustart (ohne Rückweg); Ergebnis „AG-Ressourcentyp registriert/schon“; nach einer Registrierung startet SQL neu; neustart true erzwingt den Neustart (z. B. auf dem Partnerknoten, der vor der Registrierung gestartet wurde). '
      + 'endpunkt_anlegen (zugang, partner_konto = Engine-gMSA, port 5022) ↔ endpunkt_entfernen — auf JEDEM Replikat. '
      + 'ag_anlegen (zugang = primär, name, datenbanken, replikate [{server SQL01, fqdn sql01.ad.3033.at}, …] primär zuerst) ↔ ag_entfernen — synchron, automatischer Failover, automatisches Seeding, Vollsicherung falls nötig. '
      + 'ag_beitreten (zugang = sekundär, name, datenbanken) — wartet bis SYNCHRONIZED (bis 30 min; Rückweg ag_entfernen am primären). '
      + 'listener_anlegen (zugang = primär, ag, name = VCO, ip, maske, port 1433; VCO vorher mit windows_cluster computerobjekt_vorbereiten vollzugriff <CNO>$) ↔ listener_entfernen. '
      + 'failover (zugang = Ziel, das sekundär und SYNCHRONIZED sein muss, ag) — geplant, nie mit Datenverlust; Rückweg failover auf das andere Replikat. '
      + 'datenbank_anlegen (zugang, name) ↔ datenbank_entfernen (nur von Alfred angelegte, nicht in einer AG); pruefdaten_schreiben (zugang = primär, datenbank, notiz) — Commit-Beweis (ohne Rückweg). '
      + 'sql_sicherung (zugang, datenbank, art voll|diff|log, ziel Ordner oder \\\\fs01.ad.3033.at\\SQLBackup$; ohne Rückweg) — Datei <ziel>\\<db>\\<db>_<art>_<zeit>.<bak|dif|trn>, CHECKSUM, Kompression. '
      + 'sicherungsjobs_einrichten (zugang = jedes Replikat, datenbanken, ziel, voll_uhrzeit 01:00, diff_stunden 6, log_minuten 15) ↔ sicherungsjobs_entfernen — sichert nur auf dem bevorzugten Replikat, löscht nie alte Sicherungen. '
      + 'wiederherstellung_testen (zugang, datenbank, ordner = <ziel>\\<db>, ziel_name, entfernen_danach Standard true) — Kette voll+diff+log neben der AG, Platzprüfung, DBCC CHECKDB, Prüfdaten zählen (ohne Rückweg).',
    riskLevel: 'admin',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...SQL_LESEND, ...NUR_IM_CHANGE] },
        zugang: { type: 'string' },
        instanz: { type: 'string', description: 'optional: benannte Instanz (ohne Angabe die Standardinstanz MSSQLSERVER)' },
        ausfuehrungskonto: { type: 'string', description: 'sql_installieren optional: Ausführungskonto „name“ oder „NETBIOS\\name“ (Standard alfred), z. B. fremde Domäne' },
        url: { type: 'string' }, art: { type: 'string' }, sha256: { type: 'string' },
        engine_konto: { type: 'string' }, agent_konto: { type: 'string' }, sysadmins: { type: 'array', items: { type: 'string' } },
        daten: { type: 'string' }, log: { type: 'string' }, tempdb: { type: 'string' }, sicherung: { type: 'string' },
        tempdb_dateien: { type: 'number' }, tempdb_mb: { type: 'number' }, tempdb_log_mb: { type: 'number' }, max_speicher_mb: { type: 'number' }, maxdop: { type: 'number' }, kostenschwelle: { type: 'number' }, pid: { type: 'string' },
        konto_tresor: { type: 'string' }, neustart: { type: 'boolean', description: 'hadr_aktivieren: SQL-Dienst auch dann neu starten, wenn HADR schon an ist' }, partner_konto: { type: 'string' }, port: { type: 'number' },
        name: { type: 'string' }, ag: { type: 'string' }, datenbanken: { type: 'array', items: { type: 'string' } },
        replikate: { type: 'array', items: { type: 'object', properties: { server: { type: 'string' }, fqdn: { type: 'string' } } } },
        ip: { type: 'string' }, maske: { type: 'string' }, datenbank: { type: 'string' }, notiz: { type: 'string' }, ziel: { type: 'string' },
        voll_uhrzeit: { type: 'string' }, diff_stunden: { type: 'number' }, log_minuten: { type: 'number' },
        ordner: { type: 'string' }, listener: { type: 'string', description: 'listener_testen: FQDN des Listeners' }, ziel_name: { type: 'string' }, entfernen_danach: { type: 'boolean' },
      },
      required: ['action', 'zugang'],
    },
  };

  constructor(private readonly d: SqlServerDeps) { super(); }

  async execute(input: Record<string, unknown>, context?: SkillContext): Promise<SkillResult> {
    const action = String(input.action ?? '');
    const zugang = String(input.zugang ?? '').trim().toLowerCase();
    if (!SQL_LESEND.has(action) && !NUR_IM_CHANGE.has(action)) return { success: false, error: `Unbekannte Aktion ${action}` };
    if (NUR_IM_CHANGE.has(action) && (context as { ausChange?: boolean } | undefined)?.ausChange !== true) return { success: false, error: `${action} läuft nur als Schritt eines freigegebenen Changes` };
    if (!ZUGANG.test(zugang)) return { success: false, error: 'zugang: Name des Windows-Fernzugangs' };
    const pr = <T>(f: T | string): T => { if (typeof f === 'string') throw new Error(f); return f; };
    // v1789 — benannte Instanz (Standard MSSQLSERVER) und optionales Ausführungskonto für die Installation
    const instRoh = String(input.instanz ?? '').trim();
    if (instRoh && !INSTANZ.test(instRoh)) return { success: false, error: 'instanz: Name der Instanz (Buchstabe, dann Buchstaben/Ziffern/_; höchstens 16), ohne Angabe die Standardinstanz' };
    const inst = instRoh && instRoh.toUpperCase() !== 'MSSQLSERVER' ? instRoh.toUpperCase() : undefined;
    const mi = <T extends object>(p: T): T => (inst ? Object.assign({}, p, { instanz: inst }) : p);
    const kontoRoh = String(input.ausfuehrungskonto ?? '').trim();
    if (kontoRoh && !KONTO_FREI.test(kontoRoh)) return { success: false, error: 'ausfuehrungskonto: „name“ oder „NETBIOS\\name“' };
    const mk = <T extends object>(p: T): T => (kontoRoh ? Object.assign({}, p, { ausKonto: kontoRoh }) : p);
    const name = (feld: string) => { const v = String(input[feld] ?? '').trim(); if (!BEZEICHNER.test(v)) throw new Error(`${feld}: Name (Buchstabe, dann Buchstaben/Ziffern/_)`); return v; };
    try {
      switch (action) {
        case 'status': { const s = await this.status(zugang, inst); return { success: true, data: s, display: sqlStatusText(s) }; }
        case 'pruefdaten_lesen': {
          const r = await this.lauf<{ zeilen: number; letzteId: number | null; letzterServer: string; letzteZeit: string }>(zugang, pruefdatenLesenSkript(mi({ datenbank: name('datenbank') })), 'Prüfdaten lesen', 120_000);
          return { success: true, data: r, display: `Prüfdaten ${String(input.datenbank)}: ${r.zeilen} Zeilen, letzte Id ${r.letzteId ?? '—'} (${r.letzterServer || '—'}, ${r.letzteZeit || '—'})` };
        }
        case 'sql_medien_laden': {
          const p = pr(pruefeMedien(input));
          const r = await this.lauf<Record<string, unknown>>(zugang, medienSkript(p), 'SQL-Medien laden', 3_600_000);
          return { success: true, data: r, display: `✅ Medien auf ${zugang}: ${p.art === 'cu' ? `CU ${String(r.produkt ?? '')} ${String(r.version ?? '')}` : `ISO ${String(r.iso)} (SHA-256 ${String(r.isoSha256).slice(0, 16)}…), setup.exe ${String(r.setupVersion)}`}; Signatur ${String(r.setupSignatur ?? r.signatur ?? '').replace(/,.*$/, '')}` };
        }
        case 'sql_installieren': {
          const p = pr(pruefeInstallation(input));
          const kw = await this.kennwort(input.konto_tresor, `SQL-Installation ${zugang} (Domänenkonto alfred)`);
          const r = await this.lauf<{ zustand: string; code: number; neustart?: boolean; mitCu?: boolean; summary?: string[] }>(zugang, installierenSkript(mi(mk(p))), 'SQL-Installation', 6_000_000, { kennwort: kw });
          this.d.protokoll?.('I8d SQL installiert', { zugang, zustand: r.zustand, code: r.code });
          const s = r.neustart ? await this.warte(zugang, x => x.installiert && !!x.version, 25 * 60_000, inst) : await this.status(zugang, inst);
          if (!s.installiert || !s.version) throw new Error(`nach der Installation nicht erreichbar: ${sqlStatusText(s)}`);
          return { success: true, data: { ...r, status: s }, display: `✅ ${r.zustand === 'schon' ? 'schon installiert' : `installiert${r.mitCu ? ' mit CU' : ''}${r.neustart ? ' (Neustart)' : ''}`} — ${sqlStatusText(s)}${r.summary?.length ? `; ${r.summary.join(' | ')}` : ''}` };
        }
        case 'konfigurieren': {
          const p = pr(pruefeKonfiguration(input));
          const r = await this.lauf<{ vorher: Record<string, number>; nachher: Record<string, number> }>(zugang, konfigurierenSkript(mi(p)), 'SQL konfigurieren', 120_000);
          const fmt = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ');
          return { success: true, data: r, display: `✅ ${zugang}: ${fmt(r.nachher)} (vorher ${fmt(r.vorher)}) — Rückweg konfigurieren mit ${JSON.stringify(r.vorher)}` };
        }
        case 'hadr_aktivieren': {
          let r = await this.lauf<{ zustand: string; ressourcentyp?: string; dll?: string }>(zugang, hadrSkript(inst, input.neustart === true), 'HADR einschalten', 600_000);
          // v1801 — AG-Ressourcentyp über alle Knoten registrieren braucht die Kennwort-Anmeldung (Doppel-Hop)
          if (r.ressourcentyp === 'fehlt') {
            if (!input.konto_tresor) throw new Error(`HADR auf ${zugang} an, aber Cluster-Ressourcentyp „SQL Server Availability Group“ fehlt — zum Registrieren konto_tresor angeben (Kennwort des Domänenkontos alfred, z. B. win-dc01-admin)`);
            const kw = await this.kennwort(input.konto_tresor, `AG-Ressourcentyp im Cluster registrieren von ${zugang} (Domänenkonto)`);
            const t = await this.lauf<{ ressourcentyp: string }>(zugang, ressourcentypSkript(mk({ dll: String(r.dll) })), 'AG-Ressourcentyp registrieren', 420_000, { kennwort: kw });
            // v1802 — Realfall F2 Schritt 12: ohne Neustart nach der Registrierung Fehler 35222 bei CREATE AVAILABILITY GROUP
            r = { ...(await this.lauf<{ zustand: string; ressourcentyp?: string; dll?: string }>(zugang, hadrSkript(inst, true), 'SQL-Neustart nach Registrierung', 600_000)), ressourcentyp: t.ressourcentyp === 'schon' ? 'schon' : 'registriert' };
          }
          return { success: true, data: r, display: `✅ HADR auf ${zugang}: ${r.zustand}${r.ressourcentyp ? `; AG-Ressourcentyp ${r.ressourcentyp}` : ''}` };
        }
        case 'endpunkt_anlegen': {
          const partner = String(input.partner_konto ?? '').trim();
          if (!KONTO.test(partner)) throw new Error('partner_konto: Dienstkonto der Partner-Replikate, z. B. AD3033\\gmsa-sqleng$');
          const port = input.port === undefined ? 5022 : Number(input.port);
          if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('port: Standard 5022');
          const r = await this.lauf<{ zustand: string; endpunkt: string; endpunktZustand: string; port: number }>(zugang, endpunktSkript(mi({ port, partner_konto: partner })), 'AG-Endpunkt', 180_000);
          return { success: true, data: r, display: `✅ Endpunkt ${r.endpunkt} ${r.endpunktZustand} Port ${r.port} auf ${zugang} (${r.zustand}), CONNECT für ${partner} — Rückweg endpunkt_entfernen` };
        }
        case 'endpunkt_entfernen': { const r = await this.lauf<{ zustand: string }>(zugang, endpunktEntfernenSkript(inst), 'AG-Endpunkt entfernen', 120_000); return { success: true, data: r, display: `✅ Endpunkt auf ${zugang}: ${r.zustand}` }; }
        case 'ag_anlegen': {
          const p = pr(pruefeAg(input));
          const r = await this.lauf<{ zustand: string; replikate?: string[]; vollsicherungen?: string[] }>(zugang, agAnlegenSkript(mi(p)), 'Verfügbarkeitsgruppe anlegen', 3_600_000);
          this.d.protokoll?.('I8d AG angelegt', { zugang, name: p.name, zustand: r.zustand });
          return { success: true, data: r, display: `✅ AG ${p.name} (${r.zustand})${r.replikate ? `: ${r.replikate.join(', ')}` : ''}${r.vollsicherungen?.length ? `; Vollsicherung ${r.vollsicherungen.join(', ')}` : ''} — Rückweg ag_entfernen name ${p.name}` };
        }
        case 'ag_beitreten': {
          const ag = name('name');
          const dbs = (Array.isArray(input.datenbanken) ? input.datenbanken.map(String) : []).map(s => s.trim()).filter(Boolean);
          if (!dbs.length || dbs.some(x => !BEZEICHNER.test(x))) throw new Error('datenbanken: Namen der AG-Datenbanken');
          const r = await this.lauf<{ zustand: string; synchron: string[] }>(zugang, agBeitretenSkript(mi({ name: ag, datenbanken: dbs })), 'AG beitreten', 2_000_000);
          return { success: true, data: r, display: `✅ ${zugang} in AG ${ag} (${r.zustand}); SYNCHRONIZED: ${r.synchron.join(', ')}` };
        }
        case 'ag_entfernen': { const n = name('name'); const r = await this.lauf<{ zustand: string }>(zugang, agEntfernenSkript(mi({ name: n })), 'AG entfernen', 600_000); return { success: true, data: r, display: `✅ AG ${n}: ${r.zustand}` }; }
        case 'listener_anlegen': {
          const p = pr(pruefeListener(input));
          const r = await this.lauf<{ zustand: string; listener: string[] }>(zugang, listenerSkript(mi(p)), 'AG-Listener', 600_000);
          return { success: true, data: r, display: `✅ Listener ${p.name} (${r.zustand}): ${r.listener.join(', ')} — Rückweg listener_entfernen ag ${p.ag} name ${p.name}` };
        }
        case 'listener_entfernen': {
          const p = pr(pruefeListener({ ...input, ip: '0.0.0.0', maske: '0.0.0.0' }));
          const r = await this.lauf<{ zustand: string }>(zugang, listenerEntfernenSkript(mi({ ag: p.ag, name: p.name })), 'AG-Listener entfernen', 600_000);
          return { success: true, data: r, display: `✅ Listener ${p.name}: ${r.zustand}` };
        }
        case 'listener_testen': {
          const listener = String(input.listener ?? '').trim().toLowerCase();
          if (!/^(?=.{3,120}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(listener)) throw new Error('listener: vollständiger DNS-Name, z. B. sqlag01.ad.3033.at');
          const port = input.port === undefined ? 1433 : Number(input.port);
          if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port: Standard 1433');
          const kw = await this.kennwort(input.konto_tresor, `Listener-Test ${listener} von ${zugang} (Domänenkonto)`);
          const p = { listener, port };
          const r = await this.lauf<ListenerTest>(zugang, listenerTestSkript(mk(p)), 'Listener-Test', 300_000, { kennwort: kw });
          return { success: true, data: { ...p, ...r }, display: listenerTestText(p, r) };
        }
        case 'failover': {
          const ag = name('ag');
          const r = await this.lauf<{ zustand: string; primaer: string; ms: number }>(zugang, failoverSkript(mi({ ag })), 'Geplanter Failover', 600_000);
          this.d.protokoll?.('I8d Failover', { zugang, ag, ...r });
          return { success: true, data: r, display: `✅ ${r.zustand}: ${r.primaer} ist primär in ${ag}${r.ms ? ` (${(r.ms / 1000).toFixed(1)} s)` : ''}` };
        }
        case 'datenbank_anlegen': { const n = name('name'); const r = await this.lauf<{ zustand: string; dateien: string[] }>(zugang, datenbankSkript(mi({ name: n })), 'Datenbank anlegen', 600_000); return { success: true, data: r, display: `✅ Datenbank ${n} (${r.zustand}): ${r.dateien.join(', ')} — Rückweg datenbank_entfernen name ${n}` }; }
        case 'datenbank_entfernen': { const n = name('name'); const r = await this.lauf<{ zustand: string }>(zugang, datenbankEntfernenSkript(mi({ name: n })), 'Datenbank entfernen', 600_000); return { success: true, data: r, display: `✅ Datenbank ${n}: ${r.zustand}` }; }
        case 'pruefdaten_schreiben': {
          const notiz = String(input.notiz ?? 'Alfred I8d').slice(0, 200);
          const r = await this.lauf<{ id: number; server: string; zeit: string; zeilen: number }>(zugang, pruefdatenSchreibenSkript(mi({ datenbank: name('datenbank'), notiz })), 'Prüfdaten schreiben', 120_000);
          return { success: true, data: r, display: `✅ Prüfzeile ${r.id} auf ${r.server} (${r.zeit}) committet; ${r.zeilen} Zeilen` };
        }
        case 'sql_sicherung': {
          const p = pr(pruefeSicherung(input));
          const r = await this.lauf<{ datei: string; mb: number; pruefsumme: boolean }>(zugang, sicherungSkript(mi(p)), 'SQL-Sicherung', 3_700_000);
          return { success: true, data: r, display: `✅ Sicherung ${p.art} ${p.datenbank}: ${r.datei} (${r.mb} MB${r.pruefsumme ? ', mit Prüfsumme' : ''})` };
        }
        case 'sicherungsjobs_einrichten': {
          const p = pr(pruefeJobs(input));
          const r = await this.lauf<{ jobs: string[] }>(zugang, jobsSkript(mi(p)), 'Sicherungsjobs', 180_000);
          return { success: true, data: r, display: `✅ Sicherungsjobs auf ${zugang}: ${r.jobs.join(', ')} → ${p.ziel} — Rückweg sicherungsjobs_entfernen` };
        }
        case 'sicherungsjobs_entfernen': { const r = await this.lauf<{ entfernt: string[] }>(zugang, jobsEntfernenSkript(inst), 'Sicherungsjobs entfernen', 120_000); return { success: true, data: r, display: `✅ Sicherungsjobs entfernt: ${r.entfernt.join(', ') || 'keine'}` }; }
        case 'wiederherstellung_testen': {
          const p = pr(pruefeWiederherstellung(input));
          const r = await this.lauf<{ kette: string[]; sekunden: number; checkdb: string; pruefZeilen: number; letzteId: number | null; entfernt: boolean }>(zugang, wiederherstellungSkript(mi(p)), 'Wiederherstellungstest', 7_200_000);
          this.d.protokoll?.('I8d Wiederherstellung getestet', { zugang, ...p, sekunden: r.sekunden, zeilen: r.pruefZeilen });
          return { success: true, data: r, display: `✅ Wiederherstellung ${p.datenbank} → ${p.ziel_name} auf ${zugang}: ${r.kette.length} Dateien (${r.kette.join(', ')}) in ${r.sekunden} s, DBCC CHECKDB ${r.checkdb}, ${r.pruefZeilen} Prüfzeilen (letzte Id ${r.letzteId ?? '—'})${r.entfernt ? ', danach entfernt' : ''}` };
        }
      }
    } catch (err) { return { success: false, error: (err as Error).message.slice(0, 900) }; }
    return { success: false, error: 'Unbekannte Aktion' };
  }

  private async lauf<T>(zugang: string, skript: string, zweck: string, timeoutMs: number, eingabe?: Record<string, string>): Promise<T> {
    const r = await this.d.skript(zugang, kodiert(skript), eingabe ? JSON.stringify(eingabe) : undefined, timeoutMs, zweck);
    const e = adErgebnis<T>(r.stdout);
    if (r.code !== 0 || !e) {
      const klar = `${r.stderr}\n${r.stdout}`.split(/\r?\n/).filter(z => z.trim() && !z.startsWith('#< CLIXML') && !z.startsWith('<Objs')).join(' ');
      const fehler = `${klar} ${clixmlFehler(`${r.stderr}\n${r.stdout}`)}`.replace(/\s+/g, ' ').trim().slice(-600);
      throw new Error(`${zweck} auf ${zugang} gescheitert (Exit ${r.code}): ${fehler || 'keine Ausgabe'}`);
    }
    return e;
  }

  private status(zugang: string, instanz?: string): Promise<SqlStatus> { return this.lauf<SqlStatus>(zugang, sqlStatusSkript(instanz), 'SQL-Status', 180_000); }

  private async warte(zugang: string, bereit: (s: SqlStatus) => boolean, grenzeMs: number, instanz?: string): Promise<SqlStatus> {
    const schlafe = this.d.schlafe ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    const bis = Date.now() + grenzeMs; let letzter: SqlStatus | undefined; let fehler = '';
    await schlafe(60_000);
    while (Date.now() < bis) {
      try { letzter = await this.status(zugang, instanz); if (bereit(letzter)) return letzter; fehler = ''; } catch (err) { fehler = (err as Error).message.slice(0, 200); }
      await schlafe(20_000);
    }
    throw new Error(`${zugang} nach ${Math.round(grenzeMs / 60_000)} min nicht bereit — zuletzt: ${letzter ? sqlStatusText(letzter) : fehler || 'kein Status'}`);
  }

  private async kennwort(name: unknown, wofuer: string): Promise<string> {
    const n = String(name ?? '').trim();
    if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(n)) throw new Error('konto_tresor: Tresor-Eintrag mit dem Kennwort des Domänenkontos alfred (z. B. win-dc01-admin)');
    if (!this.d.tresor) throw new Error('Tresor nicht verfügbar');
    if (!(await this.d.tresor.namen()).has(n)) throw new Error(`Tresor-Eintrag ${n} gibt es nicht`);
    return this.d.tresor.lies(n, wofuer);
  }
}
