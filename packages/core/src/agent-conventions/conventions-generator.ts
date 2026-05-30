/**
 * v824 — ConventionsGenerator.
 *
 * Nimmt einen RepoScanner-Output und ruft einen LLM auf der eine kuratierte
 * CLAUDE.md generiert. Tier konfigurierbar (`strong` default für Generate).
 *
 * Output: Markdown-Body MIT YAML-Frontmatter. Frontmatter erlaubt späteres
 * Erkennen ob das File von Alfred verwaltet ist.
 *
 * Mistral + andere Provider: läuft transparent via Tier-System.
 * Quorum-Mode (Phase 4.4) ist über `generateMode` erreichbar.
 *
 * Side-Effect-Notiz: nur LLM-Call. Schreibt nichts ins Filesystem.
 */

import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { LLMProvider } from '@alfred/llm';
import type {
  NeutralConventions,
  ConventionsLanguage,
  ConventionsScanSnapshot,
  ConventionsSection,
  ConventionsGenerateMode,
} from '@alfred/types';

export interface GenerateOptions {
  cwd: string;
  llmContext: string;
  scanSnapshot: ConventionsScanSnapshot;
  scanHash: string;
  language: ConventionsLanguage;
  generateMode: ConventionsGenerateMode;
  tier: 'fast' | 'default' | 'strong';
  /** Vorhandene Conventions (für Refresh-Modus). */
  existingContent?: string;
  /** Phase 3.6: Skill-Contributions zum Anreichern. */
  skillContributions?: Array<{ skill: string; markdown: string; section: ConventionsSection }>;
  /** Phase 3.3: Cross-Project-Patterns die matchen. */
  patternSuggestions?: Array<{ patternText: string; section: ConventionsSection; confidence: number }>;
}

export interface GenerateOutput {
  ok: boolean;
  markdown?: string;
  neutralFormat?: NeutralConventions;
  scanHash: string;
  contentHash?: string;
  warnings: string[];
  costUsd: number;
  reason?: string;
}

const SECTION_ORDER: ConventionsSection[] = ['stack', 'commands', 'testSetup', 'architecture', 'style', 'gotchas', 'doNotTouch'];

const SECTION_LABELS_DE: Record<ConventionsSection, string> = {
  stack: 'Stack & Setup',
  commands: 'Build/Test/Dev Commands',
  testSetup: 'Test-Setup-Eigenheiten',
  architecture: 'Architektur',
  style: 'Code-Style & Konventionen',
  gotchas: 'Gotchas & Bekannte Stolperfallen',
  doNotTouch: 'Do-Not-Touch',
};

const SECTION_LABELS_EN: Record<ConventionsSection, string> = {
  stack: 'Stack & Setup',
  commands: 'Build/Test/Dev Commands',
  testSetup: 'Test-Setup Quirks',
  architecture: 'Architecture',
  style: 'Code Style & Conventions',
  gotchas: 'Gotchas & Known Pitfalls',
  doNotTouch: 'Do Not Touch',
};

export class ConventionsGenerator {
  constructor(
    private readonly llm: LLMProvider,
    private readonly logger: Logger,
  ) {}

  async generate(opts: GenerateOptions): Promise<GenerateOutput> {
    const warnings: string[] = [];

    if (opts.generateMode === 'single' || opts.generateMode === 'quorum-first-time') {
      return this.generateSingle(opts, warnings);
    }

    // Quorum-Modes (Phase 4.4): mehrere LLM-Calls + Judge.
    // Default-Implementation für jetzt: single. Quorum kommt voll in v827/v828.
    warnings.push(`generateMode '${opts.generateMode}' not yet implemented — falling back to single`);
    return this.generateSingle(opts, warnings);
  }

  private async generateSingle(opts: GenerateOptions, warnings: string[]): Promise<GenerateOutput> {
    const systemPrompt = this.buildSystemPrompt(opts.language);
    const userPrompt = this.buildUserPrompt(opts);

    let costUsd = 0;
    try {
      const startTime = Date.now();
      const res = await this.llm.complete({
        messages: [{ role: 'user', content: userPrompt }],
        system: systemPrompt,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tier: opts.tier as any,
        maxTokens: 3000,
        temperature: 0.3,
      });
      // LLMUsage shape variiert pro provider — best-effort cost-extract
      const usage = res.usage as { costUsd?: number; cost?: number } | undefined;
      costUsd = usage?.costUsd ?? usage?.cost ?? 0;
      const durationMs = Date.now() - startTime;
      this.logger.info({
        cwd: opts.cwd,
        tier: opts.tier,
        language: opts.language,
        durationMs,
        outputChars: res.content.length,
        costUsd,
      }, 'v824 ConventionsGenerator LLM-call complete');

      const cleaned = this.extractMarkdown(res.content);
      if (!cleaned || cleaned.length < 50) {
        return {
          ok: false,
          warnings,
          scanHash: opts.scanHash,
          costUsd,
          reason: 'LLM returned empty or too-short content',
        };
      }

      const markdown = this.wrapWithFrontmatter(cleaned, opts);
      const neutralFormat = this.parseToNeutralFormat(cleaned, opts);
      const contentHash = createHash('sha256').update(markdown).digest('hex').slice(0, 16);

      return {
        ok: true,
        markdown,
        neutralFormat,
        scanHash: opts.scanHash,
        contentHash,
        warnings,
        costUsd,
      };
    } catch (err) {
      this.logger.warn({ err, cwd: opts.cwd }, 'v824 ConventionsGenerator failed');
      return {
        ok: false,
        warnings,
        scanHash: opts.scanHash,
        costUsd,
        reason: (err as Error).message,
      };
    }
  }

  private buildSystemPrompt(lang: ConventionsLanguage): string {
    if (lang === 'de') {
      return `Du bist Senior-Engineer der für eine neue Person/AI eine CLAUDE.md schreibt. Diese Datei wird beim Start jeder Coding-Session vom Agent automatisch gelesen.

WICHTIGE REGELN:
- Schreibe NUR projekt-spezifische Konventionen, KEINE Generika wie "schreibe sauberen Code"
- Pro Sektion lieber 0 Zeilen als generische Worthülsen
- Maximale Gesamtlänge 200 Zeilen
- Bei Unsicherheit: SKIP die Sektion, halluziniere nicht
- Schreibe in der "du"-Form, direkt an den Agent gerichtet
- Bei genauen Befehlen: exakte Strings, nicht "üblicherweise..."
- Markdown-Output, keine Erklärung drumherum

ZIELSEKTIONEN (in dieser Reihenfolge, einige weglassen wenn nicht relevant):
1. Stack & Setup
2. Build/Test/Dev Commands
3. Test-Setup-Eigenheiten (in-memory vs real DB? Setup-Files die mit-aktualisiert werden müssen?)
4. Architektur (Layer/Module + ihre Beziehungen)
5. Code-Style (nur was NICHT aus Linter ableitbar)
6. Gotchas & Bekannte Stolperfallen (das wichtigste! Aus README/docs/Churn extrahieren)
7. Do-Not-Touch (Files die ohne Plan nicht angefasst werden sollen)

Antworte NUR mit dem reinen Markdown der CLAUDE.md (keine Vorrede, kein YAML).`;
    }
    return `You are a senior engineer writing a CLAUDE.md for a new team member / AI agent. This file will be auto-loaded by the coding agent at the start of every session.

IMPORTANT RULES:
- Write ONLY project-specific conventions, NO generic advice like "write clean code"
- Per section prefer 0 lines over generic statements
- Maximum total length 200 lines
- When uncertain: SKIP the section, do not hallucinate
- Write in second-person ("you"), directly addressing the agent
- For commands: exact strings, not "usually..."
- Markdown output only, no surrounding explanation

TARGET SECTIONS (in this order, skip what's not relevant):
1. Stack & Setup
2. Build/Test/Dev Commands
3. Test-Setup Quirks (in-memory vs real DB? Setup-files that must be co-maintained?)
4. Architecture (layers/modules and their relationships)
5. Code Style (only what's not derivable from linter config)
6. Gotchas & Known Pitfalls (most important! extract from README/docs/churn)
7. Do Not Touch (files that should not be modified without a plan)

Reply ONLY with the raw CLAUDE.md markdown (no preamble, no YAML).`;
  }

  private buildUserPrompt(opts: GenerateOptions): string {
    const lang = opts.language;
    const parts: string[] = [];
    parts.push(lang === 'de' ? 'Repo-Scan:' : 'Repo Scan:');
    parts.push(opts.llmContext);

    if (opts.skillContributions && opts.skillContributions.length > 0) {
      parts.push('');
      parts.push(lang === 'de' ? '## Skill-Contributions (relevante Konventionen aus aktiven Skills)' : '## Skill Contributions');
      for (const c of opts.skillContributions) {
        parts.push(`### Skill: ${c.skill} (Section: ${c.section})`);
        parts.push(c.markdown.slice(0, 1500));
      }
    }

    if (opts.patternSuggestions && opts.patternSuggestions.length > 0) {
      parts.push('');
      parts.push(lang === 'de' ? '## Cross-Project-Patterns (aus anderen ähnlichen Projekten gelernt)' : '## Cross-Project Patterns');
      for (const p of opts.patternSuggestions) {
        parts.push(`- (${p.section}, conf=${p.confidence.toFixed(2)}) ${p.patternText}`);
      }
    }

    if (opts.existingContent) {
      parts.push('');
      parts.push(lang === 'de' ? '## Bestehende CLAUDE.md (Refresh-Kontext)' : '## Existing CLAUDE.md (refresh context)');
      parts.push('```markdown');
      parts.push(opts.existingContent.slice(0, 6000));
      parts.push('```');
      parts.push(lang === 'de'
        ? 'Behalte was noch stimmt, update was sich geändert hat, ergänze fehlende wichtige Konventionen.'
        : 'Keep what still applies, update what has changed, add missing important conventions.');
    }

    parts.push('');
    parts.push(lang === 'de'
      ? 'Schreibe jetzt die CLAUDE.md. Reine Markdown, keine Vorrede.'
      : 'Now write the CLAUDE.md. Raw markdown, no preamble.');

    return parts.join('\n');
  }

  private extractMarkdown(content: string): string {
    let s = content.trim();
    // Strip outer ```markdown ... ``` blocks if LLM wrapped it
    const blockMatch = s.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
    if (blockMatch) s = blockMatch[1].trim();
    // Strip leading frontmatter that might be already there (we'll add our own)
    if (s.startsWith('---')) {
      const endMarker = s.indexOf('\n---', 3);
      if (endMarker > 0) s = s.slice(endMarker + 4).trim();
    }
    return s;
  }

  private wrapWithFrontmatter(markdown: string, opts: GenerateOptions): string {
    const frontmatter = [
      '---',
      'generated_by: alfred-agent-conventions',
      `generated_at: ${new Date().toISOString()}`,
      `scan_hash: ${opts.scanHash}`,
      `language: ${opts.language}`,
      `framework: ${opts.scanSnapshot.framework ?? 'unknown'}`,
      'review_status: draft',
      'lessons_count: 0',
      '---',
      '',
    ].join('\n');
    return frontmatter + markdown.trim() + '\n';
  }

  private parseToNeutralFormat(markdown: string, opts: GenerateOptions): NeutralConventions {
    const sections: Partial<Record<ConventionsSection, string>> = {};
    const labels = opts.language === 'de' ? SECTION_LABELS_DE : SECTION_LABELS_EN;
    const lines = markdown.split('\n');
    let currentSection: ConventionsSection | null = null;
    let buffer: string[] = [];

    const flushSection = () => {
      if (currentSection && buffer.length > 0) {
        const text = buffer.join('\n').trim();
        if (text) sections[currentSection] = text;
      }
      buffer = [];
    };

    for (const line of lines) {
      const headingMatch = line.match(/^##\s+(.+?)\s*$/);
      if (headingMatch) {
        flushSection();
        const heading = headingMatch[1].trim();
        // Match section by label or keyword
        let matched: ConventionsSection | null = null;
        for (const sec of SECTION_ORDER) {
          if (heading.toLowerCase().includes(labels[sec].split(' ')[0].toLowerCase())) {
            matched = sec;
            break;
          }
        }
        if (!matched) {
          // Heuristic fallback
          const lower = heading.toLowerCase();
          if (lower.includes('gotcha') || lower.includes('stolper') || lower.includes('pitfall')) matched = 'gotchas';
          else if (lower.includes('test')) matched = 'testSetup';
          else if (lower.includes('command') || lower.includes('build')) matched = 'commands';
          else if (lower.includes('arch')) matched = 'architecture';
          else if (lower.includes('style')) matched = 'style';
          else if (lower.includes('touch') || lower.includes('not modify')) matched = 'doNotTouch';
          else if (lower.includes('stack') || lower.includes('setup')) matched = 'stack';
        }
        currentSection = matched;
      } else if (currentSection) {
        buffer.push(line);
      }
    }
    flushSection();

    return {
      meta: {
        version: '1',
        generatedAt: new Date().toISOString(),
        scanHash: opts.scanHash,
        lessonsCount: 0,
        language: opts.language,
      },
      sections,
      lessons: [],
    };
  }
}
