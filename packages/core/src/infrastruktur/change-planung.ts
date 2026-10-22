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
  setzeSchritte(owner: string, id: string, d: ChangeSchrittDaten): Promise<CmdbChangeRequest>;
  freigeben(owner: string, id: string, fingerabdruck: string, ueber: 'frage' | 'web'): Promise<CmdbChangeRequest>;
  setzeFreigabeAnfrage(owner: string, id: string, a: { hash: string; bis: string; fingerabdruck: string } | null): Promise<void>;
}
/** Gültigkeit einer Freigabe-Frage (das Ja kann auch Stunden später kommen; der Fingerabdruck bindet sie an den Plan) */
export const FREIGABE_FRAGE_GUELTIG_MS = 24 * 3_600_000;
const hash = (nonce: string) => createHash('sha256').update(nonce).digest('hex');
export interface ChangeDeps {
  itsm: ChangeSpeicher;
  skill: PruefKontext['skill'];
  assets: () => Promise<Array<{ id: string; name: string; hostname?: string; status?: string }>>;
  auswirkung: (assetIds: string[], ohneChangeId?: string) => Promise<Auswirkung>;
  bestaetigung?: (frage: { description: string; params: Record<string, unknown> }) => Promise<boolean>;
  jetzt?: () => number;
  protokoll?: (msg: string, daten: Record<string, unknown>) => void;
}

const RISIKO_TEXT: Record<string, string> = { low: 'niedrig', medium: 'mittel', high: 'hoch', critical: 'kritisch' };

/** Gespeicherten Change wieder in die Planform bringen (für die erneute Prüfung vor der Freigabe). */
export function planAusChange(c: CmdbChangeRequest): Record<string, unknown> {
  const z = (c.pruefung as { zusatz?: { zweck?: string; ohneSicherungGrund?: string } } | undefined)?.zusatz ?? {};
  return {
    titel: c.title, begruendung: c.description ?? '', typ: c.type === 'emergency' ? 'notfall' : c.type, risiko: c.riskLevel,
    ausfallMinuten: c.ausfallMinuten, ...(c.scheduledAt ? { geplantAb: c.scheduledAt } : {}), betroffen: c.affectedAssetIds,
    abhaengigVon: c.abhaengigVon ?? [], ...(z.zweck ? { zweck: z.zweck } : {}), ...(z.ohneSicherungGrund ? { ohneSicherungGrund: z.ohneSicherungGrund } : {}),
    schritte: (c.schritte ?? []) as unknown[],
  };
}

export class ChangePlanung {
  constructor(private readonly d: ChangeDeps) {}

  private async kontext(owner: string): Promise<PruefKontext> {
    const [assets, changes] = await Promise.all([this.d.assets(), this.d.itsm.liste(owner)]);
    return {
      skill: this.d.skill,
      changes: changes.map(c => ({ id: c.id, abhaengigVon: c.abhaengigVon ?? [], status: c.status })),
      asset: (k: string) => {
        const n = k.trim().toLowerCase();
        const id = assets.find(a => a.id === k.trim());
        if (id) return { id: id.id, name: id.name };
        let treffer = assets.filter(a => a.name.toLowerCase() === n || a.hostname?.toLowerCase() === n);
        if (treffer.length > 1) { const aktiv = treffer.filter(a => a.status === 'active'); if (aktiv.length) treffer = aktiv; }
        if (treffer.length > 1) return { mehrdeutig: treffer.map(a => `${a.name} ${a.id.slice(0, 8)}`) };
        return treffer[0] ? { id: treffer[0].id, name: treffer[0].name } : undefined;
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
      pruefung: { fehler: [], hinweise, zeit: new Date().toISOString(), ...({ zusatz: { ...(plan.zweck ? { zweck: plan.zweck } : {}), ...(plan.ohneSicherungGrund ? { ohneSicherungGrund: plan.ohneSicherungGrund } : {}) } }) } as ChangeSchrittDaten['pruefung'],
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

  /** Paket planen. `vorhaben` nur mit angenommener Architektur. */
  async planen(owner: string, roh: unknown[], vorhaben?: { id: string; status: string; titel: string }): Promise<{ ok: true; changes: CmdbChangeRequest[] } | { ok: false; fehler: string[] }> {
    if (vorhaben && vorhaben.status !== 'angenommen') return { ok: false, fehler: [`Vorhaben „${vorhaben.titel}“: Architektur ist noch nicht angenommen — erst entscheidet der Owner`] };
    if (!roh.length) return { ok: false, fehler: ['changes fehlt'] };
    if (roh.length > 30) return { ok: false, fehler: ['höchstens 30 Changes je Paket'] };
    const ctx = await this.kontext(owner);
    const schluessel = roh.map((r, i) => String((r as Record<string, unknown>)?.schluessel ?? `c${i + 1}`));
    if (new Set(schluessel).size !== schluessel.length) return { ok: false, fehler: ['schluessel der Changes müssen eindeutig sein'] };
    const ergebnisse = roh.map((r, i) => pruefeChangePlan({ ...(r as object), schluessel: schluessel[i] }, ctx, schluessel));
    const fehler = ergebnisse.flatMap((e, i) => e.fehler.map(x => `Change ${schluessel[i]} (${e.plan.titel || '?'}): ${x}`));
    const kanten = new Map<string, string[]>();
    for (const c of ctx.changes) kanten.set(c.id, c.abhaengigVon);
    ergebnisse.forEach((e, i) => kanten.set(schluessel[i]!, e.plan.abhaengigVon));
    const z = zyklus(kanten);
    if (z) fehler.push(`Abhängigkeiten im Kreis: ${z.join(' → ')}`);
    if (fehler.length) return { ok: false, fehler };
    // Reihenfolge: Abhängigkeiten innerhalb des Pakets zuerst anlegen (kein Kreis → terminiert)
    const ids = new Map<string, string>();
    const angelegt: CmdbChangeRequest[] = [];
    const offen = ergebnisse.map((e, i) => ({ e, k: schluessel[i]! }));
    while (offen.length) {
      const idx = offen.findIndex(o => o.e.plan.abhaengigVon.every(d => !schluessel.includes(d) || ids.has(d)));
      const { e, k } = offen.splice(idx < 0 ? 0 : idx, 1)[0]!;
      const abh = e.plan.abhaengigVon.map(d => ids.get(d) ?? d);
      const aus = await this.d.auswirkung(e.betroffeneIds);
      const c = await this.d.itsm.legeAn(owner, this.daten(e.plan, e.betroffeneIds, abh, aus, [...e.hinweise, ...this.auswirkungsHinweise(aus, e.plan.typ)], vorhaben?.id));
      ids.set(k, c.id); angelegt.push(c);
    }
    this.d.protokoll?.('I3 Changes geplant', { anzahl: angelegt.length, vorhaben: vorhaben?.id, ids: angelegt.map(c => c.id) });
    return { ok: true, changes: angelegt };
  }

  /** Plan eines vorhandenen Changes ersetzen (neue Prüfung; Freigabe verfällt bei geändertem Fingerabdruck). */
  async aendern(owner: string, id: string, roh: unknown): Promise<{ ok: true; change: CmdbChangeRequest; freigabeVerfallen: boolean } | { ok: false; fehler: string[] }> {
    const alt = await this.finde(owner, id);
    if (!alt?.schritte?.length) return { ok: false, fehler: [`Change ${id} nicht gefunden oder ohne Schritte`] };
    const ctx = await this.kontext(owner);
    ctx.changes = ctx.changes.filter(c => c.id !== alt.id);
    const e = pruefeChangePlan(roh, ctx);
    const fehler = [...e.fehler];
    const kanten = new Map(ctx.changes.map(c => [c.id, c.abhaengigVon] as [string, string[]]));
    kanten.set(alt.id, e.plan.abhaengigVon);
    const z = zyklus(kanten);
    if (z) fehler.push(`Abhängigkeiten im Kreis: ${z.join(' → ')}`);
    if (fehler.length) return { ok: false, fehler };
    const aus = await this.d.auswirkung(e.betroffeneIds, alt.id);
    const neu = await this.d.itsm.setzeSchritte(owner, alt.id, this.daten(e.plan, e.betroffeneIds, e.plan.abhaengigVon, aus, [...e.hinweise, ...this.auswirkungsHinweise(aus, e.plan.typ)], alt.vorhabenId));
    const verfallen = alt.status === 'approved' && neu.status !== 'approved';
    this.d.protokoll?.('I3 Change geändert', { id: alt.id, freigabeVerfallen: verfallen, fingerabdruck: neu.fingerabdruck?.slice(0, 12) });
    return { ok: true, change: neu, freigabeVerfallen: verfallen };
  }

  liste(owner: string): Promise<CmdbChangeRequest[]> { return this.d.itsm.liste(owner); }

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
    if (c.status !== 'submitted') return { ok: false, grund: `Status ${c.status} — freigeben geht nur bei submitted` };
    const ctx = await this.kontext(owner);
    ctx.changes = ctx.changes.filter(x => x.id !== c.id);
    const e = pruefeChangePlan(planAusChange(c), ctx);
    if (e.fehler.length) return { ok: false, grund: `Prüfung jetzt nicht bestanden: ${e.fehler.slice(0, 5).join('; ')}` };
    if (changeFingerabdruck(e.plan, e.betroffeneIds, c.abhaengigVon ?? []) !== c.fingerabdruck) return { ok: false, grund: 'Gespeicherter Plan und Fingerabdruck passen nicht zusammen — Change neu planen' };
    const aus = await this.d.auswirkung(c.affectedAssetIds, c.id);
    if (c.type !== 'emergency' && aus.offeneIncidents.some(i => /\b(critical|kritisch)\b/i.test(i))) return { ok: false, grund: `Offener kritischer Incident auf betroffenen Assets (${aus.offeneIncidents.join('; ')}) — erst klären oder als Notfall-Change planen` };
    return { ok: true, auswirkung: aus, hinweise: [...(c.pruefung?.hinweise ?? []), ...this.auswirkungsHinweise(aus, c.type === 'emergency' ? 'notfall' : 'normal')] };
  }

  /** Freigabe-Frage an den Owner (App/Telegram-Button) für einen oder mehrere Changes — Einmal-Freigabe über Fingerabdrücke. */
  async freigabeAnfragen(owner: string, keys: string[]): Promise<{ ok: true; text: string } | { ok: false; fehler: string[] }> {
    if (!this.d.bestaetigung) return { ok: false, fehler: ['Freigabe-Fragen sind nicht verfügbar'] };
    const fehler: string[] = []; const teile: string[] = []; const changes: Array<{ id: string; fingerabdruck: string }> = [];
    for (const k of keys) {
      const c = await this.finde(owner, k);
      if (!c) { fehler.push(`${k}: nicht gefunden`); continue; }
      const b = await this.freigabeBereit(owner, c);
      if (!b.ok) { fehler.push(`${c.title} (${c.id.slice(0, 8)}): ${b.grund}`); continue; }
      changes.push({ id: c.id, fingerabdruck: c.fingerabdruck! });
      teile.push(freigabeText({ id: c.id, titel: c.title, risiko: RISIKO_TEXT[c.riskLevel] ?? c.riskLevel, typ: c.type === 'emergency' ? 'Notfall-Change' : 'Normal-Change', ...(c.ausfallMinuten !== undefined ? { ausfallMinuten: c.ausfallMinuten } : {}), ...(c.scheduledAt ? { geplantAb: c.scheduledAt } : {}), schritte: c.schritte as ChangeSchritt[], auswirkung: b.auswirkung, hinweise: b.hinweise, fingerabdruck: c.fingerabdruck! }));
    }
    if (fehler.length) return { ok: false, fehler };
    const params = { action: 'freigeben', changes };
    // Einmal-Freigabe: der Wert geht nur in die Bestätigungs-Queue, am Change steht nur sein Hash (übersteht Neustarts)
    const nonce = randomUUID();
    const bis = new Date((this.d.jetzt?.() ?? Date.now()) + FREIGABE_FRAGE_GUELTIG_MS).toISOString();
    for (const c of changes) await this.d.itsm.setzeFreigabeAnfrage(owner, c.id, { hash: hash(nonce), bis, fingerabdruck: c.fingerabdruck });
    const kopf = changes.length > 1 ? `${changes.length} Changes freigeben (Paket):` : 'Change freigeben:';
    const ok = await this.d.bestaetigung({ description: `${kopf}\n\n${teile.join('\n\n')}\n\nNach dem Ja ist der Change freigegeben, ausgeführt wird er erst im Ausführungsmotor (folgt mit I4).`, params: { ...params, freigabe: nonce } });
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
      try { const f = await this.d.itsm.freigeben(owner, c.id, c.fingerabdruck, 'frage'); z.push(`✓ ${f.title} (${f.id.slice(0, 8)}) freigegeben`); }
      catch (err) { z.push(`✗ ${akt!.title}: ${(err as Error).message}`); }
    }
    this.d.protokoll?.('I3 Owner-Freigabe', { ergebnis: z });
    return { ok: z.every(x => x.startsWith('✓')), text: z.join('\n') };
  }

  /** Freigabe über das Web (angemeldeter Owner, Knopf „Approve“). */
  async freigebenWeb(owner: string, id: string): Promise<CmdbChangeRequest> {
    const c = await this.finde(owner, id);
    if (!c) throw new Error(`Change ${id} nicht gefunden`);
    const b = await this.freigabeBereit(owner, c);
    if (!b.ok) throw new Error(b.grund);
    const f = await this.d.itsm.freigeben(owner, c.id, c.fingerabdruck!, 'web');
    this.d.protokoll?.('I3 Owner-Freigabe', { id: c.id, ueber: 'web' });
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
  return z.filter(x => x !== undefined).join('\n').replace(/\n{3,}/g, '\n\n');
}
