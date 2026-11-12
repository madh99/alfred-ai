/**
 * Skill windows_pki (Vorhaben 3bb8c058) — v1810 Etappe 1: status (lesend), online über SSH (zugang) oder für die netzlose
 * Offline-Root über den QEMU-Gastagenten (vmid + vm_name). Ändernde Bausteine folgen in Etappe 2 (nur in Changes).
 */
import { Skill } from '@alfred/skills';
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { kodiert, adErgebnis, clixmlFehler } from './windows-ad.js';
import { pkiStatusSkript, pkiStatusText, type PkiStatus, pruefeRoot, rootInitSkript, featuresSkript, featuresEntfernenSkript, artefakteSkript, type PkiArtefakte,
  pruefePublikation, publikationSkript, crlSkript, pruefeIssuer, issuerAnfordernSkript, pruefeSignieren, signierenSkript, type Signiert, pruefeAktivieren, aktivierenSkript } from './windows-pki.js';
import { KONTO_FREI } from './windows-ad.js';

export interface WindowsPkiDeps {
  skript: (zugang: string, befehl: string, eingabe: string | undefined, timeoutMs: number, zweck: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  gast?: (vmid: number, vmName: string, skript: string, eingabe: string | undefined, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;
  tresor?: { namen: () => Promise<Set<string>>; lies: (name: string, wofuer: string) => Promise<string> };
}

export const PKI_LESEND = new Set(['status', 'artefakte_lesen']);
/** nur als Schritte freigegebener Changes */
export const PKI_AENDERND = new Set(['features_installieren', 'features_entfernen', 'root_initialisieren', 'publication_setzen', 'crl_erzeugen', 'issuer_anfordern', 'subordinate_signieren', 'issuer_aktivieren']);
const ZUGANG = /^[a-z0-9][a-z0-9.-]{0,62}$/i;
const VM_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export class WindowsPkiSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'windows_pki',
    category: 'infrastructure',
    description:
      'Eigene PKI (Vorhaben 3bb8c058: Offline-Root pkiroot01 ohne Netz + Enterprise-Issuing-CA pkiiss01) über feste PowerShell-Bausteine. '
      + 'status (lesend, auch außerhalb von Changes): entweder zugang = Windows-Fernzugang (Issuing-CA, Domänenmitglied) ODER vmid + vm_name für die netzlose Offline-Root (über den QEMU-Gastagenten, nie über ein Netz) — '
      + 'Rolle ADCS-Cert-Authority, Dienst CertSvc, CA-Name und -Typ, Zertifikat (Schlüssel, Signatur, pathLen, Laufzeit, Kette, privater Schlüssel, Thumbprint), CRL-Periode/Überlappung/Delta, CDP/AIA, CRL-Dateien, Domäne/Workgroup und Zahl der Netzwerkkarten. '
      + 'Ergebnis beginnt mit „PKI_STATUS_OK“, sobald eine CA eingerichtet ist; vorher „keine CA“ bzw. „Rolle installiert, keine CA eingerichtet“. Offline-Ergebnisse tragen die Erhebungszeit. '
      + 'artefakte_lesen (lesend; zugang oder vmid + vm_name) — CA-Zertifikat (DER Base64, SHA-256, Thumbprint) und neueste Basis-CRL (Base64, SHA-256, Nummer, ThisUpdate/NextUpdate) für die hashgeprüfte Übertragung; im Text nur Hashes, die Base64-Daten stehen in data. '
      + 'NUR als Schritte freigegebener Changes: features_installieren (zugang oder vmid + vm_name) — Rolle ADCS-Cert-Authority ohne Web Enrollment/NDES (ohne Rückweg nur, solange keine CA; Rückweg features_entfernen, verweigert bei eingerichteter CA). '
      + 'root_initialisieren (NUR vmid + vm_name über den Gastagenten; ca_name z. B. „AD3033 Root CA“, key_bits 4096, hash SHA256, validity_years 20, path_length 1, crl_wochen 26, crl_ueberlappung_wochen 4, ausgestellt_jahre 10) — bricht ab bei Netzwerkkarte, Domänenmitgliedschaft oder anderer vorhandener CA; Standalone Root mit CAPolicy.inf (pathLen kritisch, kein CDP/AIA im Root-Zertifikat), CRL-Fristen, Laufzeit ausgestellter Zertifikate, erste CRL; wiederholbar („schon“); OHNE Rückweg (CA-Identität), Stilllegung ist ein eigener Change. Ergebnis „ROOT_CA_READY“ mit Fingerprint aus dem anschließenden Status. '
      + 'publication_setzen (zugang oder vmid + vm_name; datei_name z. B. ad3033-root, http_basis http://pki.ad.3033.at/pki/, unc_ziel optional \\\\fs01.ad.3033.at\\pki$\\ für die automatische CRL-Ablage der Issuing-CA; optional crl_einheit Hours|Days|Weeks + crl_anzahl, ueberlappung_einheit + ueberlappung_anzahl) — CDP/AIA nur lokal + HTTP (kein LDAP), Dienstneustart, neue CRL; Ergebnis nennt vorher/nachher; Rückweg publication_setzen mit cdp_roh/aia_roh = gemeldetes vorher. VOR subordinate_signieren auf der Root setzen, sonst stehen falsche CDP/AIA im Issuing-Zertifikat. '
      + 'crl_erzeugen (zugang oder vmid + vm_name) — neue Basis-CRL (CRL-Nummern steigen nur; ohne Rückweg). '
      + 'issuer_anfordern (zugang = Issuing-CA, Domänenmitglied; ca_name z. B. „AD3033 Issuing CA 1“, key_bits 4096, hash SHA256; konto_tresor Standard win-dc01-admin = Kennwort des Domänen-Administrators/Enterprise Admins) — Enterprise Subordinate bis zur Anforderung, CAPolicy pathLen 0 kritisch, keine Standardvorlagen; wiederholbar mit DERSELBEN Anforderung; Ergebnis „ISSUER_CSR_READY“ mit csrSha256, csrBase64 in data. '
      + 'subordinate_signieren (NUR vmid + vm_name der Root; csr_base64 und erwartet_csr_sha256 aus issuer_anfordern, erwartet_subject = CA-Name der Issuing-CA) — hashgeprüft einreichen, ausstellen, abholen; prüft Aussteller, Subject und pathLen 0; wiederholbar ohne zweite Ausstellung; Ergebnis „ISSUER_CERT_SIGNED“ mit Zertifikat-, Root- und Root-CRL-Hashes (Base64 in data); ohne Rückweg (Widerruf ist ein eigener Vorgang). '
      + 'issuer_aktivieren (zugang = Issuing-CA; zert_base64, root_base64, crl_base64 und erwartet_zert_sha256, erwartet_root_sha256, erwartet_crl_sha256 aus subordinate_signieren) — Root und Root-CRL hashgeprüft in LocalMachine\\Root, CA-Zertifikat installieren, Dienst starten; Ergebnis „ISSUER_CA_READY“ mit Status (EnterpriseSubordinate, pathLen 0, Kette ok); ohne Rückweg (Stilllegung eigener Change).',
    riskLevel: 'admin',
    version: '1.0.0',
    timeoutMs: 600_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...PKI_LESEND, ...PKI_AENDERND] },
        zugang: { type: 'string', description: 'Windows-Fernzugang (z. B. pkiiss01)' },
        vmid: { type: 'number', description: 'netzlose Offline-Root: VMID (Gastagent)' },
        vm_name: { type: 'string', description: 'netzlose Offline-Root: erwarteter VM-Name (Schutz vor falscher VMID), z. B. pkiroot01' },
        ca_name: { type: 'string' }, key_bits: { type: 'number' }, hash: { type: 'string' }, validity_years: { type: 'number' }, path_length: { type: 'number' },
        crl_wochen: { type: 'number' }, crl_ueberlappung_wochen: { type: 'number' }, ausgestellt_jahre: { type: 'number' },
        datei_name: { type: 'string' }, http_basis: { type: 'string' }, unc_ziel: { type: 'string' }, cdp_roh: { type: 'array', items: { type: 'string' } }, aia_roh: { type: 'array', items: { type: 'string' } },
        crl_einheit: { type: 'string' }, crl_anzahl: { type: 'number' }, ueberlappung_einheit: { type: 'string' }, ueberlappung_anzahl: { type: 'number' },
        konto_tresor: { type: 'string' }, ausfuehrungskonto: { type: 'string' },
        csr_base64: { type: 'string' }, erwartet_csr_sha256: { type: 'string' }, erwartet_subject: { type: 'string' },
        zert_base64: { type: 'string' }, root_base64: { type: 'string' }, crl_base64: { type: 'string' }, erwartet_zert_sha256: { type: 'string' }, erwartet_root_sha256: { type: 'string' }, erwartet_crl_sha256: { type: 'string' },
      },
      required: ['action'],
    },
  };

  constructor(private readonly d: WindowsPkiDeps) { super(); }

  async execute(input: Record<string, unknown>, context?: SkillContext): Promise<SkillResult> {
    const action = String(input.action ?? '');
    if (!PKI_LESEND.has(action) && !PKI_AENDERND.has(action)) return { success: false, error: `Unbekannte Aktion ${action}` };
    if (PKI_AENDERND.has(action) && (context as { ausChange?: boolean } | undefined)?.ausChange !== true) return { success: false, error: `${action} läuft nur als Schritt eines freigegebenen Changes` };
    try {
      switch (action) {
        case 'status': {
          const { r, weg } = await this.lauf<PkiStatus>(input, pkiStatusSkript(), 'PKI-Status', 180_000);
          return { success: true, data: { ...r, weg }, display: pkiStatusText(r, weg) };
        }
        case 'artefakte_lesen': {
          const { r, weg } = await this.lauf<PkiArtefakte>(input, artefakteSkript(), 'PKI-Artefakte', 180_000);
          return { success: true, data: { ...r, weg }, display: `Artefakte „${r.ca}“ (${weg}): Zertifikat ${r.zertifikat.subject}, Thumbprint ${r.zertifikat.thumbprint}, SHA-256 ${r.zertifikat.sha256}, bis ${r.zertifikat.bis}; ${r.crl ? `CRL ${r.crl.datei} Nummer ${r.crl.nummer || '?'}, SHA-256 ${r.crl.sha256}, ThisUpdate ${r.crl.thisUpdate || '?'}, NextUpdate ${r.crl.nextUpdate || '?'}` : 'keine CRL-Datei'}` };
        }
        case 'features_installieren': {
          const { r, weg } = await this.lauf<{ zustand: string; vorher: boolean; nachher: boolean; neustart: boolean }>(input, featuresSkript(), 'AD-CS-Rolle installieren', 1_200_000);
          return { success: true, data: { ...r, weg }, display: `✅ PKI_FEATURES_READY: ADCS-Cert-Authority ${r.zustand} (vorher ${r.vorher ? 'da' : 'nicht da'}, nachher ${r.nachher ? 'da' : 'FEHLT'}${r.neustart ? ', Neustart nötig' : ''}) — Rückweg features_entfernen (nur ohne eingerichtete CA)` };
        }
        case 'features_entfernen': {
          const { r } = await this.lauf<{ zustand: string; neustart?: boolean }>(input, featuresEntfernenSkript(), 'AD-CS-Rolle entfernen', 1_200_000);
          return { success: true, data: r, display: `✅ ADCS-Cert-Authority ${r.zustand}${r.neustart ? ' (Neustart nötig)' : ''}` };
        }
        case 'root_initialisieren': {
          if (input.zugang !== undefined) return { success: false, error: 'root_initialisieren nur über den Gastagenten (vmid + vm_name) — die Offline-Root hat kein Netz' };
          const rp = pruefeRoot(input);
          if (typeof rp === 'string') return { success: false, error: rp };
          const { r } = await this.lauf<{ zustand: string; ca: string; dienst: string }>(input, rootInitSkript(rp), 'Offline-Root anlegen', 1_200_000);
          const { r: st } = await this.lauf<PkiStatus>(input, pkiStatusSkript(), 'PKI-Status', 180_000);
          const z = st.ca?.zertifikat;
          const ok = !!z && st.ca?.typ === 'StandaloneRoot' && z.pathLen === String(rp.path_length) && z.privaterSchluessel && z.ketteOk && st.netzwerkkarten.length === 0 && !st.domaene;
          const text = `${ok ? '✅ ROOT_CA_READY' : 'ROOT-CA NICHT wie verlangt'} (${r.zustand}): ${pkiStatusText(st, 'gastagent')}`;
          return ok ? { success: true, data: { ...r, status: st }, display: text } : { success: false, data: { ...r, status: st }, error: text };
        }
        case 'publication_setzen': {
          const pb = pruefePublikation(input);
          if (typeof pb === 'string') return { success: false, error: pb };
          const { r } = await this.lauf<{ ca: string; vorher: { cdp: string[]; aia: string[] }; nachher: { cdp: string[]; aia: string[] }; dienst: string; crlExit: number }>(input, publikationSkript(pb), 'CDP/AIA setzen', 600_000);
          const gleich = JSON.stringify(r.nachher) === JSON.stringify({ cdp: pb.cdp, aia: pb.aia });
          const text = `${gleich && r.dienst === 'Running' && r.crlExit === 0 ? '✅ PKI_PUBLICATION_CONFIG_OK' : 'CDP/AIA NICHT wie verlangt'} „${r.ca}“: CDP ${r.nachher.cdp.join(' | ')}; AIA ${r.nachher.aia.join(' | ')}; Dienst ${r.dienst}, CRL-Exit ${r.crlExit} — Rückweg publication_setzen cdp_roh ${JSON.stringify(r.vorher.cdp)} aia_roh ${JSON.stringify(r.vorher.aia)}`;
          return gleich && r.dienst === 'Running' && r.crlExit === 0 ? { success: true, data: r, display: text } : { success: false, data: r, error: text };
        }
        case 'crl_erzeugen': {
          const { r } = await this.lauf<{ zustand: string; zeit: string }>(input, crlSkript(), 'CRL ausstellen', 300_000);
          const { r: a } = await this.lauf<PkiArtefakte>(input, artefakteSkript(), 'PKI-Artefakte', 180_000);
          return { success: true, data: { ...r, crl: a.crl ? { ...a.crl, base64: undefined } : null }, display: `✅ CRL_VALID „${a.ca}“: ${a.crl ? `${a.crl.datei} Nummer ${a.crl.nummer || '?'}, ThisUpdate ${a.crl.thisUpdate || '?'}, NextUpdate ${a.crl.nextUpdate || '?'}, SHA-256 ${a.crl.sha256}` : 'keine CRL-Datei gefunden'}` };
        }
        case 'issuer_anfordern': {
          if (input.vmid !== undefined) return { success: false, error: 'issuer_anfordern nur über den Fernzugang der Issuing-CA (zugang)' };
          const ip = pruefeIssuer(input);
          if (typeof ip === 'string') return { success: false, error: ip };
          const konto = String(input.ausfuehrungskonto ?? '').trim();
          if (konto && !KONTO_FREI.test(konto)) return { success: false, error: 'ausfuehrungskonto: „name“ oder „NETBIOS\\name“' };
          const kw = await this.kennwort(input.konto_tresor ?? 'win-dc01-admin', `Issuing-CA ${String(input.zugang)} anfordern (Enterprise Admin)`);
          const { r } = await this.lauf<{ zustand: string; ca: string; csrBase64: string; csrSha256: string; datei: string; domaene: string }>(input, issuerAnfordernSkript({ ...ip, ...(konto ? { ausKonto: konto } : {}) }), 'Issuing-CA anfordern', 1_200_000, { kennwort: kw });
          return { success: true, data: r, display: `✅ ISSUER_CSR_READY „${r.ca}“ (${r.zustand}, Domäne ${r.domaene}): Anforderung SHA-256 ${r.csrSha256}, ${r.csrBase64.length} Zeichen Base64 in data.csrBase64, Datei ${r.datei}` };
        }
        case 'subordinate_signieren': {
          if (input.zugang !== undefined) return { success: false, error: 'subordinate_signieren nur auf der Offline-Root über den Gastagenten (vmid + vm_name)' };
          const sp = pruefeSignieren(input);
          if (typeof sp === 'string') return { success: false, error: sp };
          const { r } = await this.lauf<Signiert>(input, signierenSkript(sp), 'Issuing-CA signieren', 600_000, { csr_base64: String(input.csr_base64) });
          if (!r.rootCrl) return { success: false, data: r, error: 'Root hat keine CRL-Datei — erst crl_erzeugen/publication_setzen auf der Root' };
          const z = r.zertifikat;
          return { success: true, data: r, display: `✅ ISSUER_CERT_SIGNED (${r.zustand}): ${z.subject} von ${z.aussteller}, Seriennummer ${z.seriennummer}, pathLen ${z.pathLen}, ${z.von} – ${z.bis}; Zertifikat SHA-256 ${z.sha256}; Root SHA-256 ${r.root.sha256}; Root-CRL ${r.rootCrl.datei} SHA-256 ${r.rootCrl.sha256}; CDP ${z.cdp || '—'}; AIA ${z.aia || '—'}` };
        }
        case 'issuer_aktivieren': {
          if (input.vmid !== undefined) return { success: false, error: 'issuer_aktivieren nur über den Fernzugang der Issuing-CA (zugang)' };
          const ap = pruefeAktivieren(input);
          if (typeof ap === 'string') return { success: false, error: ap };
          const { r } = await this.lauf<{ zustand: string; ca: string; thumbprint: string }>(input, aktivierenSkript(ap), 'Issuing-CA aktivieren', 600_000, { zert_base64: String(input.zert_base64), root_base64: String(input.root_base64), crl_base64: String(input.crl_base64) });
          const { r: st } = await this.lauf<PkiStatus>(input, pkiStatusSkript(), 'PKI-Status', 180_000);
          const z = st.ca?.zertifikat;
          const ok = !!z && st.ca?.typ === 'EnterpriseSubordinate' && z.pathLen === '0' && z.ketteOk && z.privaterSchluessel && st.dienst === 'Running' && z.thumbprint === r.thumbprint;
          const text = `${ok ? '✅ ISSUER_CA_READY' : 'ISSUING-CA NICHT wie verlangt'} (${r.zustand}): ${pkiStatusText(st, 'ssh')}`;
          return ok ? { success: true, data: { ...r, status: st }, display: text } : { success: false, data: { ...r, status: st }, error: text };
        }
      }
      return { success: false, error: `Unbekannte Aktion ${action}` };
    } catch (err) { return { success: false, error: (err as Error).message }; }
  }

  private async kennwort(name: unknown, wofuer: string): Promise<string> {
    const n = String(name ?? '').trim();
    if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(n)) throw new Error('konto_tresor: Tresor-Eintrag mit dem Kennwort (z. B. win-dc01-admin)');
    if (!this.d.tresor) throw new Error('Tresor nicht verfügbar');
    if (!(await this.d.tresor.namen()).has(n)) throw new Error(`Tresor-Eintrag ${n} gibt es nicht`);
    return this.d.tresor.lies(n, wofuer);
  }

  /** Online über SSH (zugang) oder offline über den Gastagenten (vmid + vm_name) — nie beides */
  private async lauf<T>(input: Record<string, unknown>, skript: string, zweck: string, timeoutMs: number, eingabe?: Record<string, string>): Promise<{ r: T; weg: 'ssh' | 'gastagent' }> {
    const zugang = input.zugang === undefined ? '' : String(input.zugang).trim();
    const hatVm = input.vmid !== undefined;
    if (!!zugang === hatVm) throw new Error('entweder zugang (Fernzugang) ODER vmid + vm_name (netzlose VM über den Gastagenten) angeben');
    let roh: { code: number; stdout: string; stderr: string }; let wo: string; let weg: 'ssh' | 'gastagent';
    if (zugang) {
      if (!ZUGANG.test(zugang)) throw new Error('zugang: Name des Windows-Fernzugangs');
      roh = await this.d.skript(zugang, kodiert(skript), eingabe ? JSON.stringify(eingabe) : undefined, timeoutMs, zweck); wo = zugang; weg = 'ssh';
    } else {
      const vmid = Number(input.vmid); const name = String(input.vm_name ?? '').trim();
      if (!Number.isInteger(vmid) || vmid < 100) throw new Error('vmid: VMID der netzlosen VM');
      if (!VM_NAME.test(name)) throw new Error('vm_name: erwarteter VM-Name (Pflicht beim Gastagenten)');
      if (!this.d.gast) throw new Error('Gastagent nicht verfügbar (Proxmox-Skill fehlt)');
      roh = await this.d.gast(vmid, name, skript, eingabe ? JSON.stringify(eingabe) : undefined, timeoutMs); wo = `${name} (VM ${vmid}, Gastagent)`; weg = 'gastagent';
    }
    const e = adErgebnis<T>(roh.stdout);
    if (roh.code !== 0 || !e) {
      const klar = `${roh.stderr}\n${roh.stdout}`.split(/\r?\n/).filter(z => z.trim() && !z.startsWith('#< CLIXML') && !z.startsWith('<Objs')).join(' ');
      throw new Error(`${zweck} auf ${wo} gescheitert (Exit ${roh.code}): ${`${klar} ${clixmlFehler(`${roh.stderr}\n${roh.stdout}`)}`.replace(/\s+/g, ' ').trim().slice(-600) || 'keine Ausgabe'}`);
    }
    return { r: e, weg };
  }
}
