import type { SkillMetadata, SkillContext, SkillResult, AlfredConfig } from '@alfred/types';
import { Skill } from '../skill.js';
import type { SkillRegistry } from '../skill-registry.js';
import type { MemoryRepository } from '@alfred/storage';
import { allUserIds } from '../user-utils.js';

type BriefingAction = 'run' | 'modules';

interface BriefingModule {
  name: string;
  skill: string;
  input: Record<string, unknown>;
  label: string;
}

interface ModuleResult {
  module: string;
  label: string;
  success: boolean;
  data?: unknown;
  display?: string;
  error?: string;
}

const ALL_MODULES: BriefingModule[] = [
  { name: 'calendar',   skill: 'calendar',       input: { action: 'list_events' },              label: 'Kalender' },
  { name: 'weather',    skill: 'weather',         input: {},                                     label: 'Wetter' },
  { name: 'todo',       skill: 'todo',            input: { action: 'list' },                     label: 'Lokale Todos' },
  { name: 'mstodo',     skill: 'microsoft_todo',  input: { action: 'list_tasks' },               label: 'Microsoft To Do' },
  { name: 'email',      skill: 'email',           input: { action: 'inbox' },                    label: 'E-Mail' },
  { name: 'energy',     skill: 'energy_price',    input: { action: 'current' },                  label: 'Strompreise' },
  { name: 'bmw',        skill: 'bmw',             input: { action: 'status' },                   label: 'BMW Status' },
  { name: 'home',       skill: 'homeassistant',   input: { action: 'briefing_summary' },         label: 'Smart Home' },
  { name: 'infra',      skill: 'monitor',         input: {},                                     label: 'Infrastruktur' },
];

function isWeekday(): boolean {
  const day = new Date().getDay();
  return day >= 1 && day <= 5;
}

export class BriefingSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'briefing',
    category: 'productivity',
    description:
      'Tägliches Morgenbriefing — sammelt Daten aus mehreren Skills parallel und liefert ' +
      'ein strukturiertes Ergebnis: Kalender, Wetter, Todos, E-Mails, Strompreise, Auto-Status, Smart Home, Infrastruktur. ' +
      'Mo–Fr automatisch: Pendelzeit Heim→Büro + BMW-Akkucheck (wenn kein auswärtiger Termin). ' +
      '"run" führt das Briefing aus (optional mit location für Wetter). ' +
      '"modules" zeigt verfügbare und aktive Module.',
    riskLevel: 'read',
    version: '1.1.0',
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
    private readonly memoryRepo?: MemoryRepository,
  ) {
    super();
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = (input.action as BriefingAction | undefined) ?? 'run';

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

    const hasRouting = this.skillRegistry.has('routing');
    const configuredCommute = !!(this.alfredConfig.briefing?.homeAddress && this.alfredConfig.briefing?.officeAddress);

    return {
      success: true,
      data: {
        available: available.map(m => m.name),
        all: ALL_MODULES.map(m => m.name),
        commuteAvailable: hasRouting,
        commuteConfigured: configuredCommute,
      },
      display: `Briefing-Module:\n${allNames.join('\n')}\n\nPendler-Check (Mo–Fr): ${!hasRouting ? '❌ Routing-Skill nicht verfügbar' : configuredCommute ? '✅ konfiguriert (Config)' : '⏳ Adressen werden aus Memories gelesen (oder ALFRED_BRIEFING_HOME/OFFICE_ADDRESS setzen)'}`,
    };
  }

  private async runBriefing(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const { home } = this.resolveAddresses(context);
    const location = (input.location as string | undefined) ?? this.alfredConfig.briefing?.location ?? home ?? 'Vienna';
    const requestedModules = input.modules as string[] | undefined;

    let modules = this.getAvailableModules();
    if (requestedModules?.length) {
      modules = modules.filter(m => requestedModules.includes(m.name));
    }

    // Resolve HA briefing preferences from config + memories
    const haPrefs = this.resolveHaPreferences(context);

    // Build inputs with overrides
    const tasks = modules.map(m => {
      const moduleInput = { ...m.input };
      if (m.name === 'weather') moduleInput.location = location;
      if (m.name === 'home') {
        if (haPrefs.entities?.length) moduleInput.entities = haPrefs.entities;
        if (haPrefs.domains?.length) moduleInput.domains = haPrefs.domains;
      }
      return { module: m, input: moduleInput };
    });

    // Execute all modules in parallel
    const results = await Promise.all(
      tasks.map(t => this.executeModule(t.module, t.input, context)),
    );

    // Phase 2: Weekday commute check (Mon–Fri, needs home+office+routing)
    const commuteResult = await this.runCommuteCheck(results, context);
    if (commuteResult) {
      results.push(commuteResult);
    }

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

  private async executeModule(
    module: BriefingModule,
    moduleInput: Record<string, unknown>,
    context: SkillContext,
  ): Promise<ModuleResult> {
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
  }

  /**
   * Mo–Fr commute check: Route home → office + BMW battery assessment.
   * Addresses are resolved from user memories first, then config fallback.
   * Skipped if calendar shows an external appointment (location-based event).
   */
  private async runCommuteCheck(
    moduleResults: ModuleResult[],
    context: SkillContext,
  ): Promise<ModuleResult | null> {
    if (!isWeekday()) return null;
    if (!this.skillRegistry.has('routing')) return null;

    const { home: homeAddress, office: officeAddress } = this.resolveAddresses(context);
    if (!homeAddress || !officeAddress) return null;

    // Check calendar for external appointments (events with a location)
    const calendarResult = moduleResults.find(r => r.module === 'calendar');
    if (calendarResult?.success && calendarResult.data) {
      const hasExternalAppointment = this.detectExternalAppointment(calendarResult.data);
      if (hasExternalAppointment) return null;
    }

    // Parallel: routing + BMW status (if not already fetched)
    const commutePromises: Promise<ModuleResult>[] = [];

    // Route: home → office
    commutePromises.push(
      this.executeModule(
        { name: 'commute', skill: 'routing', input: {}, label: 'Pendelzeit' },
        { action: 'route', origin: homeAddress, destination: officeAddress },
        context,
      ),
    );

    const results = await Promise.all(commutePromises);
    const routeResult = results[0];

    // Combine routing + BMW data into commute summary
    const bmwResult = moduleResults.find(r => r.module === 'bmw');
    const lines: string[] = [];

    if (routeResult.success && routeResult.display) {
      lines.push(`**Route Heim → Büro:**\n${routeResult.display}`);
    } else if (routeResult.error) {
      lines.push(`**Route:** ⚠️ ${routeResult.error}`);
    }

    if (bmwResult?.success && bmwResult.data) {
      const battery = this.extractBatteryLevel(bmwResult.data);
      if (battery != null && battery < 30) {
        lines.push(`\n⚠️ **BMW Akku niedrig (${battery}%)** — Laden vor der Fahrt empfohlen!`);
      } else if (battery != null) {
        lines.push(`\n🔋 BMW Akku: ${battery}% — ausreichend für den Arbeitsweg`);
      }
    }

    if (lines.length === 0) return null;

    return {
      module: 'commute',
      label: 'Arbeitsweg (Mo–Fr)',
      success: true,
      data: { route: routeResult.data, bmwBattery: this.extractBatteryLevel(bmwResult?.data) },
      display: lines.join('\n'),
    };
  }

  /**
   * Resolve home and office addresses: memories first, config fallback.
   * Searches for keys like "heimadresse", "home_address", "wohnadresse",
   * "büroadresse", "office_address", "arbeit_adresse" etc.
   */
  private resolveAddresses(context: SkillContext): { home: string | undefined; office: string | undefined } {
    const configHome = this.alfredConfig.briefing?.homeAddress;
    const configOffice = this.alfredConfig.briefing?.officeAddress;

    if (!this.memoryRepo) return { home: configHome, office: configOffice };

    let home = configHome;
    let office = configOffice;

    // Search memories for addresses across all linked user IDs
    for (const uid of allUserIds(context)) {
      const memories = this.memoryRepo.search(uid, 'adresse');
      for (const m of memories) {
        const key = m.key.toLowerCase();
        const val = m.value;
        if (!home && /heim|home|wohn|zuhause|privat/.test(key)) {
          home = val;
        }
        if (!office && /büro|office|arbeit|firma|work/.test(key)) {
          office = val;
        }
      }
      if (home && office) break;
    }

    return { home, office };
  }

  /**
   * Resolve HA briefing preferences: config first, then memories.
   * Users can store preferences like "briefing_ha_entities" = "sensor.victron_soc, sensor.power"
   * or "briefing_ha_domains" = "binary_sensor, light, climate".
   */
  private resolveHaPreferences(context: SkillContext): { entities?: string[]; domains?: string[] } {
    const configEntities = this.alfredConfig.briefing?.homeAssistant?.entities;
    const configDomains = this.alfredConfig.briefing?.homeAssistant?.domains;

    if (configEntities?.length || configDomains?.length) {
      return { entities: configEntities, domains: configDomains };
    }

    if (!this.memoryRepo) return {};

    // Search memories for HA briefing preferences
    for (const uid of allUserIds(context)) {
      const memories = this.memoryRepo.search(uid, 'briefing');
      for (const m of memories) {
        const key = m.key.toLowerCase();
        if (/ha_entit|home.?assistant.*entit|briefing.*entit/.test(key)) {
          const entities = m.value.split(/[,;]\s*/).map(e => e.trim()).filter(Boolean);
          if (entities.length) return { entities };
        }
        if (/ha_domain|home.?assistant.*domain|briefing.*domain/.test(key)) {
          const domains = m.value.split(/[,;]\s*/).map(d => d.trim()).filter(Boolean);
          if (domains.length) return { domains };
        }
      }
    }

    return {};
  }

  /**
   * Check if any calendar event has a physical location (= external appointment).
   */
  private detectExternalAppointment(calendarData: unknown): boolean {
    if (!Array.isArray(calendarData)) return false;
    return calendarData.some((event: any) => {
      const loc = event.location ?? event.loc ?? '';
      // Ignore virtual meetings (Teams, Zoom, Google Meet, etc.)
      if (!loc || typeof loc !== 'string') return false;
      if (/teams|zoom|meet\.google|webex|skype/i.test(loc)) return false;
      return loc.trim().length > 0;
    });
  }

  /**
   * Extract battery/SoC percentage from BMW status data.
   */
  private extractBatteryLevel(bmwData: unknown): number | null {
    if (!bmwData || typeof bmwData !== 'object') return null;
    const data = bmwData as Record<string, unknown>;
    // BMW skill returns various formats
    const soc = data.chargingLevelPercent ?? data.batterySoc ?? data.soc
      ?? (data as any).chargingState?.chargingLevelPercent;
    if (typeof soc === 'number') return soc;
    if (typeof soc === 'string') {
      const parsed = parseFloat(soc);
      return isNaN(parsed) ? null : parsed;
    }
    return null;
  }
}
