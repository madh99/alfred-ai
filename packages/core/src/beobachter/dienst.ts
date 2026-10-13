/**
 * v1429 R4a — Beobachter-Dienst: verwaltet die Regeln (Gespräch, App, Web), schickt jedem Gerät seine aktiven Regeln
 * (`beobachten`), setzt Treffer deterministisch in Wirkungen um und führt das Lebenszeichen (Befunde „beobachter").
 * Wirkungen (Owner-Entscheidung 13.10.): Hinweis, Vorgang und Aufgabe (feste Werkzeugliste) automatisch; Projekt-Wunsch nur
 * mit Bestätigung. Treffer tragen nur Kopfdaten.
 */
import { regelPruefen, geraetNutzlast, trefferText, aufgabeText, standardSkills, waechterBefunde, abgelaufen, QUELLEN, type Quelle, type RegelLike, type Treffer } from './regeln.js';

export interface BeobachterRepo {
  liste(userId: string): Promise<RegelLike[]>;
  hole(userId: string, id: string): Promise<RegelLike | null>;
  anlegen(e: Omit<RegelLike, 'id' | 'treffer' | 'letzterTreffer'> & { userId: string }): Promise<RegelLike>;
  aendern(userId: string, id: string, p: Partial<RegelLike>): Promise<RegelLike | null>;
  loeschen(userId: string, id: string): Promise<boolean>;
  treffer(id: string, zeit?: string): Promise<void>;
  /** v1433 B10 */
  artenAus(userId: string): Promise<Record<string, string[]>>;
  setzeArtenAus(userId: string, geraetId: string, arten: string[]): Promise<void>;
}

const QUELLE_TEXT: Record<Quelle, string> = { ordner: 'Ordner', benachrichtigung: 'Benachrichtigungen', outlook: 'Outlook', build: 'Build-Wache' };

export interface GeraetStand { id: string; name: string; online: boolean; sinne?: Record<string, unknown>; sinneZeit?: string }
type StandZeile = { regel: string; zustand: string; grund?: string; letzte?: string; anzahl?: number; konten?: string[] };

export interface BeobachterDienstDeps {
  repo: BeobachterRepo;
  owner: () => string | undefined;
  geraete: () => Promise<GeraetStand[]>;
  projekte: () => Promise<Array<{ id: string; name: string; geraetId?: string; pfad?: string; pruefBefehle?: string[] }>>;
  sendeAn: (geraetId: string, n: { typ: string; [k: string]: unknown }) => boolean;
  geraetSkillName: (name: string) => string;
  melde: (text: string) => Promise<void>;
  vorgang: (e: { titel: string; ziel: string; naechsterSchritt: string; dedupeKey: string }) => Promise<void>;
  aufgabe: (r: RegelLike, auftrag: string, ausloeser: string, skills: string[]) => Promise<void>;
  bestaetigung: (r: RegelLike, beschreibung: string, ziel: string, sourceId: string) => Promise<boolean>;
  befundeSync: (befunde: Array<{ gegenstand: string; titel: string; detail?: string }>) => Promise<void>;
  /** v1430 — Mailadressen, die der Server selbst liest (Owner-Entscheidung 3: Outlook nur für andere Konten) */
  serverMailKonten?: () => string[];
  logger: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
  jetzt?: () => number;
}

const MAX_JE_STUNDE = 20;

export class BeobachterDienst {
  private gesehen = new Map<string, number>();
  private wirkungen = new Map<string, number[]>();
  private gedrosseltGemeldet = new Map<string, number>();
  constructor(private readonly d: BeobachterDienstDeps) {}

  private jetzt(): number { return (this.d.jetzt ?? Date.now)(); }

  /** v1430 — liest der Server alle Outlook-Konten dieses Geräts schon selbst? Dann meldet die Outlook-Regel nichts (sonst doppelt). */
  private outlookDoppelt(z: StandZeile | undefined): boolean {
    const server = new Set((this.d.serverMailKonten?.() ?? []).map(k => k.toLowerCase()));
    return !!z?.konten?.length && z.konten.every(k => server.has(k.toLowerCase()));
  }

  private static stand(g: GeraetStand | undefined): StandZeile[] | undefined {
    const b = g?.sinne?.beobachter;
    return Array.isArray(b) ? b as StandZeile[] : undefined;
  }

  /** Regeln mit Stand am Gerät, Owner-Geräte und Projekte (für Auswahllisten in App/Web). */
  async liste(): Promise<{ regeln: Array<RegelLike & { stand: string; standGrund?: string }>; geraete: Array<{ id: string; name: string; online: boolean; artenAus: string[] }>; projekte: Array<{ id: string; name: string }>; serverKonten: string[] }> {
    const o = this.d.owner();
    if (!o) return { regeln: [], geraete: [], projekte: [], serverKonten: [] };
    const [regeln, geraete, projekte, artenAus] = await Promise.all([this.d.repo.liste(o), this.d.geraete(), this.d.projekte().catch(() => []), this.d.repo.artenAus(o).catch(() => ({} as Record<string, string[]>))]);
    const jetzt = this.jetzt();
    return {
      regeln: regeln.map(r => {
        if (!r.aktiv) return { ...r, stand: 'aus' };
        if (abgelaufen(r, jetzt)) return { ...r, stand: 'abgelaufen' }; // v1433 B11 (der Wächter schaltet sie ab)
        if ((artenAus[r.geraetId] ?? []).includes(r.quelle)) return { ...r, stand: 'Art am Gerät aus', standGrund: `${QUELLE_TEXT[r.quelle]} auf ${r.geraet} ausgeschaltet` }; // v1433 B10
        const g = geraete.find(x => x.id === r.geraetId);
        if (!g?.online) return { ...r, stand: 'Gerät offline' };
        const st = BeobachterDienst.stand(g);
        if (!st) return { ...r, stand: 'Satellit zu alt', standGrund: 'Update auf ≥ 1429 nötig' };
        const z = st.find(s => s.regel === r.id);
        if (!z) return { ...r, stand: 'wird gestartet' };
        if (r.quelle === 'outlook' && this.outlookDoppelt(z)) return { ...r, stand: 'ohne Wirkung', standGrund: `Konto ${z.konten!.join(', ')} liest der Server selbst (Mail-Regeln)` };
        return { ...r, stand: z.zustand === 'laeuft' ? 'läuft' : z.zustand === 'aus' ? 'am Gerät aus' : 'gestört', ...(z.grund ? { standGrund: z.grund } : {}) };
      }),
      geraete: geraete.map(g => ({ id: g.id, name: g.name, online: g.online, artenAus: artenAus[g.id] ?? [] })),
      projekte,
      serverKonten: [...new Set((this.d.serverMailKonten?.() ?? []).map(k => k.toLowerCase()))].sort(), // v1433 B12 — die liest Alfred selbst
    };
  }

  /** v1433 B10 — eine Beobachtungsart auf einem Gerät ein- oder ausschalten (App, Web, Gespräch). */
  async geraetArt(roh: Record<string, unknown>): Promise<{ success: boolean; display?: string; error?: string }> {
    const o = this.d.owner();
    if (!o) return { success: false, error: 'kein Owner' };
    const n = String(roh.geraet ?? roh.geraetId ?? '').trim().toLowerCase();
    const geraete = await this.d.geraete();
    const g = geraete.find(x => x.id === n || x.name.toLowerCase() === n);
    if (!g) return { success: false, error: `Gerät fehlt oder unbekannt (${geraete.map(x => x.name).join(', ') || 'keine Geräte'})` };
    const q = String(roh.quelle ?? '') as Quelle;
    if (!QUELLEN.includes(q)) return { success: false, error: `quelle muss ${QUELLEN.join(', ')} sein` };
    const an = roh.an === true || roh.an === 'true' || roh.schalter === 'an';
    const alt = (await this.d.repo.artenAus(o))[g.id] ?? [];
    const neu = an ? alt.filter(x => x !== q) : [...new Set([...alt, q])];
    await this.d.repo.setzeArtenAus(o, g.id, neu);
    this.d.logger.info({ geraet: g.name, quelle: q, an }, 'v1433 Beobachtungsart je Gerät geschaltet');
    await this.anGeraet(g.id, o);
    return { success: true, display: `${QUELLE_TEXT[q]} auf ${g.name}: ${an ? 'eingeschaltet' : 'ausgeschaltet — dort läuft keine Regel dieser Art'}.` };
  }

  async anlegen(roh: Record<string, unknown>): Promise<{ success: boolean; display?: string; error?: string; data?: unknown }> {
    if (roh.aktion === 'geraet_art') return this.geraetArt(roh); // v1433 — derselbe Weg für App, Web und Gespräch
    const o = this.d.owner();
    if (!o) return { success: false, error: 'kein Owner' };
    const p = regelPruefen(roh, (await this.d.geraete()).map(g => ({ id: g.id, name: g.name })), await this.d.projekte().catch(() => []));
    if (!p.ok) return { success: false, error: p.fehler };
    const r = await this.d.repo.anlegen({ ...p.regel, userId: o });
    this.d.logger.info({ regel: r.id, name: r.name, geraet: r.geraet, wirkung: r.wirkung }, 'v1429 Beobachter-Regel angelegt');
    const gesendet = this.anGeraet(r.geraetId, o);
    const artAus = ((await this.d.repo.artenAus(o).catch(() => ({} as Record<string, string[]>)))[r.geraetId] ?? []).includes(r.quelle);
    const dauer = `${r.einmalig ? ', einmalig' : ''}${r.bis ? `, bis ${new Date(r.bis).toLocaleString('de-AT', { timeZone: 'Europe/Vienna', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}`;
    return { success: true, data: r, display: `Beobachter „${r.name}" angelegt (${r.geraet}: ${r.quelle === 'ordner' ? String(r.filter.pfad) : QUELLE_TEXT[r.quelle]}${r.filter.muster ? `, ${String(r.filter.muster)}` : ''} → ${r.wirkung}${dauer})${artAus ? ` — ${QUELLE_TEXT[r.quelle]} ist auf ${r.geraet} ausgeschaltet, die Regel läuft erst nach dem Einschalten` : await gesendet ? '' : ' — Gerät gerade nicht verbunden, startet bei der nächsten Verbindung'}.` };
  }

  /** aktion an|aus|loeschen oder Änderung einzelner Felder. */
  async aendern(id: string, roh: Record<string, unknown>): Promise<{ success: boolean; display?: string; error?: string }> {
    const o = this.d.owner();
    if (!o) return { success: false, error: 'kein Owner' };
    const alt = await this.d.repo.hole(o, id);
    if (!alt) return { success: false, error: 'Regel nicht gefunden' };
    if (roh.aktion === 'loeschen') {
      await this.d.repo.loeschen(o, id);
      await this.anGeraet(alt.geraetId, o);
      return { success: true, display: `Beobachter „${alt.name}" gelöscht.` };
    }
    let p: Partial<RegelLike> = {};
    if (roh.aktion === 'an' || roh.aktion === 'aus') p.aktiv = roh.aktion === 'an';
    else {
      const neu = regelPruefen({ ...alt, ...alt.filter, geraet: alt.geraetId, projekt: alt.projektId, ...roh }, (await this.d.geraete()).map(g => ({ id: g.id, name: g.name })), await this.d.projekte().catch(() => []));
      if (!neu.ok) return { success: false, error: neu.fehler };
      const { geraetId: _g, geraet: _n, ...rest } = neu.regel; // Gerät bleibt (neue Regel für anderes Gerät)
      p = rest;
    }
    const r = await this.d.repo.aendern(o, id, p);
    if (!r) return { success: false, error: 'Regel nicht gefunden' };
    this.d.logger.info({ regel: id, aktiv: r.aktiv }, 'v1429 Beobachter-Regel geändert');
    await this.anGeraet(r.geraetId, o);
    return { success: true, display: `Beobachter „${r.name}" ${roh.aktion === 'an' ? 'eingeschaltet' : roh.aktion === 'aus' ? 'ausgeschaltet' : 'geändert'}.` };
  }

  /** Aktive Regeln an ein Gerät (bei Verbindung und nach jeder Änderung). */
  async anGeraet(geraetId: string, owner = this.d.owner()): Promise<boolean> {
    if (!owner) return false;
    const [alle, artenAus] = await Promise.all([this.d.repo.liste(owner), this.d.repo.artenAus(owner).catch(() => ({} as Record<string, string[]>))]);
    return this.d.sendeAn(geraetId, { typ: 'beobachten', regeln: geraetNutzlast(alle.filter(r => r.geraetId === geraetId), artenAus[geraetId] ?? [], this.jetzt()) });
  }

  /** Treffer vom Gerät → Wirkung. Fremde oder ausgeschaltete Regeln, Dubletten und Überlauf werden verworfen (Logzeile). */
  async verarbeite(geraetId: string, ereignisse: Treffer[]): Promise<number> {
    const o = this.d.owner();
    if (!o || !Array.isArray(ereignisse)) return 0;
    const jetzt = this.jetzt();
    for (const [k, t] of this.gesehen) if (jetzt - t > 24 * 3_600_000) this.gesehen.delete(k);
    let n = 0;
    for (const t of ereignisse.slice(0, 50)) {
      const r = await this.d.repo.hole(o, String(t.regel));
      if (!r || !r.aktiv || r.geraetId !== geraetId) { this.d.logger.info({ geraetId, regel: t.regel }, 'v1429 Beobachtung ohne aktive Regel verworfen'); continue; }
      if (abgelaufen(r, jetzt) || ((await this.d.repo.artenAus(o).catch(() => ({} as Record<string, string[]>)))[geraetId] ?? []).includes(r.quelle)) { this.d.logger.info({ geraetId, regel: r.id }, 'v1433 Beobachtung verworfen — Regel abgelaufen oder Art am Gerät aus'); continue; }
      if (this.gesehen.has(t.schluessel)) continue;
      if (r.quelle === 'outlook') {
        const g = (await this.d.geraete()).find(x => x.id === geraetId);
        if (this.outlookDoppelt(BeobachterDienst.stand(g)?.find(s => s.regel === r.id))) { this.d.logger.info({ regel: r.id }, 'v1430 Outlook-Treffer verworfen — Konto liest der Server selbst'); continue; }
      }
      this.gesehen.set(t.schluessel, jetzt);
      const w = (this.wirkungen.get(r.id) ?? []).filter(x => jetzt - x < 3_600_000);
      if (w.length >= MAX_JE_STUNDE) {
        this.d.logger.info({ regel: r.id, name: r.name }, 'v1429 Beobachter gedrosselt (mehr als 20 Treffer je Stunde)');
        if (jetzt - (this.gedrosseltGemeldet.get(r.id) ?? 0) > 3_600_000) { this.gedrosseltGemeldet.set(r.id, jetzt); await this.d.melde(`🔭 Beobachter „${r.name}" auf ${r.geraet}: mehr als ${MAX_JE_STUNDE} Treffer in einer Stunde — weitere werden bis zur nächsten Stunde nur gezählt.`).catch(() => undefined); }
        await this.d.repo.treffer(r.id).catch(() => undefined);
        continue;
      }
      w.push(jetzt); this.wirkungen.set(r.id, w);
      await this.d.repo.treffer(r.id).catch(() => undefined);
      try { await this.wirke(r, t); n++; } catch (err) { this.d.logger.warn({ regel: r.id, err: (err as Error).message }, 'v1429 Beobachter-Wirkung fehlgeschlagen'); }
      // v1433 B11 — „sag mir Bescheid, sobald …“: nach dem ersten Treffer aus
      if (r.einmalig) { await this.beende(r, o, `🔭 Beobachter „${r.name}" auf ${r.geraet} hat angeschlagen und ist jetzt aus (einmalig) — erledigt.`); break; }
    }
    return n;
  }

  private async wirke(r: RegelLike, t: Treffer): Promise<void> {
    const text = trefferText(r, t);
    this.d.logger.info({ regel: r.id, name: r.name, wirkung: r.wirkung, art: t.art, schluessel: t.schluessel.slice(0, 120) }, 'v1429 Beobachtung');
    if (r.wirkung === 'hinweis') { await this.d.melde(`🔭 ${text}`); return; }
    // v1431 — Build-Wache: „wieder grün" ist nur eine Meldung, kein neuer Vorgang/Fix-Lauf
    if (r.quelle === 'build' && t.art === 'gruen') { await this.d.melde(`🔭 ${text}`); return; }
    if (r.wirkung === 'vorgang') {
      await this.d.vorgang({ titel: `${r.name}: ${String(t.kopf.name ?? t.art)}`.slice(0, 160), ziel: text, naechsterSchritt: r.auftrag ?? 'Owner entscheidet', dedupeKey: `beobachtung:${r.id}:${t.schluessel}` });
      await this.d.melde(`🔭 ${text} — als Vorgang angelegt.`);
      return;
    }
    if (r.wirkung === 'aufgabe') {
      const skill = this.d.geraetSkillName(r.geraet);
      await this.d.aufgabe(r, r.auftrag ?? '', aufgabeText(r, t, skill), r.skills?.length ? r.skills : standardSkills(skill));
      return;
    }
    // projekt: nur mit Bestätigung (Owner-Entscheidung 4)
    const ok = await this.d.bestaetigung(r, `🔭 ${text}\nProjekt weiterarbeiten: ${r.auftrag ?? ''}?`, `${r.auftrag ?? ''}\n\nAnlass: ${text}`, `beobachter-${r.id}-${t.schluessel}`.slice(0, 200));
    if (!ok) this.d.logger.info({ regel: r.id }, 'v1429 Projekt-Bestätigung schon offen (Dublette)');
  }

  /** v1433 B11 — Regel abschalten (einmalig erledigt oder abgelaufen), Gerät neu versorgen, Owner Bescheid geben. */
  private async beende(r: RegelLike, o: string, text: string): Promise<void> {
    await this.d.repo.aendern(o, r.id, { aktiv: false });
    this.d.logger.info({ regel: r.id, name: r.name, einmalig: !!r.einmalig, bis: r.bis }, 'v1433 Beobachter beendet');
    await this.anGeraet(r.geraetId, o).catch(() => false);
    await this.d.melde(text).catch(() => undefined);
  }

  /** Lebenszeichen: gestörte/fehlende Beobachter als Befunde (Quelle „beobachter"); v1433 — abgelaufene Regeln abschalten. */
  async waechter(): Promise<number> {
    const o = this.d.owner();
    if (!o) return 0;
    const jetzt = this.jetzt();
    for (const r of (await this.d.repo.liste(o)).filter(x => x.aktiv && abgelaufen(x, jetzt))) await this.beende(r, o, `🔭 Beobachter „${r.name}" auf ${r.geraet} ist abgelaufen und jetzt aus.`);
    const [regeln, geraete, artenAus] = await Promise.all([this.d.repo.liste(o), this.d.geraete(), this.d.repo.artenAus(o).catch(() => ({} as Record<string, string[]>))]);
    const befunde = waechterBefunde(regeln, geraete.map(g => ({ id: g.id, name: g.name, online: g.online, sinneZeit: g.sinneZeit, beobachter: BeobachterDienst.stand(g) })), jetzt, artenAus);
    await this.d.befundeSync(befunde);
    return befunde.length;
  }
}
