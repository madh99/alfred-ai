/**
 * v1100 — Volltext-Anreicherung für Headline-only-Quellen.
 *
 * GoogleNews-RSS-Items tragen als Summary nur die Schlagzeile (Realfall
 * Adams 11.07.: der Lead-Artikel entstand aus EINEM Satz Stoff — das LLM
 * füllte mit Spekulation auf). Dieser Helfer löst die GoogleNews-Weiterleitung
 * auf (die /articles/<id>-Kennung enthält die Publisher-URL base64url-kodiert,
 * ganz ohne Netzwerk-Roundtrip) und extrahiert die Text-Absätze der Zielseite.
 * Paywall-Seiten liefern nur den Teaser — auch der ist mehr als die Schlagzeile.
 * Jeder Fehler ist still (undefined): Anreicherung ist optional, nie blockierend.
 */

const MAX_CHARS = 1800;

/** GoogleNews-Artikel-Kennung → Publisher-URL (base64url-dekodiert, offline). */
export function decodeGoogleNewsUrl(url: string): string | undefined {
  const m = url.match(/news\.google\.com\/(?:rss\/)?articles\/([^?/&]+)/);
  if (!m) return undefined;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const raw = Buffer.from(b64, 'base64').toString('latin1');
    // Im Protobuf steckt die Ziel-URL als Klartext — erste http(s)-URL greifen
    // (reines ASCII-Zeichenset; Steuer-/Multibyte-Zeichen beenden den Treffer).
    const hit = raw.match(/https?:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%[\]-]+/);
    return hit?.[0];
  } catch {
    return undefined;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
}

/** Text-Absätze aus HTML ziehen (nur <p> mit Substanz — Menü/Cookie-Zeilen sind kurz). */
export function extractArticleText(html: string): string | undefined {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  const paras: string[] = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m: RegExpExecArray | null;
  let collected = 0;
  while ((m = re.exec(cleaned)) !== null && collected < MAX_CHARS * 2) {
    const text = decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (text.length >= 60) {
      paras.push(text);
      collected += text.length;
    }
  }
  const joined = paras.join('\n\n').slice(0, MAX_CHARS);
  return joined.length >= 200 ? joined : undefined;
}

/** Artikeltext einer News-URL holen (GoogleNews wird vorab dekodiert). */
export async function fetchArticleText(url: string, timeoutMs = 8_000): Promise<string | undefined> {
  const target = decodeGoogleNewsUrl(url) ?? url;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(target, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; AlfredNews/1.0)', accept: 'text/html' },
    });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    if (!(res.headers.get('content-type') ?? '').includes('html')) return undefined;
    const html = (await res.text()).slice(0, 500_000);
    return extractArticleText(html);
  } catch {
    return undefined;
  }
}
