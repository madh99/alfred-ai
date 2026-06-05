/**
 * v851 — Snapshot-Importer für Code-Übernahme
 *
 * Wenn der User einen Goal-Match akzeptiert ("übernehmen + adaptieren"):
 * dieser Importer kopiert die Source-Files des Match-Features in einen
 * abgegrenzten read-only Snapshot-Dir im Target-Projekt:
 *
 *   <target-cwd>/.alfred/feature-imports/<feature-id>/
 *
 * Vorteil gegenüber `--add-dir <source-project>`:
 *  - Privacy: agent sieht nur die explizit ausgewählten Source-Files,
 *    NICHT das ganze Source-Projekt-Repo
 *  - Reproduzierbarkeit: Snapshot ist Git-tracked (kann committed werden)
 *  - Adapter-agnostisch: claude/codex/vibe verarbeiten files identisch
 *
 * Nachteil: Update-Tracking ist statisch — wenn der Source später ändert,
 * sieht der Target-Agent das nicht. → User muss bei Bedarf neu importieren.
 *
 * Glob-Matching: erlaubt `**` wildcards. Wenn ein source-File-Pattern
 * keinen Match liefert: skip + warn. Keine hard failure.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';

export interface SnapshotImportInput {
  /** Source-Repo (read-only). */
  sourceProjectCwd: string;
  /** Target-Projekt-cwd (wo der Snapshot landet). */
  targetProjectCwd: string;
  /** Feature-ID — dient als subdir-name. */
  featureId: string;
  /** Feature-Name für README im Snapshot. */
  featureName: string;
  /** Glob-Patterns aus feature.sourceFiles. */
  sourceFilePatterns: string[];
  /** Git-SHA der Source-Version (für README). */
  sourceGitSha?: string;
  logger: Logger;
}

export interface SnapshotImportResult {
  snapshotDir: string;
  importedFiles: string[];
  skippedPatterns: string[];
}

/**
 * Kopiert source-files in den Target-Snapshot-Dir und schreibt ein README.
 */
export async function importFeatureSnapshot(input: SnapshotImportInput): Promise<SnapshotImportResult> {
  const snapshotDir = path.join(input.targetProjectCwd, '.alfred', 'feature-imports', input.featureId);
  fs.mkdirSync(snapshotDir, { recursive: true });

  const importedFiles: string[] = [];
  const skippedPatterns: string[] = [];

  for (const pattern of input.sourceFilePatterns) {
    const files = expandGlobShallow(input.sourceProjectCwd, pattern);
    if (files.length === 0) {
      skippedPatterns.push(pattern);
      input.logger.warn({ pattern, sourceCwd: input.sourceProjectCwd }, 'v851 snapshot: glob expanded to 0 files');
      continue;
    }
    for (const f of files) {
      const relPath = path.relative(input.sourceProjectCwd, f);
      const targetPath = path.join(snapshotDir, relPath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      try {
        fs.copyFileSync(f, targetPath);
        importedFiles.push(relPath);
      } catch (err) {
        input.logger.warn({ err: (err as Error).message, f }, 'v851 snapshot: copy failed');
      }
    }
  }

  // README im Snapshot-Dir: erklärt was das ist
  const readme = [
    `# Feature-Import-Snapshot: ${input.featureName}`,
    ``,
    `Diese Files wurden automatisch von Alfred aus einem anderen Projekt importiert,`,
    `um die Implementierung als Referenz für den Code-Agent verfügbar zu machen.`,
    ``,
    `- Feature-ID: ${input.featureId}`,
    `- Source-Projekt: ${path.basename(input.sourceProjectCwd)}`,
    input.sourceGitSha ? `- Source-Git-SHA: ${input.sourceGitSha}` : '',
    `- Import-Zeitpunkt: ${new Date().toISOString()}`,
    `- ${importedFiles.length} Files importiert${skippedPatterns.length > 0 ? `, ${skippedPatterns.length} Patterns übersprungen` : ''}`,
    ``,
    `## Importierte Dateien`,
    ``,
    ...importedFiles.map(f => `- \`${f}\``),
    ``,
    skippedPatterns.length > 0 ? `## Übersprungen (no match)\n${skippedPatterns.map(p => `- \`${p}\``).join('\n')}\n` : '',
    `## Hinweis für den Code-Agent`,
    ``,
    `Diese Snapshots sind READ-ONLY Referenz-Material. Du sollst:`,
    `1. Die Pattern + Struktur verstehen`,
    `2. An aktuellen Stack des Target-Projekts adaptieren (NICHT 1:1 kopieren)`,
    `3. Imports/Namespaces/Types an die Target-Codebase anpassen`,
    `4. Tests aus dem Snapshot übernehmen wenn sinnvoll`,
    ``,
    `Nach erfolgreichem Übernehmen kann dieses Verzeichnis gelöscht werden.`,
  ].filter(Boolean).join('\n');
  fs.writeFileSync(path.join(snapshotDir, 'README.md'), readme);

  // .gitignore: das Verzeichnis SOLL committed werden (Reproduzierbarkeit)
  // aber wir setzen ein hint-file dass es ein Import ist
  fs.writeFileSync(path.join(snapshotDir, '.alfred-import-marker'), `feature-id: ${input.featureId}\n`);

  input.logger.info({
    snapshotDir, imported: importedFiles.length, skipped: skippedPatterns.length,
  }, 'v851 snapshot: import completed');

  return { snapshotDir, importedFiles, skippedPatterns };
}

/**
 * Pragmatische Glob-Expansion ohne fs-extra/glob-Lib.
 * Unterstützt:
 *  - Konkrete Pfade: "src/lib/funding/index.ts" → einzelne Datei
 *  - Verzeichnisse mit Suffix /**: "src/lib/funding/**" → alle files im baum
 *  - Single * im basename: "src/lib/*.ts" → nur direct children mit Suffix
 *
 * KEIN voller minimatch — defensive subset um deps zu sparen.
 */
function expandGlobShallow(rootCwd: string, pattern: string): string[] {
  const norm = pattern.replace(/\\/g, '/');
  // Rekursiv (`/**` suffix)
  if (norm.endsWith('/**')) {
    const base = path.join(rootCwd, norm.slice(0, -3));
    if (!fs.existsSync(base)) return [];
    const out: string[] = [];
    walk(base, out);
    return out;
  }
  // Single * in basename
  if (norm.includes('*')) {
    const dir = path.join(rootCwd, path.dirname(norm));
    if (!fs.existsSync(dir)) return [];
    const basenamePattern = path.basename(norm);
    const regex = new RegExp('^' + basenamePattern.replace(/\*/g, '.*') + '$');
    return fs.readdirSync(dir)
      .filter(n => regex.test(n))
      .map(n => path.join(dir, n))
      .filter(p => {
        try { return fs.statSync(p).isFile(); } catch { return false; }
      });
  }
  // Konkreter Pfad
  const full = path.join(rootCwd, norm);
  if (fs.existsSync(full)) {
    try {
      const stat = fs.statSync(full);
      if (stat.isFile()) return [full];
      if (stat.isDirectory()) {
        const out: string[] = [];
        walk(full, out);
        return out;
      }
    } catch { /* */ }
  }
  return [];
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache']);

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
}
