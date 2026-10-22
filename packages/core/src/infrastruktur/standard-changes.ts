/**
 * I4b Teil 4 — Standard-Changes: einmalige Owner-Freigabe je Vorlage (Button, Hash der Einmal-Freigabe in der DB, an den
 * Vorlagen-Abdruck gebunden), Widerruf, Anlegen eines Changes aus einer freigegebenen Vorlage (gleiche Planprüfung wie jeder
 * Change; Start durch den Motor nach Zeitplan).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { CmdbChangeRequest } from '@alfred/types';
import { VORLAGEN, vorlagenAbdruck, type StandardKontext, type Vorlage } from './standard-vorlagen.js';

export interface StandardDeps {
  stand(o: string): Promise<Array<{ vorlage: string; abdruck: string; status: string; frageHash?: string; frageBis?: string; freigegebenAt?: string }>>;
  setze(o: string, vorlage: string, d: { abdruck: string; status: 'angefragt' | 'freigegeben' | 'widerrufen'; frageHash?: string | null; frageBis?: string | null }): Promise<void>;
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
const hash = (n: string) => createHash('sha256').update(n).digest('hex');

export class StandardChanges {
  private readonly vorlagen: Vorlage[];
  constructor(private readonly d: StandardDeps) { this.vorlagen = d.vorlagen ?? VORLAGEN; }
  private jetzt() { return this.d.jetzt?.() ?? Date.now(); }
  vorlage(key: string) { return this.vorlagen.find(v => v.key === key); }

  async liste(o: string): Promise<Array<{ key: string; titel: string; beschreibung: string; parameter: Record<string, string>; zustand: string }>> {
    const st = await this.d.stand(o);
    return this.vorlagen.map(v => {
      const s = st.find(x => x.vorlage === v.key);
      const zustand = !v.verfuegbar ? `folgt ${v.folgt ?? ''}`.trim()
        : s?.status === 'freigegeben' && s.abdruck === vorlagenAbdruck(v) ? `freigegeben ${s.freigegebenAt?.slice(0, 10) ?? ''}`.trim()
        : s?.status === 'freigegeben' ? 'Vorlage geändert — neue Freigabe nötig'
        : s?.status === 'angefragt' ? 'Freigabe angefragt' : s?.status === 'widerrufen' ? 'widerrufen' : 'nicht freigegeben';
      return { key: v.key, titel: v.titel, beschreibung: v.beschreibung, parameter: v.parameter, zustand };
    });
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

  /** Change aus einer freigegebenen Vorlage anlegen (der Motor startet ihn nach Zeitplan). */
  async anlegen(o: string, key: string, p: Record<string, unknown>): Promise<{ ok: true; change: CmdbChangeRequest } | { ok: false; fehler: string[] }> {
    const v = this.vorlage(key);
    if (!v) return { ok: false, fehler: [`Vorlage „${key}“ unbekannt (${this.vorlagen.map(x => x.key).join(', ')})`] };
    if (!v.verfuegbar || !v.erzeuge) return { ok: false, fehler: [`${v.titel} folgt ${v.folgt ?? 'später'}`] };
    const s = (await this.d.stand(o)).find(x => x.vorlage === key);
    if (s?.status !== 'freigegeben' || s.abdruck !== vorlagenAbdruck(v)) return { ok: false, fehler: [`Vorlage ${v.titel} ist nicht (mehr) freigegeben — erst standard_freigabe_anfragen, der Owner bestätigt einmal`] };
    const e = await v.erzeuge(p, await this.d.kontext(o));
    if ('fehler' in e) return { ok: false, fehler: [e.fehler] };
    const r = await this.d.speichere(o, e.plan, key, e.merkmal);
    if (r.ok) { this.d.protokoll?.('I4b Standard-Change angelegt', { vorlage: key, id: r.change.id, merkmal: e.merkmal }); this.d.nachAnlage?.(); }
    return r;
  }
}
