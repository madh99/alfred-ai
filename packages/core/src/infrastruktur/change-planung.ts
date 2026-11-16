/**
 * Spec Infrastruktur-Vorhaben, I3 — Planung, Prüfung und Owner-Freigabe von Changes mit Schritten (keine Ausführung).
 * Alles-oder-nichts je Paket: ein Fehler in einem Change → kein Change wird gespeichert, das Modell bekommt alle Fehler.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { CmdbChangeRequest } from '@alfred/types';
import type { ChangeSchrittDaten } from '@alfred/storage';
import { changeFingerabdruck, freigabeText, plaeneAusSchritten, pruefeChangePlan, schrittText, pruefText, zyklus, type Auswirkung, type ChangePlan, type ChangeSchritt, type PruefKontext } from './change-schritte.js';

export interface ChangeSpeicher {
  liste(owner: string): Promise<CmdbChangeRequest[]>;
  hole(owner: string, id: string): Promise<CmdbChangeRequest | null>;
  legeAn(owner: string, d: ChangeSchrittDaten): Promise<CmdbChangeRequest>;
  setzeSchritte(owner: string, id: string, d: ChangeSchrittDaten, o?: { haltOhneWirkung?: boolean; korrekturAb?: number }): Promise<CmdbChangeRequest>;
  freigeben(owner: string, id: string, fingerabdruck: string, ueber: 'frage' | 'web'): Promise<CmdbChangeRequest>;
  setzeFreigabeAnfrage(owner: string, id: string, a: { hash: string; bis: string; fingerabdruck: string } | null): Promise<void>;
  /** I4b Teil 4 — Change aus freigegebener Standard-Vorlage (sofort freigegeben) */
  legeStandardAn?(owner: string, d: ChangeSchrittDaten, vorlage: string): Promise<CmdbChangeRequest>;
}
/** Gültigkeit einer Freigabe-Frage (das Ja kann auch Stunden später kommen; der Fingerabdruck bindet sie an den Plan) */
export const FREIGABE_FRAGE_GUELTIG_MS = 24 * 3_600_000;
/**
 * v1784 — Realfall 10.11. (I8c D 12d82a15): Schritt 2 hatte einen Snapshot angelegt (Einordnung „sicherung“), Schritt 3 hielt an. Die
 * Korrektur galt als „Halt ohne Wirkung“, der Change startete nach der Freigabe bei Schritt 1 neu und scheiterte am vorhandenen Snapshot.
 * Auch eine angelegte Sicherung ist Wirkung — dann geht es nach der Korrektur am Haltepunkt weiter.
 */
const WIRKUNG = new Set(['aendern', 'loeschen', 'sicherung']);
const hash = (nonce: string) => createHash('sha256').update(nonce).digest('hex');
export interface ChangeDeps {
  itsm: ChangeSpeicher;
  skill: PruefKontext['skill'];
  assets: () => Promise<Array<{ id: string; name: string; hostname?: string; status?: string; assetType?: string; sourceId?: string; sourceSkill?: string }>>;
  auswirkung: (assetIds: string[], ohneChangeId?: string) => Promise<Auswirkung>;
  bestaetigung?: (frage: { description: string; params: Record<string, unknown> }) => Promise<boolean>;
  jetzt?: () => number;
  protokoll?: (msg: string, daten: Record<string, unknown>) => void;
  /** I4 — nach jeder Owner-Freigabe (Motor anstoßen) */
  nachFreigabe?: () => void;
  /** v1688 — nach einer Plankorrektur veraltete Owner-Fragen zurückziehen */
  nachAenderung?: () => void;
  /** I4c — Namen im Tresor (für die Prüfung der Tresor-Verweise) */
  tresorNamen?: (owner: string) => Promise<Set<string>>;
  /** v1684 — Namen der Fernzugänge (für die Prüfung von zugang/name in Plänen) */
  zugaenge?: (owner: string) => Promise<string[]>;
  /** Einwand — offene Einwände blockieren, Antworten sind Pflicht, Freigabe-Frage nennt sie */
  einwand?: import('./einwand.js').EinwandDienst;
}

const RISIKO_TEXT: Record<string, string> = { low: 'niedrig', medium: 'mittel', high: 'hoch', critical: 'kritisch' };

/** Gespeicherten Change wieder in die Planform bringen (für die erneute Prüfung vor der Freigabe). */
/** V3 — beim Planen festgehaltener Stand der Vorgänger eines gespeicherten Change (für die erneute Prüfung, nie aus Modell-Eingaben) */
export function vorgaengerAbdruckVon(c: CmdbChangeRequest): Record<string, string> | undefined {
  return (c.pruefung as { zusatz?: { vorgaengerAbdruck?: Record<string, string> } } | undefined)?.zusatz?.vorgaengerAbdruck;
}

export function planAusChange(c: CmdbChangeRequest): Record<string, unknown> {
  const z = (c.pruefung as { zusatz?: { zweck?: string; ohneSicherungGrund?: string } } | undefined)?.zusatz ?? {};
  return {
    titel: c.title, begruendung: c.description ?? '', typ: c.type === 'emergency' ? 'notfall' : 'normal', risiko: c.riskLevel,
    ausfallMinuten: c.ausfallMinuten, ...(c.scheduledAt ? { geplantAb: c.scheduledAt } : {}), betroffen: c.affectedAssetIds,
    abhaengigVon: c.abhaengigVon ?? [], ...(z.zweck ? { zweck: z.zweck } : {}), ...(z.ohneSicherungGrund ? { ohneSicherungGrund: z.ohneSicherungGrund } : {}),
    schritte: (c.schritte ?? []) as unknown[],
  };
}

/**
 * v1680 — Realfall 26.10. (Matrix H/I): change_aendern verlangte den vollständigen Plan; für I (19 Schritte mit langen Skripten) wich das
 * Modell auf einen Code-Agenten aus und scheiterte. Jetzt gezielt: einzelne Schritte ersetzen ({nr, schritt}) oder nach Schritt N
 * einfügen ({nach, schritt}). Beim Einfügen rücken die folgenden Schritte nach, ihre Verweise {{schrittK…}} (K > N) werden mitgezählt.
 */
export function planMitSchrittAenderungen(plan: Record<string, unknown>, ersetzenRoh?: unknown, einfuegenRoh?: unknown, textErsetzenRoh?: unknown): { plan: Record<string, unknown> } | { fehler: string[] } {
  const schritte = JSON.parse(JSON.stringify(plan.schritte ?? [])) as Array<Record<string, unknown>>;
  const fehler: string[] = [];
  const liste = (v: unknown) => (Array.isArray(v) ? v : typeof v === 'string' ? (() => { try { const j = JSON.parse(v); return Array.isArray(j) ? j : []; } catch { return []; } })() : []) as Array<Record<string, unknown>>;
  // v1691 — Realfall a3982e74: exakter Textersatz in genannten Schritten, ohne dass das Modell die (abgeschnittenen) Schritte neu schreiben muss
  for (const e of liste(textErsetzenRoh)) {
    const suchen = typeof e.suchen === 'string' ? e.suchen : '';
    const durch = typeof e.durch === 'string' ? e.durch : undefined;
    const nrn = (Array.isArray(e.schritte) ? e.schritte : []).map(Number);
    if (!suchen || durch === undefined) { fehler.push('text_ersetzen: suchen und durch (Text) angeben'); continue; }
    if (!nrn.length) { fehler.push(`text_ersetzen „${suchen.slice(0, 40)}“: schritte (Nummern) angeben`); continue; }
    for (const nr of nrn) {
      if (!Number.isInteger(nr) || nr < 1 || nr > schritte.length) { fehler.push(`text_ersetzen: Schritt ${String(nr)} gibt es nicht (1–${schritte.length})`); continue; }
      let treffer = 0;
      const ersetze = (v: unknown): unknown => {
        if (typeof v === 'string') { const teile = v.split(suchen); treffer += teile.length - 1; return teile.join(durch); }
        if (Array.isArray(v)) return v.map(ersetze);
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ersetze(x)]));
        return v;
      };
      const neu = ersetze(schritte[nr - 1]) as Record<string, unknown>;
      if (!treffer) { fehler.push(`text_ersetzen: „${suchen.slice(0, 60)}“ kommt in Schritt ${nr} nicht vor`); continue; }
      schritte[nr - 1] = neu;
    }
  }
  for (const e of liste(ersetzenRoh)) {
    const nr = Number(e.nr);
    const s = e.schritt;
    if (!Number.isInteger(nr) || nr < 1 || nr > schritte.length) { fehler.push(`schritte_ersetzen: Schritt ${String(e.nr)} gibt es nicht (1–${schritte.length})`); continue; }
    if (!s || typeof s !== 'object' || Array.isArray(s)) { fehler.push(`schritte_ersetzen: Schritt ${nr} ohne schritt-Objekt`); continue; }
    schritte[nr - 1] = { ...(s as Record<string, unknown>), nr };
  }
  const einf = liste(einfuegenRoh).map(e => ({ nach: Number(e.nach), schritt: e.schritt })).sort((a, b) => b.nach - a.nach);
  for (const e of einf) {
    if (!Number.isInteger(e.nach) || e.nach < 0 || e.nach > schritte.length) { fehler.push(`schritte_einfuegen: nach ${String(e.nach)} ungültig (0–${schritte.length})`); continue; }
    if (!e.schritt || typeof e.schritt !== 'object' || Array.isArray(e.schritt)) { fehler.push(`schritte_einfuegen: nach ${e.nach} ohne schritt-Objekt`); continue; }
    // Verweise der folgenden Schritte nachziehen (die eingefügten Schritte verweisen nur auf frühere)
    for (let i = e.nach; i < schritte.length; i++) {
      schritte[i] = JSON.parse(JSON.stringify(schritte[i]).replace(/\{\{(\s*)schritt(\d+)\./g, (m, ws: string, k: string) => (Number(k) > e.nach ? `{{${ws}schritt${Number(k) + 1}.` : m)));
    }
    schritte.splice(e.nach, 0, { ...(e.schritt as Record<string, unknown>) });
  }
  if (fehler.length) return { fehler };
  return { plan: { ...plan, schritte: schritte.map((s, i) => ({ ...s, nr: i + 1 })) } };
}

/** {{change:<schlüssel>.  (Gruppe 1: Leerraum, Gruppe 2: Schlüssel bzw. ID) */
const VERWEIS_SCHLUESSEL = /\{\{(\s*)change:([A-Za-z0-9_-]{1,64})\./g;
const ENDE = new Set(['completed', 'cancelled', 'failed', 'rolled_back', 'closed']);
/** V3 Fix 1 (C-1) — Fingerabdruck je Vorgänger-ID, auf den {{change:<id>…}} verweist (undefined, wenn keiner) */
function vorgaengerAbdruecke(schritte: unknown, fp: (id: string) => string | undefined): Record<string, string> | undefined {
  const aus: Record<string, string> = {};
  for (const m of JSON.stringify(schritte ?? []).matchAll(VERWEIS_SCHLUESSEL)) { const f = fp(m[2]!); if (f) aus[m[2]!] = f; }
  return Object.keys(aus).length ? aus : undefined;
}

export class ChangePlanung {
  constructor(private readonly d: ChangeDeps) {}

  private async kontext(owner: string): Promise<PruefKontext> {
    const [assets, changes, tresorNamen, zugaenge] = await Promise.all([this.d.assets(), this.d.itsm.liste(owner), this.d.tresorNamen?.(owner).catch(() => undefined), this.d.zugaenge?.(owner).catch(() => undefined)]);
    return {
      ...(tresorNamen ? { tresorNamen } : {}),
      ...(zugaenge ? { zugaenge: new Set(zugaenge.map(z => z.toLowerCase())) } : {}),
      skill: this.d.skill,
      changes: changes.map(c => ({ id: c.id, abhaengigVon: c.abhaengigVon ?? [], status: c.status, ...(c.fingerabdruck ? { fingerabdruck: c.fingerabdruck } : {}), ...(c.schritte ? { schritte: c.schritte as unknown[] } : {}) })),
      // I3 (Realfall 22.10.: „test-ubuntu“ = Deploy-Anwendung und VM) — ID, ID-Anfang ab 8 Zeichen, sourceId (z. B. pve3:142), Name/Hostname;
      // bei mehreren Treffern mit gleichem Namen nur die aktiven; bleibt es mehrdeutig, nennt der Hinweis volle IDs mit Typ und Quelle.
      asset: (k: string) => {
        const roh = k.trim(); const n = roh.toLowerCase();
        const eins = (a: (typeof assets)[number]) => ({ id: a.id, name: a.name });
        const id = assets.find(a => a.id === roh);
        if (id) return eins(id);
        if (roh.length >= 8) { const p = assets.filter(a => a.id.startsWith(roh)); if (p.length === 1) return eins(p[0]!); }
        const quelle = assets.filter(a => a.sourceId?.toLowerCase() === n);
        if (quelle.length === 1) return eins(quelle[0]!);
        let treffer = assets.filter(a => a.name.toLowerCase() === n || a.hostname?.toLowerCase() === n);
        if (treffer.length > 1) { const aktiv = treffer.filter(a => a.status === 'active'); if (aktiv.length) treffer = aktiv; }
        if (treffer.length > 1) return { mehrdeutig: treffer.map(a => `${a.id} (${a.assetType ?? '?'}, ${a.sourceSkill ?? '?'}${a.sourceId ? ` ${a.sourceId}` : ''})`) };
        return treffer[0] ? eins(treffer[0]) : undefined;
      },
    };
  }

  private daten(plan: ChangePlan, betroffeneIds: string[], abhaengigIds: string[], auswirkung: Auswirkung | undefined, hinweise: string[], vorhabenId?: string): ChangeSchrittDaten {
    const pl = plaeneAusSchritten(plan);
    const fp = changeFingerabdruck(plan, betroffeneIds, abhaengigIds);
    return {
      title: plan.titel, description: plan.begruendung, type: plan.typ === 'notfall' ? 'emergency' : 'normal', riskLevel: plan.risiko,
      affectedAssetIds: betroffeneIds, affectedServiceIds: [], implementationPlan: pl.umsetzung, rollbackPlan: pl.rueckweg, testPlan: pl.test,
      ...(plan.geplantAb ? { scheduledAt: plan.geplantAb } : {}), schritte: plan.schritte, ...(vorhabenId ? { vorhabenId } : {}),
      abhaengigVon: abhaengigIds, ...(plan.ausfallMinuten !== undefined ? { ausfallMinuten: plan.ausfallMinuten } : {}),
      ...(auswirkung ? { auswirkung } : {}),
      pruefung: { fehler: [], hinweise, zeit: new Date().toISOString(), ...({ zusatz: { ...(plan.zweck ? { zweck: plan.zweck } : {}), ...(plan.ohneSicherungGrund ? { ohneSicherungGrund: plan.ohneSicherungGrund } : {}), ...(plan.vorgaengerAbdruck ? { vorgaengerAbdruck: plan.vorgaengerAbdruck } : {}) } }) } as ChangeSchrittDaten['pruefung'],
      fingerabdruck: fp,
    };
  }

  private auswirkungsHinweise(a: Auswirkung, typ: ChangePlan['typ']): string[] {
    const h: string[] = [];
    if (a.kritisch) h.push(`Kritische Services betroffen: ${a.services.filter(s => s.kritikalitaet === 'critical').map(s => s.name).join(', ')}`);
    if (a.offeneIncidents.length) h.push(`Offene Incidents auf betroffenen Assets: ${a.offeneIncidents.join('; ')}${typ === 'normal' ? ' — kritische blockieren die Freigabe (außer Notfall-Change)' : ''}`);
    if (a.ueberschneidungen.length) h.push(`Überschneidet sich mit: ${a.ueberschneidungen.join('; ')}`);
    return h;
  }

  /**
   * Prüfungen eines Pakets ohne Speichern: Anzahl, eindeutige Schlüssel, Validator je Plan (mit Abhängigkeiten im Paket für
   * {{change:…}}), Zyklen. `fehler` = Paket als Ganzes unbrauchbar; `je` = Fehler je Change; `allgemein` = Zyklen.
   */
  private async pruefePaket(owner: string, roh: unknown[]): Promise<{ fehler: string[] } | { ctx: PruefKontext; schluessel: string[]; ergebnisse: Array<ReturnType<typeof pruefeChangePlan>>; je: Array<{ k: string; titel: string; text: string }>; allgemein: string[] }> {
    if (!roh.length) return { fehler: ['changes fehlt'] };
    if (roh.length > 30) return { fehler: ['höchstens 30 Changes je Paket'] };
    const ctx = await this.kontext(owner);
    const schluessel = roh.map((r, i) => String((r as Record<string, unknown>)?.schluessel ?? `c${i + 1}`));
    if (new Set(schluessel).size !== schluessel.length) return { fehler: ['schluessel der Changes müssen eindeutig sein'] };
    // abhaengigVon je Schlüssel (roh) — für Verweise über mehrere Stufen; der Validator löst Paket-Schlüssel und Change-IDs selbst auf
    const paket = new Map(roh.map((r, i) => {
      const a = (r as Record<string, unknown>)?.abhaengigVon; const st = (r as Record<string, unknown>)?.schritte;
      return [schluessel[i]!, { abhaengigVon: Array.isArray(a) ? a.map(x => (typeof x === 'string' ? x.trim() : '')).filter(Boolean) : [], schritte: Array.isArray(st) ? st : [] }] as [string, { abhaengigVon: string[]; schritte: unknown[] }];
    }));
    const ergebnisse = roh.map((r, i) => pruefeChangePlan({ ...(r as object), schluessel: schluessel[i] }, ctx, schluessel, paket));
    const je = ergebnisse.flatMap((e, i) => e.fehler.map(text => ({ k: schluessel[i]!, titel: e.plan.titel, text })));
    const kanten = new Map<string, string[]>();
    for (const c of ctx.changes) kanten.set(c.id, c.abhaengigVon);
    ergebnisse.forEach((e, i) => kanten.set(schluessel[i]!, e.plan.abhaengigVon));
    const z = zyklus(kanten);
    return { ctx, schluessel, ergebnisse, je, allgemein: z ? [`Abhängigkeiten im Kreis: ${z.join(' → ')}`] : [] };
  }

  /** V3 — Probe: dieselben Prüfungen wie planen, nichts wird gespeichert. Fehler je Change mit „Change <schlüssel>: …“. */
  async pruefeNur(owner: string, roh: unknown[]): Promise<string[]> {
    const p = await this.pruefePaket(owner, roh);
    if ('fehler' in p) return p.fehler;
    return [...p.je.map(x => `Change ${x.k}: ${x.text}`), ...p.allgemein];
  }

  /** Paket planen. `vorhaben` nur mit angenommener Architektur. */
  async planen(owner: string, roh: unknown[], vorhaben?: { id: string; status: string; titel: string }): Promise<{ ok: true; changes: CmdbChangeRequest[] } | { ok: false; fehler: string[] }> {
    if (vorhaben && vorhaben.status !== 'angenommen') return { ok: false, fehler: [`Vorhaben „${vorhaben.titel}“: Architektur ist noch nicht angenommen — erst entscheidet der Owner`] };
    const p = await this.pruefePaket(owner, roh);
    if ('fehler' in p) return { ok: false, fehler: p.fehler };
    const fehler = [...p.je.map(x => `Change ${x.k} (${x.titel || '?'}): ${x.text}`), ...p.allgemein];
    if (fehler.length) return { ok: false, fehler };
    const { ctx, schluessel, ergebnisse } = p;
    // Reihenfolge: Abhängigkeiten innerhalb des Pakets zuerst anlegen (kein Kreis → terminiert)
    const reihe: Array<{ e: (typeof ergebnisse)[number]; k: string }> = [];
    const offen = ergebnisse.map((e, i) => ({ e, k: schluessel[i]! }));
    while (offen.length) {
      const idx = offen.findIndex(o => o.e.plan.abhaengigVon.every(d => !schluessel.includes(d) || reihe.some(r => r.k === d)));
      reihe.push(offen.splice(idx < 0 ? 0 : idx, 1)[0]!);
    }
    // V3 Fix 1 (M-3) — Wächter VOR dem Anlegen (nie ein halb angelegtes Paket): jeder Schlüssel-Verweis zeigt auf einen früher angelegten Change
    for (const [i, { e, k }] of reihe.entries()) {
      for (const m of JSON.stringify(e.plan.schritte).matchAll(VERWEIS_SCHLUESSEL)) {
        if (schluessel.includes(m[2]!) && !reihe.slice(0, i).some(r => r.k === m[2])) return { ok: false, fehler: [`Change ${k}: Verweis auf Change ${m[2]}, der nicht vorher angelegt wird`] };
      }
    }
    const ids = new Map<string, string>(); const abdruck = new Map<string, string>();
    for (const c of ctx.changes) if (c.fingerabdruck) abdruck.set(c.id, c.fingerabdruck);
    const angelegt: CmdbChangeRequest[] = [];
    for (const { e, k } of reihe) {
      const abh = e.plan.abhaengigVon.map(d => ids.get(d) ?? d);
      // V3 — {{change:<schlüssel>…}} auf die volle ID der (schon angelegten) Vorgänger umschreiben, bevor Fingerabdruck und Speichern
      // den Plan festhalten; der Validator hat geprüft, dass nur Changes der Abhängigkeits-Hülle gemeint sind (die zuerst angelegt werden)
      e.plan.schritte = JSON.parse(JSON.stringify(e.plan.schritte).replace(VERWEIS_SCHLUESSEL, (m, ws: string, sk: string) => (ids.has(sk) ? `{{${ws}change:${ids.get(sk)}.` : m))) as ChangeSchritt[];
      // V3 Fix 1 (C-1) — Stand jedes Vorgängers festhalten, auf dessen Schritte verwiesen wird (Teil des eigenen Fingerabdrucks)
      const va = vorgaengerAbdruecke(e.plan.schritte, id => abdruck.get(id));
      if (va) e.plan.vorgaengerAbdruck = va; else delete e.plan.vorgaengerAbdruck;
      const aus = await this.d.auswirkung(e.betroffeneIds);
      const c = await this.d.itsm.legeAn(owner, this.daten(e.plan, e.betroffeneIds, abh, aus, [...e.hinweise, ...this.auswirkungsHinweise(aus, e.plan.typ)], vorhaben?.id));
      ids.set(k, c.id); angelegt.push(c); if (c.fingerabdruck) abdruck.set(c.id, c.fingerabdruck);
    }
    this.d.protokoll?.('I3 Changes geplant', { anzahl: angelegt.length, vorhaben: vorhaben?.id, ids: angelegt.map(c => c.id) });
    return { ok: true, changes: angelegt };
  }

  /**
   * I4b Teil 4 — Plan einer freigegebenen Standard-Vorlage prüfen (dieselben Regeln wie jeder Change) und als Standard-Change
   * speichern; das Merkmal (z. B. Host:Container) dient den Grenzen („höchstens 1× je Tag“).
   */
  async planenStandard(owner: string, roh: Record<string, unknown>, vorlage: string, merkmal: string): Promise<{ ok: true; change: CmdbChangeRequest } | { ok: false; fehler: string[] }> {
    if (!this.d.itsm.legeStandardAn) return { ok: false, fehler: ['Standard-Changes nicht verfügbar'] };
    const ctx = await this.kontext(owner);
    const e = pruefeChangePlan(roh, ctx);
    if (e.fehler.length) return { ok: false, fehler: e.fehler };
    const aus = await this.d.auswirkung(e.betroffeneIds);
    if (aus.offeneIncidents.some(i => /\b(critical|kritisch)\b/i.test(i)) && vorlage !== 'neustart_unhealthy') return { ok: false, fehler: [`Offener kritischer Incident auf betroffenen Assets (${aus.offeneIncidents.join('; ')}) — kein Standard-Change`] };
    const d = this.daten(e.plan, e.betroffeneIds, [], aus, [...e.hinweise, `Standard-Change aus Vorlage ${vorlage} (vom Owner vorab freigegeben)`, ...this.auswirkungsHinweise(aus, 'normal')]);
    (d.pruefung as unknown as { zusatz: Record<string, unknown> }).zusatz = { ...((d.pruefung as unknown as { zusatz?: Record<string, unknown> }).zusatz ?? {}), vorlage, merkmal };
    const c = await this.d.itsm.legeStandardAn(owner, d, vorlage);
    this.d.protokoll?.('I4b Standard-Change gespeichert', { id: c.id, vorlage, merkmal, status: c.status });
    return { ok: true, change: c };
  }

  /** Plan eines vorhandenen Changes ersetzen (neue Prüfung; Freigabe verfällt bei geändertem Fingerabdruck). */
  async aendern(owner: string, id: string, roh: unknown, antwortenRoh?: unknown): Promise<{ ok: true; change: CmdbChangeRequest; freigabeVerfallen: boolean; hinweis?: string } | { ok: false; fehler: string[] }> {
    const alt = await this.finde(owner, id);
    if (!alt?.schritte?.length) return { ok: false, fehler: [`Change ${id} nicht gefunden oder ohne Schritte`] };
    const ew = this.d.einwand ? await this.d.einwand.pruefeAntworten(owner, 'change', alt.id, antwortenRoh) : { fehler: [], antworten: [] };
    if (ew.fehler.length) return { ok: false, fehler: ew.fehler };
    const ctx = await this.kontext(owner);
    ctx.changes = ctx.changes.filter(c => c.id !== alt.id);
    // v1661 — Realfall 25.10. (0cd5c0a4 Schritt 8: falscher Image-Vergleich, Schritte 1–7 hatten schon gewirkt): ein angehaltener Change MIT
    // Wirkung ist ab dem Haltepunkt korrigierbar. Die schon gelaufenen Schritte übernimmt der Server unverändert aus dem gespeicherten Plan,
    // der Lauf mit seinen Ergebnissen bleibt; die Freigabe verfällt, nach dem neuen Ja geht es am Haltepunkt weiter.
    const lauf0 = alt.lauf as { phase?: string; schritt?: number; ergebnisse?: Array<{ nr: number; ok?: boolean; aktionOk?: boolean; teilweise?: boolean }> } | undefined;
    const hatGewirkt = (lauf0?.ergebnisse ?? []).some(x => (x.ok || x.aktionOk || x.teilweise) && ((alt.schritte ?? []) as ChangeSchritt[]).some(s => s.nr === x.nr && WIRKUNG.has(s.einordnung ?? '')));
    // v1685 — auch bei wartendem Owner-Schritt (dessen Frage verfällt; der Repository-Teil setzt den Lauf auf angehalten)
    const korrekturAb = alt.status === 'in_progress' && (lauf0?.phase === 'angehalten' || lauf0?.phase === 'wartet_owner') && hatGewirkt && typeof lauf0.schritt === 'number' ? lauf0.schritt : undefined;
    if (korrekturAb !== undefined) {
      const r = (typeof roh === 'string' ? (() => { try { return JSON.parse(roh) as Record<string, unknown>; } catch { return undefined; } })() : roh as Record<string, unknown> | undefined) ?? {};
      const neue = Array.isArray(r.schritte) ? r.schritte : [];
      if (neue.length < korrekturAb) return { ok: false, fehler: [`Change ${alt.id.slice(0, 8)} ist bei Schritt ${korrekturAb} angehalten und hat schon gewirkt — nur ab Schritt ${korrekturAb} änderbar; die vollständige Schrittliste mit gleicher Nummerierung senden`] };
      const gelaufen = [...((alt.schritte ?? []) as ChangeSchritt[])].filter(s => s.nr < korrekturAb).sort((a, b) => a.nr - b.nr);
      roh = { ...r, schritte: [...gelaufen, ...neue.slice(korrekturAb - 1)] };
    }
    // V3 Fix 1 (C-1) — Neu planen bindet an den JETZIGEN Stand der Vorgänger, auf deren Schritte verwiesen wird
    const va = roh && typeof roh === 'object' && !Array.isArray(roh) ? vorgaengerAbdruecke((roh as Record<string, unknown>).schritte, x => ctx.changes.find(c => c.id === x)?.fingerabdruck) : undefined;
    const e = pruefeChangePlan(roh, ctx, [], undefined, va);
    const fehler = [...e.fehler];
    const kanten = new Map(ctx.changes.map(c => [c.id, c.abhaengigVon] as [string, string[]]));
    kanten.set(alt.id, e.plan.abhaengigVon);
    const z = zyklus(kanten);
    if (z) fehler.push(`Abhängigkeiten im Kreis: ${z.join(' → ')}`);
    if (fehler.length) return { ok: false, fehler };
    const aus = await this.d.auswirkung(e.betroffeneIds, alt.id);
    // v1644 — Realfall 24.10. (5d960660: Klon auf falschen Speicher, nichts angelegt): ein angehaltener Change ohne Wirkung darf unter
    // derselben ID neu geplant werden — abhängige Changes behalten ihren Bezug; die Freigabe verfällt
    const lauf = alt.lauf as { phase?: string; ergebnisse?: Array<{ nr: number; ok?: boolean; aktionOk?: boolean; teilweise?: boolean }> } | undefined;
    // v1787 — auch ein bei einem Owner-Schritt wartender Change ohne Wirkung (Realfall bc771a88) ist neu planbar
    const haltOhneWirkung = alt.status === 'in_progress' && (lauf?.phase === 'angehalten' || lauf?.phase === 'wartet_owner')
      && !(lauf.ergebnisse ?? []).some(x => (x.ok || x.aktionOk || x.teilweise) && ((alt.schritte ?? []) as ChangeSchritt[]).some(s => s.nr === x.nr && WIRKUNG.has(s.einordnung ?? '')));
    if (alt.status === 'in_progress' && !haltOhneWirkung && korrekturAb === undefined) return { ok: false, fehler: [`Change ${alt.id.slice(0, 8)} läuft gerade — nicht änderbar (erst angehalten ist er ab dem Haltepunkt korrigierbar)`] };
    const neu = await this.d.itsm.setzeSchritte(owner, alt.id, this.daten(e.plan, e.betroffeneIds, e.plan.abhaengigVon, aus, [...e.hinweise, ...this.auswirkungsHinweise(aus, e.plan.typ)], alt.vorhabenId), { haltOhneWirkung, ...(korrekturAb !== undefined ? { korrekturAb } : {}) });
    if (ew.antworten.length) await this.d.einwand!.speichereAntworten(owner, ew.antworten);
    const verfallen = (alt.status === 'approved' || haltOhneWirkung || korrekturAb !== undefined) && neu.freigabeFingerabdruck !== neu.fingerabdruck;
    if (korrekturAb !== undefined) this.d.nachAenderung?.();
    this.d.protokoll?.('I3 Change geändert', { id: alt.id, freigabeVerfallen: verfallen, fingerabdruck: neu.fingerabdruck?.slice(0, 12) });
    // V3 Fix 1 (C-1) — nicht beendete Changes, die auf Schritte dieses Changes verweisen, sind an den alten Stand gebunden
    const abhaengige = neu.fingerabdruck !== alt.fingerabdruck
      ? ctx.changes.filter(c => !ENDE.has(c.status) && JSON.stringify(c.schritte ?? []).includes(`change:${alt.id}.`)).map(c => c.id.slice(0, 8))
      : [];
    const hinweis = abhaengige.length ? `Abhängige Changes ${abhaengige.join(', ')} verweisen auf Schritte dieses Changes — sie halten an, bis sie neu geplant sind (change_aendern).` : undefined;
    return { ok: true, change: neu, freigabeVerfallen: verfallen, ...(hinweis ? { hinweis } : {}) };
  }

  liste(owner: string): Promise<CmdbChangeRequest[]> { return this.d.itsm.liste(owner); }

  /** I4b — Asset-Namen/IDs/Quellen eindeutig auflösen (dieselben Regeln wie bei „betroffen“). */
  async loeseAssets(owner: string, namen: string[]): Promise<{ ids: string[]; namen: string[]; fehler: string[] }> {
    const ctx = await this.kontext(owner);
    const aus = { ids: [] as string[], namen: [] as string[], fehler: [] as string[] };
    for (const n of namen) {
      const a = ctx.asset(n);
      if (!a) aus.fehler.push(`„${n}“ ist kein CMDB-Asset`);
      else if ('mehrdeutig' in a) aus.fehler.push(`„${n}“ ist mehrdeutig: ${a.mehrdeutig.slice(0, 5).join('; ')}`);
      else if (!aus.ids.includes(a.id)) { aus.ids.push(a.id); aus.namen.push(a.name); }
    }
    return aus;
  }

  async finde(owner: string, k: string): Promise<CmdbChangeRequest | null> {
    const direkt = await this.d.itsm.hole(owner, k);
    if (direkt) return direkt;
    if (k.length < 6) return null;
    const t = (await this.d.itsm.liste(owner)).filter(c => c.id.startsWith(k));
    return t.length === 1 ? t[0]! : null;
  }

  /** Vor jeder Freigabe: gespeicherten Plan erneut prüfen (CMDB/Skills können sich geändert haben), Fingerabdruck vergleichen, Sperren. */
  async freigabeBereit(owner: string, c: CmdbChangeRequest): Promise<{ ok: true; auswirkung: Auswirkung; hinweise: string[] } | { ok: false; grund: string }> {
    if (!c.schritte?.length) return { ok: false, grund: 'Change ohne Schritte' };
    // v1661 — korrigierter angehaltener Change: braucht die Freigabe des neuen Plans
    const korrigiert = c.status === 'in_progress' && !!(c.lauf as { korrektur?: unknown } | undefined)?.korrektur && (c.lauf as { phase?: string }).phase === 'angehalten' && c.freigabeFingerabdruck !== c.fingerabdruck;
    if (c.status !== 'submitted' && !korrigiert) return { ok: false, grund: `Status ${c.status} — freigeben geht nur bei submitted${c.status === 'draft' ? ' (offener Einwand oder Prüffehler — erst den Plan überarbeiten)' : ''}` };
    const offen = this.d.einwand ? await this.d.einwand.offen(owner, 'change', c.id) : [];
    if (offen.length) return { ok: false, grund: `${offen.length} offene Einwände des Owners — erst beantworten (change_aendern mit antworten)` };
    const ctx = await this.kontext(owner);
    ctx.changes = ctx.changes.filter(x => x.id !== c.id);
    const e = pruefeChangePlan(planAusChange(c), ctx, [], undefined, vorgaengerAbdruckVon(c));
    if (e.fehler.length) return { ok: false, grund: `Prüfung jetzt nicht bestanden: ${e.fehler.slice(0, 5).join('; ')}` };
    if (changeFingerabdruck(e.plan, e.betroffeneIds, c.abhaengigVon ?? []) !== c.fingerabdruck) return { ok: false, grund: 'Gespeicherter Plan und Fingerabdruck passen nicht zusammen — Change neu planen' };
    const aus = await this.d.auswirkung(c.affectedAssetIds, c.id);
    if (c.type !== 'emergency' && aus.offeneIncidents.some(i => /\b(critical|kritisch)\b/i.test(i))) return { ok: false, grund: `Offener kritischer Incident auf betroffenen Assets (${aus.offeneIncidents.join('; ')}) — erst klären oder als Notfall-Change planen` };
    return { ok: true, auswirkung: aus, hinweise: [...(c.pruefung?.hinweise ?? []), ...this.auswirkungsHinweise(aus, c.type === 'emergency' ? 'notfall' : 'normal')] };
  }

  /**
   * Freigabe-Frage an den Owner (App/Telegram-Button) für einen oder mehrere Changes — Einmal-Freigabe über Fingerabdrücke.
   * V3 — `zusatz` (Bauplan: Herkunft, Netz/Firewall/Löschung, Werte über Change-Grenzen) steht direkt nach der Kopfzeile.
   */
  async freigabeAnfragen(owner: string, keys: string[], zusatz?: string): Promise<{ ok: true; text: string } | { ok: false; fehler: string[] }> {
    if (!this.d.bestaetigung) return { ok: false, fehler: ['Freigabe-Fragen sind nicht verfügbar'] };
    const fehler: string[] = []; const teile: string[] = []; const changes: Array<{ id: string; fingerabdruck: string }> = []; const titel: string[] = [];
    for (const k of keys) {
      const c = await this.finde(owner, k);
      if (!c) { fehler.push(`${k}: nicht gefunden`); continue; }
      const b = await this.freigabeBereit(owner, c);
      if (!b.ok) { fehler.push(`${c.title} (${c.id.slice(0, 8)}): ${b.grund}`); continue; }
      changes.push({ id: c.id, fingerabdruck: c.fingerabdruck! });
      titel.push(`${c.title} (${c.id.slice(0, 8)})`);
      const einwaende = this.d.einwand ? await this.d.einwand.antwortText(owner, 'change', c.id) : '';
      if (einwaende) teile.push(einwaende);
      teile.push(freigabeText({ id: c.id, titel: c.title, risiko: RISIKO_TEXT[c.riskLevel] ?? c.riskLevel, typ: c.type === 'emergency' ? 'Notfall-Change' : 'Normal-Change', ...(c.ausfallMinuten !== undefined ? { ausfallMinuten: c.ausfallMinuten } : {}), ...(c.scheduledAt ? { geplantAb: c.scheduledAt } : {}), schritte: c.schritte as ChangeSchritt[], auswirkung: b.auswirkung, hinweise: b.hinweise, fingerabdruck: c.fingerabdruck! }));
    }
    if (fehler.length) return { ok: false, fehler };
    const params = { action: 'freigeben', changes };
    // Einmal-Freigabe: der Wert geht nur in die Bestätigungs-Queue, am Change steht nur sein Hash (übersteht Neustarts)
    const nonce = randomUUID();
    const bis = new Date((this.d.jetzt?.() ?? Date.now()) + FREIGABE_FRAGE_GUELTIG_MS).toISOString();
    for (const c of changes) await this.d.itsm.setzeFreigabeAnfrage(owner, c.id, { hash: hash(nonce), bis, fingerabdruck: c.fingerabdruck });
    // v1600 — Realfall 22.10.: Die App zeigt nur die ersten 80–100 Zeichen („Freigegeben: Change freigeben: **Übergangss…“) → Titel in die erste Zeile
    const kopf = changes.length > 1 ? `${changes.length} Changes freigeben: ${titel.join(' · ')}` : `Change freigeben: ${titel[0]}`;
    const ok = await this.d.bestaetigung({ description: `${kopf}\n\n${zusatz?.trim() ? `${zusatz.trim()}\n\n` : ''}${teile.join('\n\n')}\n\nNach dem Ja startet der Ausführungsmotor den Change — sofort oder im nächsten passenden Wartungsfenster (nie in einer Sperrzeit) und meldet das Ergebnis. „Nein, weil …“ wird ein Einwand.`, params: { ...params, freigabe: nonce } });
    if (!ok) return { ok: false, fehler: ['Freigabe-Frage konnte nicht gestellt werden'] };
    this.d.protokoll?.('I3 Freigabe angefragt', { changes: changes.map(c => c.id) });
    return { ok: true, text: `Freigabe-Frage gestellt (${changes.length} Change${changes.length > 1 ? 's' : ''}) — der Owner bestätigt in der App oder in Telegram.` };
  }

  /** Nach dem Owner-Ja: Einmal-Freigabe verbrauchen und jeden Change mit seinem Fingerabdruck freigeben. */
  async freigebenNachJa(owner: string, input: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    const changes = Array.isArray(input.changes) ? (input.changes as Array<{ id?: unknown; fingerabdruck?: unknown }>).filter(c => typeof c?.id === 'string' && typeof c?.fingerabdruck === 'string') as Array<{ id: string; fingerabdruck: string }> : [];
    const nonce = typeof input.freigabe === 'string' ? input.freigabe : '';
    const keine = { ok: false, text: 'Keine gültige Freigabe — freigeben geht nur über das Ja des Owners auf die Freigabe-Frage (freigabe_anfragen).' };
    if (!nonce || !changes.length) return keine;
    const jetzt = this.d.jetzt?.() ?? Date.now();
    const z: string[] = [];
    for (const c of changes) {
      const akt = await this.d.itsm.hole(owner, c.id);
      const a = akt?.freigabeAnfrage;
      // Jeder Change muss genau diese Frage offen haben: gleicher Hash, nicht abgelaufen, gleicher Plan
      if (!a || a.hash !== hash(nonce) || Date.parse(a.bis) < jetzt || a.fingerabdruck !== c.fingerabdruck) { z.push(`✗ ${akt?.title ?? c.id}: ${keine.text}`); continue; }
      await this.d.itsm.setzeFreigabeAnfrage(owner, c.id, null); // einmal verwendbar
      const b = akt ? await this.freigabeBereit(owner, akt) : { ok: false as const, grund: 'nicht gefunden' };
      if (!b.ok) { z.push(`✗ ${akt?.title ?? c.id}: ${b.grund}`); continue; }
      try { const f = await this.d.itsm.freigeben(owner, c.id, c.fingerabdruck, 'frage'); await this.d.einwand?.erledigeBeantwortete(owner, 'change', f.id); z.push(`✓ ${f.title} (${f.id.slice(0, 8)}) freigegeben`); }
      catch (err) { z.push(`✗ ${akt!.title}: ${(err as Error).message}`); }
    }
    this.d.protokoll?.('I3 Owner-Freigabe', { ergebnis: z });
    if (z.some(x => x.startsWith('✓'))) this.d.nachFreigabe?.();
    return { ok: z.every(x => x.startsWith('✓')), text: z.join('\n') };
  }

  /** Freigabe über das Web (angemeldeter Owner, Knopf „Approve“). */
  async freigebenWeb(owner: string, id: string): Promise<CmdbChangeRequest> {
    const c = await this.finde(owner, id);
    if (!c) throw new Error(`Change ${id} nicht gefunden`);
    const b = await this.freigabeBereit(owner, c);
    if (!b.ok) throw new Error(b.grund);
    const f = await this.d.itsm.freigeben(owner, c.id, c.fingerabdruck!, 'web');
    await this.d.einwand?.erledigeBeantwortete(owner, 'change', f.id);
    this.d.protokoll?.('I3 Owner-Freigabe', { id: c.id, ueber: 'web' });
    this.d.nachFreigabe?.();
    return f;
  }
}

/** Darstellung eines Changes mit Schritten (Chat). */
export function changeAnzeige(c: CmdbChangeRequest): string {
  const s = (c.schritte ?? []) as ChangeSchritt[];
  const a = c.auswirkung as Auswirkung | undefined;
  const fr = c.status === 'approved' ? `freigegeben ${c.freigegebenAt?.slice(0, 16).replace('T', ' ')} UTC über ${c.freigegebenUeber === 'web' ? 'Web' : 'Freigabe-Frage'}` : c.status === 'submitted' ? 'wartet auf Freigabe' : c.status;
  const z = [
    `## ${c.title}`, '',
    `**ID:** ${c.id} · **Typ:** ${c.type === 'emergency' ? 'Notfall' : 'Normal'} · **Risiko:** ${RISIKO_TEXT[c.riskLevel] ?? c.riskLevel} · **Ausfall:** ${c.ausfallMinuten ?? '?'} min · **Status:** ${fr}`,
    c.scheduledAt ? `**Geplant ab:** ${c.scheduledAt.slice(0, 16).replace('T', ' ')} UTC` : '',
    c.vorhabenId ? `**Vorhaben:** ${c.vorhabenId.slice(0, 8)}` : '',
    c.abhaengigVon?.length ? `**Hängt ab von:** ${c.abhaengigVon.map(x => x.slice(0, 8)).join(', ')}` : '',
    `**Plan:** ${c.fingerabdruck?.slice(0, 12)}`, '', c.description ?? '', '',
    '| # | Schritt | Art | Was | Prüfung | Rückweg | bei Fehler |', '|---|---|---|---|---|---|---|',
    ...s.map(x => `| ${x.nr} | ${x.titel} | ${x.einordnung ?? x.art} | ${schrittText(x).replace(/\|/g, '/')} | ${pruefText(x.pruefung).replace(/\|/g, '/')} | ${x.rueckweg ? (x.rueckweg.keiner ? `keiner: ${x.rueckweg.keiner}` : `${x.rueckweg.skill}.${x.rueckweg.aktion}`) : '—'} | ${x.beiFehler} |`),
  ];
  if (a) z.push('', `**Auswirkung:** ${a.assets.join(', ')}${a.abhaengige.length ? `; abhängig: ${a.abhaengige.slice(0, 10).join(', ')}` : ''}${a.services.length ? `; Services: ${a.services.map(x => `${x.name} (${x.kritikalitaet})`).join(', ')}` : ''}`);
  if (c.pruefung?.hinweise.length) z.push('', '**Hinweise:**', ...c.pruefung.hinweise.map(x => `- ${x}`));
  const l = c.lauf as { phase?: string; schritt?: number; grund?: string; ergebnisse?: Array<{ nr: number; ok: boolean; fehler?: string; pruefung?: { text: string } }> } | undefined;
  if (l?.phase) z.push('', `**Lauf:** ${l.phase}${l.schritt ? `, Schritt ${l.schritt}` : ''}${l.grund ? ` — ${l.grund}` : ''}`, ...(l.ergebnisse ?? []).map(e => `- ${e.ok ? '✓' : '✗'} Schritt ${e.nr}${e.pruefung ? `: ${e.pruefung.text}` : ''}${e.fehler ? ` — ${e.fehler}` : ''}`));
  if (c.result && ['completed', 'failed', 'rolled_back', 'cancelled'].includes(c.status)) z.push('', '**Bericht:**', c.result);
  return z.filter(x => x !== undefined).join('\n').replace(/\n{3,}/g, '\n\n');
}
