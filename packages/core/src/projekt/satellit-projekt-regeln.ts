/**
 * v1387 (R2, Owner-Freigabe 12.10.) — Projekt-Agent mit Ausführungsziel Satellit: feste Texte und Regeln ohne Modell.
 * Der Server-Projekt-Agent (project-agent-runner.ts) bleibt unverändert; dieser Ablauf nutzt dieselben Bausteine
 * (Planer, Umplan-Prüfer) und die R1-Bausteine am Gerät (Auftrag, Ende-Meldung, pruefen_befehl).
 */

/** v1394 — Budget und Zeit sind optional: nur, wenn der Owner sie nennt (Owner 12.10.: „das Budget nur prüfen, wenn man es mitgibt; von der Zeit eine harte Grenze finde ich nicht gut"). */
export interface Grenzen { budgetUsd?: number; maxStunden?: number; maxEtappen: number; maxFixVersuche: number }
/** Höchstens 8 Etappen, 3 Fix-Versuche je Etappe; Budget und Zeit ohne Vorgabe unbegrenzt. */
export const STANDARD_GRENZEN: Grenzen = { maxEtappen: 8, maxFixVersuche: 3 };

export type MutationsArt = 'done' | 'proceed' | 'skip' | 'merge' | 'extend' | 'replace';

/**
 * Umplanen am Satelliten (Owner-Entscheidung 12.10.): Verkürzen geht automatisch (weiter, überspringen, fertig);
 * neuer Plantext (zusammenlegen, erweitern, ersetzen) nur nach Rückfrage — sonst könnte eine in der Ausgabe von
 * Claude Code eingeschleuste Anweisung zu einem neuen Auftrag werden.
 */
export function mutationAutomatisch(art: MutationsArt): boolean {
  return art === 'proceed' || art === 'skip' || art === 'done';
}

/** Plan auf die Etappengrenze kürzen; überzählige Etappen werden zur letzten zusammengefasst, nicht verworfen. */
export function begrenzePlan(phasen: string[], max: number): string[] {
  const p = phasen.map(x => x.trim()).filter(Boolean);
  if (p.length <= max) return p;
  return [...p.slice(0, max - 1), `${p.slice(max - 1).join(' — danach: ')}`];
}

export function etappenAuftrag(o: { ziel: string; plan: string[]; nr: number; pruefBefehle: string[] }): string {
  const etappe = o.plan[o.nr - 1]!;
  return [
    `Projektziel: ${o.ziel}`,
    '',
    `Gesamtplan (${o.plan.length} Etappen):`,
    ...o.plan.map((p, i) => `${i + 1}. ${p}${i + 1 === o.nr ? '  ← JETZT' : i + 1 < o.nr ? '  (erledigt)' : ''}`),
    '',
    `Aufgabe: Setze NUR Etappe ${o.nr} um: ${etappe}`,
    o.pruefBefehle.length ? `Abnahme: Danach müssen diese Befehle im Projektverzeichnis mit Exit 0 laufen: ${o.pruefBefehle.join(' ; ')}` : 'Abnahme: Der Owner prüft diese Etappe selbst; beschreibe am Ende, wie man sie prüft.',
    'Ist das Verzeichnis ein Git-Repository, committe am Ende mit der Nachricht „Etappe ' + o.nr + ': <Kurztitel>".',
    'Arbeite nur in diesem Verzeichnis. Fasse am Ende in wenigen Sätzen zusammen, was du gemacht hast und was offen ist.',
  ].join('\n');
}

export function fixAuftrag(o: { ziel: string; nr: number; etappe: string; versuch: number; pruefprotokoll: string }): string {
  return [
    `Projektziel: ${o.ziel}`,
    `Etappe ${o.nr}: ${o.etappe}`,
    '',
    `Die Abnahme ist fehlgeschlagen (Fix-Versuch ${o.versuch}). Prüfprotokoll:`,
    o.pruefprotokoll.slice(0, 6000),
    '',
    'Behebe die Ursache, ohne die Prüfbefehle zu ändern oder Tests abzuschwächen. Committe am Ende (falls Git-Repository) mit „Etappe ' + o.nr + ': Korrektur".',
  ].join('\n');
}

export function planFrage(o: { geraet: string; projekt: string; ziel: string; plan: string[]; pruefBefehle: string[]; g: Grenzen; gekuerzt: boolean; verzeichnisNeu?: boolean }): string {
  return [
    `🧭 Projekt auf ${o.geraet} starten?`,
    `Ziel: ${o.ziel.slice(0, 300)}`,
    `Verzeichnis: ${o.projekt}${o.verzeichnisNeu ? ' (neu — wird als Git-Repository angelegt, jede Etappe ein Commit)' : ''}`,
    `Etappen${o.gekuerzt ? ` (auf ${o.g.maxEtappen} gekürzt)` : ''}:`,
    ...o.plan.map((p, i) => `${i + 1}. ${p.slice(0, 200)}`),
    `Abnahme je Etappe: ${o.pruefBefehle.length ? o.pruefBefehle.join(' ; ') : 'keine Prüfbefehle — nach jeder Etappe frage ich dich'}`,
    `Grenzen: ${[o.g.budgetUsd !== undefined ? `${o.g.budgetUsd} USD` : 'kein Budget', o.g.maxStunden !== undefined ? `${o.g.maxStunden} h` : 'keine Zeitgrenze'].join(', ')}, ${o.g.maxFixVersuche} Fix-Versuche je Etappe.`,
    'Freigabe gilt nur für Claude-Code-Aufträge und Prüfbefehle in diesem Verzeichnis, bis Budget, Zeit oder Ende.',
  ].join('\n');
}

export function mutationText(m: { kind: string; newPhase?: string; newPhases?: string[]; phaseIndices?: number[]; reasoning?: string }, rest: string[]): string {
  const neu = m.newPhases ?? (m.newPhase ? [m.newPhase] : []);
  const weg = (m.phaseIndices ?? []).map(i => rest[i]).filter(Boolean);
  return [
    `Planänderung vorgeschlagen (${m.kind}): ${String(m.reasoning ?? '').slice(0, 300)}`,
    ...(weg.length ? ['Entfällt:', ...weg.map(w => `− ${w!.slice(0, 160)}`)] : []),
    ...(neu.length ? ['Neu:', ...neu.map(n => `+ ${n.slice(0, 200)}`)] : []),
  ].join('\n');
}

/** Grenzen prüfen: liefert den Grund zum Anhalten oder undefined. */
export function grenzeErreicht(o: { kostenUsd: number; startMs: number; jetztMs: number; g: Grenzen }): string | undefined {
  if (o.g.budgetUsd !== undefined && o.kostenUsd >= o.g.budgetUsd) return `Budget erreicht (${o.kostenUsd.toFixed(2)} von ${o.g.budgetUsd} USD)`;
  if (o.g.maxStunden !== undefined && o.jetztMs - o.startMs >= o.g.maxStunden * 3_600_000) return `Zeitlimit erreicht (${o.g.maxStunden} h)`;
  return undefined;
}

/** v1392 — Uhrzeit in Wien für Meldungen und Lage. */
export function uhrzeit(ms: number): string {
  return new Date(ms).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Vienna' });
}

/**
 * v1392 — eine Zeile je laufendem oder wartendem Projekt (Lage, Vorgang „nächster Schritt"). Owner 12.10.: „wo sieht man,
 * dass etwas läuft?" — zwischen Bestätigung und erster Etappenmeldung war nichts zu sehen.
 */
export function projektZeile(s: { id: string; geraet: string; status: string; nr: number; plan: string[]; kostenUsd: number; etappeStart?: number; fixVersuch: number; frage?: { text: string } }, jetztMs: number): string | null {
  const kosten = `${s.kostenUsd.toFixed(2).replace('.', ',')} USD`;
  if (s.status === 'laeuft') {
    const seit = s.etappeStart !== undefined ? ` seit ${uhrzeit(s.etappeStart)} (${Math.max(0, Math.round((jetztMs - s.etappeStart) / 60_000))} min)` : '';
    return `${s.id} auf ${s.geraet}: Etappe ${s.nr}/${s.plan.length}${s.fixVersuch ? ` (Fix ${s.fixVersuch})` : ''} läuft${seit}, ${kosten}`;
  }
  if (s.status === 'wartet_owner') return `${s.id} auf ${s.geraet}: wartet auf dich — ${(s.frage?.text ?? '').split('\n')[0]!.slice(0, 100)}`;
  return null;
}
