import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { listProjectDocs, readProjectDoc } from './project-docs.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('project-docs', () => {
  let cwd: string;
  let outside: string;

  beforeAll(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'alfred-docs-'));
    outside = mkdtempSync(path.join(tmpdir(), 'alfred-docs-outside-'));
    writeFileSync(path.join(cwd, 'README.md'), '# Readme\n', 'utf8');
    writeFileSync(path.join(cwd, 'CHANGELOG.md'), '# Changelog\n', 'utf8');
    writeFileSync(path.join(cwd, 'index.ts'), 'export {};\n', 'utf8');
    mkdirSync(path.join(cwd, 'docs', 'security'), { recursive: true });
    writeFileSync(path.join(cwd, 'docs', 'proposal.md'), '# Proposal\nInhalt.\n', 'utf8');
    writeFileSync(path.join(cwd, 'docs', 'security', 'review.md'), '# Review\n', 'utf8');
    writeFileSync(path.join(cwd, 'docs', 'notes.txt'), 'kein markdown\n', 'utf8');
    mkdirSync(path.join(cwd, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(path.join(cwd, 'node_modules', 'pkg', 'README.md'), '# fremd\n', 'utf8');
    writeFileSync(path.join(outside, 'secret.md'), 'GEHEIM\n', 'utf8');
  });
  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  describe('listProjectDocs', () => {
    it('lists root *.md and docs/** recursively, README first', async () => {
      const files = await listProjectDocs(cwd);
      const paths = files.map(f => f.path);
      expect(paths[0]).toBe('README.md');
      expect(paths).toContain('CHANGELOG.md');
      expect(paths).toContain('docs/proposal.md');
      expect(paths).toContain('docs/security/review.md');
    });

    it('excludes non-markdown, node_modules and source files', async () => {
      const files = await listProjectDocs(cwd);
      const paths = files.map(f => f.path);
      expect(paths).not.toContain('index.ts');
      expect(paths).not.toContain('docs/notes.txt');
      expect(paths.some(p => p.includes('node_modules'))).toBe(false);
    });

    it('reports size and mtime', async () => {
      const files = await listProjectDocs(cwd);
      const readme = files.find(f => f.path === 'README.md')!;
      expect(readme.sizeBytes).toBeGreaterThan(0);
      expect(new Date(readme.modifiedAt).getTime()).toBeGreaterThan(0);
    });

    it('throws for missing cwd', async () => {
      await expect(listProjectDocs('/nonexistent/dir-12345')).rejects.toThrow('does not exist');
    });
  });

  describe('readProjectDoc', () => {
    it('reads a root markdown file', async () => {
      const doc = await readProjectDoc(cwd, 'README.md');
      expect(doc.content).toContain('# Readme');
      expect(doc.truncated).toBe(false);
    });

    it('reads a nested docs file (forward slashes)', async () => {
      const doc = await readProjectDoc(cwd, 'docs/security/review.md');
      expect(doc.content).toContain('# Review');
    });

    it('rejects ../ traversal', async () => {
      const rel = path.join('..', path.basename(outside), 'secret.md');
      await expect(readProjectDoc(cwd, rel)).rejects.toThrow('escapes project directory');
      await expect(readProjectDoc(cwd, '../secret.md')).rejects.toThrow('escapes project directory');
    });

    it('rejects nested traversal hidden inside the path', async () => {
      await expect(readProjectDoc(cwd, 'docs/../../outside.md')).rejects.toThrow('escapes project directory');
    });

    it('rejects absolute paths', async () => {
      await expect(readProjectDoc(cwd, path.join(outside, 'secret.md'))).rejects.toThrow(/absolute|escapes/);
    });

    it('rejects non-markdown files', async () => {
      await expect(readProjectDoc(cwd, 'docs/notes.txt')).rejects.toThrow('only .md');
      await expect(readProjectDoc(cwd, 'index.ts')).rejects.toThrow('only .md');
    });

    it('rejects missing file with fs error', async () => {
      await expect(readProjectDoc(cwd, 'nope.md')).rejects.toThrow();
    });
  });
});
