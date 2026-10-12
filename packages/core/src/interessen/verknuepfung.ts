/**
 * v1367 — Interessen als Wissen, Schritt „Verknüpfung" BEOBACHTEND (Owner 12.10.: „ok wie empfohlen", I3).
 *
 * Owner-Verständnis der Interessen: Alfred erkennt Neuigkeiten, die mit ihm oder mit Dingen, die er verwendet, zu tun
 * haben, und meldet diese. Gebaut war das nie (die Themen-Beiträge wurden nur gesammelt und still abgelegt). Hier der
 * deterministische erste Teil: Anker aus dem, was der Owner hat und kennt — Hersteller und Modelle seiner Geräte in Home
 * Assistant, Organisationen, Fahrzeug, Orte und Kürzel aus dem Wissensgraph — gegen neue Beiträge der Themen und der
 * abonnierten Feeds. Treffer im Titel zählen stark, nur in der Zusammenfassung schwach; je Anker höchstens wenige am Tag.
 * Zwei Wochen nur Logzeilen („wäre Hinweis geworden"), dann Entscheidung über die Meldung (I4).
 *
 * Kalibriert offline an 6 071 Beiträgen (05.–12.10.): 5 % mit Anker; Funde wie „Home Assistant 2026.10", „Shelly Plug über
 * stündliche Strompreise steuern" (aWATTar), „Ultraschnellladepark Altlengbach", „BMW-Modelle, die bidirektional laden";
 * Lärm vor allem Bitcoin (214, meist nur in der Zusammenfassung) — daher stark/schwach und Tagesgrenze je Anker.
 */

export type AnkerArt = 'gerät' | 'organisation' | 'fahrzeug' | 'ort' | 'kürzel';

export interface Anker { wort: string; art: AnkerArt; herkunft: string }

export interface Beitrag { titel: string; zusammenfassung?: string; url?: string; thema: string }

export interface VerknuepfungsTreffer { beitrag: Beitrag; anker: Anker[]; stark: boolean }

/** Rechtsform- und Füllzusätze in Herstellernamen („go-e GmbH [Austria]", „Ubiquiti Networks", „Super Micro Computer, Inc."). */
const RECHTSFORM = /\s*(\[[^\]]*\]|\(.*?\)|,?\s*(gmbh|ag|inc\.?|ltd\.?|llc|co\.,?|corp\.?|ab|s\.?a\.?|limited|trading|server solutions|networks|technology|computer|communications|electronics|transceivers)\b\.?)+\s*$/i;

/** Große Marken: allein zu allgemein (jede zweite Technik-Meldung) — nur zusammen mit der Produktlinie aus dem Modell. */
const GROSSMARKEN = new Set(['apple', 'google', 'samsung', 'lg', 'nvidia', 'philips', 'spotify', 'xiaomi', 'amazon', 'microsoft', 'sony']);

/** Keine Geräte des Owners: Integrationen, Erweiterungen, Netzwerk-Kennungen. */
const KEIN_GERAET = /^(home assistant|hacs\.xyz|custom devices|ieee registration authority|broadcom|espressif|met\.no|forecast\.solar|google translate|zigbee2mqtt|raspberr|humax|adbitali)\b/i;
const ERWEITERUNG = /^(plugin|integration|theme)$/i;

function sauber(s: string): string {
  let t = s.trim();
  for (let i = 0; i < 3; i++) t = t.replace(RECHTSFORM, '').trim();
  return t;
}

/** Anker aus Hersteller/Modell der Home-Assistant-Geräte. */
export function ankerAusGeraeten(geraete: Array<{ hersteller: string; modell?: string }>): Anker[] {
  const aus = new Map<string, Anker>();
  for (const g of geraete) {
    if (!g.hersteller || KEIN_GERAET.test(g.hersteller) || ERWEITERUNG.test(g.modell ?? '')) continue;
    const h = sauber(g.hersteller);
    if (h.length < 3 && !GROSSMARKEN.has(h.toLowerCase())) continue; // „LG" ist kurz, aber mit Produktlinie eindeutig
    if (GROSSMARKEN.has(h.toLowerCase())) {
      const linie = (g.modell ?? '').match(/[A-Za-z][A-Za-z]{2,}/)?.[0];
      if (!linie || /^(sm|iphone)$/i.test(linie)) continue; // Handys: Modellkennungen ohne Nachrichtenwert
      const w = `${h} ${linie}`;
      aus.set(w.toLowerCase(), { wort: w, art: 'gerät', herkunft: `Home Assistant: ${g.hersteller} ${g.modell ?? ''}`.trim() });
    } else {
      aus.set(h.toLowerCase(), { wort: h, art: 'gerät', herkunft: `Home Assistant: ${g.hersteller}` });
    }
  }
  return [...aus.values()];
}

/** Länder und Bundesländer sind als Ort zu allgemein. */
const ZU_ALLGEMEIN = new Set(['österreich', 'deutschland', 'niederösterreich', 'oberösterreich', 'steiermark', 'europa', 'eu', 'schweiz']);

/** Anker aus dem Wissensgraph: Organisationen, Fahrzeug, Orte, Kürzel (z. B. gehaltene Kryptowährungen). */
export function ankerAusWissen(entitaeten: Array<{ name: string; typ: string }>): Anker[] {
  const aus = new Map<string, Anker>();
  for (const e of entitaeten) {
    const name = sauber(e.name);
    if (name.length < 2) continue;
    let art: AnkerArt | null = null;
    if (e.typ === 'organization') art = 'organisation';
    else if (e.typ === 'vehicle') art = 'fahrzeug';
    else if (e.typ === 'location' && !ZU_ALLGEMEIN.has(name.toLowerCase())) art = 'ort';
    else if (e.typ === 'item' && /^[A-Z]{2,5}$/.test(name)) art = 'kürzel';
    if (!art || (art !== 'kürzel' && name.length < 3)) continue;
    aus.set(name.toLowerCase(), { wort: name, art, herkunft: `Wissen: ${e.typ}` });
  }
  return [...aus.values()];
}

function muster(a: Anker): RegExp {
  const w = a.wort.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  // Kürzel nur großgeschrieben („SOL", nicht „sol"), sonst ohne Groß/Klein
  return new RegExp(`(^|[^\\p{L}\\p{N}])${w}($|[^\\p{L}\\p{N}])`, a.art === 'kürzel' ? 'u' : 'iu');
}

/** Welche Anker trifft ein Beitrag — im Titel (stark) oder nur in der Zusammenfassung (schwach)? */
export function verknuepfe(b: Beitrag, anker: Array<Anker & { re?: RegExp }>): VerknuepfungsTreffer | null {
  const imTitel: Anker[] = []; const imText: Anker[] = [];
  for (const a of anker) {
    const re = a.re ?? muster(a);
    if (re.test(b.titel)) imTitel.push(a);
    else if (b.zusammenfassung && re.test(b.zusammenfassung)) imText.push(a);
  }
  if (imTitel.length === 0 && imText.length === 0) return null;
  return { beitrag: b, anker: imTitel.length ? imTitel : imText, stark: imTitel.length > 0 };
}

/** Anker mit vorbereitetem Muster (einmal je Lauf). */
export function vorbereiten(anker: Anker[]): Array<Anker & { re: RegExp }> {
  return anker.map(a => ({ ...a, re: muster(a) }));
}

/**
 * Auswahl eines Laufs: starke vor schwachen, je Anker höchstens `jeAnker` (bisherige Zählung des Tages wird
 * übergeben und fortgeschrieben), gleiche Titel nur einmal (mehrere Themen sammeln denselben Beitrag).
 */
export function auswahl(treffer: VerknuepfungsTreffer[], heute: Map<string, number>, jeAnker = 3): VerknuepfungsTreffer[] {
  const gesehen = new Set<string>();
  const aus: VerknuepfungsTreffer[] = [];
  for (const t of [...treffer].sort((a, b) => Number(b.stark) - Number(a.stark))) {
    const titel = t.beitrag.titel.trim().toLowerCase();
    if (gesehen.has(titel)) continue;
    const frei = t.anker.filter(a => (heute.get(a.wort.toLowerCase()) ?? 0) < jeAnker);
    if (frei.length === 0) continue;
    gesehen.add(titel);
    for (const a of frei) heute.set(a.wort.toLowerCase(), (heute.get(a.wort.toLowerCase()) ?? 0) + 1);
    aus.push({ ...t, anker: frei });
  }
  return aus;
}
