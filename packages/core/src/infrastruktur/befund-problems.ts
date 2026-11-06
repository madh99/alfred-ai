/**
 * Spec Infrastruktur-Vorhaben, I4b Teil 3 (4b: „E1-Befunde werden ITSM-Objekte … mit Dedup“) — Auffälligkeiten der Bestandsaufnahme
 * als ITSM-Problems, ohne Modell:
 *   - nur hoch/mittel; nie Sicherung (Owner 22.10.: „die backups usw brauchst du dich nicht zu kümmern das mach ich!“), nie Erfassungslücken
 *   - je Befund-Schlüssel höchstens ein Problem (auch ein geschlossenes zählt — der Owner hat entschieden)
 *   - Problems, deren Befund im aktuellen Bestand nicht mehr auftaucht, werden mit Vermerk gelöst
 */
import type { Auffaelligkeit, BefundKategorie } from './bericht.js';

export const METHODE = 'infrastruktur-bestand';
const AUSGENOMMEN: ReadonlySet<BefundKategorie> = new Set(['sicherung', 'erfassung']);
const KATEGORIE: Record<BefundKategorie, string> = { container: 'software', platte: 'capacity', updates: 'security', os: 'security', paketverwaltung: 'configuration', proxy: 'configuration', erfassung: 'unknown', sicherung: 'data', lizenz: 'configuration', grundlinie: 'security' };

export interface ProblemZugriff {
  liste(): Promise<Array<{ id: string; title: string; status: string; detectionMethod?: string }>>;
  anlegen(d: { title: string; description: string; priority: 'high' | 'medium'; category: string; affectedAssetIds: string[]; detectionMethod: string }): Promise<string>;
  loese(id: string, notiz: string): Promise<void>;
  /** CMDB-Asset des Hosts (Fernzugang) */
  assetFuer?(zugang: string): Promise<string | undefined>;
}

export function uebernehmen(a: Auffaelligkeit): boolean {
  return !!a.schluessel && !!a.kategorie && !AUSGENOMMEN.has(a.kategorie) && (a.schwere === 'hoch' || a.schwere === 'mittel');
}

/** Vollständig erfasste Hosts dieses Laufs — nur deren Befunde dürfen als „verschwunden“ gelten (Ausfall der Erfassung ≠ gelöst). */
export interface Erfassung { hosts: Set<string>; alle: boolean }
/** Schlüssel-Präfixe, deren zweites Feld der Fernzugang ist (container-unhealthy:dockerhost:noah …) */
const HOST_SCHLUESSEL = /^(container-[a-z]+|platte|updates|os|paketverwaltung|lizenz|grundlinie)$/;

const OFFEN = (s: string) => !['resolved', 'closed'].includes(s);

export async function befundeAlsProblems(auff: Auffaelligkeit[], z: ProblemZugriff, bericht: { docId: string; datum: string }, erfassung: Erfassung): Promise<{ neu: string[]; bekannt: number; geloest: string[]; dubletten?: string[] }> {
  // liste() liefert ALLE Problems dieser Quelle, älteste zuerst (v1770 — vorher abgeschnitten bei 1000, Realfall 07.11.)
  const vorhanden = (await z.liste()).filter(p => p.detectionMethod?.startsWith(`${METHODE}:`));
  // je Schlüssel zählt das älteste Problem (auch ein geschlossenes — Regel oben). Jüngere offene zum selben Schlüssel können nur aus
  // dem Abschneide-Fehler stammen → als Dublette schließen.
  const nachSchluessel = new Map<string, (typeof vorhanden)[number]>();
  const dubletten: string[] = [];
  for (const p of vorhanden) {
    const k = p.detectionMethod!.slice(METHODE.length + 1);
    const da = nachSchluessel.get(k);
    if (!da) { nachSchluessel.set(k, p); continue; }
    if (!OFFEN(p.status)) continue;
    await z.loese(p.id, `Dublette von Problem ${da.id} (gleicher Befund ${k}) — automatisch geschlossen (v1770).`);
    dubletten.push(p.id);
  }
  const aktuell = auff.filter(uebernehmen);
  const neu: string[] = []; let bekannt = 0;
  for (const a of aktuell) {
    if (nachSchluessel.has(a.schluessel!)) { bekannt++; continue; }
    const asset = a.zugang ? await z.assetFuer?.(a.zugang).catch(() => undefined) : undefined;
    const id = await z.anlegen({
      title: `${a.bereich}: ${a.text}`.slice(0, 200),
      description: `Befund der Bestandsaufnahme (${bericht.datum}, Bericht ${bericht.docId}).\n${a.text}\nSchwere laut Regeln: ${a.schwere}.`,
      priority: a.schwere === 'hoch' ? 'high' : 'medium', category: KATEGORIE[a.kategorie!],
      affectedAssetIds: asset ? [asset] : [], detectionMethod: `${METHODE}:${a.schluessel}`,
    });
    neu.push(id);
  }
  // Offene Problems, deren Befund verschwunden ist → gelöst (geschlossene/gelöste bleiben unberührt)
  const jetzt = new Set(auff.map(a => a.schluessel).filter(Boolean));
  const geloest: string[] = [];
  for (const [k, p] of nachSchluessel) {
    if (jetzt.has(k) || !OFFEN(p.status)) continue;
    const [kat, zugang] = k.split(':');
    const sicher = HOST_SCHLUESSEL.test(kat!) ? erfassung.hosts.has(zugang!) : erfassung.alle;
    if (!sicher) continue;
    await z.loese(p.id, `Im Bestand vom ${bericht.datum} (Bericht ${bericht.docId}) nicht mehr festgestellt — automatisch als gelöst markiert.`);
    geloest.push(p.id);
  }
  return { neu, bekannt, geloest, ...(dubletten.length ? { dubletten } : {}) };
}
