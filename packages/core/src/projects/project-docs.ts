import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * v873 — Projekt-Dokumentation: Markdown-Dateien aus dem Projekt-CWD für den
 * Docs-Tab der WebUI. Agents produzieren docs/*.md (Security-Reviews,
 * Proposals, Audits) — bisher nur per Repo-Zugriff lesbar.
 *
 * Sicherheits-Eigenschaften (beide Funktionen):
 *  - nur *.md (case-insensitive)
 *  - readProjectDoc verweigert jeden Pfad, der nach Auflösung außerhalb
 *    des cwd liegt (Path-Traversal: ../, absolute Pfade, Windows-\..\)
 *  - Größen-Kappe beim Lesen (1 MB)
 */
export interface ProjectDocFile {
  /** Relativer Pfad mit Forward-Slashes (UI- und API-stabil über OS-Grenzen). */
  path: string;
  sizeBytes: number;
  modifiedAt: string;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'bundle', '.next', 'coverage', 'vendor']);
const MAX_FILES = 300;
const MAX_DEPTH = 5;
const MAX_READ_BYTES = 1024 * 1024;

function isMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith('.md');
}

/** Root-*.md + docs/ rekursiv (bis MAX_DEPTH), gekappt auf MAX_FILES. */
export async function listProjectDocs(cwd: string): Promise<ProjectDocFile[]> {
  if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  const out: ProjectDocFile[] = [];

  const addFile = async (absPath: string, relPath: string): Promise<void> => {
    if (out.length >= MAX_FILES) return;
    try {
      const st = await fs.stat(absPath);
      if (!st.isFile()) return;
      out.push({
        path: relPath.split(path.sep).join('/'),
        sizeBytes: st.size,
        modifiedAt: st.mtime.toISOString(),
      });
    } catch { /* Datei zwischenzeitlich weg — überspringen */ }
  };

  // 1. Markdown auf Root-Ebene (README.md, CHANGELOG.md, …)
  try {
    const rootEntries = await fs.readdir(cwd, { withFileTypes: true });
    for (const e of rootEntries) {
      if (e.isFile() && isMarkdown(e.name)) await addFile(path.join(cwd, e.name), e.name);
    }
  } catch { /* unlesbares cwd → leere Liste */ }

  // 2. docs/ rekursiv
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const relPath = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) await walk(abs, relPath, depth + 1);
      else if (e.isFile() && isMarkdown(e.name)) await addFile(abs, relPath);
    }
  };
  const docsDir = path.join(cwd, 'docs');
  if (existsSync(docsDir)) await walk(docsDir, 'docs', 1);

  // README zuerst, dann alphabetisch — stabile, vorhersagbare Reihenfolge
  out.sort((a, b) => {
    const aReadme = a.path.toLowerCase() === 'readme.md' ? 0 : 1;
    const bReadme = b.path.toLowerCase() === 'readme.md' ? 0 : 1;
    if (aReadme !== bReadme) return aReadme - bReadme;
    return a.path.localeCompare(b.path);
  });
  return out;
}

/** Traversal-sicheres Lesen einer Markdown-Datei relativ zum cwd. */
export async function readProjectDoc(cwd: string, relPath: string): Promise<{ path: string; content: string; truncated: boolean }> {
  if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  if (!relPath || typeof relPath !== 'string') throw new Error('path required');
  if (!isMarkdown(relPath)) throw new Error('only .md files are readable');
  if (path.isAbsolute(relPath)) throw new Error('absolute paths are not allowed');

  // Auflösen + Containment-Check: der KANONISCHE Pfad muss im cwd liegen.
  // Fängt ../, verschachtelte ..\, und Mischformen — unabhängig vom OS-Separator.
  const resolvedCwd = path.resolve(cwd);
  const resolved = path.resolve(resolvedCwd, relPath);
  if (resolved !== resolvedCwd && !resolved.startsWith(resolvedCwd + path.sep)) {
    throw new Error('path escapes project directory');
  }

  const st = await fs.stat(resolved);
  if (!st.isFile()) throw new Error('not a file');
  const truncated = st.size > MAX_READ_BYTES;
  const fh = await fs.open(resolved, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, MAX_READ_BYTES));
    await fh.read(buf, 0, buf.length, 0);
    return {
      path: relPath.split(path.sep).join('/'),
      content: buf.toString('utf8'),
      truncated,
    };
  } finally {
    await fh.close();
  }
}
