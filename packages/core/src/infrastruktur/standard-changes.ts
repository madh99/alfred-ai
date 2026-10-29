/**
 * I4b Teil 4 — Standard-Changes: einmalige Owner-Freigabe je Vorlage (Button, Hash der Einmal-Freigabe in der DB, an den
 * Vorlagen-Abdruck gebunden), Widerruf, Anlegen eines Changes aus einer freigegebenen Vorlage (gleiche Planprüfung wie jeder
 * Change; Start durch den Motor nach Zeitplan).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { CmdbChangeRequest } from '@alfred/types';
import { VORLAGEN, vorlagenAbdruck, type Annahme, type StandardKontext, type Vorlage } from './standard-vorlagen.js';
import type { Pruefung } from './change-schritte.js';

export interface StandardDeps {
  stand(o: string): Promise<Array<{ vorlage: string; abdruck: string; status: string; frageHash?: string; frageBis?: string; freigegebenAt?: string }>>;
  setze(o: string, vorlage: string, d: { abdruck: string; status: 'angefragt' | 'freigegeben' | 'widerrufen' | 'ueberpruefen'; frageHash?: string | null; frageBis?: string | null }): Promise<void>;
  /** S1 — lesende Prüfung einer Annahme (Motor.pruefe) */
  pruefe?: (p: Pruefung) => Promise<{ ok: boolean; text: string }>;
  /** S1 — erfolgreich abgeschlossene Läufe dieser Vorlage (Anzahl, letzter Abschluss ISO) */
  laeufe?: (o: string, vorlage: string) => Promise<{ anzahl: number; letzter?: string }>;
  /** S1 — Meldung an den Owner (Sperre, Verfall, Abweichung) */
  melde?: (text: string) => Promise<void>;
  /** S4 — Serie als normales Change-Paket anlegen (verkettet) und EINE Freigabe-Frage stellen (Owner 27.10.: ein Ja je Serie) */
  planeSerie?: (o: string, plaene: Array<Record<string, unknown>>) => Promise<{ ok: true; ids: string[] } | { ok: false; fehler: string[] }>;
  freigabeAnfragen?: (o: string, ids: string[]) => Promise<string>;
  kontext(o: string): Promise<StandardKontext>;
  /** Plan prüfen und als Standard-Change (sofort freigegeben) speichern */
  speichere(o: string, plan: Record<string, unknown>, vorlage: string, merkmal: string): Promise<{ ok: true; change: CmdbChangeRequest } | { ok: false; fehler: string[] }>;
  frage?: (description: string, params: Record<string, unknown>) => Promise<boolean>;
  nachAnlage?: () => void;
  jetzt?: () => number;
  protokoll?: (msg: string, daten: Record<string, unknown>) => void;
  vorlagen?: Vorlage[];
}
const GUELTIG_MS = 24 * 3_600_000;
/** S1 — Owner 27.10.: nach mindestens 2 Monaten ohne Lauf wird eine Vorlage überprüft */
export const VERFALL_MS = 61 * 86_400_000;
const hash = (n: string) => createHash('sha256').update(n).digest('hex');

export class StandardChanges {
  private readonly vorlagen: Vorlage[];
  constructor(private readonly d: StandardDeps) { this.vorlagen = d.vorlagen ?? VORLAGEN; }
  private jetzt() { return this.d.jetzt?.() ?? Date.now(); }
  vorlage(key: string) { return this.vorlagen.find(v => v.key === key); }

  async liste(o: string): Promise<Array<{ key: string; titel: string; beschreibung: string; parameter: Record<string, string>; zustand: string; annahmen?: string[]; laeufe?: number; letzterLauf?: string }>> {
    const st = await this.d.stand(o);
    const liste: Array<{ key: string; titel: string; beschreibung: string; parameter: Record<string, string>; zustand: string; annahmen?: string[]; laeufe?: number; letzterLauf?: string }> = this.vorlagen.map(v => {
      const s = st.find(x => x.vorlage === v.key);
      const zustand = !v.verfuegbar ? `folgt ${v.folgt ?? ''}`.trim()
        : s?.status === 'freigegeben' && s.abdruck === vorlagenAbdruck(v) ? `freigegeben ${s.freigegebenAt?.slice(0, 10) ?? ''}`.trim()
        : s?.status === 'freigegeben' ? 'Vorlage geändert — neue Freigabe nötig'
        : s?.status === 'angefragt' ? 'Freigabe angefragt' : s?.status === 'widerrufen' ? 'widerrufen' : s?.status === 'ueberpruefen' ? 'überprüfen — gesperrt, neue Freigabe nötig' : 'nicht freigegeben';
      return { key: v.key, titel: v.titel, beschreibung: v.beschreibung, parameter: v.parameter, zustand, ...(v.annahmenText?.length ? { annahmen: v.annahmenText } : {}) };
    });
    // S1 — Zähler: erfolgreiche Läufe und letzter Lauf je Vorlage
    for (const z of liste) { const l = await this.d.laeufe?.(o, z.key).catch(() => undefined); if (l) Object.assign(z, { laeufe: l.anzahl, ...(l.letzter ? { letzterLauf: l.letzter } : {}) }); }
    return liste;
  }

  async freigabeAnfragen(o: string, key: string): Promise<string> {
    const v = this.vorlage(key);
    if (!v) return `Vorlage „${key}“ unbekannt`;
    if (!v.verfuegbar) return `${v.titel} folgt ${v.folgt ?? 'später'}`;
    if (!this.d.frage) return 'Freigabe-Fragen nicht verfügbar';
    const nonce = randomUUID();
    await this.d.setze(o, key, { abdruck: vorlagenAbdruck(v), status: 'angefragt', frageHash: hash(nonce), frageBis: new Date(this.jetzt() + GUELTIG_MS).toISOString() });
    const ok = await this.d.frage(`📋 Standard-Change-Vorlage freigeben: ${v.titel}\n\n${v.beschreibung}\n\nNach dem Ja darf Alfred aus dieser Vorlage Changes ohne Einzel-Ja anlegen — nur innerhalb dieser Grenzen, im Wartungsfenster, mit Prüfung und Bericht. Widerruf jederzeit („Standard-Vorlage ${v.key} widerrufen“).`, { action: 'standard_freigeben', vorlage: key, freigabe: nonce });
    this.d.protokoll?.('I4b Standard-Vorlage Freigabe angefragt', { vorlage: key, frage: ok });
    return ok ? `Freigabe-Frage zur Vorlage ${v.titel} gestellt.` : 'Frage konnte nicht gestellt werden';
  }

  async freigebenNachJa(o: string, key: string, nonce: unknown): Promise<{ ok: boolean; text: string }> {
    const v = this.vorlage(key);
    const s = (await this.d.stand(o)).find(x => x.vorlage === key);
    if (!v || !s || s.status !== 'angefragt' || typeof nonce !== 'string' || s.frageHash !== hash(nonce) || !s.frageBis || Date.parse(s.frageBis) < this.jetzt() || s.abdruck !== vorlagenAbdruck(v)) {
      return { ok: false, text: 'Keine gültige Freigabe — Vorlagen gibt nur der Owner über die Freigabe-Frage frei.' };
    }
    await this.d.setze(o, key, { abdruck: s.abdruck, status: 'freigegeben', frageHash: null, frageBis: null });
    this.d.protokoll?.('I4b Standard-Vorlage freigegeben', { vorlage: key });
    return { ok: true, text: `Vorlage ${v.titel} ist freigegeben.` };
  }

  async widerrufen(o: string, key: string): Promise<string> {
    const v = this.vorlage(key);
    if (!v) return `Vorlage „${key}“ unbekannt`;
    await this.d.setze(o, key, { abdruck: vorlagenAbdruck(v), status: 'widerrufen', frageHash: null, frageBis: null });
    this.d.protokoll?.('I4b Standard-Vorlage widerrufen', { vorlage: key });
    return `Vorlage ${v.titel} widerrufen — Alfred legt daraus keine Changes mehr an.`;
  }

  /** Gemeinsame Prüfung: freigegeben, nicht gesperrt, nicht verfallen */
  private async nutzbar(o: string, key: string): Promise<{ v: Vorlage } | { fehler: string }> {
    const v = this.vorlage(key);
    if (!v) return { fehler: `Vorlage „${key}“ unbekannt (${this.vorlagen.map(x => x.key).join(', ')})` };
    if (!v.verfuegbar || !v.erzeuge) return { fehler: `${v.titel} folgt ${v.folgt ?? 'später'}` };
    const s = (await this.d.stand(o)).find(x => x.vorlage === key);
    if (s?.status === 'ueberpruefen') return { fehler: `Vorlage ${v.titel} ist gesperrt (überprüfen) — ein Lauf hielt an oder sie lief über 2 Monate nicht. Erst prüfen, dann neu freigeben (standard_freigabe_anfragen).` };
    if (s?.status !== 'freigegeben' || s.abdruck !== vorlagenAbdruck(v)) return { fehler: `Vorlage ${v.titel} ist nicht (mehr) freigegeben — erst standard_freigabe_anfragen, der Owner bestätigt einmal` };
    const l = await this.d.laeufe?.(o, key).catch(() => undefined);
    const seit = Math.max(Date.parse(l?.letzter ?? '') || 0, Date.parse(s.freigegebenAt ?? '') || 0);
    if (seit && this.jetzt() - seit > VERFALL_MS) {
      await this.sperre(o, key, `über 2 Monate ohne Lauf (seit ${new Date(seit).toISOString().slice(0, 10)})`);
      return { fehler: `Vorlage ${v.titel}: über 2 Monate ohne Lauf — gesperrt, bitte prüfen und neu freigeben` };
    }
    return { v };
  }

  /** Eingangskontrolle einer Vorlage für einen Parametersatz: Abweichungen (leer = passt) */
  private async kontrolle(v: Vorlage, p: Record<string, unknown>, kx: StandardKontext): Promise<{ annahmen: Annahme[]; abw: string[] }> {
    const annahmen: Annahme[] = v.annahmen ? await v.annahmen(p, kx) : [];
    const abw: string[] = [];
    if (annahmen.length && this.d.pruefe) {
      for (const a of annahmen) {
        const r = await this.d.pruefe(a.pruefung).catch((err: Error) => ({ ok: false, text: err.message }));
        if (!r.ok) abw.push(`${a.text}: ${r.text.slice(0, 160)}`);
      }
    }
    return { annahmen, abw };
  }

  /**
   * S4 — Serie: Vorlage für mehrere Hosts als verkettetes Change-Paket mit EINER Freigabe-Frage (Owner 27.10.: „je Serie“). Hosts aus
   * `zugaenge` oder alle mit Schalter „Updates an“ (Reihenfolge aus dem Kontext). Jeder Host durchläuft Grenzen und Eingangskontrolle;
   * wer nicht passt, wird ausgelassen und gemeldet, die übrigen laufen. Hält ein Glied an, warten die folgenden (Abhängigkeit).
   */
  async serie(o: string, key: string, opts: { zugaenge?: string[]; parameter?: Record<string, unknown>; geplantAb?: string }): Promise<{ ok: true; text: string; ids: string[] } | { ok: false; fehler: string[] }> {
    if (!this.d.planeSerie || !this.d.freigabeAnfragen) return { ok: false, fehler: ['Serien sind hier nicht verfügbar'] };
    const n = await this.nutzbar(o, key);
    if ('fehler' in n) return { ok: false, fehler: [n.fehler] };
    const kx = await this.d.kontext(o);
    const hosts = opts.zugaenge?.length ? opts.zugaenge : (await kx.zugaengeMitUpdates?.()) ?? [];
    if (!hosts.length) return { ok: false, fehler: ['keine Hosts — kein Fernzugang mit Schalter „Sicherheitsupdates an“ (updates_schalter)'] };
    const plaene: Array<Record<string, unknown>> = []; const ausgelassen: string[] = [];
    for (const z of hosts) {
      const p = { ...(opts.parameter ?? {}), zugang: z };
      const e = await n.v.erzeuge!(p, kx);
      if ('fehler' in e) { ausgelassen.push(`${z}: ${e.fehler}`); continue; }
      const k = await this.kontrolle(n.v, p, kx);
      if (k.abw.length) { ausgelassen.push(`${z}: Eingangskontrolle weicht ab — ${k.abw.join('; ')}`); continue; }
      const vorher = plaene.at(-1)?.schluessel as string | undefined;
      plaene.push({
        ...e.plan, schluessel: `serie${plaene.length + 1}`, ...(vorher ? { abhaengigVon: [vorher] } : {}), ...(opts.geplantAb ? { geplantAb: opts.geplantAb } : {}),
        begruendung: `Standard-Serie ${key} (${n.v.titel}): ${String(e.plan.begruendung ?? '')}`,
        schritte: [...k.annahmen.map(a => ({ titel: `Eingangskontrolle: ${a.text}`, art: 'pruefung', pruefung: a.pruefung, beiFehler: 'anhalten' })), ...((e.plan.schritte as unknown[]) ?? [])],
      });
    }
    if (ausgelassen.length) await this.d.melde?.(`📋 Serie ${n.v.titel}: ausgelassen — ${ausgelassen.join(' · ')}`).catch(() => undefined);
    if (!plaene.length) return { ok: false, fehler: [`kein Host passt: ${ausgelassen.join(' · ')}`] };
    const r = await this.d.planeSerie(o, plaene);
    if (!r.ok) return r;
    const frage = await this.d.freigabeAnfragen(o, r.ids);
    this.d.protokoll?.('S4 Standard-Serie angelegt', { vorlage: key, ids: r.ids, ausgelassen });
    return { ok: true, ids: r.ids, text: `Serie ${n.v.titel}: ${r.ids.length} Changes verkettet (${hosts.filter(h => !ausgelassen.some(a => a.startsWith(`${h}:`))).join(' → ')}).${ausgelassen.length ? ` Ausgelassen: ${ausgelassen.join(' · ')}.` : ''} ${frage}` };
  }

  /** S1 — Vorlage sperren (Lauf hielt an / rollte zurück / Verfall): keine Changes mehr daraus bis zur neuen Freigabe */
  async sperre(o: string, key: string, grund: string): Promise<boolean> {
    const v = this.vorlage(key);
    const s = (await this.d.stand(o)).find(x => x.vorlage === key);
    if (!v || !s || s.status === 'ueberpruefen' || s.status === 'widerrufen') return false;
    await this.d.setze(o, key, { abdruck: s.abdruck, status: 'ueberpruefen', frageHash: null, frageBis: null });
    this.d.protokoll?.('S1 Standard-Vorlage gesperrt', { vorlage: key, grund });
    await this.d.melde?.(`📋 Standard-Vorlage ${v.titel} gesperrt (überprüfen): ${grund}. Aus ihr entstehen keine Changes mehr, bis du sie nach einer Prüfung neu freigibst.`).catch(() => undefined);
    return true;
  }

  /** Change aus einer freigegebenen Vorlage anlegen (der Motor startet ihn nach Zeitplan). */
  async anlegen(o: string, key: string, p: Record<string, unknown>): Promise<{ ok: true; change: CmdbChangeRequest } | { ok: false; fehler: string[] }> {
    const v = this.vorlage(key);
    if (!v) return { ok: false, fehler: [`Vorlage „${key}“ unbekannt (${this.vorlagen.map(x => x.key).join(', ')})`] };
    if (!v.verfuegbar || !v.erzeuge) return { ok: false, fehler: [`${v.titel} folgt ${v.folgt ?? 'später'}`] };
    const s = (await this.d.stand(o)).find(x => x.vorlage === key);
    if (s?.status === 'ueberpruefen') return { ok: false, fehler: [`Vorlage ${v.titel} ist gesperrt (überprüfen) — ein Lauf hielt an oder sie lief über 2 Monate nicht. Erst prüfen, dann neu freigeben (standard_freigabe_anfragen).`] };
    if (s?.status !== 'freigegeben' || s.abdruck !== vorlagenAbdruck(v)) return { ok: false, fehler: [`Vorlage ${v.titel} ist nicht (mehr) freigegeben — erst standard_freigabe_anfragen, der Owner bestätigt einmal`] };
    // S1 — Verfall: mindestens 2 Monate ohne erfolgreichen Lauf (seit Freigabe bzw. letztem Lauf) → überprüfen
    const l = await this.d.laeufe?.(o, key).catch(() => undefined);
    const seit = Math.max(Date.parse(l?.letzter ?? '') || 0, Date.parse(s.freigegebenAt ?? '') || 0);
    if (seit && this.jetzt() - seit > VERFALL_MS) {
      await this.sperre(o, key, `über 2 Monate ohne Lauf (seit ${new Date(seit).toISOString().slice(0, 10)})`);
      return { ok: false, fehler: [`Vorlage ${v.titel}: über 2 Monate ohne Lauf — gesperrt, bitte prüfen und neu freigeben`] };
    }
    const kx = await this.d.kontext(o);
    const e = await v.erzeuge(p, kx);
    if ('fehler' in e) return { ok: false, fehler: [e.fehler] };
    // S1 — Eingangskontrolle beim Anlegen: jede Annahme live prüfen; Abweichung → kein Change aus der Vorlage
    const annahmen: Annahme[] = v.annahmen ? await v.annahmen(p, kx) : [];
    if (annahmen.length && this.d.pruefe) {
      const abw: string[] = [];
      for (const a of annahmen) {
        const r = await this.d.pruefe(a.pruefung).catch((err: Error) => ({ ok: false, text: err.message }));
        if (!r.ok) abw.push(`${a.text}: ${r.text.slice(0, 160)}`);
      }
      if (abw.length) {
        this.d.protokoll?.('S1 Eingangskontrolle abweichend', { vorlage: key, merkmal: e.merkmal, abweichungen: abw });
        await this.d.melde?.(`📋 Standard-Vorlage ${v.titel} (${e.merkmal}): Eingangskontrolle weicht ab — kein Change aus der Vorlage.\n${abw.map(x => `• ${x}`).join('\n')}\nDer Fall braucht einen einzeln geplanten Change.`).catch(() => undefined);
        return { ok: false, fehler: [`Eingangskontrolle der Vorlage ${v.titel} weicht ab — einzeln planen: ${abw.join('; ')}`] };
      }
      // … und als erste Schritte des Changes (zwischen Anlegen und Lauf können Stunden liegen)
      const schritte = (e.plan.schritte as Array<Record<string, unknown>> | undefined) ?? [];
      e.plan.schritte = [...annahmen.map(a => ({ titel: `Eingangskontrolle: ${a.text}`, art: 'pruefung', pruefung: a.pruefung, beiFehler: 'anhalten' })), ...schritte];
    }
    const r = await this.d.speichere(o, e.plan, key, e.merkmal);
    if (r.ok) { this.d.protokoll?.('I4b Standard-Change angelegt', { vorlage: key, id: r.change.id, merkmal: e.merkmal }); this.d.nachAnlage?.(); }
    return r;
  }
}
