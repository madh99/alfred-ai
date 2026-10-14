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

/**
 * v1452 — Owner 14.10.: „das sollte eigentlich immer so sein, dass Laufzeitdaten nicht ins Repo kommen“ (Realfall Angebots-Radar:
 * daten/angebote-cache.json, 2,2 MB, war eingecheckt und änderte sich bei jedem Lauf). Gilt für jede Etappe und jeden Fix-Versuch.
 */
export const LAUFZEITDATEN_REGEL = 'Laufzeitdaten gehören nie ins Repository: Caches, Datenbanken, Logs, Sicherungen, Uploads und Nutzerdaten, die das Programm im Betrieb erzeugt oder ändert. Trag sie in die .gitignore ein; ist eine davon schon eingecheckt, nimm sie mit „git rm --cached“ aus dem Repository (die Datei selbst bleibt liegen). Beispieldaten oder Fixtures für Tests sind keine Laufzeitdaten.';

/** v1453 — vor dem Lauf vorgefundene Änderungen gehören dem Owner; die Etappen lassen sie liegen. */
export function vorgefundenRegel(v?: string[]): string[] {
  if (!v?.length) return [];
  return [`Vor dem Lauf lagen diese nicht eingecheckten Änderungen schon vor; sie gehören dem Owner: ${v.join('; ')}. Ändere sie nicht, setze sie nicht zurück und committe sie nicht mit (git add nur für deine eigenen Dateien, kein „git add -A“ oder „git add .“). Einzige Ausnahme: Laufzeitdaten nach der Regel oben aus dem Repository nehmen.`];
}

export function etappenAuftrag(o: { ziel: string; plan: string[]; nr: number; pruefBefehle: string[]; bestehend?: boolean; umgebung?: string; vorgefunden?: string[] }): string {
  const etappe = o.plan[o.nr - 1]!;
  return [
    `Projektziel: ${o.ziel}`,
    '',
    `Gesamtplan (${o.plan.length} Etappen):`,
    ...o.plan.map((p, i) => `${i + 1}. ${p}${i + 1 === o.nr ? '  ← JETZT' : i + 1 < o.nr ? '  (erledigt)' : ''}`),
    '',
    `Aufgabe: Setze NUR Etappe ${o.nr} um: ${etappe}`,
    // v1398 — Weiterarbeit an einem bestehenden Projekt
    ...(o.bestehend ? ['Bestehendes Projekt: lies zuerst README und Struktur, erweitere das Vorhandene, lege nichts neu an, was es schon gibt, und halte die bestehenden Tests grün.'] : []),
    // v1408 R3a — Umgebung bekannt; Systemweites nicht selbst installieren, sondern melden (Installieren mit Bestätigung, R3c)
    ...(o.umgebung ? [`Umgebung des Geräts: ${o.umgebung}.`, 'Fehlt ein Werkzeug systemweit, installiere es nicht selbst, sondern schreib am Ende eine eigene Zeile „FEHLT: <werkzeug>“. Projekt-lokale Abhängigkeiten (z. B. npm install im Projekt) sind erlaubt.'] : []),
    o.pruefBefehle.length ? `Abnahme: Danach müssen diese Befehle im Projektverzeichnis mit Exit 0 laufen: ${o.pruefBefehle.join(' ; ')}` : 'Abnahme: Der Owner prüft diese Etappe selbst; beschreibe am Ende, wie man sie prüft.',
    'Ist das Verzeichnis ein Git-Repository, committe am Ende mit der Nachricht „Etappe ' + o.nr + ': <Kurztitel>".',
    LAUFZEITDATEN_REGEL,
    ...vorgefundenRegel(o.vorgefunden),
    'Arbeite nur in diesem Verzeichnis. Fasse am Ende in wenigen Sätzen zusammen, was du gemacht hast und was offen ist.',
    'Der Ordner .alfred/ gehört Alfred (Aufträge, Protokoll, Anhänge des Owners): lesen ja, nicht ändern oder löschen.', // v1425
  ].join('\n');
}

/**
 * v1425 — Etappenbericht als Markdown fürs Projekt (.alfred/laeufe/<lauf>/etappe-<n>-bericht.md): was der Auftrag war, was gemacht
 * wurde, Dateien, Commit, Abnahme, Kosten. Reine Formatierung aus dem gespeicherten Etappenergebnis.
 */
export function etappenBerichtText(o: { lauf: string; geraet: string; ziel: string; plan: string[]; zeit: string; e: { nr: number; etappe: string; ok: boolean; geprueft: boolean; fixVersuche: number; kostenUsd: number; text: string; zusammenfassung?: string; dateien?: string[]; dateienAnzahl?: number; commit?: { sha: string; titel: string }; abnahme?: { ok: boolean; protokoll: string }; dauerS?: number } }): string {
  const e = o.e;
  const ergebnis = !e.ok ? `❌ nicht abgenommen${e.fixVersuche ? ` (nach ${e.fixVersuche} Fix-Versuch(en))` : ''}` : e.geprueft ? `✅ abgenommen${e.fixVersuche ? ` nach ${e.fixVersuche} Fix-Versuch(en)` : ''}` : '⚠️ fertig, ohne automatische Abnahme';
  const dauer = e.dauerS !== undefined ? ` · Dauer ${Math.max(1, Math.round(e.dauerS / 60))} min` : '';
  const dateien = e.dateien?.length ? [...e.dateien.map(d => `- ${d}`), ...((e.dateienAnzahl ?? 0) > e.dateien.length ? [`- … und ${(e.dateienAnzahl ?? 0) - e.dateien.length} weitere`] : [])] : ['- (keine Angabe)'];
  return [
    `# Etappe ${e.nr}/${o.plan.length}: ${e.etappe}`,
    '',
    `- Lauf: ${o.lauf} · Gerät: ${o.geraet} · ${o.zeit}`,
    `- Ergebnis: ${ergebnis}`,
    `- Kosten: ${e.kostenUsd.toFixed(2)} USD${dauer}`,
    `- Commit: ${e.commit ? `${e.commit.sha} ${e.commit.titel}` : '(keiner erkannt)'}`,
    '',
    '## Ziel des Laufs', '', o.ziel.trim(), '',
    '## Was gemacht wurde', '', (e.zusammenfassung ?? e.text ?? '').trim() || '(keine Zusammenfassung)', '',
    '## Geänderte Dateien', '', ...dateien, '',
    ...(e.abnahme ? ['## Abnahme', '', `Ergebnis: ${e.abnahme.ok ? 'grün' : 'rot'}`, '', '```', e.abnahme.protokoll.slice(0, 4000), '```', ''] : []),
    '_Erstellt von Alfred. Der Auftrag dieser Etappe liegt daneben (etappe-' + e.nr + '-auftrag.md)._',
    '',
  ].join('\n');
}

export function fixAuftrag(o: { ziel: string; nr: number; etappe: string; versuch: number; pruefprotokoll: string; vorgefunden?: string[] }): string {
  return [
    `Projektziel: ${o.ziel}`,
    `Etappe ${o.nr}: ${o.etappe}`,
    '',
    `Die Abnahme ist fehlgeschlagen (Fix-Versuch ${o.versuch}). Prüfprotokoll:`,
    o.pruefprotokoll.slice(0, 6000),
    '',
    'Behebe die Ursache, ohne die Prüfbefehle zu ändern oder Tests abzuschwächen. Committe am Ende (falls Git-Repository) mit „Etappe ' + o.nr + ': Korrektur".',
    LAUFZEITDATEN_REGEL,
    ...vorgefundenRegel(o.vorgefunden),
  ].join('\n');
}

export function planFrage(o: { geraet: string; projekt: string; ziel: string; plan: string[]; pruefBefehle: string[]; g: Grenzen; gekuerzt: boolean; verzeichnisNeu?: boolean; gitUebernehmen?: boolean; name?: string; nameNeu?: boolean; laeufeBisher?: number; umgebung?: string; sudoSperre?: 'projekt' | 'geraet'; vorgefunden?: string[] }): string {
  return [
    `🧭 Projekt auf ${o.geraet} starten?`,
    // v1398 — Projektakte: Name (Vorschlag oder vom Owner), Weiterarbeit mit früheren Läufen
    ...(o.name ? [`Projekt: ${o.name}${o.nameNeu ? ' (neu — anderer Name? Sag „Projekt … heißt …“)' : ''}${o.laeufeBisher ? ` — Weiterarbeit, ${o.laeufeBisher} frühere${o.laeufeBisher === 1 ? 'r Lauf' : ' Läufe'} und der Bestand sind im Plan berücksichtigt` : ''}`] : []),
    `Ziel: ${o.ziel.slice(0, 300)}`,
    `Verzeichnis: ${o.projekt}${o.verzeichnisNeu ? ' (neu — wird als Git-Repository angelegt, jede Etappe ein Commit)' : ''}`,
    // v1397 — bestehendes Verzeichnis ohne Git
    ...(o.gitUebernehmen ? ['Kein Git-Repository: wird angelegt, der jetzige Stand als Ausgangs-Commit „Stand vor Alfred" gesichert (ohne node_modules, .env, Logs und Dateien über 10 MB), danach jede Etappe ein Commit.'] : []),
    ...(o.umgebung ? [`Umgebung: ${o.umgebung}`] : []), // v1408 R3a
    // v1453 — vorgefundene Änderungen gleich hier nennen, nicht erst im Bericht von Etappe 1
    ...(o.vorgefunden?.length ? [`Vorgefunden, nicht eingecheckt (${o.vorgefunden.length}): ${o.vorgefunden.slice(0, 8).join(', ')}${o.vorgefunden.length > 8 ? ', …' : ''} — die Etappen lassen sie liegen und committen sie nicht mit.`] : []),
    `Systemrechte: ${o.sudoSperre ? `sudo gesperrt (${o.sudoSperre === 'geraet' ? 'Einstellung am Gerät' : 'Projekt-Option'})` : 'sudo erlaubt (sperrbar je Projekt oder am Gerät)'}`, // v1409 R3b
    `Etappen${o.gekuerzt ? ` (auf ${o.g.maxEtappen} gekürzt)` : ''}:`,
    ...o.plan.map((p, i) => `${i + 1}. ${p.slice(0, 200)}`),
    `Abnahme je Etappe: ${o.pruefBefehle.length ? o.pruefBefehle.join(' ; ') : 'keine Prüfbefehle — nach jeder Etappe frage ich dich'}`,
    `Grenzen: ${[o.g.budgetUsd !== undefined ? `${o.g.budgetUsd} USD` : 'kein Budget', o.g.maxStunden !== undefined ? `${o.g.maxStunden} h` : 'keine Zeitgrenze'].join(', ')}, ${o.g.maxFixVersuche} Fix-Versuche je Etappe.`,
    `Freigabe gilt nur für Claude-Code-Aufträge und Prüfbefehle in diesem Verzeichnis${o.gitUebernehmen ? ' und das Anlegen des Git-Repositorys' : ''}, bis Budget, Zeit oder Ende.`,
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
export function projektZeile(s: { id: string; geraet: string; status: string; nr: number; plan: string[]; kostenUsd: number; etappeStart?: number; fixVersuch: number; frage?: { text: string }; wartetAufGeraet?: { seit: number } }, jetztMs: number): string | null {
  const kosten = `${s.kostenUsd.toFixed(2).replace('.', ',')} USD`;
  if (s.status === 'laeuft' && s.wartetAufGeraet) return `${s.id}: Etappe ${s.nr}/${s.plan.length} wartet auf ${s.geraet} (nicht verbunden seit ${uhrzeit(s.wartetAufGeraet.seit)}), ${kosten}`; // v1415
  if (s.status === 'laeuft') {
    const seit = s.etappeStart !== undefined ? ` seit ${uhrzeit(s.etappeStart)} (${Math.max(0, Math.round((jetztMs - s.etappeStart) / 60_000))} min)` : '';
    return `${s.id} auf ${s.geraet}: Etappe ${s.nr}/${s.plan.length}${s.fixVersuch ? ` (Fix ${s.fixVersuch})` : ''} läuft${seit}, ${kosten}`;
  }
  if (s.status === 'wartet_owner') return `${s.id} auf ${s.geraet}: wartet auf dich — ${(s.frage?.text ?? '').split('\n')[0]!.slice(0, 100)}`;
  return null;
}

/**
 * v1410 R3c — fehlende Werkzeuge deterministisch erkennen: „FEHLT: x" im Ergebnis von Claude Code (Etappen-Auftrag verlangt es)
 * und typische Shell-Meldungen im Prüfprotokoll. Höchstens drei, ohne Doppel.
 */
export function fehlendeWerkzeuge(ergebnis: string, protokoll: string): string[] {
  const funde: string[] = [];
  const name = '([A-Za-z0-9][A-Za-z0-9._+-]{0,39})';
  for (const m of ergebnis.matchAll(new RegExp(`^\\s*FEHLT:\\s*${name}`, 'gm'))) funde.push(m[1]!);
  for (const re of [new RegExp(`${name}: (?:command )?not found`, 'g'), new RegExp(`command not found: ${name}`, 'g'), new RegExp(`'${name}' is not recognized`, 'g'), new RegExp(`Der Befehl "${name}" ist entweder falsch`, 'g')])
    for (const m of protokoll.matchAll(re)) funde.push(m[1]!);
  const ohne = new Set(['sh', 'bash', 'zsh', 'line', 'Error', 'error', 'npm', 'node']);
  return [...new Set(funde.filter(f => !ohne.has(f) && !/^\d+$/.test(f)).map(f => f.toLowerCase()))].slice(0, 3);
}

/** v1410 — Paket je Werkzeug und Plattform; unbekannt → Paketverwaltung des Systems mit dem Werkzeugnamen. */
const PAKETE: Record<string, Partial<Record<'npm' | 'apt' | 'brew' | 'winget' | 'pip', string>>> = {
  pnpm: { npm: 'pnpm' }, yarn: { npm: 'yarn' }, tsc: { npm: 'typescript' }, typescript: { npm: 'typescript' }, tsx: { npm: 'tsx' }, 'ts-node': { npm: 'ts-node' },
  python: { apt: 'python3', brew: 'python', winget: 'Python.Python.3.12' }, python3: { apt: 'python3', brew: 'python', winget: 'Python.Python.3.12' },
  pip: { apt: 'python3-pip' }, pip3: { apt: 'python3-pip' }, pipx: { apt: 'pipx', brew: 'pipx' },
  docker: { apt: 'docker.io', brew: 'docker', winget: 'Docker.DockerDesktop' }, git: { apt: 'git', brew: 'git', winget: 'Git.Git' },
  java: { apt: 'default-jdk', brew: 'openjdk', winget: 'EclipseAdoptium.Temurin.21.JDK' }, javac: { apt: 'default-jdk', brew: 'openjdk', winget: 'EclipseAdoptium.Temurin.21.JDK' },
  go: { apt: 'golang-go', brew: 'go', winget: 'GoLang.Go' }, cargo: { apt: 'cargo', brew: 'rust', winget: 'Rustlang.Rustup' }, rustc: { apt: 'rustc', brew: 'rust', winget: 'Rustlang.Rustup' },
  psql: { apt: 'postgresql-client', brew: 'libpq' }, sqlite3: { apt: 'sqlite3', brew: 'sqlite' }, ffmpeg: { apt: 'ffmpeg', brew: 'ffmpeg', winget: 'Gyan.FFmpeg' },
  make: { apt: 'build-essential' }, gcc: { apt: 'build-essential' }, 'g++': { apt: 'build-essential' }, curl: { apt: 'curl' }, jq: { apt: 'jq', brew: 'jq', winget: 'jqlang.jq' },
  node: { apt: 'nodejs', brew: 'node', winget: 'OpenJS.NodeJS.LTS' }, chromium: { apt: 'chromium-browser', brew: 'chromium' },
};

export function installVorschlag(werkzeug: string, umgebung?: string): { quelle: string; paket: string } {
  const sys = /windows/i.test(umgebung ?? '') ? 'winget' : /macos|darwin/i.test(umgebung ?? '') ? 'brew' : 'apt';
  const e = PAKETE[werkzeug.toLowerCase()] ?? {};
  if (e.npm) return { quelle: 'npm', paket: e.npm };
  if (e[sys as 'apt']) return { quelle: sys, paket: e[sys as 'apt']! };
  if (e.pip) return { quelle: 'pip', paket: e.pip };
  return { quelle: sys, paket: werkzeug };
}
