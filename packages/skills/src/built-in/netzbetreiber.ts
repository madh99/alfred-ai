import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';

/**
 * v1133 — Netzbetreiber-Recherche für das Verzeichnis auf lokalkraft.at.
 *
 * Recherchiert die „weichen" Daten österreichischer Strom-Netzbetreiber
 * (Smart-Meter-Portal, EEG-Check, Kontakt, Datenfreigabe-Hinweis) und reicht
 * sie als VORSCHLÄGE über die Grid-API ein — freigegeben wird von Menschen
 * im Lokalkraft-Admin, nichts geht direkt live.
 *
 * Qualitätsregeln (Skill-Definition, verbindlich):
 *  - Nur offizielle Quellen: Website des Betreibers, E-Control, ebutilities.
 *  - Jeder Vorschlag trägt eine sourceUrl — und zwar NUR eine Seite, die
 *    dieser Lauf WIRKLICH gelesen hat (deterministisch erzwungen, nicht per
 *    Prompt-Appell: das LLM kann keine Belege erfinden).
 *  - Nie raten: unsichere Felder entfallen; „nichts gefunden" ist gültig.
 *  - Nur Abweichungen vom Bestand einreichen.
 *
 * Secrets/Config: ALFRED_GRID_KEY (Pflicht fürs Einreichen) und optional
 * ALFRED_GRID_BASE_URL (Default https://lokalkraft.at) aus der Umgebung.
 */

type LlmCallback = (prompt: string, tier?: string) => Promise<string>;

const ALLOWED_FIELDS = ['website', 'phone', 'email', 'smartMeterPortalUrl', 'eegCheckUrl', 'notes'] as const;
type FieldName = (typeof ALLOWED_FIELDS)[number];
const URL_FIELDS = new Set<FieldName>(['website', 'smartMeterPortalUrl', 'eegCheckUrl']);
/** Behördliche Verzeichnisse, die als Quelle bzw. Link-Ziel immer zulässig sind. */
const OFFICIAL_HOSTS = ['e-control.at', 'ebutilities.at'];

const FETCH_TIMEOUT_MS = 12_000;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
/** Link-Texte/Pfade, hinter denen die gesuchten Infos typischerweise liegen. */
const INTERESSANTE_LINKS = /smart.?meter|portal|energiegemeinschaft|erzeugergemeinschaft|\beeg\b|datenfreigabe|viertelstund|kontakt|impressum|kundenservice/i;

interface Bestand {
  name?: string; ecPrefix?: string;
  website?: string; phone?: string; email?: string;
  smartMeterPortalUrl?: string; eegCheckUrl?: string; notes?: string;
}

export interface GridSuggestion {
  operator: string;
  field: FieldName;
  value: string;
  sourceUrl: string;
  note?: string;
}

/** Registrierbare Domain (Näherung: letzte zwei Labels — reicht für .at-Betreiber). */
export function baseDomain(hostname: string): string {
  const parts = hostname.toLowerCase().split('.').filter(Boolean);
  return parts.slice(-2).join('.');
}

/** HTML → lesbarer Text (Skript/Stil raus, Tags raus, Entities minimal). */
export function htmlZuText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&uuml;/g, 'ü').replace(/&auml;/g, 'ä').replace(/&ouml;/g, 'ö')
    .replace(/&Uuml;/g, 'Ü').replace(/&Auml;/g, 'Ä').replace(/&Ouml;/g, 'Ö').replace(/&szlig;/g, 'ß')
    .replace(/\s+/g, ' ').trim();
}

/**
 * Deterministische Validierung eines LLM-Vorschlags — die harten Garantien
 * liegen HIER, nicht im Prompt:
 *  - Feld erlaubt, Wert nicht leer, weicht vom Bestand ab
 *  - sourceUrl ∈ tatsächlich gelesene Seiten (keine erfundenen Belege)
 *  - URL-Felder: https:// und Domain des Betreibers bzw. offizielles Verzeichnis
 */
export function validiereVorschlag(
  raw: { field?: unknown; value?: unknown; sourceUrl?: unknown; note?: unknown },
  kontext: { operator: string; bestand: Bestand; gelesen: Set<string>; siteHost?: string },
): GridSuggestion | { verworfen: string } {
  const field = String(raw.field ?? '') as FieldName;
  if (!ALLOWED_FIELDS.includes(field)) return { verworfen: `Feld ${String(raw.field)} nicht zulässig` };
  const value = String(raw.value ?? '').trim();
  if (!value) return { verworfen: `${field}: leerer Wert` };
  const sourceUrl = String(raw.sourceUrl ?? '').trim();
  if (!kontext.gelesen.has(sourceUrl)) return { verworfen: `${field}: sourceUrl nicht unter den gelesenen Seiten` };
  if ((kontext.bestand[field] ?? '').trim() === value) return { verworfen: `${field}: unverändert` };
  if (URL_FIELDS.has(field)) {
    if (!/^https:\/\//i.test(value)) return { verworfen: `${field}: keine https-URL` };
    let host: string;
    try { host = new URL(value).hostname; } catch { return { verworfen: `${field}: URL unparsebar` }; }
    const dom = baseDomain(host);
    const erlaubt = (kontext.siteHost && dom === baseDomain(kontext.siteHost)) || OFFICIAL_HOSTS.includes(dom);
    if (!erlaubt) return { verworfen: `${field}: Domain ${dom} gehört nicht zum Betreiber` };
  }
  if (field === 'notes' && value.length > 240) return { verworfen: 'notes: länger als 240 Zeichen' };
  const note = typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim().slice(0, 200) : undefined;
  return { operator: kontext.operator, field, value: field === 'notes' ? value.slice(0, 240) : value, sourceUrl, ...(note ? { note } : {}) };
}

export class NetzbetreiberSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'netzbetreiber',
    category: 'automation',
    description:
      'Netzbetreiber-Recherche für das Verzeichnis auf lokalkraft.at — prüft je österreichischem Strom-Netzbetreiber '
      + 'Smart-Meter-Portal, EEG-/Nahbereichs-Check, Kontaktdaten und Datenfreigabe-Hinweise auf deren offiziellen Websites '
      + 'und reicht Abweichungen als VORSCHLÄGE ein (menschliche Freigabe im Lokalkraft-Admin). '
      + '"check_operators" (operators: Slugs oder leer für alle, limit), "status".',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['check_operators', 'status'] },
        operators: { type: 'array', items: { type: 'string' }, description: 'Slugs aus lokalkraft.at/netzbetreiber; leer = Gesamtbestand' },
        limit: { type: 'number', description: 'max. Betreiber je Lauf (Default 15)' },
        dry_run: { type: 'boolean', description: 'true = recherchieren, aber NICHT einreichen (Vorschau)' },
      },
      required: ['action'],
    },
    timeoutMs: 1_800_000,
    inactivityThresholdMs: 1_800_000,
  };

  private llmCallback?: LlmCallback;
  /** Testbar: Fetch injizierbar. */
  fetchImpl: typeof fetch = fetch;
  /** Optionaler pino-Logger (vom Kern gesetzt). */
  logger?: { info: (obj: Record<string, unknown>, msg: string) => void };

  setLlmCallback(cb: LlmCallback): void {
    this.llmCallback = cb;
  }

  private get baseUrl(): string {
    return (process.env.ALFRED_GRID_BASE_URL ?? 'https://lokalkraft.at').replace(/\/$/, '');
  }

  private get gridKey(): string | undefined {
    const k = process.env.ALFRED_GRID_KEY?.trim();
    return k && k.length >= 16 ? k : undefined;
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    void context;
    const action = String(input.action ?? '');
    try {
      if (action === 'status') return await this.status();
      if (action === 'check_operators') return await this.checkOperators(input);
      return { success: false, error: `Unbekannte Aktion: ${action}` };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  private async holeSeite(url: string): Promise<string | undefined> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      const res = await this.fetchImpl(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'de-AT,de;q=0.9' }, redirect: 'follow', signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return undefined;
      return (await res.text()).slice(0, 500_000);
    } catch {
      return undefined;
    }
  }

  /** Bestand: Slugs aus der öffentlichen Verzeichnis-Seite. */
  async listeSlugs(): Promise<string[]> {
    const html = await this.holeSeite(`${this.baseUrl}/netzbetreiber`);
    if (!html) throw new Error(`${this.baseUrl}/netzbetreiber nicht erreichbar`);
    return [...new Set([...html.matchAll(/netzbetreiber\/([a-z0-9-]{3,})/g)].map(m => m[1]))];
  }

  /** Aktuelle Werte eines Betreibers von seiner Detailseite (LLM-Extraktion). */
  private async holeBestand(slug: string): Promise<Bestand | undefined> {
    const html = await this.holeSeite(`${this.baseUrl}/netzbetreiber/${slug}`);
    if (!html || !this.llmCallback) return undefined;
    const text = htmlZuText(html).slice(0, 6_000);
    const antwort = await this.llmCallback(
      'Auf dieser Verzeichnis-Seite eines österreichischen Strom-Netzbetreibers stehen die AKTUELL hinterlegten Daten. '
      + 'Extrahiere sie als JSON — Felder nur aufnehmen, wenn sie sichtbar sind, sonst weglassen:\n'
      + '{"name": "…", "ecPrefix": "AT-Zählpunkt-Präfix z.B. AT002000", "website": "…", "phone": "…", "email": "…", "smartMeterPortalUrl": "…", "eegCheckUrl": "…", "notes": "…"}\n'
      + 'Antworte NUR mit dem JSON-Objekt.\n\nSEITE:\n' + text,
      'fast',
    );
    const m = antwort.match(/\{[\s\S]*\}/);
    if (!m) return undefined;
    try { return JSON.parse(m[0]) as Bestand; } catch { return undefined; }
  }

  /** Kandidaten-Unterseiten der Betreiber-Website (gleiche Domain, passende Link-Texte). */
  private kandidatenLinks(html: string, site: URL): string[] {
    const out: string[] = [];
    for (const m of html.matchAll(/<a[^>]+href="([^"#]+)"[^>]*>([\s\S]{0,120}?)<\/a>/gi)) {
      const [_, href, label] = m;
      void _;
      if (!INTERESSANTE_LINKS.test(href) && !INTERESSANTE_LINKS.test(htmlZuText(label))) continue;
      try {
        const u = new URL(href, site);
        if (baseDomain(u.hostname) !== baseDomain(site.hostname)) continue;
        if (!/^https?:$/.test(u.protocol)) continue;
        u.hash = '';
        const s = u.toString();
        if (!out.includes(s)) out.push(s);
      } catch { /* kaputter Link */ }
    }
    return out.slice(0, 4);
  }

  /** Recherche für EINEN Betreiber → validierte Vorschläge. */
  private async recherchiere(slug: string): Promise<{ slug: string; vorschlaege: GridSuggestion[]; verworfen: string[]; hinweis?: string }> {
    const bestand = (await this.holeBestand(slug)) ?? {};
    const operator = bestand.ecPrefix?.trim() || slug;
    if (!bestand.website || !/^https?:\/\//i.test(bestand.website)) {
      return { slug, vorschlaege: [], verworfen: [], hinweis: 'keine Ausgangs-Website im Bestand — manuelle Erstpflege nötig' };
    }
    let site: URL;
    try { site = new URL(bestand.website); } catch {
      return { slug, vorschlaege: [], verworfen: [], hinweis: `Bestand-Website unparsebar: ${bestand.website}` };
    }
    // Seiten einsammeln: Startseite + bis zu 4 vielversprechende Unterseiten
    const gelesen = new Map<string, string>();
    const startHtml = await this.holeSeite(site.toString());
    if (!startHtml) return { slug, vorschlaege: [], verworfen: [], hinweis: `Website nicht erreichbar: ${site.hostname}` };
    gelesen.set(site.toString(), htmlZuText(startHtml).slice(0, 8_000));
    for (const link of this.kandidatenLinks(startHtml, site)) {
      const html = await this.holeSeite(link);
      if (html) gelesen.set(link, htmlZuText(html).slice(0, 8_000));
      await new Promise(r => setTimeout(r, 300)); // höflich bleiben
    }
    if (!this.llmCallback) return { slug, vorschlaege: [], verworfen: [], hinweis: 'LLM nicht verfügbar' };

    const seitenBlock = [...gelesen.entries()].map(([url, text]) => `=== SEITE ${url} ===\n${text}`).join('\n\n');
    const antwort = await this.llmCallback(
      `Du recherchierst für das Netzbetreiber-Verzeichnis einer österreichischen Energiegemeinschafts-Plattform. `
      + `Betreiber: ${bestand.name ?? slug}. AKTUELLER BESTAND (nur ABWEICHUNGEN vorschlagen):\n${JSON.stringify(bestand)}\n\n`
      + `Prüfe die folgenden Seiten der offiziellen Betreiber-Website und schlage Feld-Werte vor:\n`
      + `- website: offizielle Website des NETZBETREIBERS (nicht des Energie-Vertriebs!)\n`
      + `- smartMeterPortalUrl: Kundenportal für Smart-Meter-Werte bzw. Viertelstundenwerte/Datenfreigabe\n`
      + `- eegCheckUrl: Online-Check für Energiegemeinschaften (Nahbereichs-/EEG-Fähigkeit), falls vorhanden\n`
      + `- phone: Kundenservice-Telefon (Netz, NICHT Störungshotline)\n`
      + `- email: Kundenservice-E-Mail\n`
      + `- notes: max. 2 Sätze zur Datenfreigabe für Energiegemeinschaften\n\n`
      + `REGELN (hart): NUR Werte, die WÖRTLICH auf einer der Seiten stehen. sourceUrl = exakt die SEITEN-URL aus der Kopfzeile, `
      + `auf der die Information steht. Wenn ein Feld nicht sicher belegbar ist: WEGLASSEN. Nichts gefunden = leeres Array.\n`
      + `Antworte NUR mit einem JSON-Array: [{"field": "…", "value": "…", "sourceUrl": "…", "note": "1 kurzer Satz Kontext"}]\n\n`
      + seitenBlock,
      'fast',
    );
    const arr = antwort.match(/\[[\s\S]*\]/);
    let roh: unknown[] = [];
    try { roh = arr ? JSON.parse(arr[0]) as unknown[] : []; } catch { /* unparseable → keine Vorschläge */ }
    const vorschlaege: GridSuggestion[] = [];
    const verworfen: string[] = [];
    for (const r of roh) {
      const v = validiereVorschlag(r as Record<string, unknown>, { operator, bestand, gelesen: new Set(gelesen.keys()), siteHost: site.hostname });
      if ('verworfen' in v) verworfen.push(v.verworfen);
      else vorschlaege.push(v);
    }
    return { slug, vorschlaege, verworfen };
  }

  private async checkOperators(input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.gridKey && input.dry_run !== true) {
      return { success: false, error: 'ALFRED_GRID_KEY fehlt — ohne Schlüssel nur dry_run möglich.' };
    }
    const gewuenscht = Array.isArray(input.operators) ? (input.operators as unknown[]).map(String).filter(Boolean) : [];
    const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.min(input.limit, 500) : 15;
    const slugs = gewuenscht.length > 0 ? gewuenscht : (await this.listeSlugs()).slice(0, limit);

    const alle: GridSuggestion[] = [];
    const zeilen: string[] = [];
    for (const slug of slugs.slice(0, limit)) {
      const r = await this.recherchiere(slug);
      alle.push(...r.vorschlaege);
      zeilen.push(`- ${r.slug}: ${r.vorschlaege.length} Vorschlag/Vorschläge${r.verworfen.length ? ` (${r.verworfen.length} verworfen)` : ''}${r.hinweis ? ` — ${r.hinweis}` : ''}`);
      this.logger?.info({ slug: r.slug, vorschlaege: r.vorschlaege.length, verworfen: r.verworfen }, 'v1133 netzbetreiber-recherche');
    }

    if (input.dry_run === true || alle.length === 0) {
      return {
        success: true,
        data: { suggestions: alle, submitted: false },
        display: `🔎 Netzbetreiber-Recherche (${slugs.length} Betreiber, ${input.dry_run === true ? 'DRY-RUN — nichts eingereicht' : 'keine Abweichungen gefunden'}):\n${zeilen.join('\n')}`
          + (alle.length ? `\n\nVorschläge:\n${alle.map(s => `- ${s.operator} ${s.field} = ${s.value} (Beleg: ${s.sourceUrl})`).join('\n')}` : ''),
      };
    }

    // Einreichen (Batches à max. 500; je Betreiber+Feld überschreibt der neueste)
    let accepted = 0;
    const rejected: Array<{ operator?: string; field?: string; reason?: string }> = [];
    for (let i = 0; i < alle.length; i += 500) {
      const res = await this.fetchImpl(`${this.baseUrl}/api/integrations/v1/grid/suggestions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.gridKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestions: alle.slice(i, i + 500) }),
      });
      if (res.status === 404) return { success: false, error: 'Grid-Feature plattformseitig abgeschaltet (404 disabled) — Lauf beendet.' };
      if (res.status === 401) return { success: false, error: 'Grid-Key abgelehnt (401) — ALFRED_GRID_KEY prüfen.' };
      const body = await res.json().catch(() => ({})) as { data?: { accepted?: number; rejected?: Array<{ operator?: string; field?: string; reason?: string }> } };
      accepted += body.data?.accepted ?? 0;
      rejected.push(...(body.data?.rejected ?? []));
    }
    return {
      success: true,
      data: { accepted, rejected },
      display: `📨 Netzbetreiber-Recherche: ${accepted} Vorschlag/Vorschläge eingereicht (menschliche Freigabe im Lokalkraft-Admin), ${rejected.length} von der Plattform abgelehnt.`
        + `\n${zeilen.join('\n')}`
        + (rejected.length ? `\n\nAbgelehnt:\n${rejected.map(r => `- ${r.operator ?? '?'} ${r.field ?? '?'}: ${r.reason ?? '?'}`).join('\n')}` : ''),
    };
  }

  private async status(): Promise<SkillResult> {
    const slugs = await this.listeSlugs().catch(() => []);
    return {
      success: true,
      data: { operators: slugs.length, keyConfigured: Boolean(this.gridKey) },
      display: `ℹ️ Netzbetreiber-Verzeichnis: ${slugs.length} Betreiber auf ${this.baseUrl}/netzbetreiber; Grid-Key ${this.gridKey ? 'konfiguriert' : 'FEHLT (ALFRED_GRID_KEY)'}.`,
    };
  }
}
