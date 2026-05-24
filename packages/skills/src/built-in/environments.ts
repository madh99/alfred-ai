import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';
import type { EnvironmentRepository, ProjectRepository, DbSeedRepository } from '@alfred/storage';
import type { EnvCryptoService } from '@alfred/security';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * v726 — environments skill
 *
 * CRUD für Project-ENV-Variablen pro Stage (prod/dev/sandbox/custom).
 * Werte werden AES-GCM-verschlüsselt persistiert (sofern EnvCryptoService verfügbar).
 *
 * Actions:
 *  - set         : KEY=value für eine (project, stage) speichern (Merge mit existing)
 *  - get         : einen Key lesen
 *  - list        : alle Keys einer (project, stage) listen (values maskiert)
 *  - reveal      : alle Keys einer (project, stage) im Klartext (für Owner-Audit)
 *  - delete      : einen Key löschen
 *  - delete_stage: ganze Stage löschen
 *  - copy_stage  : von Stage A nach Stage B kopieren
 *  - scan_repo   : Repo nach .env.example + process.env.X scannen, schlägt Keys vor
 *  - list_stages : alle Stages eines Projects auflisten
 */
type EnvAction =
  | 'set' | 'get' | 'list' | 'reveal' | 'delete' | 'delete_stage'
  | 'copy_stage' | 'scan_repo' | 'list_stages';

export class EnvironmentsSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'environments',
    category: 'core',
    description:
      'v726 — Manage encrypted per-project ENV variables by stage (prod/dev/sandbox). '
      + 'Used to inject configuration into Sandbox containers and Deploy targets.',
    riskLevel: 'write',
    version: '1.0.0',
    timeoutMs: 30_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['set', 'get', 'list', 'reveal', 'delete', 'delete_stage', 'copy_stage', 'scan_repo', 'list_stages'],
        },
        project: { type: 'string', description: 'Project-ID ODER Name (resolved via ProjectRepository).' },
        stage: { type: 'string', description: 'Stage-Name: prod | dev | sandbox | custom-name. Default: sandbox.' },
        key: { type: 'string', description: 'ENV-Key (für set/get/delete).' },
        value: { type: 'string', description: 'ENV-Value (für set).' },
        from_stage: { type: 'string', description: 'Quell-Stage (für copy_stage).' },
        to_stage: { type: 'string', description: 'Ziel-Stage (für copy_stage).' },
        overwrite: { type: 'boolean', description: 'Bei copy_stage: existing keys überschreiben? Default false (merge).' },
      },
      required: ['action'],
    },
  };

  constructor(
    private readonly envRepo: EnvironmentRepository,
    private readonly envCrypto: EnvCryptoService,
    private readonly projectRepo: ProjectRepository,
    private readonly ownerMasterUserId: string,
    private readonly dbSeedRepo?: DbSeedRepository,
  ) {
    super();
    void this.dbSeedRepo;
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = input.action as EnvAction;
    const userId = context.alfredUserId ?? context.userId;
    if (userId !== this.ownerMasterUserId && context.masterUserId !== this.ownerMasterUserId) {
      return { success: false, error: 'environments-Skill ist nur für Owner verfügbar.' };
    }

    try {
      switch (action) {
        case 'set':         return await this.setVar(input);
        case 'get':         return await this.getVar(input);
        case 'list':        return await this.listVars(input, false);
        case 'reveal':      return await this.listVars(input, true);
        case 'delete':      return await this.deleteVar(input);
        case 'delete_stage':return await this.deleteStage(input);
        case 'copy_stage':  return await this.copyStage(input);
        case 'scan_repo':   return await this.scanRepo(input);
        case 'list_stages': return await this.listStages(input);
        default: return { success: false, error: `Unknown action: ${String(action)}` };
      }
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  private async resolveProject(input: Record<string, unknown>): Promise<{ id: string; cwd?: string; name: string } | null> {
    const raw = String(input.project ?? '').trim();
    if (!raw) return null;
    const direct = await this.projectRepo.getByIdAnyOwner(raw).catch(() => null);
    if (direct) return { id: direct.id, cwd: direct.cwd, name: direct.name };
    // Fallback: über Owner-User-ID + Name/Slug suchen
    const list = await this.projectRepo.list(this.ownerMasterUserId).catch(() => []);
    const slugMatch = list.find(p => p.slug === raw);
    if (slugMatch) return { id: slugMatch.id, cwd: slugMatch.cwd, name: slugMatch.name };
    const nameMatch = list.find(p => p.name.toLowerCase() === raw.toLowerCase());
    if (nameMatch) return { id: nameMatch.id, cwd: nameMatch.cwd, name: nameMatch.name };
    return null;
  }

  private async loadDecrypted(projectId: string, stage: string): Promise<Record<string, string>> {
    const entry = await this.envRepo.get(projectId, stage);
    if (!entry) return {};
    return this.envCrypto.decrypt(entry.varsEncrypted, entry.iv, entry.authTag);
  }

  private async storeEncrypted(projectId: string, stage: string, vars: Record<string, string>): Promise<void> {
    const { ciphertext, iv, authTag } = this.envCrypto.encrypt(vars);
    await this.envRepo.upsert({
      projectId, stage, varsEncrypted: ciphertext, iv, authTag, encryptionVersion: 1,
    });
  }

  private maskValue(v: string): string {
    if (v.length <= 4) return '****';
    return v.slice(0, 2) + '****' + v.slice(-2);
  }

  private async setVar(input: Record<string, unknown>): Promise<SkillResult> {
    const proj = await this.resolveProject(input);
    if (!proj) return { success: false, error: 'Project nicht gefunden (use project=<id|slug|name>)' };
    const stage = String(input.stage ?? 'sandbox');
    const key = String(input.key ?? '').trim();
    const value = String(input.value ?? '');
    if (!key) return { success: false, error: 'Missing required field: key' };
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) return { success: false, error: `Key "${key}" hat ungültiges Format (erlaubt: A-Z, 0-9, _; muss mit Buchstabe beginnen).` };
    const current = await this.loadDecrypted(proj.id, stage);
    current[key] = value;
    await this.storeEncrypted(proj.id, stage, current);
    return {
      success: true,
      data: { project: proj.name, stage, key, value: this.maskValue(value), total_keys: Object.keys(current).length },
      display: `🔐 Set ${key}=${this.maskValue(value)} → ${proj.name} / ${stage} (${Object.keys(current).length} keys insgesamt)`,
    };
  }

  private async getVar(input: Record<string, unknown>): Promise<SkillResult> {
    const proj = await this.resolveProject(input);
    if (!proj) return { success: false, error: 'Project nicht gefunden' };
    const stage = String(input.stage ?? 'sandbox');
    const key = String(input.key ?? '').trim();
    if (!key) return { success: false, error: 'Missing key' };
    const current = await this.loadDecrypted(proj.id, stage);
    const value = current[key];
    if (value === undefined) return { success: false, error: `Key "${key}" nicht gesetzt in ${proj.name}/${stage}` };
    return {
      success: true,
      data: { project: proj.name, stage, key, value },
      display: `🔓 ${proj.name} / ${stage}: ${key}=${value}`,
    };
  }

  private async listVars(input: Record<string, unknown>, reveal: boolean): Promise<SkillResult> {
    const proj = await this.resolveProject(input);
    if (!proj) return { success: false, error: 'Project nicht gefunden' };
    const stage = String(input.stage ?? 'sandbox');
    const current = await this.loadDecrypted(proj.id, stage);
    const keys = Object.keys(current).sort();
    if (keys.length === 0) {
      return {
        success: true,
        data: { project: proj.name, stage, keys: [] },
        display: `📭 ${proj.name} / ${stage}: keine ENVs gesetzt`,
      };
    }
    const lines: string[] = [`📋 ${proj.name} / ${stage} (${keys.length} keys):`];
    for (const k of keys) {
      const v = current[k];
      lines.push(`  ${k}=${reveal ? v : this.maskValue(v)}`);
    }
    return {
      success: true,
      data: { project: proj.name, stage, keys, count: keys.length, reveal },
      display: lines.join('\n'),
    };
  }

  private async deleteVar(input: Record<string, unknown>): Promise<SkillResult> {
    const proj = await this.resolveProject(input);
    if (!proj) return { success: false, error: 'Project nicht gefunden' };
    const stage = String(input.stage ?? 'sandbox');
    const key = String(input.key ?? '').trim();
    if (!key) return { success: false, error: 'Missing key' };
    const current = await this.loadDecrypted(proj.id, stage);
    if (current[key] === undefined) return { success: false, error: `Key "${key}" nicht gesetzt` };
    delete current[key];
    if (Object.keys(current).length === 0) {
      await this.envRepo.delete(proj.id, stage);
    } else {
      await this.storeEncrypted(proj.id, stage, current);
    }
    return {
      success: true,
      data: { project: proj.name, stage, deletedKey: key, remaining: Object.keys(current).length },
      display: `🗑️ Gelöscht: ${key} aus ${proj.name}/${stage} (${Object.keys(current).length} keys übrig)`,
    };
  }

  private async deleteStage(input: Record<string, unknown>): Promise<SkillResult> {
    const proj = await this.resolveProject(input);
    if (!proj) return { success: false, error: 'Project nicht gefunden' };
    const stage = String(input.stage ?? '');
    if (!stage) return { success: false, error: 'Missing stage' };
    await this.envRepo.delete(proj.id, stage);
    return {
      success: true,
      data: { project: proj.name, stage },
      display: `🗑️ Stage gelöscht: ${proj.name}/${stage}`,
    };
  }

  private async copyStage(input: Record<string, unknown>): Promise<SkillResult> {
    const proj = await this.resolveProject(input);
    if (!proj) return { success: false, error: 'Project nicht gefunden' };
    const from = String(input.from_stage ?? '');
    const to = String(input.to_stage ?? '');
    if (!from || !to) return { success: false, error: 'Missing from_stage/to_stage' };
    if (from === to) return { success: false, error: 'from_stage = to_stage' };
    const overwrite = input.overwrite === true;
    const src = await this.loadDecrypted(proj.id, from);
    if (Object.keys(src).length === 0) return { success: false, error: `Source-Stage "${from}" ist leer` };
    const dst = overwrite ? {} : await this.loadDecrypted(proj.id, to);
    let added = 0, skipped = 0;
    for (const [k, v] of Object.entries(src)) {
      if (!overwrite && dst[k] !== undefined) { skipped++; continue; }
      dst[k] = v;
      added++;
    }
    await this.storeEncrypted(proj.id, to, dst);
    return {
      success: true,
      data: { project: proj.name, from, to, added, skipped, total: Object.keys(dst).length },
      display: `📋 ${proj.name}: ${from} → ${to}: ${added} kopiert, ${skipped} übersprungen (total: ${Object.keys(dst).length})`,
    };
  }

  private async listStages(input: Record<string, unknown>): Promise<SkillResult> {
    const proj = await this.resolveProject(input);
    if (!proj) return { success: false, error: 'Project nicht gefunden' };
    const all = await this.envRepo.listForProject(proj.id);
    const stages = await Promise.all(all.map(async e => {
      try {
        const vars = this.envCrypto.decrypt(e.varsEncrypted, e.iv, e.authTag);
        return { stage: e.stage, keyCount: Object.keys(vars).length, updatedAt: e.updatedAt };
      } catch {
        return { stage: e.stage, keyCount: -1, updatedAt: e.updatedAt };
      }
    }));
    if (stages.length === 0) {
      return { success: true, data: { project: proj.name, stages: [] }, display: `📭 ${proj.name}: keine Stages konfiguriert` };
    }
    const lines = [`📋 ${proj.name} hat ${stages.length} Stage(s):`];
    for (const s of stages) lines.push(`  ${s.stage}: ${s.keyCount} keys (updated ${s.updatedAt})`);
    return { success: true, data: { project: proj.name, stages }, display: lines.join('\n') };
  }

  private async scanRepo(input: Record<string, unknown>): Promise<SkillResult> {
    const proj = await this.resolveProject(input);
    if (!proj || !proj.cwd) return { success: false, error: 'Project oder cwd nicht gefunden' };
    if (!existsSync(proj.cwd)) return { success: false, error: `cwd existiert nicht: ${proj.cwd}` };
    const cwd = proj.cwd;
    const found = new Map<string, { fromExample: boolean; fromCode: string[] }>();

    // .env.example / .sample / .template
    const exampleNames = ['.env.example', '.env.sample', '.env.template'];
    for (const fn of exampleNames) {
      const p = path.join(cwd, fn);
      if (!existsSync(p)) continue;
      try {
        const content = readFileSync(p, 'utf8');
        for (const line of content.split('\n')) {
          const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
          if (m) {
            const k = m[1];
            const existing = found.get(k) ?? { fromExample: false, fromCode: [] };
            existing.fromExample = true;
            found.set(k, existing);
          }
        }
      } catch { /* skip */ }
    }

    // Quelltext-Scan auf process.env.X (TS/JS) und env('X') (PHP) — best-effort begrenzt
    const codeExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.php', '.rb', '.go']);
    const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.alfred-data', 'coverage']);
    const walk = (dir: string, depth: number) => {
      if (depth > 4) return;
      let entries: import('node:fs').Dirent[] = [];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (skipDirs.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full, depth + 1);
          continue;
        }
        const ext = path.extname(e.name);
        if (!codeExts.has(ext)) continue;
        try {
          const size = statSync(full).size;
          if (size > 512 * 1024) continue;
          const content = readFileSync(full, 'utf8');
          const regexes = [
            /process\.env\.([A-Z][A-Z0-9_]*)/g,
            /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
            /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
            /\bos\.environ\.get\(['"]([A-Z][A-Z0-9_]*)['"]\)/g,
            /\bos\.getenv\(['"]([A-Z][A-Z0-9_]*)['"]\)/g,
          ];
          for (const r of regexes) {
            let m: RegExpExecArray | null;
            while ((m = r.exec(content)) !== null) {
              const k = m[1];
              const existing = found.get(k) ?? { fromExample: false, fromCode: [] };
              const rel = path.relative(cwd, full);
              if (!existing.fromCode.includes(rel)) existing.fromCode.push(rel);
              found.set(k, existing);
            }
          }
        } catch { /* skip */ }
      }
    };
    walk(cwd, 0);

    const sorted = Array.from(found.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const data = sorted.map(([key, info]) => ({
      key,
      sources: [
        ...(info.fromExample ? ['.env.example'] : []),
        ...info.fromCode.slice(0, 3),
      ],
      example_count: info.fromExample ? 1 : 0,
      code_files: info.fromCode.length,
    }));
    const lines = [`🔍 ${proj.name}: ${sorted.length} ENV-Variablen gefunden`];
    for (const k of sorted.slice(0, 50)) {
      const info = k[1];
      const src = info.fromExample ? '.env.example' : `${info.fromCode.length} code-refs`;
      lines.push(`  ${k[0]} (${src})`);
    }
    if (sorted.length > 50) lines.push(`  … +${sorted.length - 50} weitere`);
    return { success: true, data: { project: proj.name, count: sorted.length, keys: data }, display: lines.join('\n') };
  }
}
