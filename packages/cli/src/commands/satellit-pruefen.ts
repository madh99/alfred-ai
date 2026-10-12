/**
 * v1383 (R1, Owner-Freigabe 12.10.) — harte Prüfschritte ohne Modell (Spec Projektvorgang, Schleife Schritt 4): je Kriterium
 * ok/fehl mit Grund und gekürztem Auszug. Arten: datei (existiert, enthält Text), http (Status, enthält Text),
 * fenster (Text im Fenster laut Element-Karte), befehl (Exit 0, Ausgabe enthält Text). Befehle laufen nur über die
 * Aktion `pruefen_befehl` (Bestätigung); `pruefen` ohne Befehle ist lesend und automatisch.
 */

export type PruefArt = 'datei' | 'http' | 'fenster' | 'befehl';
export interface Pruefung { art: PruefArt; ziel: string; enthaelt?: string; status?: number; cwd?: string; timeoutS?: number }
export interface PruefErgebnis { art: PruefArt; ziel: string; ok: boolean; grund: string; auszug?: string }

export interface PruefMittel {
  datei: (pfad: string) => Promise<{ existiert: boolean; inhalt?: string; fehler?: string }>;
  http: (url: string, nurLokal: boolean) => Promise<{ status: number; text: string }>;
  fenster: (titel?: string) => Promise<string>;
  befehl: (befehl: string, cwd: string | undefined, timeoutMs: number) => Promise<{ exit: number | null; ausgabe: string }>;
}

const MAX_PRUEFUNGEN = 10;
const AUSZUG = 400;

/**
 * v1384 — Sicherheitsbefund 12.10. (SSRF): `pruefen` läuft ohne Bestätigung; eine eingeschleuste Anweisung könnte damit
 * Router-Oberflächen oder interne Dienste im LAN abfragen und Auszüge zurückholen. Ohne Bestätigung darum nur das Gerät
 * selbst (der Entwicklungsserver, den ein Auftrag gebaut hat); andere Adressen nur über pruefen_befehl (Bestätigung).
 */
export function istLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
  } catch { return false; }
}

function auszug(t: string): string { const s = t.trim(); return s.length > AUSZUG ? `…${s.slice(-AUSZUG)}` : s; }

/** Parameter → Prüfliste; `erlaubt` begrenzt die Arten je Aktion. Fehler als Text, sonst die Liste. */
export function pruefungenAus(params: Record<string, unknown>, erlaubt: PruefArt[]): Pruefung[] | string {
  const roh = params.pruefungen;
  if (!Array.isArray(roh) || roh.length === 0) return 'pruefungen fehlt (Liste von {art, ziel, enthaelt?, status?})';
  if (roh.length > MAX_PRUEFUNGEN) return `höchstens ${MAX_PRUEFUNGEN} Prüfungen je Aufruf`;
  const aus: Pruefung[] = [];
  for (const [i, r] of roh.entries()) {
    const o = (r ?? {}) as Record<string, unknown>;
    const art = String(o.art ?? '') as PruefArt;
    if (!erlaubt.includes(art)) return `Prüfung ${i + 1}: art muss ${erlaubt.join(' | ')} sein${art === 'befehl' ? ' — Befehle über pruefen_befehl' : ''}`;
    const ziel = String(o.ziel ?? o.pfad ?? o.url ?? o.befehl ?? o.titel ?? '').trim();
    if (!ziel && art !== 'fenster') return `Prüfung ${i + 1}: ziel fehlt`;
    if (art === 'http' && !/^https?:\/\//i.test(ziel)) return `Prüfung ${i + 1}: ziel muss eine http(s)-Adresse sein`;
    if (art === 'http' && !erlaubt.includes('befehl') && !istLoopbackUrl(ziel)) return `Prüfung ${i + 1}: ohne Bestätigung nur Adressen auf diesem Gerät (localhost, 127.0.0.1) — andere über pruefen_befehl`;
    aus.push({
      art, ziel,
      ...(o.enthaelt !== undefined && String(o.enthaelt) !== '' ? { enthaelt: String(o.enthaelt) } : {}),
      ...(o.status !== undefined ? { status: Number(o.status) } : {}),
      ...(o.cwd ? { cwd: String(o.cwd) } : {}),
      ...(o.timeoutS !== undefined ? { timeoutS: Math.min(Math.max(1, Number(o.timeoutS) || 60), 600) } : {}),
    });
  }
  return aus;
}

function enthaeltPruefung(text: string, p: Pruefung): { ok: boolean; grund: string } | undefined {
  if (p.enthaelt === undefined) return undefined;
  return text.toLowerCase().includes(p.enthaelt.toLowerCase()) ? { ok: true, grund: `enthält „${p.enthaelt}"` } : { ok: false, grund: `enthält „${p.enthaelt}" nicht` };
}

export async function pruefe(p: Pruefung, m: PruefMittel, nurLokal = false): Promise<PruefErgebnis> {
  const basis = { art: p.art, ziel: p.ziel };
  try {
    switch (p.art) {
      case 'datei': {
        const d = await m.datei(p.ziel);
        if (d.fehler) return { ...basis, ok: false, grund: d.fehler };
        if (!d.existiert) return { ...basis, ok: false, grund: 'Datei fehlt' };
        const e = enthaeltPruefung(d.inhalt ?? '', p);
        return { ...basis, ok: e?.ok ?? true, grund: e ? `existiert, ${e.grund}` : 'existiert', ...(e && !e.ok ? { auszug: auszug(d.inhalt ?? '') } : {}) };
      }
      case 'http': {
        if (nurLokal && !istLoopbackUrl(p.ziel)) return { ...basis, ok: false, grund: 'nur Adressen auf diesem Gerät ohne Bestätigung' };
        const r = await m.http(p.ziel, nurLokal);
        const sollStatus = p.status ?? 200;
        if (r.status !== sollStatus) return { ...basis, ok: false, grund: `Status ${r.status} statt ${sollStatus}`, auszug: auszug(r.text) };
        const e = enthaeltPruefung(r.text, p);
        return { ...basis, ok: e?.ok ?? true, grund: e ? `Status ${r.status}, ${e.grund}` : `Status ${r.status}`, ...(e && !e.ok ? { auszug: auszug(r.text) } : {}) };
      }
      case 'fenster': {
        const t = await m.fenster(p.ziel || undefined);
        const e = enthaeltPruefung(t, p);
        if (!e) return { ...basis, ok: t.trim().length > 0, grund: t.trim() ? 'Fenster gefunden' : 'kein Fenster' };
        return { ...basis, ok: e.ok, grund: `Fenstertext ${e.grund}`, ...(e.ok ? {} : { auszug: auszug(t) }) };
      }
      case 'befehl': {
        const r = await m.befehl(p.ziel, p.cwd, (p.timeoutS ?? 300) * 1000);
        if (r.exit !== 0) return { ...basis, ok: false, grund: r.exit === null ? 'abgebrochen (Zeitlimit)' : `Exit ${r.exit}`, auszug: auszug(r.ausgabe) };
        const e = enthaeltPruefung(r.ausgabe, p);
        return { ...basis, ok: e?.ok ?? true, grund: e ? `Exit 0, ${e.grund}` : 'Exit 0', auszug: auszug(r.ausgabe) };
      }
    }
  } catch (err) {
    return { ...basis, ok: false, grund: `Fehler: ${(err as Error).message.slice(0, 200)}` };
  }
}

export async function pruefeAlle(liste: Pruefung[], m: PruefMittel, nurLokal = false): Promise<{ ok: boolean; ergebnisse: PruefErgebnis[]; text: string }> {
  const ergebnisse: PruefErgebnis[] = [];
  for (const p of liste) ergebnisse.push(await pruefe(p, m, nurLokal)); // nacheinander: Befehle können aufeinander aufbauen (Build vor Test)
  const ok = ergebnisse.every(e => e.ok);
  const zeilen = ergebnisse.map(e => `${e.ok ? '✅' : '❌'} ${e.art} ${e.ziel.slice(0, 120)} — ${e.grund}${e.auszug && !e.ok ? `\n   ${e.auszug.replace(/\n/g, '\n   ')}` : ''}`);
  return { ok, ergebnisse, text: `${ok ? 'Alle Prüfungen bestanden' : `${ergebnisse.filter(e => !e.ok).length} von ${ergebnisse.length} Prüfungen fehlgeschlagen`}:\n${zeilen.join('\n')}` };
}
