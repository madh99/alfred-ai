import type { LLMProvider } from '@alfred/llm';
import type { SkillRegistry } from '@alfred/skills';
import type { Logger } from 'pino';
import type { WorkflowStep, WorkflowGuard } from '@alfred/types';

interface ParsedWorkflow {
  name: string;
  description: string;
  triggerType: string;
  triggerConfig?: Record<string, unknown>;
  guards?: WorkflowGuard[];
  steps: WorkflowStep[];
}

export class PromptParser {
  constructor(
    private readonly llm: LLMProvider,
    private readonly skillRegistry: SkillRegistry,
    private readonly logger: Logger,
  ) {}

  async parse(userPrompt: string): Promise<ParsedWorkflow | null> {
    const skills: string[] = [];
    for (const skill of this.skillRegistry.getAll()) {
      const name = skill.metadata.name;
      const schema = skill.metadata.inputSchema as any;
      const actions = schema?.properties?.action?.enum;
      skills.push(`- ${name}: ${(skill.metadata.description ?? '').slice(0, 80)}${actions ? ` [${actions.join(', ')}]` : ''}`);
    }

    const response = await this.llm.complete({
      messages: [{
        role: 'user',
        content: `Erstelle einen Workflow aus dieser Beschreibung:

"${userPrompt}"

Verfuegbare Skills (als Workflow-Steps nutzbar):
${skills.join('\n')}

Antworte NUR mit validem JSON:
{
  "name": "kurzer-kebab-name",
  "description": "Was der Workflow macht",
  "triggerType": "interval|cron|webhook|watch|manual",
  "triggerConfig": { "value": "15" },
  "guards": [{"type":"time_window","value":"22:00-06:00"}],
  "steps": [
    { "type": "action", "skillName": "energy_price", "inputMapping": {"action":"current"}, "onError": "skip" },
    { "type": "condition", "condition": {"field":"steps.0.price_gross","operator":"lt","value":15}, "then": 2, "else": "end" },
    { "type": "action", "skillName": "goe_charger", "inputMapping": {"action":"start_charging"}, "onError": "stop" }
  ]
}

Regeln:
- NUR Skills aus der Liste oben verwenden
- triggerType: cron (zeitbasiert), interval (alle N Minuten), webhook (extern), watch (Event), manual
- Guards optional: time_window "HH:MM-HH:MM", weekday "mon,tue,...", skill_condition
- Steps: type "action" (Skill ausfuehren), "condition" (if/else), "script" (Code), "db_query" (SQL)
- Referenzen: {{steps.N.field}} oder {{prev.field}}
- onError: stop | skip | retry`,
      }],
      system: 'Du bist ein Workflow-Builder. Antworte ausschliesslich mit validem JSON. Keine Erklaerungen.',
      maxTokens: 1024,
      tier: 'default',
    });

    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { this.logger.warn('PromptParser: no JSON in LLM response'); return null; }
      const parsed = JSON.parse(jsonMatch[0]) as ParsedWorkflow;

      // Validate: all action skillNames must exist
      for (const step of parsed.steps) {
        if ((step as any).type === 'action' || !(step as any).type) {
          const skillName = (step as any).skillName;
          if (skillName && !this.skillRegistry.has(skillName)) {
            this.logger.warn({ skillName }, 'PromptParser: unknown skill in workflow');
            return null;
          }
        }
      }

      if (!parsed.name || !parsed.steps || parsed.steps.length === 0) {
        this.logger.warn('PromptParser: incomplete workflow');
        return null;
      }

      return parsed;
    } catch (err) {
      this.logger.warn({ err }, 'PromptParser: JSON parse failed');
      return null;
    }
  }
}
