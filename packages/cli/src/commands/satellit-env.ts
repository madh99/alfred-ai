import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import path from 'node:path';

/**
 * v1443 B15 — Schlüssel der Umgebung eines Geräte-Projekts erkennen (wie scan_repo am Server): `.env.example`/`.sample`/`.template`
 * und Verweise im Quelltext (process.env.X, import.meta.env.X, os.environ/os.getenv). Liefert NUR Schlüsselnamen und Fundstellen —
 * nie Werte; echte `.env`-Dateien werden nicht gelesen (Owner 13.10.: Umgebungswerte gehören nicht aufs Entwicklungsgerät).
 */
export function envSchluessel(dir: string): Array<{ key: string; sources: string[] }> {
  const found = new Map<string, { example: boolean; code: string[] }>();
  const merke = (k: string, quelle?: string) => {
    const e = found.get(k) ?? { example: false, code: [] };
    if (quelle === undefined) e.example = true; else if (!e.code.includes(quelle)) e.code.push(quelle);
    found.set(k, e);
  };
  for (const fn of ['.env.example', '.env.sample', '.env.template']) {
    const p = path.join(dir, fn);
    if (!existsSync(p)) continue;
    try { for (const line of readFileSync(p, 'utf8').split('\n')) { const m = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line); if (m) merke(m[1]!); } } catch { /* weiter */ }
  }
  const exts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.php', '.rb', '.go']);
  const auslassen = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.alfred', '.alfred-anhaenge', 'coverage', 'venv', '.venv']);
  const muster = [/process\.env\.([A-Z][A-Z0-9_]*)/g, /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g, /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g, /\bos\.environ\.get\(['"]([A-Z][A-Z0-9_]*)['"]\)/g, /\bos\.environ\[['"]([A-Z][A-Z0-9_]*)['"]\]/g, /\bos\.getenv\(['"]([A-Z][A-Z0-9_]*)['"]\)/g];
  let dateien = 0;
  const geh = (d: string, tiefe: number) => {
    if (tiefe > 4 || dateien > 3000) return;
    let eintraege: Dirent[] = [];
    try { eintraege = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of eintraege) {
      if (auslassen.has(e.name)) continue;
      const voll = path.join(d, e.name);
      if (e.isDirectory()) { geh(voll, tiefe + 1); continue; }
      if (!exts.has(path.extname(e.name)) || /^\.env/.test(e.name)) continue;
      dateien++;
      try {
        if (statSync(voll).size > 512 * 1024) continue;
        const text = readFileSync(voll, 'utf8');
        for (const r of muster) { r.lastIndex = 0; let m: RegExpExecArray | null; while ((m = r.exec(text)) !== null) merke(m[1]!, path.relative(dir, voll).split(path.sep).join('/')); }
      } catch { /* weiter */ }
    }
  };
  geh(dir, 0);
  return [...found.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, e]) => ({ key, sources: [...(e.example ? ['.env.example'] : []), ...e.code.slice(0, 3)] }));
}
