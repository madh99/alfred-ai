import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';

/**
 * Onboarding Skill — interactive first-run setup.
 * Guides the user through initial configuration by asking questions one at a time
 * and storing answers as structured memories.
 *
 * Designed to be called by the LLM when it detects a new user without memories,
 * or manually via "einrichten" / "setup" / "onboarding".
 */
export class OnboardingSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'onboarding',
    category: 'core',
    description:
      'Geführte Ersteinrichtung für neue Benutzer. Fragt Name, Wohnort, Familie, Arbeitgeber und bevorzugte Services ab. ' +
      '"start" beginnt die Einrichtung. "step" beantwortet eine Frage (step_id + answer). ' +
      '"status" zeigt den Fortschritt. "skip" überspringt einen Schritt. ' +
      'Sollte automatisch aufgerufen werden wenn ein neuer User keine Memories hat.',
    riskLevel: 'read',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'step', 'status', 'skip'], description: 'Onboarding action' },
        step_id: { type: 'string', description: 'Aktuelle Schritt-ID (für step/skip)' },
        answer: { type: 'string', description: 'Antwort des Users (für step)' },
      },
      required: ['action'],
    },
  };

  private memoryCallback?: (key: string, value: string, type: string, category: string) => Promise<void>;

  setMemoryCallback(cb: (key: string, value: string, type: string, category: string) => Promise<void>): void {
    this.memoryCallback = cb;
  }

  private readonly steps = [
    { id: 'name', question: 'Wie heißt du? (Vor- und Nachname)', memoryKey: 'user_full_name', type: 'entity', category: 'general' },
    { id: 'location', question: 'Wo wohnst du? (Ort und optional Adresse)', memoryKey: 'home_address', type: 'fact', category: 'general' },
    { id: 'employer', question: 'Wo arbeitest du? (Firma und optional Position)', memoryKey: 'current_employment', type: 'entity', category: 'general' },
    { id: 'spouse', question: 'Hast du einen Partner/Ehepartner? (Name oder "nein")', memoryKey: 'spouse_full_name', type: 'entity', category: 'general' },
    { id: 'children', question: 'Hast du Kinder? (Namen, kommagetrennt, oder "nein")', memoryKey: 'children_names', type: 'entity', category: 'general' },
    { id: 'language', question: 'In welcher Sprache soll ich antworten? (z.B. Deutsch, English)', memoryKey: 'preferred_language', type: 'fact', category: 'general' },
  ];

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    const action = input.action as string;

    switch (action) {
      case 'start': return this.start();
      case 'step': return this.handleStep(input.step_id as string, input.answer as string);
      case 'status': return this.getStatus();
      case 'skip': return this.skipStep(input.step_id as string);
      default: return { success: false, error: `Unknown action "${action}"` };
    }
  }

  private start(): SkillResult {
    const firstStep = this.steps[0];
    return {
      success: true,
      data: { step_id: firstStep.id, total_steps: this.steps.length, current_step: 1 },
      display: [
        '## Willkommen bei Alfred! 👋',
        '',
        'Ich stelle dir ein paar kurze Fragen um dich kennenzulernen.',
        'Du kannst jede Frage überspringen.',
        '',
        `**Frage 1/${this.steps.length}:** ${firstStep.question}`,
      ].join('\n'),
    };
  }

  private async handleStep(stepId: string, answer: string): Promise<SkillResult> {
    if (!stepId || !answer) return { success: false, error: 'Missing step_id or answer' };

    const stepIndex = this.steps.findIndex(s => s.id === stepId);
    if (stepIndex < 0) return { success: false, error: `Unknown step "${stepId}"` };

    const step = this.steps[stepIndex];

    // Save answer as memory
    if (answer.toLowerCase() !== 'nein' && answer.toLowerCase() !== 'skip' && answer.trim().length > 0) {
      if (step.id === 'children' && answer.includes(',')) {
        // Multiple children — save each separately
        const names = answer.split(',').map(n => n.trim()).filter(Boolean);
        for (let i = 0; i < names.length; i++) {
          const childKey = `child_${names[i].toLowerCase().split(' ')[0]}_full_name`;
          await this.memoryCallback?.(childKey, names[i], 'entity', 'general');
        }
      } else {
        await this.memoryCallback?.(step.memoryKey, answer, step.type, step.category);
      }
    }

    // Next step
    const nextIndex = stepIndex + 1;
    if (nextIndex >= this.steps.length) {
      return {
        success: true,
        data: { completed: true },
        display: [
          '## Einrichtung abgeschlossen! ✅',
          '',
          'Ich habe mir alles gemerkt. Du kannst jederzeit Informationen ändern mit "merke dir..." oder "vergiss...".',
          '',
          'Wie kann ich dir helfen?',
        ].join('\n'),
      };
    }

    const nextStep = this.steps[nextIndex];
    return {
      success: true,
      data: { step_id: nextStep.id, total_steps: this.steps.length, current_step: nextIndex + 1, saved: step.id },
      display: `✅ Gespeichert.\n\n**Frage ${nextIndex + 1}/${this.steps.length}:** ${nextStep.question}`,
    };
  }

  private skipStep(stepId: string): SkillResult {
    const stepIndex = this.steps.findIndex(s => s.id === stepId);
    if (stepIndex < 0) return { success: false, error: `Unknown step "${stepId}"` };

    const nextIndex = stepIndex + 1;
    if (nextIndex >= this.steps.length) {
      return { success: true, data: { completed: true }, display: '## Einrichtung abgeschlossen! ✅\n\nWie kann ich dir helfen?' };
    }

    const nextStep = this.steps[nextIndex];
    return {
      success: true,
      data: { step_id: nextStep.id, total_steps: this.steps.length, current_step: nextIndex + 1 },
      display: `⏭️ Übersprungen.\n\n**Frage ${nextIndex + 1}/${this.steps.length}:** ${nextStep.question}`,
    };
  }

  private getStatus(): SkillResult {
    return {
      success: true,
      display: [
        '## Onboarding-Schritte',
        '',
        ...this.steps.map((s, i) => `${i + 1}. **${s.id}**: ${s.question}`),
      ].join('\n'),
    };
  }
}
