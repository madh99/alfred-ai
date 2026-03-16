import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';
import type { SkillRegistry } from '../skill-registry.js';

/** Category labels for display. */
const CATEGORY_LABELS: Record<string, string> = {
  core: '🔧 System',
  productivity: '📋 Produktivität',
  information: '🌐 Information',
  communication: '💬 Kommunikation',
  automation: '⚡ Automatisierung',
  infrastructure: '🖥️ Infrastruktur',
  identity: '👤 Benutzer',
  code: '💻 Code & Entwicklung',
};

const RISK_LABELS: Record<string, string> = {
  read: 'Nur Lesen',
  write: 'Lesen & Schreiben',
  admin: 'Admin',
  critical: 'Kritisch',
};

export class HelpSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'help',
    category: 'core',
    description: `Show available skills and how to use them. Actions:
- overview: Show all available skills grouped by category
- detail: Show detailed info about a specific skill (params, examples). Params: skill_name
- search: Search skills by keyword. Params: query`,
    riskLevel: 'read',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['overview', 'detail', 'search'],
          description: 'What help to show',
        },
        skill_name: {
          type: 'string',
          description: 'Skill name for detail view',
        },
        query: {
          type: 'string',
          description: 'Search query',
        },
      },
      required: ['action'],
    },
  };

  constructor(
    private readonly registry: SkillRegistry,
    private readonly roleAccess?: Record<string, string[] | '*'>,
  ) {
    super();
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = (input.action as string) ?? 'overview';

    switch (action) {
      case 'overview':
        return this.overview(context);
      case 'detail':
        return this.detail(input.skill_name as string, context);
      case 'search':
        return this.search(input.query as string, context);
      default:
        return this.overview(context);
    }
  }

  private getAccessibleSkills(context: SkillContext): Skill[] {
    const all = this.registry.getAll();
    const role = context.userRole ?? 'guest';

    if (!this.roleAccess) return all;

    const allowed = this.roleAccess[role];
    if (allowed === '*') return all;
    if (!allowed) return all.filter(s => s.metadata.riskLevel === 'read');

    return all.filter(s => allowed.includes(s.metadata.name));
  }

  private overview(context: SkillContext): SkillResult {
    const skills = this.getAccessibleSkills(context);
    const role = context.userRole ?? 'guest';

    // Group by category
    const groups = new Map<string, Skill[]>();
    for (const skill of skills) {
      const cat = skill.metadata.category ?? 'core';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(skill);
    }

    const lines: string[] = [];
    lines.push(`**Alfred — Verfügbare Funktionen** (Rolle: ${role})`);
    lines.push('');

    for (const [cat, catSkills] of groups) {
      const label = CATEGORY_LABELS[cat] ?? cat;
      lines.push(`${label}`);
      for (const s of catSkills.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))) {
        const desc = s.metadata.description.split('\n')[0].slice(0, 80);
        lines.push(`  • **${s.metadata.name}** — ${desc}`);
      }
      lines.push('');
    }

    lines.push(`_${skills.length} Skills verfügbar. Frag "hilfe zu [skill]" für Details._`);

    return {
      success: true,
      data: { skillCount: skills.length, role },
      display: lines.join('\n'),
    };
  }

  private detail(skillName: string, context: SkillContext): SkillResult {
    if (!skillName) {
      return { success: false, error: 'Welchen Skill möchtest du genauer kennenlernen? Gib skill_name an.' };
    }

    const skill = this.registry.get(skillName);
    if (!skill) {
      return { success: false, error: `Skill "${skillName}" nicht gefunden. Nutze "overview" für die Liste.` };
    }

    // Check access
    const accessible = this.getAccessibleSkills(context);
    if (!accessible.find(s => s.metadata.name === skillName)) {
      return { success: false, error: `Skill "${skillName}" ist für deine Rolle nicht verfügbar.` };
    }

    const m = skill.metadata;
    const lines: string[] = [];
    lines.push(`**${m.name}** (v${m.version})`);
    lines.push('');
    lines.push(m.description);
    lines.push('');
    lines.push(`Kategorie: ${CATEGORY_LABELS[m.category ?? 'core'] ?? m.category}`);
    lines.push(`Berechtigung: ${RISK_LABELS[m.riskLevel] ?? m.riskLevel}`);

    // Show parameters from inputSchema
    const schema = m.inputSchema as { properties?: Record<string, { type?: string; enum?: string[]; description?: string }> };
    if (schema.properties) {
      lines.push('');
      lines.push('**Parameter:**');
      for (const [name, prop] of Object.entries(schema.properties)) {
        const typeStr = prop.enum ? prop.enum.join(' | ') : (prop.type ?? 'string');
        const desc = prop.description ?? '';
        lines.push(`  • \`${name}\` (${typeStr}) — ${desc}`);
      }
    }

    return {
      success: true,
      data: { name: m.name, version: m.version, category: m.category, riskLevel: m.riskLevel },
      display: lines.join('\n'),
    };
  }

  private search(query: string, context: SkillContext): SkillResult {
    if (!query) {
      return { success: false, error: 'Suchbegriff fehlt. Was suchst du?' };
    }

    const skills = this.getAccessibleSkills(context);
    const q = query.toLowerCase();
    const matches = skills.filter(s =>
      s.metadata.name.toLowerCase().includes(q) ||
      s.metadata.description.toLowerCase().includes(q) ||
      (s.metadata.category ?? '').toLowerCase().includes(q)
    );

    if (matches.length === 0) {
      return { success: true, data: [], display: `Keine Skills für "${query}" gefunden.` };
    }

    const lines = matches.map(s => {
      const desc = s.metadata.description.split('\n')[0].slice(0, 80);
      return `• **${s.metadata.name}** — ${desc}`;
    });

    return {
      success: true,
      data: matches.map(s => s.metadata.name),
      display: `**Suchergebnisse für "${query}":**\n\n${lines.join('\n')}`,
    };
  }
}
