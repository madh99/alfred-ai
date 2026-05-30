/**
 * v824 — RepoScanner für Agent-Conventions.
 *
 * Read-only Scan eines Projekt-cwd. Output: ConventionsScanSnapshot mit allem
 * was der LLM-Generator als Kontext braucht. KEINE Schreiboperationen, KEINE
 * subprocess-spawn außer git-log. Cap auf 60KB Gesamt-Output damit der
 * LLM-Context-Cap nicht gesprengt wird.
 *
 * Side-Effect-Notiz: ausschließlich Filesystem-Lesezugriffe + optional
 * `git log` über execFile. Schreibt nichts. Modifiziert keinen Process-State.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { ConventionsScanSnapshot } from '@alfred/types';

const exec = promisify(execFileCb);

const PER_FILE_CAP = 8 * 1024;          // 8KB pro Datei
const TOTAL_CONTEXT_CAP = 60 * 1024;    // 60KB Gesamt-Output
const TREE_MAX_ENTRIES = 2000;          // max File-Tree-Einträge
const DOCS_MAX_FILES = 5;               // max 5 Doc-Files lesen
const GIT_LOG_LIMIT = 50;               // letzte 50 Commits

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', '.turbo',
  '.cache', 'coverage', '.nyc_output', '.vercel', '.netlify',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'target', '.gradle', '.idea', '.vscode',
]);

export interface ScanResult {
  snapshot: ConventionsScanSnapshot;
  /** Strukturiertes Kontext-Markdown für den LLM-Generator. */
  llmContext: string;
  scanHash: string;
  warnings: string[];
}

export class RepoScanner {
  constructor(private readonly logger: Logger) {}

  async scan(cwd: string): Promise<ScanResult> {
    const startTime = Date.now();
    const warnings: string[] = [];

    if (!existsSync(cwd)) {
      throw new Error(`Repo scan: cwd does not exist: ${cwd}`);
    }

    // ── Phase 1: Quick checks (no I/O-heavy stuff) ────────────────────────
    const packageJson = await this.readPackageJson(cwd, warnings);
    const workspaces = this.detectWorkspaces(cwd, packageJson, warnings);
    const framework = this.detectFramework(cwd, packageJson);
    const testRunner = this.detectTestRunner(packageJson);
    const packageManager = this.detectPackageManager(cwd);
    const hasTypescript = existsSync(path.join(cwd, 'tsconfig.json'));

    // ── Phase 2: File-Tree (capped) ────────────────────────────────────────
    const { tree, totalFiles, totalCodeFiles, topLevelDirs, fileTreeHash } = this.scanFileTree(cwd, warnings);

    // ── Phase 3: Config-Files (full content within cap) ────────────────────
    const tsconfig = this.tryRead(path.join(cwd, 'tsconfig.json'), warnings);
    const vitestConfig = this.tryReadFirst([
      path.join(cwd, 'vitest.config.ts'),
      path.join(cwd, 'vitest.config.js'),
      path.join(cwd, 'vitest.config.mjs'),
    ], warnings);
    const jestConfig = this.tryReadFirst([
      path.join(cwd, 'jest.config.ts'),
      path.join(cwd, 'jest.config.js'),
      path.join(cwd, 'jest.config.json'),
    ], warnings);
    const nextConfig = this.tryReadFirst([
      path.join(cwd, 'next.config.ts'),
      path.join(cwd, 'next.config.js'),
      path.join(cwd, 'next.config.mjs'),
    ], warnings);
    const eslintConfig = this.tryReadFirst([
      path.join(cwd, 'eslint.config.js'),
      path.join(cwd, 'eslint.config.mjs'),
      path.join(cwd, '.eslintrc.json'),
      path.join(cwd, '.eslintrc.js'),
    ], warnings);
    const biomeConfig = this.tryRead(path.join(cwd, 'biome.json'), warnings);

    // ── Phase 4: README + docs ─────────────────────────────────────────────
    const readme = this.tryReadCapped(path.join(cwd, 'README.md'), 3000);
    const docsContent = this.scanDocs(cwd, warnings);

    // ── Phase 5: Test-Setup-Files (kritisch für unsern Bug-Klasse) ──────────
    const testSetupFiles = this.findTestSetupFiles(cwd, warnings);
    const testSetupContents = testSetupFiles.slice(0, 5).map(f => ({
      path: path.relative(cwd, f),
      content: this.tryReadCapped(f, PER_FILE_CAP) ?? '',
    }));

    // ── Phase 6: Migrations ────────────────────────────────────────────────
    const migrationDirs = this.findMigrationDirs(cwd);

    // ── Phase 7: env-example ───────────────────────────────────────────────
    const envExampleContent = this.tryReadCapped(path.join(cwd, '.env.example'), 4000);
    const envExampleKeys = envExampleContent
      ? envExampleContent.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => l.split('=')[0]).filter(Boolean)
      : [];

    // ── Phase 8: git log (50 commits) ─────────────────────────────────────
    const gitLog = await this.runGitLog(cwd, warnings);
    const gitChurn = await this.runGitChurn(cwd, warnings);
    const recentCommitsHash = gitLog
      ? createHash('sha256').update(gitLog).digest('hex').slice(0, 16)
      : '';

    // ── Snapshot bauen ─────────────────────────────────────────────────────
    const snapshot: ConventionsScanSnapshot = {
      capturedAt: new Date().toISOString(),
      cwd,
      packageManager,
      framework,
      hasTypescript,
      hasTests: !!testRunner || testSetupFiles.length > 0,
      testRunner,
      topLevelDirs,
      packageJsonScripts: packageJson?.scripts,
      workspaces,
      envExampleKeys: envExampleKeys.slice(0, 40),
      migrationDirs,
      testSetupFiles: testSetupFiles.map(f => path.relative(cwd, f)),
      recentCommitsHash,
      fileTreeHash,
      totalFiles,
      totalCodeFiles,
      scanTimingMs: Date.now() - startTime,
    };

    // ── LLM-Context-Markdown bauen (60KB Cap) ──────────────────────────────
    const llmContext = this.buildLlmContext({
      cwd,
      packageJson,
      tsconfig,
      vitestConfig,
      jestConfig,
      nextConfig,
      eslintConfig,
      biomeConfig,
      readme,
      docsContent,
      testSetupContents,
      tree,
      gitLog,
      gitChurn,
      envExampleContent,
      workspaces,
      framework,
      packageManager,
      testRunner,
    });

    const scanHash = createHash('sha256')
      .update(JSON.stringify({ snapshot, contextLen: llmContext.length }))
      .digest('hex');

    this.logger.info({
      cwd,
      framework,
      totalFiles,
      totalCodeFiles,
      contextLen: llmContext.length,
      scanTimingMs: snapshot.scanTimingMs,
      warningCount: warnings.length,
    }, 'v824 RepoScanner complete');

    return { snapshot, llmContext, scanHash, warnings };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────────

  private async readPackageJson(cwd: string, warnings: string[]): Promise<{ scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; workspaces?: unknown; type?: string; engines?: Record<string, string> } | null> {
    const p = path.join(cwd, 'package.json');
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch (err) {
      warnings.push(`package.json parse failed: ${(err as Error).message}`);
      return null;
    }
  }

  private detectWorkspaces(cwd: string, pkg: { workspaces?: unknown } | null, warnings: string[]): string[] | undefined {
    // pnpm-workspace.yaml
    const pnpmWs = path.join(cwd, 'pnpm-workspace.yaml');
    if (existsSync(pnpmWs)) {
      try {
        const content = readFileSync(pnpmWs, 'utf8');
        const packages: string[] = [];
        for (const line of content.split('\n')) {
          const m = line.match(/^\s*-\s+['"]?([^'"]+)['"]?/);
          if (m) packages.push(m[1]);
        }
        if (packages.length > 0) return packages;
      } catch (err) {
        warnings.push(`pnpm-workspace.yaml parse failed: ${(err as Error).message}`);
      }
    }
    // package.json workspaces
    const ws = pkg?.workspaces;
    if (Array.isArray(ws)) return ws as string[];
    if (ws && typeof ws === 'object' && 'packages' in ws) {
      const arr = (ws as { packages: unknown }).packages;
      if (Array.isArray(arr)) return arr as string[];
    }
    // nx.json / turbo.json hints
    if (existsSync(path.join(cwd, 'nx.json'))) return ['(nx)'];
    if (existsSync(path.join(cwd, 'turbo.json'))) return ['(turbo)'];
    return undefined;
  }

  private detectFramework(cwd: string, pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null): string | undefined {
    if (!pkg) {
      if (existsSync(path.join(cwd, 'Cargo.toml'))) return 'rust';
      if (existsSync(path.join(cwd, 'pyproject.toml'))) return 'python';
      if (existsSync(path.join(cwd, 'go.mod'))) return 'go';
      return undefined;
    }
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    if (all['next']) return 'nextjs';
    if (all['vite']) return 'vite';
    if (all['@remix-run/react'] || all['remix']) return 'remix';
    if (all['astro']) return 'astro';
    if (all['express']) return 'express';
    if (all['fastify']) return 'fastify';
    if (all['@nestjs/core']) return 'nestjs';
    if (all['react'] && !all['next'] && !all['vite']) return 'react';
    if (all['vue']) return 'vue';
    if (all['svelte']) return 'svelte';
    return 'node';
  }

  private detectTestRunner(pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> } | null): string | undefined {
    if (!pkg) return undefined;
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    if (all['vitest']) return 'vitest';
    if (all['jest']) return 'jest';
    if (all['@playwright/test']) return 'playwright';
    if (all['mocha']) return 'mocha';
    const test = pkg.scripts?.test;
    if (test) {
      if (/vitest/.test(test)) return 'vitest';
      if (/jest/.test(test)) return 'jest';
      if (/playwright/.test(test)) return 'playwright';
    }
    return undefined;
  }

  private detectPackageManager(cwd: string): string | undefined {
    if (existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
    if (existsSync(path.join(cwd, 'bun.lockb'))) return 'bun';
    if (existsSync(path.join(cwd, 'package-lock.json'))) return 'npm';
    return undefined;
  }

  private scanFileTree(cwd: string, warnings: string[]): { tree: string[]; totalFiles: number; totalCodeFiles: number; topLevelDirs: string[]; fileTreeHash: string } {
    const tree: string[] = [];
    let totalFiles = 0;
    let totalCodeFiles = 0;
    const codeExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.rs', '.go', '.py', '.java', '.kt', '.swift', '.rb', '.cs', '.cpp', '.c', '.h']);

    const topLevelDirs: string[] = [];
    let topLevel: string[] = [];
    try {
      topLevel = readdirSync(cwd).filter(n => !n.startsWith('.') && !IGNORE_DIRS.has(n));
    } catch (err) {
      warnings.push(`top-level dir read failed: ${(err as Error).message}`);
      return { tree, totalFiles: 0, totalCodeFiles: 0, topLevelDirs: [], fileTreeHash: '' };
    }
    for (const name of topLevel) {
      const p = path.join(cwd, name);
      try {
        if (statSync(p).isDirectory()) topLevelDirs.push(name);
      } catch { /* skip */ }
    }

    const visit = (dir: string, depth: number, prefix: string) => {
      if (tree.length >= TREE_MAX_ENTRIES) return;
      if (depth > 3) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch { return; }
      for (const name of entries) {
        if (IGNORE_DIRS.has(name) || name.startsWith('.')) continue;
        const full = path.join(dir, name);
        let st;
        try { st = statSync(full); } catch { continue; }
        const rel = `${prefix}${name}${st.isDirectory() ? '/' : ''}`;
        if (st.isDirectory()) {
          tree.push(rel);
          visit(full, depth + 1, `${prefix}${name}/`);
        } else {
          totalFiles++;
          if (codeExts.has(path.extname(name).toLowerCase())) totalCodeFiles++;
          if (tree.length < TREE_MAX_ENTRIES) tree.push(rel);
        }
        if (tree.length >= TREE_MAX_ENTRIES) return;
      }
    };

    visit(cwd, 0, '');
    if (tree.length >= TREE_MAX_ENTRIES) {
      tree.push(`... (truncated at ${TREE_MAX_ENTRIES} entries)`);
    }

    const fileTreeHash = createHash('sha256').update(tree.join('\n')).digest('hex').slice(0, 16);
    return { tree, totalFiles, totalCodeFiles, topLevelDirs, fileTreeHash };
  }

  private findTestSetupFiles(cwd: string, warnings: string[]): string[] {
    const candidates = [
      'src/__tests__/setup.ts', 'src/__tests__/setup.js',
      'tests/setup.ts', 'tests/setup.js',
      'src/test/setup.ts', 'src/test/setup.js',
      'test/setup.ts', 'test/setup.js',
      'vitest.setup.ts', 'vitest.setup.js',
      'jest.setup.ts', 'jest.setup.js',
      'src/setupTests.ts', 'src/setupTests.js',
    ];
    const found: string[] = [];
    for (const rel of candidates) {
      const p = path.join(cwd, rel);
      if (existsSync(p)) found.push(p);
    }
    if (found.length === 0) {
      // Optional: shallow search im src/__tests__ und tests/ dirs
      for (const dir of ['src/__tests__', 'tests', 'src/test']) {
        const p = path.join(cwd, dir);
        try {
          if (existsSync(p) && statSync(p).isDirectory()) {
            const entries = readdirSync(p);
            for (const e of entries) {
              if (/setup\.(ts|js|mjs)$/.test(e)) found.push(path.join(p, e));
            }
          }
        } catch (err) {
          warnings.push(`test-setup dir read failed: ${(err as Error).message}`);
        }
      }
    }
    return found;
  }

  private findMigrationDirs(cwd: string): string[] {
    const candidates = ['migrations', 'db/migrations', 'prisma/migrations', 'src/migrations', 'database/migrations'];
    return candidates.filter(d => {
      const p = path.join(cwd, d);
      try { return existsSync(p) && statSync(p).isDirectory(); } catch { return false; }
    });
  }

  private scanDocs(cwd: string, warnings: string[]): Array<{ path: string; content: string }> {
    const docsDir = path.join(cwd, 'docs');
    if (!existsSync(docsDir)) return [];
    const result: Array<{ path: string; content: string }> = [];
    try {
      const visit = (dir: string, depth: number) => {
        if (depth > 2 || result.length >= DOCS_MAX_FILES) return;
        let entries: string[];
        try { entries = readdirSync(dir); } catch { return; }
        for (const name of entries) {
          if (result.length >= DOCS_MAX_FILES) return;
          const p = path.join(dir, name);
          let st;
          try { st = statSync(p); } catch { continue; }
          if (st.isDirectory()) visit(p, depth + 1);
          else if (/\.(md|mdx)$/i.test(name)) {
            const content = this.tryReadCapped(p, 2000);
            if (content) result.push({ path: path.relative(cwd, p), content });
          }
        }
      };
      visit(docsDir, 0);
    } catch (err) {
      warnings.push(`docs scan failed: ${(err as Error).message}`);
    }
    return result;
  }

  private tryRead(p: string, warnings: string[]): string | null {
    try {
      if (!existsSync(p)) return null;
      const content = readFileSync(p, 'utf8');
      return content.length > PER_FILE_CAP ? content.slice(0, PER_FILE_CAP) + '\n... (truncated)' : content;
    } catch (err) {
      warnings.push(`read failed (${path.basename(p)}): ${(err as Error).message}`);
      return null;
    }
  }

  private tryReadCapped(p: string, cap: number): string | null {
    try {
      if (!existsSync(p)) return null;
      const content = readFileSync(p, 'utf8');
      return content.length > cap ? content.slice(0, cap) + '\n... (truncated)' : content;
    } catch { return null; }
  }

  private tryReadFirst(paths: string[], warnings: string[]): string | null {
    for (const p of paths) {
      const r = this.tryRead(p, warnings);
      if (r) return r;
    }
    return null;
  }

  private async runGitLog(cwd: string, warnings: string[]): Promise<string | null> {
    try {
      const { stdout } = await exec('git', ['-C', cwd, 'log', `--pretty=format:%h %s`, `-n`, String(GIT_LOG_LIMIT)], {
        timeout: 5000, maxBuffer: 256 * 1024, encoding: 'utf8',
      });
      return String(stdout).trim();
    } catch (err) {
      warnings.push(`git log failed: ${(err as Error).message.slice(0, 100)}`);
      return null;
    }
  }

  private async runGitChurn(cwd: string, warnings: string[]): Promise<string | null> {
    try {
      const { stdout } = await exec('git', ['-C', cwd, 'log', '--name-only', '--pretty=format:', `-n`, String(GIT_LOG_LIMIT)], {
        timeout: 5000, maxBuffer: 512 * 1024, encoding: 'utf8',
      });
      const counts = new Map<string, number>();
      for (const line of String(stdout).split('\n')) {
        const f = line.trim();
        if (!f) continue;
        counts.set(f, (counts.get(f) ?? 0) + 1);
      }
      const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20);
      return sorted.map(([f, c]) => `${c}x ${f}`).join('\n');
    } catch (err) {
      warnings.push(`git churn failed: ${(err as Error).message.slice(0, 100)}`);
      return null;
    }
  }

  private buildLlmContext(parts: {
    cwd: string;
    packageJson: object | null;
    tsconfig: string | null;
    vitestConfig: string | null;
    jestConfig: string | null;
    nextConfig: string | null;
    eslintConfig: string | null;
    biomeConfig: string | null;
    readme: string | null;
    docsContent: Array<{ path: string; content: string }>;
    testSetupContents: Array<{ path: string; content: string }>;
    tree: string[];
    gitLog: string | null;
    gitChurn: string | null;
    envExampleContent: string | null;
    workspaces: string[] | undefined;
    framework: string | undefined;
    packageManager: string | undefined;
    testRunner: string | undefined;
  }): string {
    const blocks: string[] = [];

    blocks.push(`# Repo-Scan: ${parts.cwd}\n`);
    blocks.push(`**Framework:** ${parts.framework ?? 'unknown'}`);
    blocks.push(`**Package-Manager:** ${parts.packageManager ?? 'unknown'}`);
    blocks.push(`**Test-Runner:** ${parts.testRunner ?? 'none'}`);
    if (parts.workspaces) blocks.push(`**Workspaces:** ${parts.workspaces.join(', ')}`);
    blocks.push('');

    if (parts.packageJson) {
      blocks.push('## package.json');
      blocks.push('```json');
      blocks.push(JSON.stringify(parts.packageJson, null, 2).slice(0, PER_FILE_CAP));
      blocks.push('```');
      blocks.push('');
    }

    if (parts.tsconfig) {
      blocks.push('## tsconfig.json');
      blocks.push('```json');
      blocks.push(parts.tsconfig);
      blocks.push('```');
      blocks.push('');
    }

    if (parts.vitestConfig) blocks.push(`## vitest.config\n\`\`\`\n${parts.vitestConfig}\n\`\`\`\n`);
    if (parts.jestConfig) blocks.push(`## jest.config\n\`\`\`\n${parts.jestConfig}\n\`\`\`\n`);
    if (parts.nextConfig) blocks.push(`## next.config\n\`\`\`\n${parts.nextConfig}\n\`\`\`\n`);
    if (parts.eslintConfig) blocks.push(`## eslint.config\n\`\`\`\n${parts.eslintConfig}\n\`\`\`\n`);
    if (parts.biomeConfig) blocks.push(`## biome.json\n\`\`\`json\n${parts.biomeConfig}\n\`\`\`\n`);

    if (parts.testSetupContents.length > 0) {
      blocks.push('## Test-Setup-Files (KRITISCH für Conventions)');
      for (const f of parts.testSetupContents) {
        blocks.push(`### ${f.path}`);
        blocks.push('```');
        blocks.push(f.content);
        blocks.push('```');
        blocks.push('');
      }
    }

    if (parts.readme) {
      blocks.push('## README.md (Anfang)');
      blocks.push(parts.readme);
      blocks.push('');
    }

    if (parts.docsContent.length > 0) {
      blocks.push('## docs/');
      for (const d of parts.docsContent) {
        blocks.push(`### ${d.path}`);
        blocks.push(d.content);
        blocks.push('');
      }
    }

    if (parts.envExampleContent) {
      blocks.push('## .env.example');
      blocks.push('```');
      blocks.push(parts.envExampleContent);
      blocks.push('```');
      blocks.push('');
    }

    if (parts.tree.length > 0) {
      blocks.push(`## File-Tree (${parts.tree.length} entries, top 3 levels)`);
      blocks.push('```');
      blocks.push(parts.tree.join('\n'));
      blocks.push('```');
      blocks.push('');
    }

    if (parts.gitChurn) {
      blocks.push('## Git-Churn (last 50 commits, top-touched files)');
      blocks.push('```');
      blocks.push(parts.gitChurn);
      blocks.push('```');
      blocks.push('');
    }

    if (parts.gitLog) {
      blocks.push('## Git-Log (last 50 commits)');
      blocks.push('```');
      blocks.push(parts.gitLog.slice(0, 4000));
      blocks.push('```');
      blocks.push('');
    }

    let result = blocks.join('\n');
    if (result.length > TOTAL_CONTEXT_CAP) {
      result = result.slice(0, TOTAL_CONTEXT_CAP) + '\n\n[... Context truncated at 60KB cap ...]';
    }
    return result;
  }
}
