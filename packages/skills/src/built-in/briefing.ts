import type { SkillMetadata, SkillContext, SkillResult, AlfredConfig } from '@alfred/types';
import { Skill } from '../skill.js';
import type { SkillRegistry } from '../skill-registry.js';

type BriefingAction = 'run' | 'modules';

interface BriefingModule {
  name: string;
  skill: string;
  input: Record<string, unknown>;
  label: string;
}

const ALL_MODULES: BriefingModule[] = [
  { name: 'calendar',   skill: 'calendar',       input: { action: 'list_events' },              label: 'Kalender' },
  { name: 'weather',    skill: 'weather',         input: {},                                     label: 'Wetter' },
  { name: 'todo',       skill: 'todo',            input: { action: 'list' },                     label: 'Lokale Todos' },
  { name: 'mstodo',     skill: 'microsoft_todo',  input: { action: 'list_tasks' },               label: 'Microsoft To Do' },
  { name: 'email',      skill: 'email',           input: { action: 'inbox' },                    label: 'E-Mail' },
  { name: 'energy',     skill: 'energy_price',    input: { action: 'today' },                    label: 'Strompreise' },
  { name: 'bmw',        skill: 'bmw',             input: { action: 'status' },                   label: 'BMW Status' },
  { name: 'home',       skill: 'homeassistant',   input: { action: 'states' },                   label: 'Smart Home' },
  { name: 'infra',      skill: 'monitor',         input: {},                                     label: 'Infrastruktur' },
];

export class BriefingSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'briefing',
    category: 'productivity',
    description:
      'Tägliches Morgenbriefing — sammelt Daten aus mehreren Skills parallel und liefert ' +
      'ein strukturiertes Ergebnis: Kalender, Wetter, Todos, E-Mails, Strompreise, Auto-Status, Smart Home, Infrastruktur. ' +
      '"run" führt das Briefing aus (optional mit location für Wetter). ' +
      '"modules" zeigt verfügbare und aktive Module.',
    riskLevel: 'read',
    version: '1.0.0',
    timeoutMs: 60_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['run', 'modules'],
          description: 'run = Briefing ausführen, modules = verfügbare Module anzeigen',
        },
        location: {
          type: 'string',
          description: 'Ort für Wetterabfrage (default: aus Config oder "Vienna")',
        },
        modules: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optionale Liste aktiver Module (default: alle verfügbaren)',
        },
      },
      required: ['action'],
    },
  };

  constructor(
    private readonly skillRegistry: SkillRegistry,
    private readonly alfredConfig: AlfredConfig,
  ) {
    super();
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = input.action as BriefingAction;

    switch (action) {
      case 'run': return this.runBriefing(input, context);
      case 'modules': return this.showModules();
      default: return { success: false, error: `Unbekannte Aktion: ${action}` };
    }
  }

  private getAvailableModules(): BriefingModule[] {
    return ALL_MODULES.filter(m => this.skillRegistry.has(m.skill));
  }

  private showModules(): SkillResult {
    const available = this.getAvailableModules();
    const allNames = ALL_MODULES.map(m => {
      const active = available.some(a => a.name === m.name);
      return `${active ? '✅' : '❌'} ${m.name} (${m.label}) → ${m.skill}`;
    });

    return {
      success: true,
      data: { available: available.map(m => m.name), all: ALL_MODULES.map(m => m.name) },
      display: `Briefing-Module:\n${allNames.join('\n')}`,
    };
  }

  private async runBriefing(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const location = (input.location as string | undefined) ?? this.alfredConfig.briefing?.location ?? 'Vienna';
    const requestedModules = input.modules as string[] | undefined;

    let modules = this.getAvailableModules();
    if (requestedModules?.length) {
      modules = modules.filter(m => requestedModules.includes(m.name));
    }

    // Build inputs with overrides
    const tasks = modules.map(m => {
      const moduleInput = { ...m.input };
      if (m.name === 'weather') moduleInput.location = location;
      return { module: m, input: moduleInput };
    });

    // Execute all in parallel with individual error handling
    const results = await Promise.all(
      tasks.map(async ({ module, input: moduleInput }) => {
        try {
          const skill = this.skillRegistry.get(module.skill);
          if (!skill) return { module: module.name, label: module.label, success: false, error: 'Skill nicht gefunden' };

          const result = await skill.execute(moduleInput, context);
          return {
            module: module.name,
            label: module.label,
            success: result.success,
            data: result.data,
            display: result.display,
            error: result.error,
          };
        } catch (err) {
          return {
            module: module.name,
            label: module.label,
            success: false,
            error: String(err instanceof Error ? err.message : err),
          };
        }
      }),
    );

    // Build structured output for LLM synthesis
    const sections: string[] = [];
    sections.push(`**Morgenbriefing** — ${new Date().toLocaleDateString('de-AT', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n`);

    for (const r of results) {
      if (r.success && r.display) {
        sections.push(`### ${r.label}\n${r.display}\n`);
      } else if (r.success && r.data) {
        sections.push(`### ${r.label}\n${typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2)}\n`);
      } else if (!r.success && r.error) {
        sections.push(`### ${r.label}\n⚠️ ${r.error}\n`);
      }
    }

    return {
      success: true,
      data: results,
      display: sections.join('\n'),
    };
  }
}
