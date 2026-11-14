/**
 * Skill pki_lab — PKI Etappe 5, TLS-Negativtest-Lab (Spec Pos. 25, Owner 14.11.). Nur als Schritte freigegebener Changes und nur auf
 * Lab-Rechnern (Wächter in jedem Skript: keine Domäne, Name LAB…, Adresse in 10.203.32.0/28). Produktive CA, Sperrliste und
 * Truststores werden nie berührt.
 */
import { Skill } from '@alfred/skills';
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { kodiert, adErgebnis, clixmlFehler } from './windows-ad.js';
import { adKennwort } from './windows-ad-skill.js';
import {
  LAB_SUFFIX, LAB_CA_NAME, LAB_LOGIN, LAB_FAELLE, pruefeLabNamen, labNamenSkript, labCaSkript, labRootLesenSkript, labRootVertrauenSkript, labSqlInstallierenSkript,
  pruefeLabAusstellen, labAusstellenSkript, labSperrenSkript, labCrlDienstSkript, labBindenSkript, pruefeLabTest, labTestSkript, bewerteLabTest, labTestText, type LabBefund,
} from './pki-lab.js';

export interface PkiLabDeps {
  skript: (zugang: string, befehl: string, eingabe: string | undefined, timeoutMs: number, zweck: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  tresor?: { namen: () => Promise<Set<string>>; lies: (name: string, wofuer: string) => Promise<string>; setze: (name: string, wert: string, zweck: string) => Promise<void> };
  protokoll?: (msg: string, daten: Record<string, unknown>) => void;
}

export const LAB_AKTIONEN = ['lab_namen_setzen', 'lab_ca_einrichten', 'lab_root_vertrauen', 'lab_sql_installieren', 'lab_zertifikat_ausstellen', 'lab_zertifikat_sperren', 'lab_crl_dienst', 'lab_zertifikat_binden', 'tls_negativtest'] as const;
const ZUGANG = /^lab[a-z0-9-]{1,60}$/i;
const LAB_HOST = /^(?=.{3,80}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+pkilab\.test$/;
const TRESOR = /^pkilab-[a-z0-9-]{1,40}$/;
const THUMB = /^[0-9A-F]{40}$/;

export class PkiLabSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'pki_lab',
    category: 'infrastructure',
    description:
      'PKI-Lab für TLS-Negativtests (Spec Pos. 25): Wegwerf-Lab-CA und Test-SQL-Instanz ohne AG in einem isolierten Lab-VLAN (10.203.32.0/28, Namen <x>.pkilab.test). '
      + 'ALLE Aktionen NUR als Schritte freigegebener Changes und nur auf Lab-Rechnern (zugang lab…; jedes Skript bricht ab, wenn der Rechner in einer Domäne ist, nicht LAB… heißt oder keine Lab-Adresse hat). Produktive CA/Sperrliste/Truststores bleiben unberührt. '
      + 'lab_namen_setzen (zugang, eintraege [{name x.pkilab.test, ip}]) — hosts-Block und primäres DNS-Suffix pkilab.test; meldet „neustart“, dann reboot_vm. '
      + 'lab_ca_einrichten (zugang = Lab-Server, crl_host z. B. labsrv01.pkilab.test) — Standalone-Root „PKI-Lab Root CA“ ohne Freigabeordner, Sperrliste/Root über IIS http://<crl_host>/pki/, Anforderungen werden sofort ausgestellt, Firewall 80/1433; Ergebnis LAB_CA_READY. '
      + 'lab_root_vertrauen (zugang = Lab-Client, quelle = Lab-Server) — Lab-Root in LocalMachine\\Root des Clients; LAB_ROOT_TRUSTED. '
      + 'lab_sql_installieren (zugang = Lab-Server, konto_tresor Standard pkilab-sql) — Developer-Instanz MSSQLSERVER aus dem eingelegten SQL-ISO (proxmox attach_iso + reboot_vm vorher; setup.exe muss Microsoft-signiert sein), virtuelles Dienstkonto, Login alfredlab (Kennwort wird bei Bedarf erzeugt und im Tresor abgelegt), sa gesperrt; LAB_SQL_READY. '
      + 'lab_zertifikat_ausstellen (zugang = Lab-Server, art gueltig|selbstsigniert|kurzlebig, dns [x.pkilab.test], minuten 5–120 bei kurzlebig) — Fixture im Maschinenspeicher; LAB_CERT_ISSUED mit thumbprint. '
      + 'lab_zertifikat_binden (zugang = Lab-Server, thumbprint) — SQL-Bindung + ForceEncryption ohne Produktions-Gates, Neustart, geladenes Zertifikat aus dem Fehlerprotokoll; LAB_SQL_BOUND. '
      + 'lab_zertifikat_sperren (zugang = Lab-Server, thumbprint) — sperren, Sperrliste veröffentlichen, Seriennummer darin nachweisen; LAB_CERT_REVOKED. '
      + 'lab_crl_dienst (zugang = Lab-Server, an true|false, crl_host) — Webserver der Sperrliste starten/stoppen mit Abrufprobe; LAB_CRL_ONLINE / LAB_CRL_OFFLINE. '
      + `tls_negativtest (zugang = Lab-Client, ziel x.pkilab.test, fall ${LAB_FAELLE.join('|')}, erwarteter_thumbprint = Fixture, konto_tresor Standard pkilab-sql) — leert den Sperrlisten-Zwischenspeicher des Clients, holt per TDS das vorgelegte Zertifikat, prüft Kette online und meldet sich mit Encrypt=True/TrustServerCertificate=False an; Ergebnis LAB_TLS_OK (gueltig) bzw. EXPECTED_TLS_FAILURE mit dem passenden Grund — nie aus einem bloßen Verbindungsfehler. `
      + 'Fälle: falscher_name = gültiges Fixture, aber ziel ist ein Alias, der nicht im SAN steht; crl_unerreichbar = gültiges Fixture bei gestopptem Sperrlisten-Webserver; abgelaufen = kurzlebiges Fixture nach Ablauf.',
    riskLevel: 'admin',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...LAB_AKTIONEN] },
        zugang: { type: 'string', description: 'Fernzugang des Lab-Rechners (lab…)' },
        quelle: { type: 'string', description: 'lab_root_vertrauen: Fernzugang des Lab-Servers mit der Lab-CA' },
        eintraege: { type: 'array', items: { type: 'object' }, description: 'lab_namen_setzen: [{ name: x.pkilab.test, ip: 10.203.32.x }]' },
        crl_host: { type: 'string', description: 'lab_ca_einrichten/lab_crl_dienst: DNS-Name des Lab-Servers (x.pkilab.test)' },
        art: { type: 'string', enum: ['gueltig', 'selbstsigniert', 'kurzlebig'] },
        dns: { type: 'array', items: { type: 'string' }, description: 'lab_zertifikat_ausstellen: Namen im SAN (x.pkilab.test)' },
        minuten: { type: 'number', description: 'lab_zertifikat_ausstellen art=kurzlebig: Laufzeit 5–120 min' },
        thumbprint: { type: 'string' },
        an: { type: 'boolean' },
        ziel: { type: 'string', description: 'tls_negativtest: Name des Servers (x.pkilab.test)' },
        fall: { type: 'string', enum: [...LAB_FAELLE] },
        erwarteter_thumbprint: { type: 'string' },
        konto_tresor: { type: 'string', description: 'Tresor-Eintrag mit dem Kennwort des Lab-Logins (Standard pkilab-sql)' },
      },
      required: ['action', 'zugang'],
    },
  };

  constructor(private readonly d: PkiLabDeps) { super(); }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = String(input.action ?? '');
    if (!(LAB_AKTIONEN as readonly string[]).includes(action)) return { success: false, error: `Unbekannte Aktion ${action}` };
    if (context.ausChange !== true) return { success: false, error: `${action} läuft nur als Schritt eines freigegebenen Changes — mit infrastruktur changes_planen planen` };
    const zugang = String(input.zugang ?? '').trim();
    if (!ZUGANG.test(zugang)) return { success: false, error: 'zugang: Fernzugang eines Lab-Rechners (lab…)' };
    const pr = <T>(x: T | string): T => { if (typeof x === 'string') throw new Error(x); return x; };
    const host = (k: string) => { const h = String(input[k] ?? '').trim().toLowerCase(); if (!LAB_HOST.test(h)) throw new Error(`${k}: Lab-Name <x>.${LAB_SUFFIX}`); return h; };
    const thumb = () => { const t = String(input.thumbprint ?? '').replace(/\s/g, '').toUpperCase(); if (!THUMB.test(t)) throw new Error('thumbprint: 40 Hex'); return t; };
    try {
      switch (action) {
        case 'lab_namen_setzen': {
          const r = await this.lauf<{ rechner: string; suffixVorher: string; suffix: string; neustart: boolean; aufgeloest: Array<{ name: string; ip: string }> }>(zugang, labNamenSkript(pr(pruefeLabNamen(input))), 'Lab-Namen setzen', 120_000);
          return { success: true, data: r, display: `✅ LAB_NAMES_SET ${r.rechner}: ${r.aufgeloest.map(x => `${x.name} → ${x.ip || '—'}`).join(', ')}; DNS-Suffix ${r.suffixVorher || '—'} → ${r.suffix}${r.neustart ? ' — wirksam erst nach reboot_vm' : ''}` };
        }
        case 'lab_ca_einrichten': {
          const r = await this.lauf<{ zustand: string; rechner: string; ca: string; thumbprint: string; bis: string; crl: string[]; crlUrl: string; neustartNoetig: boolean }>(zugang, labCaSkript({ crl_host: host('crl_host') }), 'Lab-CA einrichten', 2_100_000);
          this.d.protokoll?.('PKI-Lab CA', { zugang, thumbprint: r.thumbprint, zustand: r.zustand });
          return { success: true, data: r, display: `✅ LAB_CA_READY „${r.ca}“ auf ${r.rechner} (${r.zustand}): Root ${r.thumbprint} bis ${r.bis}, Sperrliste ${r.crl.join(', ') || '—'} unter ${r.crlUrl}${r.neustartNoetig ? ' — Windows meldet Neustart nötig (reboot_vm)' : ''}` };
        }
        case 'lab_root_vertrauen': {
          const quelle = String(input.quelle ?? '').trim();
          if (!ZUGANG.test(quelle)) throw new Error('quelle: Fernzugang des Lab-Servers (lab…)');
          const root = await this.lauf<{ thumbprint: string; subjekt: string; base64: string }>(quelle, labRootLesenSkript(), 'Lab-Root lesen', 60_000);
          if (root.subjekt !== `CN=${LAB_CA_NAME}`) throw new Error(`${quelle} liefert ${root.subjekt} statt CN=${LAB_CA_NAME}`);
          const r = await this.lauf<{ rechner: string; thumbprint: string; zustand: string }>(zugang, labRootVertrauenSkript({ thumbprint: root.thumbprint }), 'Lab-Root vertrauen', 60_000, { base64: root.base64 });
          return { success: true, data: r, display: `✅ LAB_ROOT_TRUSTED ${r.rechner}: ${LAB_CA_NAME} ${r.thumbprint} (${r.zustand}) — nur im Lab-Client` };
        }
        case 'lab_sql_installieren': {
          const kw = await this.kennwort(input, true);
          const r = await this.lauf<{ rechner: string; zustand: string; code: number; summary: string[]; signiert: string; login: string; sql: { version: string; edition: string; hadr: number; saGesperrt: boolean } }>(zugang, labSqlInstallierenSkript(), 'Lab-SQL installieren', 6_000_000, { kennwort: kw.wert });
          this.d.protokoll?.('PKI-Lab SQL', { zugang, zustand: r.zustand, version: r.sql?.version });
          if (!r.sql?.saGesperrt) throw new Error('sa nach der Installation nicht gesperrt');
          return { success: true, data: r, display: `✅ LAB_SQL_READY ${r.rechner}: ${r.sql.edition} ${r.sql.version} (${r.zustand === 'schon' ? 'schon installiert' : `installiert, Exit ${r.code}`}), ohne AG (HADR ${r.sql.hadr}), Login ${r.login} (Kennwort im Tresor ${kw.name}${kw.neu ? ', neu erzeugt' : ''}), sa gesperrt${r.signiert ? `; setup.exe signiert von ${r.signiert.replace(/,.*$/, '')}` : ''}` };
        }
        case 'lab_zertifikat_ausstellen': {
          const r = await this.lauf<{ rechner: string; art: string; thumbprint: string; seriennummer: string; subjekt: string; aussteller: string; sans: string[]; von: string; bis: string }>(zugang, labAusstellenSkript(pr(pruefeLabAusstellen(input))), 'Lab-Zertifikat ausstellen', 900_000);
          return { success: true, data: r, display: `✅ LAB_CERT_ISSUED ${r.art} auf ${r.rechner}: ${r.thumbprint} ${r.subjekt} (Aussteller ${r.aussteller}, Seriennummer ${r.seriennummer}, SAN ${r.sans.join(',')}, ${r.von} – ${r.bis})` };
        }
        case 'lab_zertifikat_binden': {
          const r = await this.lauf<{ rechner: string; vorher: string; thumbprint: string; geladen: string; neustart: string; bis: string }>(zugang, labBindenSkript({ thumbprint: thumb() }), 'Lab-Bindung', 600_000);
          return { success: true, data: r, display: `✅ LAB_SQL_BOUND ${r.rechner}: SQL hat ${r.geladen} geladen (ForceEncryption 1, Neustart ${r.neustart}; vorher ${r.vorher || '—'}; Zertifikat gültig bis ${r.bis})` };
        }
        case 'lab_zertifikat_sperren': {
          const r = await this.lauf<{ rechner: string; thumbprint: string; seriennummer: string; crl: string; crlNummer: string }>(zugang, labSperrenSkript({ thumbprint: thumb() }), 'Lab-Zertifikat sperren', 600_000);
          return { success: true, data: r, display: `✅ LAB_CERT_REVOKED ${r.thumbprint} (Seriennummer ${r.seriennummer}) auf ${r.rechner}: in der veröffentlichten Sperrliste ${r.crl} (Nummer ${r.crlNummer || '—'})` };
        }
        case 'lab_crl_dienst': {
          if (typeof input.an !== 'boolean') throw new Error('an: true oder false');
          const r = await this.lauf<{ rechner: string; webserver: string; url: string; http: number; fehler: string }>(zugang, labCrlDienstSkript({ an: input.an, crl_host: host('crl_host') }), 'Lab-Sperrliste schalten', 120_000);
          return { success: true, data: r, display: `✅ ${input.an ? 'LAB_CRL_ONLINE' : 'LAB_CRL_OFFLINE'} ${r.rechner}: Webserver ${r.webserver}, ${r.url} → ${r.http ? `HTTP ${r.http}` : `nicht abrufbar (${r.fehler.slice(0, 120)})`}` };
        }
        case 'tls_negativtest': {
          const t = pr(pruefeLabTest(input));
          const kw = await this.kennwort(input, false);
          const b = await this.lauf<LabBefund>(zugang, labTestSkript(t), `TLS-Negativtest ${t.fall}`, 300_000, { kennwort: kw.wert });
          const e = bewerteLabTest(t, b);
          const text = labTestText(t, b, e);
          this.d.protokoll?.('PKI-Lab TLS-Test', { zugang, fall: t.fall, ergebnis: e.ergebnis, kette: b.probe.kettenStatus, treiber: b.anmeldung?.fehler ? 'abgelehnt' : 'verbunden' });
          return e.ok ? { success: true, data: { ...b, ergebnis: e.ergebnis, grund: e.grund }, display: text } : { success: false, data: { ...b, ergebnis: e.ergebnis, befunde: e.befunde }, error: text };
        }
      }
      return { success: false, error: `Unbekannte Aktion ${action}` };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  private async kennwort(input: Record<string, unknown>, erzeugen: boolean): Promise<{ name: string; wert: string; neu: boolean }> {
    const name = String(input.konto_tresor ?? 'pkilab-sql').trim();
    if (!TRESOR.test(name)) throw new Error('konto_tresor: Tresor-Eintrag pkilab-… (Standard pkilab-sql)');
    if (!this.d.tresor) throw new Error('Tresor nicht verfügbar');
    if ((await this.d.tresor.namen()).has(name)) return { name, wert: await this.d.tresor.lies(name, `Kennwort des Lab-Logins ${LAB_LOGIN} (PKI-Lab)`), neu: false };
    if (!erzeugen) throw new Error(`Tresor-Eintrag ${name} gibt es nicht — zuerst lab_sql_installieren`);
    const wert = adKennwort();
    await this.d.tresor.setze(name, wert, `Kennwort des SQL-Logins ${LAB_LOGIN} der Test-Instanz im PKI-Lab (Wegwerf)`);
    return { name, wert, neu: true };
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
}
