/**
 * Skill windows_pki (Vorhaben 3bb8c058) — v1810 Etappe 1: status (lesend), online über SSH (zugang) oder für die netzlose
 * Offline-Root über den QEMU-Gastagenten (vmid + vm_name). Ändernde Bausteine folgen in Etappe 2 (nur in Changes).
 */
import { Skill } from '@alfred/skills';
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { kodiert, adErgebnis, clixmlFehler } from './windows-ad.js';
import { pkiStatusSkript, pkiStatusText, type PkiStatus, pruefeRoot, rootInitSkript, featuresSkript, featuresEntfernenSkript, artefakteSkript, type PkiArtefakte,
  pruefePublikation, publikationSkript, crlSkript, pruefeIssuer, issuerAnfordernSkript, pruefeSignieren, signierenSkript, type Signiert, pruefeAktivieren, aktivierenSkript,
  pruefeWeb, webSkript, webEntfernenSkript, pruefeAblage, ablageSkript, abrufSkript, adVeroeffentlichenSkript, trustAktualisierenSkript, trustPruefenSkript,
  pruefeSicherungsziel, caSicherungSkript, caSicherungStatusSkript, caSatzPackenSkript, caSatzAblegenSkript, CA_SATZ } from './windows-pki.js';
import { KONTO_FREI } from './windows-ad.js';

export interface WindowsPkiDeps {
  skript: (zugang: string, befehl: string, eingabe: string | undefined, timeoutMs: number, zweck: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  gast?: (vmid: number, vmName: string, skript: string, eingabe: string | undefined, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;
  tresor?: { namen: () => Promise<Set<string>>; lies: (name: string, wofuer: string) => Promise<string> };
}

export const PKI_LESEND = new Set(['status', 'artefakte_lesen', 'publication_pruefen', 'trust_pruefen', 'ca_sicherung_status']);
/** nur als Schritte freigegebener Changes */
export const PKI_AENDERND = new Set(['features_installieren', 'features_entfernen', 'root_initialisieren', 'publication_setzen', 'crl_erzeugen', 'issuer_anfordern', 'subordinate_signieren', 'issuer_aktivieren', 'pki_web_einrichten', 'pki_web_entfernen', 'datei_ablegen', 'ad_veroeffentlichen', 'trust_aktualisieren', 'ca_sicherung', 'ca_sicherung_kopieren']);
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
      + 'issuer_aktivieren (zugang = Issuing-CA; zert_base64, root_base64, crl_base64 und erwartet_zert_sha256, erwartet_root_sha256, erwartet_crl_sha256 aus subordinate_signieren) — Root und Root-CRL hashgeprüft in LocalMachine\\Root, CA-Zertifikat installieren, Dienst starten; Ergebnis „ISSUER_CA_READY“ mit Status (EnterpriseSubordinate, pathLen 0, Kette ok); ohne Rückweg (Stilllegung eigener Change). '
      + 'pki_web_einrichten (zugang = fs01; host_header pki.ad.3033.at, pfad z. B. W:\\PKI — vorher windows_cluster freigabe_anlegen name pki$ mit aendern = Issuing-CA-Computerkonto; site Standard Alfred-PKI; alias optional z. B. pki = virtuelles Verzeichnis /pki auf denselben Ordner) — IIS nur statisch + Anforderungsfilter, eigene Site Port 80 mit Host-Header, kein Listing, MIME .crl/.crt, IUSR lesend; Witness$/SQLBackup$ unberührt; Rückweg pki_web_entfernen (site). Firewall-Freigabe TCP 80 und DNS pki.ad.3033.at sind eigene Schritte (windows_cluster firewall_regel, windows_ad dns_eintrag). '
      + 'datei_ablegen (zugang = fs01; ordner W:\\PKI, datei z. B. ad3033-root.crl/.crt passend zu datei_name, base64 + erwartet_sha256 aus artefakte_lesen bzw. subordinate_signieren) — hashgeprüft, ersetzt nie eine CRL durch eine ältere Nummer; meldet den vorherigen Hash. '
      + 'publication_pruefen (lesend; zugang = Client, z. B. sql01 oder pkiiss01; urls; erwartet optional {url: sha256}) — HTTP-Status ohne Umleitung, SHA-256, Typ, bei CRLs Nummer und NextUpdate; Ergebnis „PKI_PUBLICATION_VERIFIED“ nur bei 200 und passenden Hashes. '
      + 'ad_veroeffentlichen (zugang = Issuing-CA oder Mitglied mit RSAT; root_base64 + erwartet_root_sha256, optional sub_base64 + erwartet_sub_sha256, dcs = [dc01.ad.3033.at, dc02.ad.3033.at], konto_tresor Standard win-dc01-admin) — certutil -dspublish RootCA/SubCA als Enterprise Admin, NTAuth unverändert, keine CRL ins AD; Beleg je DC; Ergebnis „AD_PKI_PUBLISHED“. '
      + 'issuer_anfordern zusätzlich db_pfad/log_pfad (z. B. D:\\CertDB, D:\\CertLog; nicht C:). '
      + 'ca_sicherung (zugang oder vmid + vm_name; ziel_ordner auf der Sicherungsplatte z. B. B:\\CA-Sicherung; passwort_tresor = Tresor-Eintrag für das PKCS#12-Kennwort, z. B. pki-root-sicherung) — Backup-CARoleService (Datenbank + privater Schlüssel kennwortgeschützt), CA-Konfiguration, CAPolicy.inf, Manifest mit SHA-256; additiv, ohne Rückweg; Ergebnis „CA_BACKUP_VERIFIED“ erst nach Hash-Abgleich. '
      + 'ca_sicherung_status (lesend; zugang oder vmid + vm_name; ziel_ordner) — Sätze mit Alter und Hash-Abgleich. '
      + 'ca_sicherung_kopieren (Quelle zugang oder vmid + vm_name, ziel_ordner der Quelle, satz = ca-JJJJMMTT-HHMMSS aus ca_sicherung; ziel_zugang = anderer Windows-Fernzugang, ziel_ziel_ordner dort) — hashgeprüfte unabhängige Kopie (ZIP über Alfred, entpackt, Manifest nachgeprüft); additiv. '
      + 'trust_aktualisieren (zugang) — gpupdate Computer + certutil -pulse (additiv). trust_pruefen (lesend; zugang, root_thumbprints, zwischen_thumbprints) — Ergebnis „TRUST_APPLIED“ je Ziel nur, wenn alle Fingerprints in LocalMachine stehen.',
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
        host_header: { type: 'string' }, pfad: { type: 'string' }, site: { type: 'string' }, alias: { type: 'string', description: 'pki_web_einrichten: URL-Unterpfad, z. B. pki' }, ordner: { type: 'string' }, datei: { type: 'string' }, base64: { type: 'string' }, erwartet_sha256: { type: 'string' },
        urls: { type: 'array', items: { type: 'string' } }, erwartet: { type: 'object' }, dcs: { type: 'array', items: { type: 'string' } }, sub_base64: { type: 'string' }, erwartet_sub_sha256: { type: 'string' },
        ziel_ordner: { type: 'string' }, passwort_tresor: { type: 'string' }, satz: { type: 'string' }, ziel_zugang: { type: 'string' }, ziel_ziel_ordner: { type: 'string' },
        db_pfad: { type: 'string' }, log_pfad: { type: 'string' },
        root_thumbprints: { type: 'array', items: { type: 'string' } }, zwischen_thumbprints: { type: 'array', items: { type: 'string' } },
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
          const kw = await this.kennwort(input.konto_tresor ?? 'win-dc01-admin', `Issuing-CA ${String(input.zugang)} aktivieren (Domänen-Administrator)`);
          const { r } = await this.lauf<{ zustand: string; ca: string; thumbprint: string }>(input, aktivierenSkript(ap), 'Issuing-CA aktivieren', 600_000, { kennwort: kw, zert_base64: String(input.zert_base64), root_base64: String(input.root_base64), crl_base64: String(input.crl_base64) });
          const { r: st } = await this.lauf<PkiStatus>(input, pkiStatusSkript(), 'PKI-Status', 180_000);
          const z = st.ca?.zertifikat;
          const ok = !!z && st.ca?.typ === 'EnterpriseSubordinate' && z.pathLen === '0' && z.ketteOk && z.privaterSchluessel && st.dienst === 'Running' && z.thumbprint === r.thumbprint;
          const text = `${ok ? '✅ ISSUER_CA_READY' : 'ISSUING-CA NICHT wie verlangt'} (${r.zustand}): ${pkiStatusText(st, 'ssh')}`;
          return ok ? { success: true, data: { ...r, status: st }, display: text } : { success: false, data: { ...r, status: st }, error: text };
        }
        case 'pki_web_einrichten': {
          const w = pruefeWeb(input); if (typeof w === 'string') return { success: false, error: w };
          const { r } = await this.lauf<{ zustand: string; site: string; pfad: string; host: string; alias?: string; listing: string }>(input, webSkript(w), 'PKI-Webdienst', 1_200_000);
          const ok = /Started/i.test(r.site) && r.listing !== '200' && (!w.alias || Boolean(r.alias));
          const text = `${ok ? '✅ PKI_HTTP_READY' : 'PKI-Webdienst NICHT wie verlangt'} (${r.zustand}): ${r.site}; Stammverzeichnis ohne Listing (HTTP ${r.listing}); Ordner ${r.pfad}${r.alias ? `; Alias ${r.alias} → ${r.pfad} (PKI_ALIAS_READY)` : ''} — Rückweg pki_web_entfernen site ${w.site}`;
          return ok ? { success: true, data: r, display: text } : { success: false, data: r, error: text };
        }
        case 'pki_web_entfernen': {
          const site = String(input.site ?? 'Alfred-PKI'); if (!/^[A-Za-z][A-Za-z0-9-]{2,40}$/.test(site)) return { success: false, error: 'site: Name der IIS-Site' };
          const { r } = await this.lauf<{ zustand: string }>(input, webEntfernenSkript({ site }), 'PKI-Webdienst entfernen', 300_000);
          return { success: true, data: r, display: `✅ IIS-Site ${site} ${r.zustand}` };
        }
        case 'datei_ablegen': {
          const a = pruefeAblage(input); if (typeof a === 'string') return { success: false, error: a };
          const { r } = await this.lauf<{ zustand: string; datei: string; sha256: string; vorher: string }>(input, ablageSkript(a), 'Artefakt ablegen', 300_000, { base64: String(input.base64) });
          return { success: true, data: r, display: `✅ ${r.datei} ${r.zustand}, SHA-256 ${r.sha256}${r.vorher && r.vorher !== r.sha256 ? ` (vorher ${r.vorher})` : r.vorher ? '' : ' (neu)'}` };
        }
        case 'publication_pruefen': {
          const urls = (Array.isArray(input.urls) ? input.urls.map(String) : []).map(x => x.trim());
          if (!urls.length || urls.length > 10 || urls.some(x => !/^http:\/\/[a-z0-9.-]+\/[A-Za-z0-9._\/%()-]+\.(crl|crt)$/.test(x))) return { success: false, error: 'urls: 1–10 http-URLs auf .crl/.crt' };
          const erw: Record<string, string> = {};
          for (const [u2, h] of Object.entries((input.erwartet ?? {}) as Record<string, unknown>)) { if (urls.includes(u2) && /^[0-9a-f]{64}$/.test(String(h).toLowerCase())) erw[u2] = String(h).toLowerCase(); }
          const { r } = await this.lauf<{ rechner: string; zeit: string; abrufe: { url: string; status: number; sha256?: string; passt?: boolean; typ?: string; nummer?: string; nextUpdate?: string; fehler?: string }[] }>(input, abrufSkript({ urls, erwartet: erw }), 'PKI-Abruf', 180_000);
          const ok = r.abrufe.every(x => x.status === 200 && x.passt !== false);
          const text = `${ok ? 'PKI_PUBLICATION_VERIFIED' : 'PKI-Abruf NICHT ok'} von ${r.rechner} (${r.zeit}):\n${r.abrufe.map(x => `${x.url} → HTTP ${x.status}${x.sha256 ? `, SHA-256 ${x.sha256}${x.passt === undefined ? '' : x.passt ? ' (passt)' : ' (PASST NICHT)'}` : ''}${x.nummer ? `, CRL-Nummer ${x.nummer}, NextUpdate ${x.nextUpdate}` : ''}${x.fehler ? `, ${x.fehler}` : ''}`).join('\n')}`;
          return ok ? { success: true, data: r, display: text } : { success: false, data: r, error: text };
        }
        case 'ad_veroeffentlichen': {
          if (input.vmid !== undefined) return { success: false, error: 'ad_veroeffentlichen nur über einen Fernzugang in der Domäne' };
          const dcs = (Array.isArray(input.dcs) ? input.dcs.map(String) : []).map(x => x.trim().toLowerCase());
          if (!dcs.length || dcs.length > 6 || dcs.some(x => !/^[a-z0-9]([a-z0-9-]{0,62})(\.[a-z0-9-]{1,63})+$/.test(x))) return { success: false, error: 'dcs: FQDNs der DCs, z. B. [dc01.ad.3033.at, dc02.ad.3033.at]' };
          const rs = String(input.erwartet_root_sha256 ?? '').toLowerCase(); const ss = String(input.erwartet_sub_sha256 ?? '').toLowerCase();
          if (!/^[0-9a-f]{64}$/.test(rs) || typeof input.root_base64 !== 'string') return { success: false, error: 'root_base64 und erwartet_root_sha256 angeben' };
          const mitSub = input.sub_base64 !== undefined;
          if (mitSub && (!/^[0-9a-f]{64}$/.test(ss) || typeof input.sub_base64 !== 'string')) return { success: false, error: 'sub_base64 und erwartet_sub_sha256 zusammen angeben' };
          const konto = String(input.ausfuehrungskonto ?? '').trim();
          if (konto && !KONTO_FREI.test(konto)) return { success: false, error: 'ausfuehrungskonto: „name“ oder „NETBIOS\\name“' };
          const kw = await this.kennwort(input.konto_tresor ?? 'win-dc01-admin', `PKI im AD veröffentlichen (${String(input.zugang)})`);
          const { r } = await this.lauf<{ rootThumbprint: string; subThumbprint: string | null; belege: { dc: string; rootDa: boolean; subDa: boolean | null }[] }>(input, adVeroeffentlichenSkript({ dcs, erwartet_root_sha256: rs, mit_sub: mitSub, ...(mitSub ? { erwartet_sub_sha256: ss } : {}), ...(konto ? { ausKonto: konto } : {}) }), 'PKI im AD veröffentlichen', 600_000, { kennwort: kw, root_base64: String(input.root_base64), ...(mitSub ? { sub_base64: String(input.sub_base64) } : {}) });
          const ok = r.belege.length === dcs.length && r.belege.every(b => b.rootDa && b.subDa !== false);
          const text = `${ok ? '✅ AD_PKI_PUBLISHED' : 'AD-Veröffentlichung NICHT auf allen DCs belegt'}: Root ${r.rootThumbprint}${r.subThumbprint ? `, Issuing ${r.subThumbprint}` : ''}; ${r.belege.map(b => `${b.dc}: Root ${b.rootDa ? 'da' : 'FEHLT'}${b.subDa === null ? '' : `, AIA ${b.subDa ? 'da' : 'FEHLT'}`}`).join('; ')} — NTAuth unverändert`;
          return ok ? { success: true, data: r, display: text } : { success: false, data: r, error: text };
        }
        case 'trust_aktualisieren': {
          const { r } = await this.lauf<{ zustand: string; zeit: string }>(input, trustAktualisierenSkript(), 'Vertrauen nachladen', 300_000);
          return { success: true, data: r, display: `✅ Gruppenrichtlinie und Autoenrollment-Puls auf ${String(input.zugang ?? '')} ${r.zeit}` };
        }
        case 'trust_pruefen': {
          const fp = (v: unknown) => (Array.isArray(v) ? v.map(x => String(x).replace(/\s/g, '').toUpperCase()) : []);
          const root = fp(input.root_thumbprints); const zw = fp(input.zwischen_thumbprints);
          if (!root.length || [...root, ...zw].some(x => !/^[0-9A-F]{40}$/.test(x))) return { success: false, error: 'root_thumbprints (und optional zwischen_thumbprints): SHA-1-Thumbprints (40 Hex)' };
          const { r } = await this.lauf<{ rechner: string; zeit: string; root: { thumbprint: string; da: boolean }[]; zwischen: { thumbprint: string; da: boolean }[] }>(input, trustPruefenSkript({ root, zwischen: zw }), 'Vertrauen prüfen', 120_000);
          const ok = [...r.root, ...r.zwischen].every(x => x.da);
          const text = `${ok ? 'TRUST_APPLIED' : 'Vertrauen NICHT vollständig'} auf ${r.rechner} (${r.zeit}): ${[...r.root.map(x => `Root ${x.thumbprint} ${x.da ? 'da' : 'FEHLT'}`), ...r.zwischen.map(x => `Issuing ${x.thumbprint} ${x.da ? 'da' : 'FEHLT'}`)].join(', ')}`;
          return ok ? { success: true, data: r, display: text } : { success: false, data: r, error: text };
        }
        case 'ca_sicherung': {
          const z = pruefeSicherungsziel(input); if (typeof z === 'string') return { success: false, error: z };
          const kw = await this.kennwort(input.passwort_tresor, 'CA-Sicherung (PKCS#12-Kennwort)');
          const { r, weg } = await this.lauf<{ ca: string; satz: string; ordner: string; dateien: number; bytes: number; zeit: string }>(input, caSicherungSkript(z), 'CA sichern', 1_200_000, { kennwort: kw });
          const { r: st } = await this.lauf<{ saetze: { satz: string; ok: boolean; falsch?: string[] }[] }>(input, caSicherungStatusSkript(z), 'CA-Sicherung prüfen', 300_000);
          const s2 = st.saetze.find(x => x.satz === r.satz);
          const ok = !!s2?.ok;
          const text = `${ok ? '✅ CA_BACKUP_VERIFIED' : 'CA-Sicherung NICHT geprüft'} „${r.ca}“ (${weg}): Satz ${r.satz} in ${r.ordner}, ${r.dateien} Dateien, ${Math.round(r.bytes / 1024)} KB, ${r.zeit}${s2?.falsch?.length ? `; abweichend: ${s2.falsch.join(', ')}` : ''}`;
          return ok ? { success: true, data: r, display: text } : { success: false, data: r, error: text };
        }
        case 'ca_sicherung_status': {
          const z = pruefeSicherungsziel(input); if (typeof z === 'string') return { success: false, error: z };
          const { r, weg } = await this.lauf<{ ordner: string; rechner?: string; saetze: { satz: string; ca?: string; zeit?: string; alterStunden?: number; dateien?: number; ok: boolean; grund?: string; falsch?: string[] }[] }>(input, caSicherungStatusSkript(z), 'CA-Sicherung prüfen', 300_000);
          return { success: true, data: { ...r, weg }, display: `CA-Sicherungen ${r.ordner} (${weg}): ${r.saetze.length ? r.saetze.map(x => `${x.satz} ${x.ok ? 'ok' : `FEHLERHAFT (${x.grund ?? x.falsch?.join(', ')})`}${x.alterStunden !== undefined ? `, ${x.alterStunden} h alt` : ''}`).join('; ') : 'keine'}` };
        }
        case 'ca_sicherung_kopieren': {
          const z = pruefeSicherungsziel(input); if (typeof z === 'string') return { success: false, error: z };
          const satz = String(input.satz ?? '').trim(); if (!CA_SATZ.test(satz)) return { success: false, error: 'satz: ca-JJJJMMTT-HHMMSS aus ca_sicherung' };
          const zz = String(input.ziel_zugang ?? '').trim().toLowerCase(); if (!ZUGANG.test(zz)) return { success: false, error: 'ziel_zugang: Windows-Fernzugang für die unabhängige Kopie' };
          const zo = pruefeSicherungsziel({ ziel_ordner: input.ziel_ziel_ordner }); if (typeof zo === 'string') return { success: false, error: 'ziel_ziel_ordner: Ordner auf dem Ziel (nicht C:)' };
          const { r: pk, weg } = await this.lauf<{ satz: string; bytes: number; sha256: string; base64: string }>(input, caSatzPackenSkript({ ...z, satz }), 'CA-Sicherung packen', 600_000);
          const { r } = await this.lauf<{ zustand: string; ordner: string; dateien: number; ca: string; rechner: string }>({ zugang: zz }, caSatzAblegenSkript({ ziel_ordner: zo.ziel_ordner, satz, sha256: pk.sha256 }), 'CA-Sicherung ablegen', 600_000, { base64: pk.base64 });
          return { success: true, data: { satz, bytes: pk.bytes, sha256: pk.sha256, quelle: weg, ziel: r }, display: `✅ CA_BACKUP_COPY_VERIFIED „${r.ca}“: Satz ${satz} (${Math.round(pk.bytes / 1024)} KB, SHA-256 ${pk.sha256}) → ${r.rechner} ${r.ordner}, ${r.dateien} Dateien, Manifest nachgeprüft (${r.zustand})` };
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
