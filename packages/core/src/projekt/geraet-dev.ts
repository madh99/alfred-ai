/**
 * v1460 — dev je Projekt: „am Gerät“ (Standard; die App läuft im Arbeitsordner des Geräts, Alfred startet sie über den Satelliten)
 * oder „eigener Host“ (das dev-Deploy-Ziel per SSH, v1443). Owner 15.10.: „dev wahlweise auf dem Gerät selbst lassen oder einen
 * anderen Host bestimmen … wie man das Programm starten muss, sollte Alfred automatisch herausfinden — vor allem, wenn man das Projekt
 * mit ihm von Anfang an startet; wenn man eines übernimmt, wenn man es aktiviert, oder man trägt es manuell ein.“
 *
 * Gespeichert unter projects.deploy_ziel.geraetDev (neben den Stufen). Ein Startbefehl wird nur nach Owner-Bestätigung ausgeführt.
 */

export interface StartAngabe { dienst: boolean; start?: string; port?: number; pruefung?: string; /** v1464 — einmalige Einrichtung frischer Ordner (test) */ einrichten?: string[] }

export interface GeraetDev {
  art: 'geraet' | 'host';
  /** dev am Gerät aktiv: neue Projekte (mit Alfred begonnen) automatisch, übernommene erst, wenn der Owner es einschaltet */
  aktiv?: boolean;
  /** bestätigte Startangabe (Owner) */
  angabe?: StartAngabe;
  quelle?: 'datei' | 'erkannt' | 'claude' | 'manuell';
  /** zuletzt zur Bestätigung gestellte Angabe (gegen wiederholte Fragen) */
  vorgeschlagen?: StartAngabe;
  zuletzt?: { zeit: string; ok: boolean; url?: string; text: string };
  /** v1462 — test am Gerät: eigener Ordner aus dem Zielzweig, eigener Port, Start wie dev */
  test?: { aktiv?: boolean; ordner: string; port?: number; zweig?: string; zuletzt?: { zeit: string; ok: boolean; url?: string; sha?: string; text: string } };
}

/** Aus deploy_ziel; ohne Eintrag: am Gerät, außer ein dev-Host ist schon eingetragen (bisheriges Verhalten bleibt). */
export function geraetDevAus(deployZiel: Record<string, unknown> | undefined, devHostDa: boolean): GeraetDev {
  const g = deployZiel?.geraetDev as Partial<GeraetDev> | undefined;
  if (!g || typeof g !== 'object') return { art: devHostDa ? 'host' : 'geraet' };
  return { ...g, art: g.art === 'host' ? 'host' : 'geraet' } as GeraetDev;
}

export function angabeGleich(a: StartAngabe | undefined, b: StartAngabe | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.dienst === b.dienst && (a.start ?? '') === (b.start ?? '') && (a.port ?? 0) === (b.port ?? 0) && (a.pruefung ?? '') === (b.pruefung ?? '') && (a.einrichten ?? []).join('\n') === (b.einrichten ?? []).join('\n');
}

export function angabeText(a: StartAngabe): string {
  if (!a.dienst) return 'kein Dienst (dev heißt hier: Build und Tests grün)';
  return `Start \`${a.start}\`${a.port ? `, Port ${a.port}` : ''}${a.pruefung ? `, Prüfadresse ${a.pruefung}` : ''}${a.einrichten?.length ? `, Einrichtung ${a.einrichten.map(b => `\`${b}\``).join(', ')}` : ''}`;
}

/** Etappenregel: wie das Projekt startet, hält Claude Code an fester Stelle fest (Alfred liest es danach ohne Modell). */
export const START_REGEL = 'Startangabe: Ist das Projekt ein Dienst (Server, Web-App, API) oder wird es einer, halte in der Datei .alfred-start.json im Projektordner fest, wie es lokal startet — {"dienst": true, "start": "<Befehl im Projektordner>", "port": <Port>, "pruefung": "<Pfad, der mit Status 2xx antwortet>", "einrichten": ["<einmalige Befehle für einen frischen Ordner, z. B. Browser-Installation — nur wenn nötig>"]}; sonst {"dienst": false}. Halte die Datei aktuell, wenn sich Start, Port oder Prüfadresse ändern. Starte den Dienst nicht dauerhaft selbst — das übernimmt Alfred.';

/** Bestätigungstext für eine Startangabe. */
export function vorschlagText(o: { name: string; geraet: string; pfad: string; angabe: StartAngabe; quelle: string; hinweise: string[]; geaendert?: StartAngabe }): string {
  return [
    `▶ dev am Gerät für „${o.name}“ (${o.geraet}, ${o.pfad}):`,
    angabeText(o.angabe),
    `Herkunft: ${o.quelle === 'datei' ? '.alfred-start.json im Projekt' : o.quelle === 'claude' ? 'von Claude Code ermittelt (nur lesend)' : o.quelle === 'manuell' ? 'von dir eingetragen' : 'erkannt'}${o.hinweise.length ? ` — ${o.hinweise.join('; ')}` : ''}`,
    ...(o.geaendert ? [`Bisher: ${angabeText(o.geaendert)}`] : []),
    o.angabe.dienst ? 'Ja: so übernehmen und starten — Alfred startet dev nach jeder grünen Etappe neu (eine laufende Instanz dieses Projekts wird ersetzt, fremde Prozesse nie).' : 'Ja: so übernehmen (es wird nichts gestartet).',
  ].join('\n');
}

/** v1462 — Vorschlag für test am Gerät: Ordner neben dem Projekt (…-test), Port dev + 1000 (sonst + 1). */
export function testVorschlag(cwd: string, devPort?: number): { ordner: string; port?: number } {
  const ordner = `${cwd.replace(/[\\/]+$/, '')}-test`;
  if (!devPort) return { ordner };
  return { ordner, port: devPort + 1000 < 65536 ? devPort + 1000 : devPort + 1 };
}

/** v1462 — .env-Inhalt aus einer Projektumgebung (gleiche Maskierung wie der Deploy-Skill). */
export function envText(vars: Record<string, string>): string {
  const wert = (v: string) => { const s = v.replace(/[\r\n]/g, ''); return /[\s"'$`\\#]/.test(s) ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')}"` : s; };
  return Object.entries(vars).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).map(([k, v]) => `${k}=${wert(v)}`).join('\n') + '\n';
}
