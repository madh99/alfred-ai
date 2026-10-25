import { Skill } from '@alfred/skills';
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';

/**
 * v1658 — Owner 25.10. („registry.lokalkraft.at sollte auf jeden Fall für Alfred in den GitLab-Skill aufgenommen werden“):
 * nur lesender Blick auf das eigene GitLab — Projekte mit ihrem Registry-Pfad und die Images/Tags einer Projekt-Registry mit Digest.
 * Hochladen und Holen von Images laufen als fernzugriff image_hochladen / image_holen in freigegebenen Changes.
 */
export interface GitlabDeps {
  istOwner: (ctx: SkillContext) => boolean;
  /** GET auf die GitLab-API v4 (Pfad ab /api/v4), JSON zurück */
  api: (pfad: string) => Promise<unknown>;
}

interface Projekt { id: number; path_with_namespace: string; container_registry_image_prefix?: string; last_activity_at?: string; default_branch?: string; web_url?: string }
interface Repo { id: number; path: string; location: string; tags_count?: number }
interface Tag { name: string; location?: string; digest?: string; created_at?: string; total_size?: number }

const PROJEKT = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*){0,5}$/;

export class GitlabSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'gitlab',
    category: 'infrastructure',
    description:
      'Eigenes GitLab (git.lokalkraft.at) und seine Container-Registry (registry.lokalkraft.at), nur lesend. ' +
      'projekte (suche?): Projekte mit Registry-Pfad (<registry>/<projekt>), Standard-Branch, letzte Aktivität. ' +
      'registry (projekt = Pfad wie madh/noahhabel-landingpage): Images der Projekt-Registry mit Tags, Digest, Größe, Datum. ' +
      'Lokal gebaute Images unverändert übertragen: in einem Change fernzugriff image_hochladen (registry_ziel = <Registry-Pfad des Projekts>/<name>:<tag>), am Ziel fernzugriff image_holen mit @sha256-Digest.',
    riskLevel: 'read',
    version: '1.0.0',
    timeoutMs: 60_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['projekte', 'registry'], description: 'projekte | registry' },
        suche: { type: 'string', description: 'projekte: Teil des Namens' },
        projekt: { type: 'string', description: 'registry: Projektpfad, z. B. madh/noahhabel-landingpage' },
      },
      required: ['action'],
    },
  };

  constructor(private readonly deps: GitlabDeps) { super(); }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    if (!this.deps.istOwner(context)) return { success: false, error: 'GitLab ist nur für den Owner.' };
    try {
      const action = String(input.action ?? 'projekte');
      if (action === 'projekte') return await this.projekte(typeof input.suche === 'string' ? input.suche.trim() : '');
      if (action === 'registry') return await this.registry(String(input.projekt ?? '').trim());
      return { success: false, error: `Unbekannte Aktion „${action}“ (projekte, registry)` };
    } catch (err) {
      return { success: false, error: (err as Error).message.slice(0, 400) };
    }
  }

  private async projekte(suche: string): Promise<SkillResult> {
    const q = suche ? `&search=${encodeURIComponent(suche.slice(0, 80))}` : '';
    const l = (await this.deps.api(`/projects?membership=true&per_page=100&order_by=last_activity_at&simple=false${q}`)) as Projekt[];
    const daten = l.map(p => ({ projekt: p.path_with_namespace, registry: p.container_registry_image_prefix ?? null, branch: p.default_branch ?? null, aktiv: p.last_activity_at?.slice(0, 10) ?? null }));
    const zeilen = daten.map(p => `- **${p.projekt}** · ${p.registry ?? 'keine Registry'} · ${p.branch ?? '–'} · zuletzt ${p.aktiv ?? '–'}`);
    return { success: true, data: daten, display: zeilen.length ? `${zeilen.length} Projekte:\n${zeilen.join('\n')}` : 'Keine Projekte gefunden.' };
  }

  private async registry(projekt: string): Promise<SkillResult> {
    if (!PROJEKT.test(projekt)) return { success: false, error: 'projekt: Pfad wie madh/noahhabel-landingpage angeben' };
    const id = encodeURIComponent(projekt);
    const repos = (await this.deps.api(`/projects/${id}/registry/repositories?tags_count=true&per_page=50`)) as Repo[];
    if (!repos.length) return { success: true, data: { projekt, images: [] }, display: `${projekt}: noch keine Images in der Registry.` };
    const images: Array<{ image: string; tags: Array<{ tag: string; digest: string | null; erstellt: string | null; groesseMb: number | null }> }> = [];
    for (const r of repos.slice(0, 20)) {
      const namen = ((await this.deps.api(`/projects/${id}/registry/repositories/${r.id}/tags?per_page=50`)) as Tag[]).map(t => t.name).slice(0, 20);
      const tags = [];
      for (const n of namen) {
        const t = (await this.deps.api(`/projects/${id}/registry/repositories/${r.id}/tags/${encodeURIComponent(n)}`)) as Tag;
        tags.push({ tag: n, digest: t.digest ?? null, erstellt: t.created_at ?? null, groesseMb: typeof t.total_size === 'number' ? Math.round(t.total_size / 1048576) : null });
      }
      images.push({ image: r.location, tags });
    }
    const zeilen = images.flatMap(i => [`**${i.image}**`, ...i.tags.map(t => `- ${t.tag} · ${t.digest ?? 'ohne Digest'} · ${t.erstellt?.slice(0, 16).replace('T', ' ') ?? '–'}${t.groesseMb !== null ? ` · ${t.groesseMb} MB` : ''}`)]);
    return { success: true, data: { projekt, images }, display: zeilen.join('\n') };
  }
}
