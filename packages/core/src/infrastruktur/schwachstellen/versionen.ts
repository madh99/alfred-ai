/**
 * Spec Schwachstellen-Überwachung §3 — Versionsvergleich und Auswertung der Bereichsangaben aus Hersteller-Advisories.
 *
 * GitHub-Repo-Advisories nennen Bereiche als freien Text (Realfall Vaultwarden 25.11.: „<=1.37.3“, „>= 1.33.0, <= 1.37.3“, „≤ 1.36.0 “,
 * „<1.35.8“, „1.35.3“). Maßgeblich ist die behobene Version: betroffen ist, wer darunter liegt und die übrigen Grenzen erfüllt. Eine
 * bloße Versionsangabe gilt als „bis einschließlich“. Ohne behobene Version und ohne Grenze ist die Lage unbekannt (undefined).
 */

/** Zerlegt „v1.37.5“, „1.144.0“, „4.18.0-r0“, „v4.47.1-ls208“ in Zahlen; Zusätze nach „-“/„+“ zählen nicht */
export function versionTeile(v: string): number[] | undefined {
  const m = /^\s*v?(\d+(?:\.\d+)*)/i.exec(v);
  return m ? m[1]!.split('.').map(Number) : undefined;
}

/** < 0: a älter, 0: gleich, > 0: a neuer; undefined, wenn eine Seite keine Version ist */
export function vergleiche(a: string, b: string): number | undefined {
  const x = versionTeile(a); const y = versionTeile(b);
  if (!x || !y) return undefined;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

type Grenze = { op: '<' | '<=' | '>' | '>=' | '='; v: string };

/** „>= 1.33.0, <= 1.37.3“ → Grenzen; „1.35.3“ allein → <= 1.35.3; Unlesbares → undefined */
export function leseBereich(text: string): Grenze[] | undefined {
  const t = text.replace(/≤/g, '<=').replace(/≥/g, '>=').trim();
  if (!t) return [];
  const teile = t.split(/\s*,\s*|\s+(?=[<>=])/).map(x => x.trim()).filter(Boolean);
  const g: Grenze[] = [];
  for (const p of teile) {
    const m = /^(<=|>=|<|>|=)?\s*(v?\d+(?:\.\d+)*\S*)$/.exec(p);
    if (!m) return undefined;
    g.push({ op: (m[1] as Grenze['op'] | undefined) ?? (teile.length === 1 ? '<=' : '='), v: m[2]! });
  }
  return g;
}

/**
 * Betroffen? true/false; undefined = nicht entscheidbar (keine Version, unlesbarer Bereich ohne behobene Version).
 * behoben: kleinste behobene Version (Liste „1.37.4“ oder „1.36.1, 1.37.0“); laufende Versionen darunter sind betroffen,
 * sofern sie die unteren Grenzen des Bereichs erfüllen.
 */
export function betroffen(version: string, bereich: string | undefined, behoben: string | undefined): boolean | undefined {
  if (!versionTeile(version)) return undefined;
  const fix = (behoben ?? '').split(/\s*,\s*/).map(x => x.trim()).filter(x => versionTeile(x)).sort((a, b) => vergleiche(a, b)!)[0];
  const g = bereich !== undefined ? leseBereich(bereich) : [];
  const erfuellt = (x: Grenze) => {
    const d = vergleiche(version, x.v)!;
    return x.op === '<' ? d < 0 : x.op === '<=' ? d <= 0 : x.op === '>' ? d > 0 : x.op === '>=' ? d >= 0 : d === 0;
  };
  if (fix) {
    if (vergleiche(version, fix)! >= 0) return false;
    // nur untere Grenzen zählen zusätzlich (obere sind durch die behobene Version abgedeckt bzw. oft ungenau)
    return (g ?? []).filter(x => x.op === '>' || x.op === '>=').every(erfuellt);
  }
  if (!g || !g.length) return undefined;
  return g.every(erfuellt);
}
