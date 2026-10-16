import type { ProjectRepository, Project } from '@alfred/storage';

/**
 * v1399 — Owner 12.10. („ja wie vorgeschlagen machen"): Geräte-Projekte leben im vorhandenen Projekt-System (`projects`, Web-Seite
 * „Projects", Projekt-Chat, offene Punkte) statt in eigenen Akten. Diese Schicht bietet dem Projektablauf dieselbe Sicht wie die
 * Akten aus v1398 (Name, Gerät, Pfad, Prüfbefehle, Status aktiv/archiviert) und schreibt jeden Lauf als Projekt-Sitzung
 * (`session_type 'geraet'`, `source_id` = sat-…).
 */
export type AktenStatus = 'aktiv' | 'archiviert';

export interface ProjektAkte {
  id: string; userId: string; name: string; geraetId: string; geraet: string; pfad: string;
  beschreibung?: string; pruefBefehle: string[]; status: AktenStatus; erstellt: string; aktualisiert: string;
  /** v1409 R3b — Projekt-Option „sudo gesperrt" (Projekt-Tag sudo-sperre) */
  sudoSperre?: boolean;
  /** v1425 — Protokoll im Projekt (Aufträge + Berichte committen); Standard an, Tag protokoll-aus schaltet ab */
  protokoll: boolean;
  /** v1455 — Etappen über Branch und Merge Request (Tag merge-requests); Standard aus */
  mergeRequests: boolean;
  /** v1458 — bei grünem Lauf automatisch zusammenführen (Tag mr-auto-merge); Standard aus = nach dem Ja des Owners */
  mergeRequestsAuto: boolean;
}

/**
 * v1486 F5 — Einrichtung eines Geräte-Projekts (Owner 16.10.: Onboarding wie empfohlen, ohne Kostengrenze — eine Grenze gibt es
 * auf Wunsch schon). Der Stand ergibt sich aus den vorhandenen Einstellungen; was der Owner bewusst so lässt, markiert „passt so“
 * (Tag eingerichtet:<schritt>). Nichts davon hält einen Lauf auf.
 */
export const EINRICHTUNG_SCHRITTE = ['repo', 'pruefung', 'mr', 'regeln', 'protokoll'] as const;
export type EinrichtungSchritt = typeof EINRICHTUNG_SCHRITTE[number];
export const einrichtungTag = (k: EinrichtungSchritt) => `eingerichtet:${k}`;
export interface EinrichtungStand { schritte: Array<{ schritt: EinrichtungSchritt; titel: string; erledigt: boolean; stand: string }>; erledigt: number; gesamt: number }

export function einrichtungStand(p: { repoUrl?: string | null; tags?: string[] | null; conventions?: object | null; pruefBefehle?: string[] | null }): EinrichtungStand {
  const t = p.tags ?? [];
  const ok = (k: EinrichtungSchritt) => t.includes(einrichtungTag(k));
  const befehle = p.pruefBefehle ?? [];
  const regeln = Object.keys(p.conventions ?? {}).length > 0;
  const mr = t.includes('merge-requests');
  const protokollAus = t.includes('protokoll-aus');
  const schritte: EinrichtungStand['schritte'] = [
    { schritt: 'repo', titel: 'Repository', erledigt: !!p.repoUrl || ok('repo'), stand: p.repoUrl ? p.repoUrl : ok('repo') ? 'keins (nur lokal)' : 'offen: neu anlegen, vorhandenes eintragen oder keins' },
    { schritt: 'pruefung', titel: 'Prüfbefehle', erledigt: befehle.length > 0 || ok('pruefung'), stand: befehle.length ? befehle.join(' · ') : ok('pruefung') ? 'keine (du nimmst jede Etappe selbst ab)' : 'offen: Vorschlag aus dem Projekt holen' },
    { schritt: 'mr', titel: 'Merge Requests', erledigt: mr || ok('mr'), stand: mr ? `an${t.includes('mr-auto-merge') ? ', automatisch zusammenführen' : ', Zusammenführen nach deinem Ja'}` : ok('mr') ? 'aus (direkt auf dem Zweig)' : 'offen: an oder aus' },
    { schritt: 'regeln', titel: 'Projektregeln', erledigt: regeln || ok('regeln'), stand: regeln ? 'festgelegt' : ok('regeln') ? 'keine eigenen' : 'offen: CHANGELOG, Commits, README' },
    { schritt: 'protokoll', titel: 'Protokoll im Repository', erledigt: protokollAus || ok('protokoll'), stand: protokollAus ? 'aus (nur lokal)' : ok('protokoll') ? 'an' : 'offen: an (Standard) oder aus' },
  ];
  return { schritte, erledigt: schritte.filter(s => s.erledigt).length, gesamt: schritte.length };
}

/** v1486 F5 — eine Zeile für den Projektfaden; undefined, wenn alles eingerichtet ist. */
export function einrichtungHinweis(e: EinrichtungStand): string | undefined {
  const offen = e.schritte.filter(s => !s.erledigt);
  if (!offen.length) return undefined;
  return `🧭 Einrichtung ${e.erledigt}/${e.gesamt} — offen: ${offen.map(s => s.titel).join(' · ')}. Festlegen in der App unter Projekte → Einrichtung (der Lauf läuft trotzdem).`;
}

export function akteAusProjekt(p: Project): ProjektAkte {
  return {
    id: p.id, userId: p.userId, name: p.name, geraetId: p.geraetId ?? '', geraet: p.geraet ?? '', pfad: p.cwd ?? '',
    ...(p.description ? { beschreibung: p.description } : {}), pruefBefehle: p.pruefBefehle ?? [],
    status: p.status === 'archived' ? 'archiviert' : 'aktiv', erstellt: p.createdAt, aktualisiert: p.lastActiveAt,
    ...(p.tags?.includes('sudo-sperre') ? { sudoSperre: true } : {}),
    protokoll: !(p.tags ?? []).includes('protokoll-aus'),
    mergeRequests: (p.tags ?? []).includes('merge-requests'),
    mergeRequestsAuto: (p.tags ?? []).includes('mr-auto-merge'),
  };
}

export interface LaufSitzung { id: string; ziel: string; plan: string[]; erledigt: Array<{ nr: number; ok: boolean; etappe?: string }>; status: string; kostenUsd: number; grund?: string }

/** Zusammenfassung eines Laufs für die Projekt-Sitzung (Web „Sessions", Projekt-Chat-Kontext). */
export function sitzungsZusammenfassung(l: LaufSitzung): { whatWasDone: string; status: 'success' | 'failed' | 'partial' } {
  const ok = l.erledigt.filter(e => e.ok).length;
  const etappen = l.erledigt.filter(e => e.ok).map(e => l.plan[e.nr - 1] ?? `Etappe ${e.nr}`).map(t => `✅ ${t.slice(0, 120)}`);
  const kopf = `${l.id}: ${l.ziel.slice(0, 200)} — ${ok}/${l.plan.length} Etappen, ${l.kostenUsd.toFixed(2)} USD${l.grund ? ` (${l.grund})` : ''}`;
  return { whatWasDone: [kopf, ...etappen].join('\n'), status: l.status === 'fertig' ? 'success' : ok > 0 ? 'partial' : 'failed' };
}

export class ProjektAktenUeberProjekte {
  constructor(private readonly repo: ProjectRepository) {}

  async liste(userId: string, mitArchiv = false): Promise<ProjektAkte[]> {
    const l = await this.repo.list(userId, { nurGeraete: true, limit: 500 });
    return l.filter(p => mitArchiv || p.status !== 'archived').map(akteAusProjekt);
  }

  async findePfad(userId: string, geraetId: string, pfad: string): Promise<ProjektAkte | null> {
    const p = await this.repo.findByGeraetPfad(userId, geraetId, pfad);
    return p ? akteAusProjekt(p) : null;
  }

  async anlegen(a: { userId: string; name: string; geraetId: string; geraet: string; pfad: string; beschreibung?: string; pruefBefehle: string[]; status?: AktenStatus; /** v1434 B13 */ repoUrl?: string }): Promise<ProjektAkte> {
    const pfad = a.pfad.trim().length > 1 ? a.pfad.trim().replace(/[\\/]+$/, '') : a.pfad.trim();
    const p = await this.repo.create(a.userId, { name: a.name, description: a.beschreibung, cwd: pfad, tags: ['geraet'], status: a.status === 'archiviert' ? 'archived' : 'active', geraetId: a.geraetId, geraet: a.geraet, pruefBefehle: a.pruefBefehle, ...(a.repoUrl ? { repoUrl: a.repoUrl } : {}) });
    return akteAusProjekt(p);
  }

  async aendern(userId: string, id: string, f: { name?: string; beschreibung?: string; pruefBefehle?: string[]; status?: AktenStatus; geraet?: string }): Promise<void> {
    if (f.name !== undefined || f.beschreibung !== undefined || f.status !== undefined) {
      await this.repo.update(userId, id, { ...(f.name !== undefined ? { name: f.name } : {}), ...(f.beschreibung !== undefined ? { description: f.beschreibung } : {}), ...(f.status !== undefined ? { status: f.status === 'archiviert' ? 'archived' as const : 'active' as const } : {}) });
    }
    if (f.geraet !== undefined || f.pruefBefehle !== undefined) await this.repo.updateGeraet(id, { geraet: f.geraet, pruefBefehle: f.pruefBefehle });
    await this.repo.touch(id);
  }

  /** v1409 R3b — Projekt-Option sudo-Sperre an/aus (Tag am Projekt). */
  async setzeSudoSperre(userId: string, id: string, an: boolean): Promise<void> {
    const p = await this.repo.getById(userId, id);
    if (!p) return;
    const tags = (p.tags ?? []).filter(t => t !== 'sudo-sperre');
    await this.repo.update(userId, id, { tags: an ? [...tags, 'sudo-sperre'] : tags });
  }

  /** v1425 — Schalter „Protokoll im Projekt“ (Tag protokoll-aus = aus). Liefert false, wenn das Projekt fehlt. */
  async setzeProtokoll(userId: string, id: string, an: boolean): Promise<boolean> {
    const p = await this.repo.getById(userId, id);
    if (!p?.geraetId) return false;
    const tags = (p.tags ?? []).filter(t => t !== 'protokoll-aus' && t !== einrichtungTag('protokoll'));
    await this.repo.update(userId, id, { tags: [...(an ? tags : [...tags, 'protokoll-aus']), einrichtungTag('protokoll')] }); // v1486 F5 — bewusst gesetzt
    return true;
  }

  /** v1455 — Schalter „Merge Requests“ (Tag merge-requests = an). Liefert false, wenn das Projekt fehlt oder kein Geräte-Projekt ist. */
  async setzeMergeRequests(userId: string, id: string, an: boolean, tag: 'merge-requests' | 'mr-auto-merge' = 'merge-requests'): Promise<boolean> {
    const p = await this.repo.getById(userId, id);
    if (!p?.geraetId) return false;
    const tags = (p.tags ?? []).filter(t => t !== tag && t !== einrichtungTag('mr'));
    await this.repo.update(userId, id, { tags: [...(an ? [...tags, tag] : tags), einrichtungTag('mr')] }); // v1486 F5 — bewusst gesetzt
    return true;
  }

  /** v1486 F5 — Einrichtungsschritt „passt so“ (bleibt, wie er ist). Liefert false, wenn das Projekt fehlt. */
  async einrichtungOk(userId: string, id: string, schritt: EinrichtungSchritt): Promise<boolean> {
    const p = await this.repo.getById(userId, id);
    if (!p?.geraetId) return false;
    const tag = einrichtungTag(schritt);
    if (!(p.tags ?? []).includes(tag)) await this.repo.update(userId, id, { tags: [...(p.tags ?? []), tag] });
    return true;
  }

  /** Lauf als Projekt-Sitzung: anlegen (einmal je Lauf) bzw. beim Ende zusammenfassen. */
  async sitzung(projektId: string, l: LaufSitzung, start: number, ende?: number): Promise<void> {
    const da = await this.repo.findSessionBySource('geraet', l.id);
    const summary = sitzungsZusammenfassung(l);
    if (!da) { await this.repo.createSession(projektId, { sessionType: 'geraet', sourceId: l.id, summary, startedAt: new Date(start).toISOString(), ...(ende ? { endedAt: new Date(ende).toISOString() } : {}) }); return; }
    if (!ende) return; // läuft noch: updateSessionSummary setzt sonst ended_at
    await this.repo.updateSessionSummary(da.id, summary, ende ? new Date(ende).toISOString() : undefined);
  }
}

/** v1401 — ein Lauf für Web und App (Etappen, Kosten, Zustand); gemeinsame Form statt zweier Abbildungen. */
export function laufAnzeige(l: { id: string; status: string; grund?: string; ziel: string; plan: string[]; erledigt: Array<{ nr: number; ok: boolean; kostenUsd: number; geprueft?: boolean; fixVersuche?: number; zusammenfassung?: string; text?: string; dateien?: string[]; dateienAnzahl?: number; commit?: { sha: string; titel: string }; abnahme?: { ok: boolean; protokoll: string }; dauerS?: number; ownerAbgenommen?: boolean }>; nr: number; kostenUsd: number; start: number; aktualisiert: number; frage?: { text: string; art: string }; wartetAufGeraet?: { seit: number } }, live?: { zeit: string; schritte: string[]; werkzeuge: number }) {
  return {
    id: l.id, status: l.status, grund: l.grund, ziel: l.ziel, plan: l.plan, erledigt: l.erledigt.map(e => ({ nr: e.nr, ok: e.ok, kostenUsd: e.kostenUsd,
      // v1417 G1 — Etappenbericht (ältere Läufe: nur der kurze Text)
      bericht: { geprueft: !!e.geprueft, fixVersuche: e.fixVersuche ?? 0, zusammenfassung: e.zusammenfassung ?? e.text ?? '', dateien: e.dateien ?? [], dateienAnzahl: e.dateienAnzahl ?? e.dateien?.length ?? 0, ...(e.commit ? { commit: e.commit } : {}), ...(e.abnahme ? { abnahme: e.abnahme } : {}), ...(e.dauerS !== undefined ? { dauerS: e.dauerS } : {}), ...(e.ownerAbgenommen ? { ownerAbgenommen: true } : {}) } })), // v1484 F1
    nr: l.nr, kostenUsd: Number(l.kostenUsd.toFixed(2)), start: new Date(l.start).toISOString(), aktualisiert: new Date(l.aktualisiert).toISOString(), wartetAufDich: l.status === 'wartet_owner',
    // v1403 — offene Frage (Plan, Weiter, Planänderung) zum Freigeben direkt in der Projektansicht; die Einmal-Kennung bleibt am Server
    ...(l.frage ? { frage: l.frage.text, frageArt: l.frage.art } : {}),
    ...(l.wartetAufGeraet ? { wartetAufGeraet: new Date(l.wartetAufGeraet.seit).toISOString() } : {}), // v1415
    ...(live && l.status === 'laeuft' ? { live } : {}), // v1418 G2
  };
}
