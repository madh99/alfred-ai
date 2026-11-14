/**
 * PKI Etappe 5 — Betrieb (Owner 14.11.: „Alfred-Job + Telegram“; Bau-Spec 252217f3 Pos. 15/17/18): täglicher Prüflauf über die festen
 * Lesebausteine von windows_pki, Befunde als Problems (Kategorie pki, wiederkehrend):
 *   - SQL-TLS-Zertifikate der Vorlage: Warnstufen 90/60/30/14 Tage (≤14 hoch, ≤30 mittel, ≤90 niedrig), fehlendes Zertifikat hoch.
 *   - Sperrlisten (HTTP vom Client-Netz aus): nicht abrufbar hoch; NextUpdate Issuing < 1 Tag hoch, < 3 Tage mittel (wird täglich
 *     neu veröffentlicht, gültig 1 Tag + 6 Tage Überlappung); Root < 14 Tage hoch, < 30 Tage mittel, < 60 Tage niedrig (Offline-Zeremonie).
 *   - CA-Sicherungen (Issuer lokal und Kopie auf fs01): neuester geprüfter Satz älter als 8 Tage mittel, älter als 15 Tage hoch;
 *     fehlerhafte Sätze mittel. Root-Sicherungen entstehen nur bei Zeremonien und werden hier nicht nach Alter bewertet.
 * Nur lesend; kein Modell.
 */
import type { Auffaelligkeit } from './bericht.js';

export type PkiAufruf = (aktion: string, parameter: Record<string, unknown>) => Promise<{ success: boolean; data?: unknown; error?: string; display?: string }>;

export interface PkiBetriebKonfig {
  sqlKnoten: string[];
  client: string;
  basis: string;
  issuerCrl: string; rootCrl: string; issuerCrt: string; rootCrt: string;
  issuer: { zugang: string; ordner: string };
  kopie: { zugang: string; ordner: string };
}

export const PKI_BETRIEB: PkiBetriebKonfig = {
  sqlKnoten: ['sql01', 'sql02'],
  client: 'sql01',
  basis: 'http://pki.ad.3033.at/pki/',
  issuerCrl: 'ad3033-issuing1.crl', rootCrl: 'ad3033-root.crl', issuerCrt: 'ad3033-issuing1.crt', rootCrt: 'ad3033-root.crt',
  issuer: { zugang: 'pkiiss01', ordner: 'B:\\CA-Sicherung' },
  kopie: { zugang: 'fs01', ordner: 'S:\\PKI-Sicherung\\Issuer' },
};

const TAG = 86_400_000;

export async function pkiBefunde(aufruf: PkiAufruf, k: PkiBetriebKonfig = PKI_BETRIEB, jetzt = new Date()): Promise<{ befunde: Auffaelligkeit[]; erfasst: Set<string>; fehler: string[]; zeilen: string[] }> {
  const befunde: Auffaelligkeit[] = []; const erfasst = new Set<string>(); const fehler: string[] = []; const zeilen: string[] = [];
  const ruf = (a: string, pa: Record<string, unknown>) => aufruf(a, pa).catch((err: Error) => ({ success: false, error: err.message }) as Awaited<ReturnType<PkiAufruf>>);
  const b = (schwere: Auffaelligkeit['schwere'], zugang: string, teil: string, text: string) => befunde.push({ schwere, bereich: zugang, text, schluessel: `pki:${zugang}:${teil}`, kategorie: 'pki', zugang });

  // 1. SQL-TLS-Zertifikate (erneuerung_status)
  const e = await ruf('erneuerung_status', { zugaenge: k.sqlKnoten });
  if (!e.success) fehler.push(`Zertifikate: ${String(e.error).slice(0, 200)}`);
  else {
    for (const d of (e.data ?? []) as Array<{ zugang: string; zertifikate: Array<{ thumbprint: string; bis: string; tage: number }>; warnstufe: number | null }>) {
      erfasst.add(d.zugang);
      const n = d.zertifikate[0];
      if (!n) { b('hoch', d.zugang, 'sql-tls', 'kein SQL-TLS-Zertifikat der Vorlage AD3033-SQL-TLS-v1 vorhanden'); continue; }
      zeilen.push(`${d.zugang}: SQL-TLS ${n.thumbprint.slice(0, 8)}… noch ${n.tage} Tage`);
      if (n.tage <= 90) b(n.tage <= 14 ? 'hoch' : n.tage <= 30 ? 'mittel' : 'niedrig', d.zugang, 'sql-tls', `SQL-TLS-Zertifikat ${n.thumbprint} läuft in ${n.tage} Tagen ab (${n.bis.slice(0, 10)}, Warnstufe ${d.warnstufe ?? '—'} Tage) — erneuern (erneuerung_anfordern) und kontrolliert neu binden`);
    }
  }

  // 2. Veröffentlichung: Zertifikate und Sperrlisten über HTTP vom Client aus
  const urls = [k.issuerCrl, k.rootCrl, k.issuerCrt, k.rootCrt].map(x => k.basis + x);
  const p = await ruf('publication_pruefen', { zugang: k.client, urls });
  const abrufe = ((p.data ?? {}) as { abrufe?: Array<{ url: string; status: number; nummer?: string; nextUpdate?: string; fehler?: string }> }).abrufe;
  if (!abrufe) fehler.push(`Veröffentlichung: ${String(p.error ?? 'keine Daten').slice(0, 200)}`);
  else {
    erfasst.add(k.client);
    for (const a of abrufe) {
      const datei = a.url.slice(k.basis.length);
      if (a.status !== 200) { b('hoch', k.client, `abruf:${datei}`, `${a.url} nicht abrufbar (HTTP ${a.status}${a.fehler ? `, ${a.fehler}` : ''}) — Clients können Kette/Sperrstatus nicht prüfen`); continue; }
      if (!datei.endsWith('.crl')) continue;
      const nu = a.nextUpdate ? Date.parse(a.nextUpdate) : NaN;
      if (!Number.isFinite(nu)) { b('mittel', k.client, `crl:${datei}`, `Sperrliste ${datei}: NextUpdate nicht lesbar`); continue; }
      const tage = (nu - jetzt.getTime()) / TAG;
      zeilen.push(`${datei}: Nr. ${a.nummer ?? '?'}, NextUpdate ${a.nextUpdate} (${tage.toFixed(1)} Tage)`);
      if (datei === k.issuerCrl) {
        if (tage < 3) b(tage < 1 ? 'hoch' : 'mittel', k.client, `crl:${datei}`, `Sperrliste der Issuing-CA ${datei} gilt nur noch ${tage.toFixed(1)} Tage (NextUpdate ${a.nextUpdate}, Nr. ${a.nummer ?? '?'}) — automatische Neuveröffentlichung auf pkiiss01/fs01 prüfen`);
      } else if (tage < 60) {
        b(tage < 14 ? 'hoch' : tage < 30 ? 'mittel' : 'niedrig', k.client, `crl:${datei}`, `Root-Sperrliste ${datei} gilt nur noch ${Math.floor(tage)} Tage (NextUpdate ${a.nextUpdate}, Nr. ${a.nummer ?? '?'}) — Offline-Zeremonie auf pkiroot01 (crl_erzeugen) als eigener Change einplanen`);
      }
    }
  }

  // 3. CA-Sicherungen: Issuer lokal und unabhängige Kopie
  for (const s of [k.issuer, k.kopie]) {
    const r = await ruf('ca_sicherung_status', { zugang: s.zugang, ziel_ordner: s.ordner });
    if (!r.success) { fehler.push(`Sicherung ${s.zugang}: ${String(r.error).slice(0, 200)}`); continue; }
    erfasst.add(s.zugang);
    const saetze = ((r.data ?? {}) as { saetze?: Array<{ satz: string; ok: boolean; alterStunden?: number; grund?: string }> }).saetze ?? [];
    for (const x of saetze.filter(x => !x.ok)) b('mittel', s.zugang, `sicherung-defekt:${x.satz}`, `CA-Sicherungssatz ${x.satz} in ${s.ordner} fehlerhaft (${x.grund ?? 'Hash passt nicht'})`);
    const gut = saetze.filter(x => x.ok && typeof x.alterStunden === 'number').sort((a, c) => a.alterStunden! - c.alterStunden!)[0];
    const tage = gut ? gut.alterStunden! / 24 : Infinity;
    zeilen.push(`${s.zugang} ${s.ordner}: neuester geprüfter Satz ${gut ? `${gut.satz} (${tage.toFixed(1)} Tage)` : 'keiner'}`);
    if (tage > 8) b(tage > 15 ? 'hoch' : 'mittel', s.zugang, 'sicherung-alter', gut ? `neueste geprüfte CA-Sicherung in ${s.ordner} ist ${Math.floor(tage)} Tage alt (${gut.satz}) — wöchentliche Sicherung prüfen` : `keine geprüfte CA-Sicherung in ${s.ordner}`);
  }
  return { befunde, erfasst, fehler, zeilen };
}
