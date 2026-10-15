/**
 * v1459 — Status eines willhaben-Inserats aus den Seitendaten (__NEXT_DATA__ → advertDetails.advertStatus, deleteReason).
 * Realfall 15.10. 09:00: Die geplante Mac-Prüfung las die Inserate mit dem rohen http-Werkzeug und konnte „verkauft“ nicht
 * sicher ablesen; am Vorabend (marketplace detail) ging es. Beide Wege nutzen jetzt diesen Baustein — das Ergebnis hängt nicht
 * mehr davon ab, welches Werkzeug das Modell wählt. Geprüft an echten Seiten: verkauft = {id:"sold", statusId:120,
 * deleteReason:"SOLD_ON_WILLHABEN"}, aktiv = {id:"active", statusId:50}.
 */

export interface WillhabenStatus {
  /** aktiv | verkauft | reserviert | sonst die Beschreibung von willhaben */
  status: string;
  /** Rohwert advertStatus.id */
  id: string;
  /** deleteReason, z. B. SOLD_ON_WILLHABEN */
  grund?: string;
}

const NAMEN: Record<string, string> = { active: 'aktiv', sold: 'verkauft', reserved: 'reserviert' };

/** Aus dem (geparsten) advertDetails-Objekt. */
export function willhabenStatusAus(ad: unknown): WillhabenStatus | undefined {
  const a = ad as { advertStatus?: { id?: unknown; description?: unknown }; deleteReason?: unknown } | undefined;
  const id = typeof a?.advertStatus?.id === 'string' ? a.advertStatus.id : undefined;
  if (!id) return undefined;
  const beschreibung = typeof a?.advertStatus?.description === 'string' ? a.advertStatus.description : id;
  return { status: NAMEN[id] ?? beschreibung, id, ...(typeof a?.deleteReason === 'string' && a.deleteReason ? { grund: a.deleteReason } : {}) };
}

/** Aus dem HTML einer willhaben-Detailseite; undefined, wenn die Seite keine Inseratsdaten enthält. */
export function willhabenStatusAusHtml(html: string): WillhabenStatus | undefined {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return undefined;
  try { return willhabenStatusAus((JSON.parse(m[1]!) as { props?: { pageProps?: { advertDetails?: unknown } } })?.props?.pageProps?.advertDetails); } catch { return undefined; }
}

/** Eine Zeile für die Anzeige: „Status laut willhaben: verkauft (SOLD_ON_WILLHABEN)“. */
export function willhabenStatusZeile(s: WillhabenStatus): string {
  return `Status laut willhaben: ${s.status}${s.grund ? ` (${s.grund})` : ''}`;
}
