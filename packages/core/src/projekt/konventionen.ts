/**
 * v1426 — Projekt-Konventionen (v663a, `projects.conventions`) für ALLE Projekt-Läufe: Server-Agent und Geräte-Projekte bekommen
 * dieselben Anweisungen (Owner 13.10.: „Konventionen per Schalter pro Projekt mit Optionen in App und Web, neben dem Gespräch").
 * Reine Regeln ohne Modell: Text für den Auftrag, Bereinigung von Eingaben aus App/Web/Gespräch, Changelog-Pflicht.
 */

export interface Konventionen {
  readme?: { autoUpdate?: boolean; template?: 'default' | 'minimal' | 'custom' };
  changelog?: { autoUpdate?: boolean; format?: 'keepachangelog' | 'free' };
  commits?: { convention?: 'conventional' | 'free'; scopePolicy?: 'required' | 'optional' | 'forbidden' };
  branching?: { strategy?: 'main-only' | 'feature-branches' | 'gitflow'; prTarget?: string };
  versioning?: { scheme?: 'semver' | 'date' | 'custom'; autoTag?: boolean };
  /** v1426 — eigene Regeln des Owners („Commits auf Deutsch", „keine neuen Abhängigkeiten ohne Rückfrage") */
  regeln?: string[];
}

export const REGELN_MAX = 12;
export const REGEL_MAX_ZEICHEN = 200;

/** Anweisungszeilen (Format „- …") für einen Auftrag; die ersten drei Texte sind wortgleich mit dem Server-Agent seit v663a. */
export function konventionsZeilen(c?: Konventionen | null): string[] {
  if (!c) return [];
  const z: string[] = [];
  if (c.readme?.autoUpdate) {
    const template = c.readme.template ?? 'default';
    z.push(`- README.md pflegen (Template: ${template}). Wenn neue Features/Skripte/Setup-Schritte: README.md aktualisieren (Sections: Features / Setup / Usage).`);
  }
  if (c.changelog?.autoUpdate) {
    const fmt = c.changelog.format ?? 'keepachangelog';
    z.push(`- CHANGELOG.md pflegen (Format: ${fmt}). Trage eine Zeile unter "## [Unreleased]" ein die diese Phase beschreibt (z.B. "### Added/Changed/Fixed").`);
  }
  if (c.commits?.convention === 'conventional') {
    const scope = c.commits.scopePolicy;
    z.push(`- Commits: Conventional Commits Format (feat: / fix: / refactor: / test: / docs: / style: / perf: / chore:)${scope === 'required' ? ' mit Scope: feat(scope): …' : scope === 'forbidden' ? ' OHNE Scope' : ''}.`);
  }
  for (const r of c.regeln ?? []) { const t = r.trim(); if (t) z.push(`- ${t}`); }
  return z;
}

/** Block für Geräte-Aufträge (leer ohne Konventionen). */
export function konventionsBlock(c?: Konventionen | null): string {
  const z = konventionsZeilen(c);
  return z.length ? `\n\nProjektregeln des Owners (gelten für jede Etappe):\n${z.join('\n')}` : '';
}

export function changelogPflicht(c?: Konventionen | null): boolean {
  return !!c?.changelog?.autoUpdate;
}

const EINS = <T extends string>(v: unknown, erlaubt: readonly T[]): T | undefined => (typeof v === 'string' && (erlaubt as readonly string[]).includes(v) ? v as T : undefined);

/**
 * Teil-Änderung aus App/Web/Gespräch auf bestehende Konventionen anwenden: nur bekannte Felder und Werte, Regeln gekürzt und begrenzt.
 * `regel` fügt eine Regel hinzu, `regelEntfernen` entfernt sie (Text oder 1-basierte Nummer).
 */
export function konventionenAendern(alt: Konventionen | undefined, roh: unknown): Konventionen {
  const a: Konventionen = JSON.parse(JSON.stringify(alt ?? {}));
  if (!roh || typeof roh !== 'object') return a;
  const r = roh as Record<string, unknown>;
  const teil = (k: string) => (r[k] && typeof r[k] === 'object' ? r[k] as Record<string, unknown> : undefined);
  if (typeof r.changelog === 'boolean') a.changelog = { ...a.changelog, autoUpdate: r.changelog };
  if (typeof r.readme === 'boolean') a.readme = { ...a.readme, autoUpdate: r.readme };
  if (typeof r.conventionalCommits === 'boolean') a.commits = { ...a.commits, convention: r.conventionalCommits ? 'conventional' : 'free' };
  const cl = teil('changelog'); if (cl) a.changelog = { ...a.changelog, ...(typeof cl.autoUpdate === 'boolean' ? { autoUpdate: cl.autoUpdate } : {}), ...(EINS(cl.format, ['keepachangelog', 'free'] as const) ? { format: EINS(cl.format, ['keepachangelog', 'free'] as const) } : {}) };
  const rm = teil('readme'); if (rm) a.readme = { ...a.readme, ...(typeof rm.autoUpdate === 'boolean' ? { autoUpdate: rm.autoUpdate } : {}), ...(EINS(rm.template, ['default', 'minimal', 'custom'] as const) ? { template: EINS(rm.template, ['default', 'minimal', 'custom'] as const) } : {}) };
  const cm = teil('commits'); if (cm) a.commits = { ...a.commits, ...(EINS(cm.convention, ['conventional', 'free'] as const) ? { convention: EINS(cm.convention, ['conventional', 'free'] as const) } : {}), ...(EINS(cm.scopePolicy, ['required', 'optional', 'forbidden'] as const) ? { scopePolicy: EINS(cm.scopePolicy, ['required', 'optional', 'forbidden'] as const) } : {}) };
  let regeln = [...(a.regeln ?? [])];
  if (Array.isArray(r.regeln)) regeln = r.regeln.map(x => String(x));
  if (typeof r.regel === 'string' && r.regel.trim()) regeln.push(r.regel);
  if (r.regelEntfernen !== undefined) {
    const n = Number(r.regelEntfernen);
    regeln = Number.isInteger(n) && n >= 1 && String(r.regelEntfernen).trim() === String(n) ? regeln.filter((_, i) => i !== n - 1) : regeln.filter(x => x.trim().toLowerCase() !== String(r.regelEntfernen).trim().toLowerCase());
  }
  regeln = [...new Set(regeln.map(x => x.replace(/\s+/g, ' ').trim().slice(0, REGEL_MAX_ZEICHEN)).filter(Boolean))].slice(0, REGELN_MAX);
  if (regeln.length) a.regeln = regeln; else delete a.regeln;
  return a;
}

/** Kurze Anzeige für Gespräch und Meldungen. */
export function konventionenText(c?: Konventionen | null): string {
  const teile: string[] = [];
  teile.push(`CHANGELOG ${c?.changelog?.autoUpdate ? `an (${c.changelog.format ?? 'keepachangelog'})` : 'aus'}`);
  teile.push(`README ${c?.readme?.autoUpdate ? `an (${c.readme.template ?? 'default'})` : 'aus'}`);
  teile.push(`Commits ${c?.commits?.convention === 'conventional' ? `conventional${c.commits.scopePolicy ? `, Scope ${c.commits.scopePolicy}` : ''}` : 'frei'}`);
  const r = c?.regeln ?? [];
  return `${teile.join(' · ')}${r.length ? `\nEigene Regeln:\n${r.map((x, i) => `${i + 1}. ${x}`).join('\n')}` : '\nKeine eigenen Regeln.'}`;
}

/** Auftrag „Changelog nachtragen" (Etappe fertig, CHANGELOG.md nicht geändert). Commit-Text beginnt bewusst NICHT mit „Etappe ". */
export function changelogAuftrag(o: { nr: number; etappe: string; format?: string; zusammenfassung?: string }): string {
  return [
    `Etappe ${o.nr} („${o.etappe}") ist fertig, aber CHANGELOG.md wurde nicht ergänzt — das ist eine Projektregel des Owners.`,
    `Trage in CHANGELOG.md (Format: ${o.format ?? 'keepachangelog'}; Datei anlegen, falls sie fehlt) unter "## [Unreleased]" ein, was diese Etappe für Nutzer geändert hat. Grundlage: die letzten Commits (git log) und diese Zusammenfassung:`,
    (o.zusammenfassung ?? '').slice(0, 3000) || '(keine Zusammenfassung)',
    '',
    'Ändere NUR CHANGELOG.md. Ist das Verzeichnis ein Git-Repository, committe mit der Nachricht „docs(changelog): Etappe ' + o.nr + ' nachgetragen".',
  ].join('\n');
}
