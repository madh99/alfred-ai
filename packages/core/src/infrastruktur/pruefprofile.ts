/**
 * S3 (Spec 2026-10-27-standard-changes-eingangskontrolle §4.4, Owner-Entscheidung 5 vom 27.10.) — Prüfprofile je Asset in der CMDB:
 * dienstspezifische, lesende Prüfungen mit Erwartung, die jede Vorlage nach der Wirkung abnimmt (zuerst Updates v2).
 *
 * Alfred schlägt ein Profil vor — ohne Modell aus den abgeschlossenen Changes am Asset (nur Prüfungen, die dauerhaft gelten) oder mit
 * ausdrücklich genannten Prüfungen. Jede Prüfung läuft durch die Planprüfung (Leseliste, feste Ausgaben) und wird einmal live
 * ausgeführt; was nicht besteht, kommt nicht ins Profil. Gültig wird das Profil erst mit dem Ja des Owners (Freigabe-Frage, an den
 * Abdruck gebunden). Fehlt ein Profil, gilt nur der generische Vorher-/Nachher-Vergleich (S2) — der Plan sagt das ausdrücklich.
 */
import { createHash, randomUUID } from 'node:crypto';
import { pruefText, type Pruefung } from './change-schritte.js';

export type ProfilStatus = 'angefragt' | 'bestaetigt' | 'abgelehnt' | 'entfernt';
/**
 * Eine Zeile je Asset. `pruefungen` gilt nur mit status bestaetigt; ein offener Vorschlag steht in `vorschlag` (mit Quelle und
 * Einmal-Freigabe) und ersetzt ein bestätigtes Profil erst mit dem Ja.
 */
export interface ProfilZeile {
  assetId: string; assetName: string; status: ProfilStatus; pruefungen: Pruefung[]; abdruck: string; quelle: string; bestaetigtAt?: string;
  vorschlag?: Pruefung[]; vorschlagQuelle?: string; frageHash?: string; frageBis?: string;
}

/** Quelle eines Kandidaten: abgeschlossener Change am Asset */
export interface QuellChange { id: string; titel: string; schritte: Array<{ pruefung?: unknown }> }

export interface ProfilDeps {
  lade(o: string): Promise<ProfilZeile[]>;
  setze(o: string, z: ProfilZeile): Promise<void>;
  /** Asset (VM) nach Name, vmid oder Fernzugang; zugang = Fernzugang auf dieser VM (für host-gebundene Prüfungen) */
  asset(o: string, k: string): Promise<{ id: string; name: string; zugang?: string } | { fehler: string }>;
  /** abgeschlossene Changes, die das Asset betreffen (älteste zuerst) */
  quellen(o: string, assetId: string): Promise<QuellChange[]>;
  /** Planprüfung ohne Speichern (ChangePlanung.pruefeNur) — Fehlertexte mit „Schritt n“ */
  planPruefen(o: string, plan: Record<string, unknown>): Promise<string[]>;
  /** einmal live ausführen (Motor.pruefe) */
  pruefe(p: Pruefung): Promise<{ ok: boolean; text: string }>;
  frage?(text: string, params: Record<string, unknown>): Promise<boolean>;
  jetzt?(): number;
  protokoll?(msg: string, daten: Record<string, unknown>): void;
}

const GUELTIG_MS = 24 * 3_600_000;
/** höchstens so viele Prüfungen je Profil (Laufzeit des Change, Lesbarkeit der Freigabe-Frage) */
export const PROFIL_MAX = 15;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
/** Abdruck: Asset + Prüfungen in fester Reihenfolge der Schlüssel */
export function profilAbdruck(assetId: string, pruefungen: Pruefung[]): string {
  const stabil = (v: unknown): unknown => (Array.isArray(v) ? v.map(stabil) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, stabil((v as Record<string, unknown>)[k])])) : v);
  return hash(JSON.stringify([assetId, stabil(pruefungen)])).slice(0, 32);
}
const schluessel = (p: Pruefung) => profilAbdruck('', [p]);

/** Einmal-Beweise und Lauf-Artefakte gelten nicht dauerhaft (Realfall I9/Matrix: Marker-Dateien, Snapshot-Namen, Tagesordner) */
const MARKER = /^[A-Z][A-Z0-9_]{5,}$/;
const ARTEFAKT = /\/var\/lib\/alfred-wartung\/|\/srv\/i9-|\/proofs\/|\.bak\b|20\d\d-?[01]\d-?[0-3]\d/;
/** Verweise auf Schritte, andere Changes oder den Tresor (Go-Templates wie docker inspect {{.State.Running}} sind keine) */
const VERWEIS = /\{\{\s*(schritt\d|change:|geheim)/;
/**
 * v1958 — Realfall 25.11.: aus Umzugs-Changes kamen Prüfungen auf den genauen Image-Digest (docker images --digests, Config.Image
 * mit sha256:…). Sie belegten dort die richtige Kopie; als Dauerprüfung hielten sie jedes Image-Update an.
 */
const VERSION_FEST = /sha256:[0-9a-f]{12,}|docker\s+images|\{\{\s*\.Config\.Image\s*\}\}|\{\{\s*\.Image\s*\}\}/;
const BEWEIS_BEFEHL = /^\s*(cat|stat|test|ls|head|tail|wc|sha256sum|md5sum)\s/;

/**
 * Kandidaten aus abgeschlossenen Changes: nur Prüfungen, die an den Fernzugang dieser VM gebunden sind (Befehl bzw. Container gesund),
 * ohne Verweise, Einmal-Beweise, Marker oder Datumsbezug; doppelte nur einmal; jüngste Changes zuerst, höchstens PROFIL_MAX.
 */
export function kandidaten(quellen: QuellChange[], zugang: string | undefined): { pruefungen: Pruefung[]; quellen: string[] } {
  if (!zugang) return { pruefungen: [], quellen: [] };
  const z = zugang.toLowerCase();
  const gesehen = new Set<string>(); const aus = new Set<string>(); const r: Pruefung[] = [];
  for (const c of [...quellen].reverse()) {
    for (const s of c.schritte) {
      const p = s.pruefung as Pruefung | undefined;
      if (!p || typeof p !== 'object' || (p.typ !== 'befehl' && p.typ !== 'container_healthy')) continue;
      if (String(p.zugang ?? '').toLowerCase() !== z) continue;
      const text = JSON.stringify(p);
      if (VERWEIS.test(text)) continue;
      const befehl = String(p.befehl ?? '');
      if (p.typ === 'befehl' && (!befehl || BEWEIS_BEFEHL.test(befehl) || ARTEFAKT.test(befehl))) continue;
      if (p.erwartet && (MARKER.test(p.erwartet) || ARTEFAKT.test(p.erwartet))) continue;
      if (VERSION_FEST.test(befehl) || VERSION_FEST.test(String(p.erwartet ?? ''))) continue;
      const k = schluessel(p);
      if (gesehen.has(k)) continue;
      gesehen.add(k); r.push(p); aus.add(c.id.slice(0, 8));
      if (r.length >= PROFIL_MAX) return { pruefungen: r, quellen: [...aus] };
    }
  }
  return { pruefungen: r, quellen: [...aus] };
}

/** Prüf-Schritte eines bestätigten Profils für einen Change-Plan (nach der Wirkung, Halt bei Abweichung) */
export function profilSchritte(assetName: string, pruefungen: Pruefung[]): Array<Record<string, unknown>> {
  return pruefungen.map((p, i) => ({ titel: `Prüfprofil ${assetName} ${i + 1}/${pruefungen.length}: ${pruefText(p).slice(0, 120)}`, art: 'pruefung', pruefung: p, beiFehler: 'anhalten', zeitlimitS: 300 }));
}

export class Pruefprofile {
  constructor(private readonly d: ProfilDeps) {}
  private jetzt() { return this.d.jetzt?.() ?? Date.now(); }

  /** bestätigtes Profil eines Assets — nur wenn der Abdruck zu den gespeicherten Prüfungen passt */
  async bestaetigt(o: string, assetId: string): Promise<Pruefung[] | undefined> {
    const z = (await this.d.lade(o)).find(x => x.assetId === assetId);
    return z?.status === 'bestaetigt' && z.abdruck === profilAbdruck(z.assetId, z.pruefungen) && z.pruefungen.length ? z.pruefungen : undefined;
  }

  async liste(o: string): Promise<ProfilZeile[]> { return (await this.d.lade(o)).filter(z => z.status !== 'entfernt'); }

  /**
   * Vorschlag: aus den abgeschlossenen Changes am Asset (ohne `pruefungen`) oder mit den genannten Prüfungen. Planprüfung + Live-Lauf;
   * die bestandenen gehen als Freigabe-Frage an den Owner. Ein bestätigtes Profil bleibt gültig, bis der Owner das neue bestätigt.
   */
  async vorschlagen(o: string, k: string, genannt?: unknown[]): Promise<{ ok: true; text: string } | { ok: false; fehler: string }> {
    if (!this.d.frage) return { ok: false, fehler: 'Freigabe-Fragen nicht verfügbar' };
    const a = await this.d.asset(o, k);
    if ('fehler' in a) return { ok: false, fehler: a.fehler };
    let roh: Pruefung[]; let quelle: string;
    if (genannt?.length) {
      roh = genannt.filter((p): p is Pruefung => !!p && typeof p === 'object' && typeof (p as Pruefung).typ === 'string');
      if (roh.length !== genannt.length) return { ok: false, fehler: 'pruefungen: Liste von Prüfungen ({typ, …, erwartet}) wie in Change-Schritten' };
      if (roh.length > PROFIL_MAX) return { ok: false, fehler: `höchstens ${PROFIL_MAX} Prüfungen je Profil` };
      quelle = 'genannt';
    } else {
      const kd = kandidaten(await this.d.quellen(o, a.id), a.zugang);
      if (!kd.pruefungen.length) return { ok: false, fehler: `${a.name}: keine dauerhaft gültigen Prüfungen in abgeschlossenen Changes${a.zugang ? '' : ' (kein Fernzugang auf dieser VM)'} — Prüfungen ausdrücklich nennen (pruefungen)` };
      roh = kd.pruefungen; quelle = `abgeleitet aus ${kd.quellen.join(', ')}`;
    }
    // Planprüfung: dieselben Regeln wie jeder Change (Leseliste, feste Ausgaben, Käfig). v1957 — betroffen als volle Asset-ID: Realfall
    // 25.11. 14:40, der VM-Name war mehrdeutig (Proxmox-VM und Fernzugriffs-Host gleichen Namens), alle fünf Vorschläge scheiterten
    const plan = { schluessel: 'profil', titel: `Prüfprofil ${a.name}`, begruendung: 'S3 Prüfprofil (nur Prüfung, nichts wird gespeichert)', typ: 'normal', risiko: 'gering', ausfallMinuten: 0, betroffen: [a.id],
      schritte: roh.map((p, i) => ({ titel: `Prüfung ${i + 1}`, art: 'pruefung', pruefung: p })) };
    const fehler = await this.d.planPruefen(o, plan);
    const schlecht = new Map<number, string>(); const allgemein: string[] = [];
    for (const f of fehler) { const m = /Schritt (\d+)/.exec(f); if (m && Number(m[1]) >= 1 && Number(m[1]) <= roh.length) schlecht.set(Number(m[1]) - 1, f.replace(/^Change [^:]+: /, '')); else allgemein.push(f); }
    if (allgemein.length) return { ok: false, fehler: `Planprüfung: ${allgemein.join('; ').slice(0, 600)}` };
    const gut: Pruefung[] = []; const raus: string[] = [];
    for (const [i, p] of roh.entries()) {
      if (schlecht.has(i)) { raus.push(`${pruefText(p).slice(0, 80)} — ${schlecht.get(i)!.slice(0, 160)}`); continue; }
      const r = await this.d.pruefe(p).catch((err: Error) => ({ ok: false, text: err.message }));
      if (r.ok) gut.push(p); else raus.push(`${pruefText(p).slice(0, 80)} — besteht jetzt nicht: ${r.text.slice(0, 120)}`);
    }
    if (!gut.length) return { ok: false, fehler: `${a.name}: keine Prüfung besteht — nichts vorgeschlagen.${raus.length ? ` ${raus.join(' · ')}` : ''}` };
    const nonce = randomUUID();
    const alt = (await this.d.lade(o)).find(x => x.assetId === a.id);
    const bisher = alt?.status === 'bestaetigt' ? alt : undefined;
    await this.d.setze(o, {
      assetId: a.id, assetName: a.name, status: bisher ? 'bestaetigt' : 'angefragt', pruefungen: bisher?.pruefungen ?? [], abdruck: bisher?.abdruck ?? '', quelle: bisher?.quelle ?? '',
      ...(bisher?.bestaetigtAt ? { bestaetigtAt: bisher.bestaetigtAt } : {}),
      vorschlag: gut, vorschlagQuelle: quelle, frageHash: hash(nonce), frageBis: new Date(this.jetzt() + GUELTIG_MS).toISOString(),
    });
    const liste = gut.map((p, i) => `${i + 1}. ${pruefText(p).slice(0, 160)}`).join('\n');
    const ok = await this.d.frage(`🔎 Prüfprofil für ${a.name} bestätigen (${gut.length} Prüfungen, ${quelle})\n\n${liste}${raus.length ? `\n\nNicht aufgenommen:\n${raus.map(x => `• ${x}`).join('\n')}` : ''}\n\nNach dem Ja nimmt jede Standard-Vorlage (zuerst Betriebssystem-Updates) ${a.name} nach der Wirkung mit diesen Prüfungen ab; eine Abweichung hält den Change an.${alt?.status === 'bestaetigt' ? ' Ersetzt das bisher bestätigte Profil.' : ''}`,
      { action: 'pruefprofil_bestaetigen', asset: a.id, freigabe: nonce });
    this.d.protokoll?.('S3 Prüfprofil vorgeschlagen', { asset: a.name, anzahl: gut.length, raus: raus.length, quelle, frage: ok });
    return ok ? { ok: true, text: `Prüfprofil ${a.name}: ${gut.length} Prüfungen zur Bestätigung vorgelegt${raus.length ? `, ${raus.length} nicht aufgenommen (${raus.join(' · ')})` : ''}.` } : { ok: false, fehler: 'Frage konnte nicht gestellt werden' };
  }

  /** Ja des Owners (Button): nur mit gültiger Einmal-Freigabe; ersetzt ein bisher bestätigtes Profil */
  async bestaetigenNachJa(o: string, assetId: unknown, nonce: unknown): Promise<{ ok: boolean; text: string }> {
    const z = (await this.d.lade(o)).find(x => x.assetId === assetId);
    if (!z || typeof nonce !== 'string' || !z.frageHash || z.frageHash !== hash(nonce) || !z.frageBis || Date.parse(z.frageBis) < this.jetzt()) {
      return { ok: false, text: 'Keine gültige Bestätigung — Prüfprofile bestätigt nur der Owner über die Freigabe-Frage.' };
    }
    if (!z.vorschlag?.length) return { ok: false, text: `${z.assetName}: kein offener Vorschlag` };
    const pruefungen = z.vorschlag; const quelle = z.vorschlagQuelle ?? '';
    await this.d.setze(o, { assetId: z.assetId, assetName: z.assetName, status: 'bestaetigt', pruefungen, abdruck: profilAbdruck(z.assetId, pruefungen), quelle, bestaetigtAt: new Date(this.jetzt()).toISOString() });
    this.d.protokoll?.('S3 Prüfprofil bestätigt', { asset: z.assetName, anzahl: pruefungen.length });
    return { ok: true, text: `Prüfprofil ${z.assetName} bestätigt (${pruefungen.length} Prüfungen).` };
  }

  async entfernen(o: string, k: string): Promise<{ ok: boolean; text: string }> {
    const a = await this.d.asset(o, k);
    if ('fehler' in a) return { ok: false, text: a.fehler };
    const z = (await this.d.lade(o)).find(x => x.assetId === a.id);
    if (!z || z.status === 'entfernt') return { ok: false, text: `${a.name} hat kein Prüfprofil` };
    await this.d.setze(o, { assetId: z.assetId, assetName: z.assetName, status: 'entfernt', pruefungen: [], abdruck: '', quelle: z.quelle });
    this.d.protokoll?.('S3 Prüfprofil entfernt', { asset: a.name });
    return { ok: true, text: `Prüfprofil ${a.name} entfernt — Vorlagen prüfen dort nur noch generisch (Vorher-/Nachher-Vergleich).` };
  }
}
