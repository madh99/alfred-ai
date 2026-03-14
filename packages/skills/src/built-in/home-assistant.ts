import type { SkillMetadata, SkillContext, SkillResult, HomeAssistantConfig } from '@alfred/types';
import { Skill } from '../skill.js';

type Action =
  | 'states'
  | 'state'
  | 'turn_on'
  | 'turn_off'
  | 'toggle'
  | 'call_service'
  | 'services'
  | 'history'
  | 'logbook'
  | 'config'
  | 'areas'
  | 'template'
  | 'presence'
  | 'notify'
  | 'activate_scene'
  | 'trigger_automation'
  | 'run_script'
  | 'calendar_events'
  | 'error_log'
  | 'create_automation'
  | 'delete_automation'
  | 'create_script'
  | 'delete_script'
  | 'create_scene'
  | 'delete_scene'
  | 'briefing_summary'
  | 'energy_stats';

function parsePeriod(period: string): string {
  const m = period.match(/^(\d+)\s*(h|d|m|w)$/i);
  if (!m) return new Date(Date.now() - 3600_000).toISOString();
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const ms = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit] ?? 3_600_000;
  return new Date(Date.now() - n * ms).toISOString();
}

function extractDomain(entityId: string): string {
  const dot = entityId.indexOf('.');
  if (dot < 1) throw new Error(`Invalid entity_id "${entityId}" — expected format "domain.name"`);
  return entityId.slice(0, dot);
}

export class HomeAssistantSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'homeassistant',
    category: 'infrastructure',
    description:
      'Control Home Assistant smart home devices. ' +
      'Use "states" to list entities, "turn_on"/"turn_off"/"toggle" to control devices, ' +
      '"call_service" for advanced service calls, "history" for entity state history. ' +
      'Also: "areas" for rooms/zones, "presence" for who is home, "activate_scene"/"trigger_automation"/"run_script" ' +
      'for automations, "notify" for notifications, "calendar_events" for calendars, "template" for Jinja2 queries, "error_log" for HA logs. ' +
      'Config API: "create_automation"/"delete_automation", "create_script"/"delete_script", "create_scene"/"delete_scene" — ' +
      'create persistent automations, scripts, and scenes in HA. Use configData (JSON) with the HA automation/script/scene schema. ' +
      '"briefing_summary" for a compact smart home overview (open contacts, lights on, battery/SoC, energy, climate, presence). ' +
      'Optionally pass entities[] or domains[] to filter. ' +
      '"energy_stats" for energy consumption statistics over a period (today, yesterday, last_week, etc.) — auto-discovers all energy sensors and calculates kWh consumed.',
    riskLevel: 'write',
    version: '2.1.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'states',
            'state',
            'turn_on',
            'turn_off',
            'toggle',
            'call_service',
            'services',
            'history',
            'logbook',
            'config',
            'areas',
            'template',
            'presence',
            'notify',
            'activate_scene',
            'trigger_automation',
            'run_script',
            'calendar_events',
            'error_log',
            'create_automation',
            'delete_automation',
            'create_script',
            'delete_script',
            'create_scene',
            'delete_scene',
            'briefing_summary',
            'energy_stats',
          ],
          description: 'The Home Assistant action to perform',
        },
        entityId: {
          type: 'string',
          description: 'Entity ID, e.g. light.wohnzimmer, switch.garage, sensor.temperature',
        },
        domain: {
          type: 'string',
          description: 'Domain filter for "states" (e.g. light, sensor, switch) or domain for "call_service"',
        },
        service: {
          type: 'string',
          description: 'Service name for "call_service", e.g. set_temperature, set_hvac_mode',
        },
        serviceData: {
          type: 'string',
          description: 'JSON string with service parameters, e.g. {"brightness": 200, "color_name": "red"}',
        },
        period: {
          type: 'string',
          description: 'Time period for history/logbook/energy_stats. Formats: "1h", "24h", "7d" or friendly names "today", "yesterday", "this_week", "last_week", "this_month", "last_month" (default for energy_stats: "today")',
        },
        area: {
          type: 'string',
          description: 'Area name or ID (for areas action)',
        },
        template: {
          type: 'string',
          description: 'Jinja2 template string (for template action)',
        },
        target: {
          type: 'string',
          description: 'Notification target (for notify action, e.g. mobile_app_pixel)',
        },
        message: {
          type: 'string',
          description: 'Notification message (for notify action)',
        },
        title: {
          type: 'string',
          description: 'Optional title (for notify action)',
        },
        startTime: {
          type: 'string',
          description: 'ISO datetime start (for calendar_events, default: now)',
        },
        endTime: {
          type: 'string',
          description: 'ISO datetime end (for calendar_events, default: +24h)',
        },
        subAction: {
          type: 'string',
          enum: ['trigger', 'enable', 'disable'],
          description: 'Sub-action for trigger_automation',
        },
        variables: {
          type: 'string',
          description: 'JSON string with script variables (for run_script)',
        },
        configId: {
          type: 'string',
          description: 'Unique ID for create/delete automation, script, or scene (e.g. "notify_garage_light"). Used as the HA config entry ID.',
        },
        configData: {
          type: 'string',
          description: 'JSON string with the HA config object for create actions. For automations: {alias, description, trigger[], condition[], action[], mode}. For scripts: {alias, sequence[], mode}. For scenes: {name, entities: {entity_id: state}}.',
        },
        entities: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific entity IDs for briefing_summary (e.g. ["sensor.victron_soc", "sensor.power_consumption"])',
        },
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Domain filters for briefing_summary (e.g. ["binary_sensor", "light", "climate"])',
        },
      },
      required: ['action'],
    },
  };

  private readonly config: HomeAssistantConfig;

  constructor(config: HomeAssistantConfig) {
    super();
    this.config = config;
  }

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    const action = input.action as Action | undefined;
    if (!action) {
      return { success: false, error: 'Missing required field "action"' };
    }

    try {
      switch (action) {
        case 'states':
          return await this.getStates(input.domain as string | undefined);
        case 'state':
          return await this.getState(input.entityId as string | undefined);
        case 'turn_on':
          return await this.switchAction('turn_on', input.entityId as string | undefined, input.serviceData as string | undefined);
        case 'turn_off':
          return await this.switchAction('turn_off', input.entityId as string | undefined, input.serviceData as string | undefined);
        case 'toggle':
          return await this.switchAction('toggle', input.entityId as string | undefined, input.serviceData as string | undefined);
        case 'call_service':
          return await this.callService(
            input.domain as string | undefined,
            input.service as string | undefined,
            input.entityId as string | undefined,
            input.serviceData as string | undefined,
          );
        case 'services':
          return await this.getServices();
        case 'history':
          return await this.getHistory(
            input.entityId as string | undefined,
            input.period as string | undefined,
          );
        case 'logbook':
          return await this.getLogbook(
            input.entityId as string | undefined,
            input.period as string | undefined,
          );
        case 'config':
          return await this.getConfig();
        case 'areas':
          return await this.getAreas(input.area as string | undefined);
        case 'template':
          return await this.renderTemplate(input.template as string | undefined);
        case 'presence':
          return await this.getPresence();
        case 'notify':
          return await this.sendNotification(
            input.message as string | undefined,
            input.title as string | undefined,
            input.target as string | undefined,
          );
        case 'activate_scene':
          return await this.activateScene(input.entityId as string | undefined);
        case 'trigger_automation':
          return await this.triggerAutomation(
            input.entityId as string | undefined,
            input.subAction as string | undefined,
          );
        case 'run_script':
          return await this.runScript(
            input.entityId as string | undefined,
            input.variables as string | undefined,
          );
        case 'calendar_events':
          return await this.getCalendarEvents(
            input.entityId as string | undefined,
            input.startTime as string | undefined,
            input.endTime as string | undefined,
          );
        case 'error_log':
          return await this.getErrorLog();
        case 'create_automation':
          return await this.createConfig('automation', input.configId as string | undefined, input.configData as string | undefined);
        case 'delete_automation':
          return await this.deleteConfig('automation', input.configId as string | undefined);
        case 'create_script':
          return await this.createConfig('script', input.configId as string | undefined, input.configData as string | undefined);
        case 'delete_script':
          return await this.deleteConfig('script', input.configId as string | undefined);
        case 'create_scene':
          return await this.createConfig('scene', input.configId as string | undefined, input.configData as string | undefined);
        case 'delete_scene':
          return await this.deleteConfig('scene', input.configId as string | undefined);
        case 'briefing_summary':
          return await this.getBriefingSummary(
            input.entities as string[] | undefined,
            input.domains as string[] | undefined,
          );
        case 'energy_stats':
          return await this.getEnergyStats(
            input.period as string | undefined,
            input.entityId as string | undefined,
          );
        default:
          return { success: false, error: `Unknown action "${action as string}"` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `Home Assistant API error: ${msg}. Check baseUrl and connectivity.`,
      };
    }
  }

  // ── HTTP helper ──────────────────────────────────────────────

  private async api<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.accessToken}`,
      'Content-Type': 'application/json',
    };

    const fetchOpts: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(15_000),
    };

    if (body && method !== 'GET') {
      fetchOpts.body = JSON.stringify(body);
    }

    const skipTls = this.config.verifyTls === false;
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    if (skipTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    let res: Response;
    try {
      res = await fetch(url, fetchOpts);
    } finally {
      if (skipTls) {
        if (prev === undefined) {
          delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        } else {
          process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
        }
      }
    }

    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 500);
      } catch { /* ignore */ }
      throw new Error(`HTTP ${res.status} ${res.statusText} — ${detail}`);
    }

    return (await res.json()) as T;
  }

  private async apiText(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<string> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.accessToken}`,
      'Content-Type': 'application/json',
    };

    const fetchOpts: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(15_000),
    };

    if (body && method !== 'GET') {
      fetchOpts.body = JSON.stringify(body);
    }

    const skipTls = this.config.verifyTls === false;
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    if (skipTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    let res: Response;
    try {
      res = await fetch(url, fetchOpts);
    } finally {
      if (skipTls) {
        if (prev === undefined) {
          delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        } else {
          process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
        }
      }
    }

    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 500);
      } catch { /* ignore */ }
      throw new Error(`HTTP ${res.status} ${res.statusText} — ${detail}`);
    }

    return await res.text();
  }

  // ── READ actions ─────────────────────────────────────────────

  private async getStates(domain?: string): Promise<SkillResult> {
    let data = await this.api<any[]>('GET', '/api/states');

    if (domain) {
      data = data.filter((e) => e.entity_id.startsWith(`${domain}.`));
    }

    const lines = [
      `## Entities${domain ? ` (${domain})` : ''}`,
      '',
      '| Entity ID | State | Name | Unit |',
      '|-----------|-------|------|------|',
    ];

    for (const entity of data) {
      const name = entity.attributes?.friendly_name ?? '-';
      const unit = entity.attributes?.unit_of_measurement ?? '-';
      lines.push(`| ${entity.entity_id} | ${entity.state} | ${name} | ${unit} |`);
    }

    if (data.length === 0) {
      lines.push(`| - | No entities found${domain ? ` for domain "${domain}"` : ''} | - | - |`);
    }

    return { success: true, data, display: lines.join('\n') };
  }

  private async getState(entityId?: string): Promise<SkillResult> {
    if (!entityId) {
      return { success: false, error: 'Missing required "entityId" parameter' };
    }

    const data = await this.api<any>('GET', `/api/states/${entityId}`);

    const attrs = data.attributes ?? {};
    const lines = [
      `## ${attrs.friendly_name ?? entityId}`,
      '',
      `**Entity ID:** ${data.entity_id}`,
      `**State:** ${data.state}`,
      `**Last Changed:** ${data.last_changed ?? '-'}`,
      `**Last Updated:** ${data.last_updated ?? '-'}`,
      '',
      '### Attributes',
    ];

    for (const [key, value] of Object.entries(attrs)) {
      const display = typeof value === 'object' ? JSON.stringify(value) : String(value);
      lines.push(`- **${key}:** ${display}`);
    }

    return { success: true, data, display: lines.join('\n') };
  }

  private async getServices(): Promise<SkillResult> {
    const data = await this.api<any[]>('GET', '/api/services');

    const lines = ['## Available Services', ''];

    for (const domainEntry of data) {
      const domainName = domainEntry.domain ?? 'unknown';
      const services = Object.keys(domainEntry.services ?? {});
      if (services.length === 0) continue;
      lines.push(`### ${domainName}`);
      for (const svc of services) {
        const desc = domainEntry.services[svc]?.description ?? '';
        lines.push(`- **${svc}**${desc ? `: ${desc}` : ''}`);
      }
      lines.push('');
    }

    return { success: true, data, display: lines.join('\n') };
  }

  private async getHistory(entityId?: string, period?: string): Promise<SkillResult> {
    const ts = parsePeriod(period ?? '1h');
    const now = new Date().toISOString();
    const params = entityId
      ? `?filter_entity_id=${entityId}&end_time=${now}`
      : `?end_time=${now}`;
    const data = await this.api<any[][]>('GET', `/api/history/period/${ts}${params}`);

    const lines = ['## History', ''];

    if (!data || data.length === 0 || data.every((arr) => arr.length === 0)) {
      lines.push('No history entries found for the given period.');
      return { success: true, data: [], display: lines.join('\n') };
    }

    for (const entityHistory of data) {
      if (entityHistory.length === 0) continue;
      const eid = entityHistory[0]?.entity_id ?? 'unknown';
      const name = entityHistory[0]?.attributes?.friendly_name ?? eid;
      lines.push(`### ${name} (\`${eid}\`)`);
      lines.push('');
      lines.push('| Time | State |');
      lines.push('|------|-------|');
      for (const entry of entityHistory) {
        const time = entry.last_changed
          ? new Date(entry.last_changed).toLocaleString()
          : '-';
        lines.push(`| ${time} | ${entry.state} |`);
      }
      lines.push('');
    }

    return { success: true, data, display: lines.join('\n') };
  }

  private async getLogbook(entityId?: string, period?: string): Promise<SkillResult> {
    const ts = parsePeriod(period ?? '1h');
    const now = new Date().toISOString();
    const params = entityId
      ? `?entity=${entityId}&end_time=${now}`
      : `?end_time=${now}`;
    const data = await this.api<any[]>('GET', `/api/logbook/${ts}${params}`);

    const lines = ['## Logbook', ''];

    if (!data || data.length === 0) {
      lines.push('No logbook entries found for the given period.');
      return { success: true, data: [], display: lines.join('\n') };
    }

    lines.push('| Time | Entity | Message |');
    lines.push('|------|--------|---------|');

    for (const entry of data) {
      const time = entry.when
        ? new Date(entry.when).toLocaleString()
        : '-';
      const name = entry.name ?? entry.entity_id ?? '-';
      const message = entry.message ?? entry.state ?? '-';
      lines.push(`| ${time} | ${name} | ${message} |`);
    }

    return { success: true, data, display: lines.join('\n') };
  }

  private async getConfig(): Promise<SkillResult> {
    const data = await this.api<any>('GET', '/api/config');

    const lines = [
      '## Home Assistant Configuration',
      '',
      `**Name:** ${data.location_name ?? '-'}`,
      `**Version:** ${data.version ?? '-'}`,
      `**Time Zone:** ${data.time_zone ?? '-'}`,
      `**Latitude:** ${data.latitude ?? '-'}`,
      `**Longitude:** ${data.longitude ?? '-'}`,
      `**Elevation:** ${data.elevation ?? '-'} m`,
      `**Unit System:** ${data.unit_system?.length ? JSON.stringify(data.unit_system) : '-'}`,
      `**Currency:** ${data.currency ?? '-'}`,
      `**Internal URL:** ${data.internal_url ?? '-'}`,
      `**External URL:** ${data.external_url ?? '-'}`,
    ];

    if (data.components && Array.isArray(data.components)) {
      lines.push('', `**Components:** ${data.components.length} loaded`);
    }

    return { success: true, data, display: lines.join('\n') };
  }

  // ── WRITE actions ────────────────────────────────────────────

  private async switchAction(
    action: 'turn_on' | 'turn_off' | 'toggle',
    entityId?: string,
    serviceDataStr?: string,
  ): Promise<SkillResult> {
    if (!entityId) {
      return { success: false, error: 'Missing required "entityId" parameter' };
    }

    const domain = extractDomain(entityId);
    const body: Record<string, unknown> = { entity_id: entityId };

    if (serviceDataStr) {
      try {
        const extra = JSON.parse(serviceDataStr);
        Object.assign(body, extra);
      } catch {
        return { success: false, error: 'Invalid "serviceData" — must be valid JSON' };
      }
    }

    const result = await this.api<any[]>('POST', `/api/services/${domain}/${action}`, body);

    const newState = result?.[0]?.state ?? 'unknown';
    const name = result?.[0]?.attributes?.friendly_name ?? entityId;

    return {
      success: true,
      data: result,
      display: [
        `**${action.replace('_', ' ')}** → **${name}**`,
        '',
        `New state: **${newState}**`,
      ].join('\n'),
    };
  }

  private async callService(
    domain?: string,
    service?: string,
    entityId?: string,
    serviceDataStr?: string,
  ): Promise<SkillResult> {
    if (!domain) {
      return { success: false, error: 'Missing required "domain" parameter for call_service' };
    }
    if (!service) {
      return { success: false, error: 'Missing required "service" parameter for call_service' };
    }

    const body: Record<string, unknown> = {};
    if (entityId) body.entity_id = entityId;

    if (serviceDataStr) {
      try {
        const extra = JSON.parse(serviceDataStr);
        Object.assign(body, extra);
      } catch {
        return { success: false, error: 'Invalid "serviceData" — must be valid JSON' };
      }
    }

    const result = await this.api<any[]>('POST', `/api/services/${domain}/${service}`, body);

    const affected = result?.length ?? 0;
    const lines = [
      `**Service called:** \`${domain}.${service}\``,
      entityId ? `**Entity:** ${entityId}` : '',
      `**Affected entities:** ${affected}`,
    ].filter(Boolean);

    if (result && result.length > 0) {
      lines.push('');
      for (const entity of result) {
        const name = entity.attributes?.friendly_name ?? entity.entity_id ?? 'unknown';
        lines.push(`- **${name}**: ${entity.state}`);
      }
    }

    return { success: true, data: result, display: lines.join('\n') };
  }

  // ── NEW actions (v2) ──────────────────────────────────────────

  private async getAreas(area?: string): Promise<SkillResult> {
    if (area) {
      // Validate area name to prevent Jinja2 injection (allow alphanumeric, spaces, hyphens, underscores, umlauts)
      if (!/^[\w\s\-äöüÄÖÜß]+$/u.test(area)) {
        return { success: false, error: `Invalid area name: "${area}"` };
      }
      const tpl = `{% for eid in area_entities('${area.replace(/'/g, "\\'")}') %}{{ eid }}||{{ states(eid) }}||{{ state_attr(eid, 'friendly_name') }}\n{% endfor %}`;
      const text = await this.apiText('POST', '/api/template', { template: tpl });
      const rows = text.trim().split('\n').filter(Boolean);

      const lines = [
        `## Area: ${area}`,
        '',
        '| Entity ID | State | Name |',
        '|-----------|-------|------|',
      ];

      for (const row of rows) {
        const [eid, state, name] = row.split('||');
        lines.push(`| ${eid} | ${state} | ${name ?? '-'} |`);
      }
      if (rows.length === 0) {
        lines.push(`| - | No entities found for area "${area}" | - |`);
      }

      return { success: true, data: rows, display: lines.join('\n') };
    }

    const tpl = '{% for aid in areas() %}{{ area_name(aid) }}||{{ aid }}||{{ area_entities(aid) | length }}\n{% endfor %}';
    const text = await this.apiText('POST', '/api/template', { template: tpl });
    const rows = text.trim().split('\n').filter(Boolean);

    const lines = [
      '## Areas',
      '',
      '| Area Name | Area ID | Entity Count |',
      '|-----------|---------|--------------|',
    ];

    for (const row of rows) {
      const [name, aid, count] = row.split('||');
      lines.push(`| ${name} | ${aid} | ${count} |`);
    }
    if (rows.length === 0) {
      lines.push('| - | No areas configured | - |');
    }

    return { success: true, data: rows, display: lines.join('\n') };
  }

  private async renderTemplate(template?: string): Promise<SkillResult> {
    if (!template) {
      return { success: false, error: 'Missing required "template" parameter' };
    }

    const text = await this.apiText('POST', '/api/template', { template });
    return { success: true, data: text, display: text };
  }

  private async getPresence(): Promise<SkillResult> {
    const allStates = await this.api<any[]>('GET', '/api/states');
    const persons = allStates.filter((e) => e.entity_id.startsWith('person.'));

    const lines = [
      '## Presence',
      '',
      '| Person | Status | Last Changed |',
      '|--------|--------|--------------|',
    ];

    for (const p of persons) {
      const name = p.attributes?.friendly_name ?? p.entity_id;
      const status = p.state ?? 'unknown';
      const changed = p.last_changed
        ? new Date(p.last_changed).toLocaleString()
        : '-';
      lines.push(`| ${name} | ${status} | ${changed} |`);
    }
    if (persons.length === 0) {
      lines.push('| - | No person entities found | - |');
    }

    return { success: true, data: persons, display: lines.join('\n') };
  }

  private async sendNotification(
    message?: string,
    title?: string,
    target?: string,
  ): Promise<SkillResult> {
    if (!message) {
      return { success: false, error: 'Missing required "message" parameter' };
    }

    const svc = target ?? 'notify';
    const body: Record<string, unknown> = { message };
    if (title) body.title = title;

    const result = await this.api<any>('POST', `/api/services/notify/${svc}`, body);

    return {
      success: true,
      data: result,
      display: [
        `**Notification sent** → \`notify.${svc}\``,
        title ? `**Title:** ${title}` : '',
        `**Message:** ${message.slice(0, 200)}${message.length > 200 ? '…' : ''}`,
      ].filter(Boolean).join('\n'),
    };
  }

  private async activateScene(entityId?: string): Promise<SkillResult> {
    if (!entityId) {
      const allStates = await this.api<any[]>('GET', '/api/states');
      const scenes = allStates.filter((e) => e.entity_id.startsWith('scene.'));

      const lines = [
        '## Available Scenes',
        '',
        '| Entity ID | Name |',
        '|-----------|------|',
      ];

      for (const s of scenes) {
        const name = s.attributes?.friendly_name ?? s.entity_id;
        lines.push(`| ${s.entity_id} | ${name} |`);
      }
      if (scenes.length === 0) {
        lines.push('| - | No scenes found |');
      }

      return { success: true, data: scenes, display: lines.join('\n') };
    }

    const result = await this.api<any[]>('POST', '/api/services/scene/turn_on', {
      entity_id: entityId,
    });

    const name = result?.[0]?.attributes?.friendly_name ?? entityId;
    return {
      success: true,
      data: result,
      display: `**Scene activated:** ${name} (\`${entityId}\`)`,
    };
  }

  private async triggerAutomation(
    entityId?: string,
    subAction?: string,
  ): Promise<SkillResult> {
    if (!entityId) {
      const allStates = await this.api<any[]>('GET', '/api/states');
      const autos = allStates.filter((e) => e.entity_id.startsWith('automation.'));

      const lines = [
        '## Automations',
        '',
        '| Entity ID | Name | State | Last Triggered |',
        '|-----------|------|-------|----------------|',
      ];

      for (const a of autos) {
        const name = a.attributes?.friendly_name ?? a.entity_id;
        const lastTriggered = a.attributes?.last_triggered
          ? new Date(a.attributes.last_triggered).toLocaleString()
          : '-';
        lines.push(`| ${a.entity_id} | ${name} | ${a.state} | ${lastTriggered} |`);
      }
      if (autos.length === 0) {
        lines.push('| - | No automations found | - | - |');
      }

      return { success: true, data: autos, display: lines.join('\n') };
    }

    const actionMap: Record<string, string> = {
      trigger: 'trigger',
      enable: 'turn_on',
      disable: 'turn_off',
    };
    const resolved = subAction ?? 'trigger';
    const haService = actionMap[resolved] ?? 'trigger';

    const result = await this.api<any[]>('POST', `/api/services/automation/${haService}`, {
      entity_id: entityId,
    });

    const name = result?.[0]?.attributes?.friendly_name ?? entityId;
    const lastTriggered = result?.[0]?.attributes?.last_triggered
      ? new Date(result[0].attributes.last_triggered).toLocaleString()
      : '-';

    return {
      success: true,
      data: result,
      display: [
        `**Automation ${resolved}:** ${name} (\`${entityId}\`)`,
        `**Last triggered:** ${lastTriggered}`,
      ].join('\n'),
    };
  }

  private async runScript(
    entityId?: string,
    variablesStr?: string,
  ): Promise<SkillResult> {
    if (!entityId) {
      const allStates = await this.api<any[]>('GET', '/api/states');
      const scripts = allStates.filter((e) => e.entity_id.startsWith('script.'));

      const lines = [
        '## Scripts',
        '',
        '| Entity ID | Name | State |',
        '|-----------|------|-------|',
      ];

      for (const s of scripts) {
        const name = s.attributes?.friendly_name ?? s.entity_id;
        lines.push(`| ${s.entity_id} | ${name} | ${s.state} |`);
      }
      if (scripts.length === 0) {
        lines.push('| - | No scripts found | - |');
      }

      return { success: true, data: scripts, display: lines.join('\n') };
    }

    const scriptName = entityId.startsWith('script.') ? entityId.slice(7) : entityId;
    let body: Record<string, unknown> = {};

    if (variablesStr) {
      try {
        body = JSON.parse(variablesStr);
      } catch {
        return { success: false, error: 'Invalid "variables" — must be valid JSON' };
      }
    }

    const result = await this.api<any>('POST', `/api/services/script/${scriptName}`, body);

    return {
      success: true,
      data: result,
      display: `**Script executed:** \`script.${scriptName}\``,
    };
  }

  private async getCalendarEvents(
    entityId?: string,
    startTime?: string,
    endTime?: string,
  ): Promise<SkillResult> {
    if (!entityId) {
      const calendars = await this.api<any[]>('GET', '/api/calendars');

      const lines = [
        '## Calendars',
        '',
        '| Entity ID | Name |',
        '|-----------|------|',
      ];

      for (const c of calendars) {
        const name = c.name ?? c.entity_id ?? '-';
        lines.push(`| ${c.entity_id} | ${name} |`);
      }
      if (calendars.length === 0) {
        lines.push('| - | No calendars found |');
      }

      return { success: true, data: calendars, display: lines.join('\n') };
    }

    const start = startTime ?? new Date().toISOString();
    const end = endTime ?? new Date(Date.now() + 86_400_000).toISOString();

    const events = await this.api<any[]>(
      'GET',
      `/api/calendars/${entityId}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
    );

    const lines = [
      `## Calendar Events: ${entityId}`,
      '',
      '| Start | End | Summary | Location |',
      '|-------|-----|---------|----------|',
    ];

    for (const ev of events) {
      const s = ev.start?.dateTime
        ? new Date(ev.start.dateTime).toLocaleString()
        : ev.start?.date ?? '-';
      const e = ev.end?.dateTime
        ? new Date(ev.end.dateTime).toLocaleString()
        : ev.end?.date ?? '-';
      lines.push(`| ${s} | ${e} | ${ev.summary ?? '-'} | ${ev.location ?? '-'} |`);
    }
    if (events.length === 0) {
      lines.push('| - | - | No events in range | - |');
    }

    return { success: true, data: events, display: lines.join('\n') };
  }

  private async getErrorLog(): Promise<SkillResult> {
    const text = await this.apiText('GET', '/api/error_log');
    const truncated = text.length > 3000 ? `…${text.slice(-3000)}` : text;

    return {
      success: true,
      data: truncated,
      display: [
        '## Error Log',
        '',
        '```',
        truncated,
        '```',
      ].join('\n'),
    };
  }

  // ── Briefing summary ─────────────────────────────────────────

  /**
   * Compact smart home summary for the daily briefing.
   * If specific entities/domains are provided, shows only those.
   * Otherwise uses smart defaults: open contacts, lights on, battery/SoC sensors,
   * energy/power sensors, climate entities, person presence.
   */
  private async getBriefingSummary(
    entities?: string[],
    domains?: string[],
  ): Promise<SkillResult> {
    const allStates = await this.api<any[]>('GET', '/api/states');

    // If specific entities requested, filter to those
    if (entities?.length) {
      const entitySet = new Set(entities.map(e => e.toLowerCase()));
      const filtered = allStates.filter(e => entitySet.has(e.entity_id.toLowerCase()));
      return this.formatBriefingSummary(filtered);
    }

    // If specific domains requested, filter to those
    if (domains?.length) {
      const domainSet = new Set(domains.map(d => d.toLowerCase()));
      const filtered = allStates.filter(e => {
        const domain = e.entity_id.split('.')[0];
        return domainSet.has(domain);
      });
      return this.formatBriefingSummary(filtered);
    }

    // Smart defaults — only show what's relevant
    const relevant: any[] = [];
    const batterySensors: any[] = [];
    const powerSensors: any[] = [];

    for (const entity of allStates) {
      const eid = entity.entity_id as string;
      const domain = eid.split('.')[0];
      const state = entity.state as string;
      const attrs = entity.attributes ?? {};
      const deviceClass = (attrs.device_class ?? '') as string;

      // Binary sensors: only open/on contacts, doors, windows, motion
      if (domain === 'binary_sensor') {
        const contactClasses = ['door', 'window', 'opening', 'garage_door', 'lock', 'motion', 'occupancy', 'smoke', 'gas', 'moisture'];
        if (contactClasses.includes(deviceClass) && state === 'on') {
          relevant.push(entity);
        }
        continue;
      }

      // Lights: only real lights that are on (skip Zigbee raw IDs and network device LEDs)
      if (domain === 'light') {
        if (state === 'on') {
          const fname = (attrs.friendly_name ?? eid) as string;
          // Skip Zigbee hardware IDs (e.g. "0xa4c13800ac483d44")
          if (/^0x[a-f0-9]+$/i.test(fname)) continue;
          // Skip network equipment LEDs (UniFi APs, switches)
          if (/\bLED\b/i.test(fname)) continue;
          relevant.push(entity);
        }
        continue;
      }

      // Sensors: split into battery/SoC vs power (skip energy — use energy_stats for that)
      if (domain === 'sensor') {
        if (state === 'unavailable' || state === 'unknown') continue;
        const eidLower = eid.toLowerCase();
        const nameCheck = `${eidLower} ${(attrs.friendly_name ?? '').toLowerCase()}`;

        // Battery / SoC sensors — only device_class: battery (avoids Victron
        // system sensors with "battery" in the name that aren't actual SoC %)
        if (deviceClass === 'battery') {
          batterySensors.push(entity);
          continue;
        }

        // Power sensors (W/kW — instantaneous, useful for briefing)
        if (
          deviceClass === 'power' ||
          /power_consumption|stromverbrauch|leistung/.test(nameCheck)
        ) {
          powerSensors.push(entity);
          continue;
        }

        // Skip energy sensors (cumulative kWh — not useful in morning snapshot)
        continue;
      }

      // Climate: always show
      if (domain === 'climate') {
        relevant.push(entity);
        continue;
      }

      // Person: always show
      if (domain === 'person') {
        relevant.push(entity);
        continue;
      }
    }

    // Battery: top 5, sorted by lowest SoC first (most actionable)
    batterySensors.sort((a, b) => {
      const aVal = parseFloat(a.state) || 999;
      const bVal = parseFloat(b.state) || 999;
      return aVal - bVal;
    });
    const topBatteries = batterySensors.slice(0, 5);

    // Power: filter out non-numeric states (e.g. forecast timestamps), top 5 by absolute value
    const numericPower = powerSensors.filter(e => !isNaN(parseFloat(e.state)));
    numericPower.sort((a, b) => {
      const aVal = Math.abs(parseFloat(a.state) || 0);
      const bVal = Math.abs(parseFloat(b.state) || 0);
      return bVal - aVal;
    });
    const topPower = numericPower.slice(0, 5);

    return this.formatBriefingSummary(relevant, topBatteries, topPower);
  }

  private formatBriefingSummary(
    entities: any[],
    batterySensors?: any[],
    powerSensors?: any[],
  ): SkillResult {
    const allEntities = [...entities, ...(batterySensors ?? []), ...(powerSensors ?? [])];
    if (allEntities.length === 0) {
      return {
        success: true,
        data: [],
        display: 'Keine relevanten Smart-Home-Daten gefunden.',
      };
    }

    // Group non-sensor entities by domain
    const groups = new Map<string, any[]>();
    for (const e of entities) {
      const domain = e.entity_id.split('.')[0];
      if (!groups.has(domain)) groups.set(domain, []);
      groups.get(domain)!.push(e);
    }

    const domainLabels: Record<string, string> = {
      binary_sensor: 'Kontakte & Melder',
      light: 'Lichter (an)',
      climate: 'Klima',
      person: 'Anwesenheit',
    };

    const lines: string[] = [];

    for (const [domain, items] of groups) {
      const label = domainLabels[domain] ?? domain;
      lines.push(`**${label}:**`);
      for (const e of items) {
        const name = e.attributes?.friendly_name ?? e.entity_id;
        const unit = e.attributes?.unit_of_measurement ?? '';
        const state = e.state;
        lines.push(`- ${name}: ${state}${unit ? ` ${unit}` : ''}`);
      }
      lines.push('');
    }

    // Battery/SoC — compact list
    if (batterySensors && batterySensors.length > 0) {
      const parts = batterySensors.map(e => {
        const name = (e.attributes?.friendly_name ?? e.entity_id).replace(/\s*(battery|akku|soc|ladezustand)\s*/gi, ' ').trim();
        return `${name}: ${e.state}%`;
      });
      lines.push(`**🔋 Akkus:** ${parts.join(' | ')}`);
      lines.push('');
    }

    // Power — compact one-liner
    if (powerSensors && powerSensors.length > 0) {
      const parts = powerSensors.map(e => {
        const name = (e.attributes?.friendly_name ?? e.entity_id)
          .replace(/\s*(power|leistung|stromverbrauch)\s*/gi, ' ').trim();
        const unit = e.attributes?.unit_of_measurement ?? 'W';
        return `${name}: ${e.state} ${unit}`;
      });
      lines.push(`**⚡ Leistung:** ${parts.join(' | ')}`);
      lines.push('');
    }

    const data = allEntities.map((e: any) => ({
      entity_id: e.entity_id,
      state: e.state,
      friendly_name: e.attributes?.friendly_name,
      unit: e.attributes?.unit_of_measurement,
      device_class: e.attributes?.device_class,
    }));

    return { success: true, data, display: lines.join('\n').trim() };
  }

  // ── Energy statistics ─────────────────────────────────────────

  /**
   * Calculate energy consumption for a time period.
   * Auto-discovers energy entities (state_class: total_increasing / total,
   * device_class: energy) and computes kWh consumed by comparing the first
   * and last history values in the period.
   *
   * Falls back to Jinja2 template for periods beyond history retention.
   */
  private async getEnergyStats(period?: string, entityId?: string): Promise<SkillResult> {
    const { start, end, label } = this.parseEnergyPeriod(period ?? 'today');

    // 1. Discover energy entities (or use specific one)
    let energyEntityIds: string[];
    if (entityId) {
      energyEntityIds = [entityId];
    } else {
      const allStates = await this.api<any[]>('GET', '/api/states');
      energyEntityIds = allStates
        .filter(e => {
          const attrs = e.attributes ?? {};
          const stateClass = attrs.state_class as string | undefined;
          const deviceClass = attrs.device_class as string | undefined;
          const unit = (attrs.unit_of_measurement ?? '').toLowerCase();
          // Must be an energy accumulator sensor
          return (
            e.entity_id.startsWith('sensor.') &&
            (stateClass === 'total_increasing' || stateClass === 'total') &&
            (deviceClass === 'energy' || unit === 'kwh' || unit === 'wh' || unit === 'mwh')
          );
        })
        .map(e => e.entity_id);
    }

    if (energyEntityIds.length === 0) {
      return {
        success: true,
        data: [],
        display: 'Keine Energie-Sensoren gefunden (benötigt state_class: total_increasing und device_class: energy).',
      };
    }

    // 2. Query history for each entity and compute consumption
    const results: { entityId: string; name: string; consumption: number; unit: string }[] = [];
    const errors: string[] = [];

    // Batch query: history API supports multiple entity_ids comma-separated
    const filterIds = energyEntityIds.join(',');
    const historyUrl = `/api/history/period/${start}?end=${encodeURIComponent(end)}&filter_entity_id=${encodeURIComponent(filterIds)}&minimal_response&no_attributes`;

    let historyData: any[][];
    try {
      historyData = await this.api<any[][]>('GET', historyUrl);
    } catch (err) {
      // History API might fail for long periods — fall back to template approach
      return this.getEnergyStatsViaTemplate(energyEntityIds, start, end, label);
    }

    for (const entityHistory of historyData) {
      if (!entityHistory || entityHistory.length < 2) continue;

      const eid = entityHistory[0]?.entity_id;
      if (!eid) continue;

      // Find first and last valid numeric states
      let firstValue: number | null = null;
      let lastValue: number | null = null;

      for (const entry of entityHistory) {
        const val = parseFloat(entry.state);
        if (!isNaN(val)) {
          if (firstValue === null) firstValue = val;
          lastValue = val;
        }
      }

      if (firstValue !== null && lastValue !== null) {
        let consumption = lastValue - firstValue;
        // total_increasing sensors can reset (e.g. meter replacement).
        // Negative diff means a reset happened — skip or show 0.
        if (consumption < 0) consumption = 0;

        // Get friendly name from a separate state query (attributes stripped in minimal_response)
        const stateData = await this.api<any>('GET', `/api/states/${eid}`).catch(() => null);
        const name = stateData?.attributes?.friendly_name ?? eid;
        const unit = stateData?.attributes?.unit_of_measurement ?? 'kWh';

        // Normalize to kWh if unit is Wh or MWh
        let displayConsumption = consumption;
        let displayUnit = unit;
        if (unit.toLowerCase() === 'wh') {
          displayConsumption = consumption / 1000;
          displayUnit = 'kWh';
        } else if (unit.toLowerCase() === 'mwh') {
          displayConsumption = consumption * 1000;
          displayUnit = 'kWh';
        }

        results.push({
          entityId: eid,
          name,
          consumption: Math.round(displayConsumption * 100) / 100,
          unit: displayUnit,
        });
      }
    }

    if (results.length === 0 && errors.length === 0) {
      return {
        success: true,
        data: [],
        display: `Keine Verbrauchsdaten für Zeitraum "${label}" gefunden. Möglicherweise liegt der Zeitraum außerhalb der History-Retention.`,
      };
    }

    // 3. Format output
    const totalKwh = results.reduce((sum, r) => sum + (r.unit === 'kWh' ? r.consumption : 0), 0);
    const lines = [
      `## Energieverbrauch: ${label}`,
      '',
      '| Sensor | Verbrauch |',
      '|--------|-----------|',
    ];

    for (const r of results.sort((a, b) => b.consumption - a.consumption)) {
      lines.push(`| ${r.name} | ${r.consumption} ${r.unit} |`);
    }

    if (results.length > 1) {
      lines.push(`| **Gesamt** | **${Math.round(totalKwh * 100) / 100} kWh** |`);
    }

    if (errors.length > 0) {
      lines.push('', `Fehler bei: ${errors.join(', ')}`);
    }

    return { success: true, data: results, display: lines.join('\n') };
  }

  /**
   * Fallback: use Jinja2 template to get energy stats when history API
   * doesn't have data (period beyond retention).
   */
  private async getEnergyStatsViaTemplate(
    entityIds: string[],
    _start: string,
    _end: string,
    label: string,
  ): Promise<SkillResult> {
    // Use Jinja2 to read current state values — for cumulative sensors
    // we can at least show the current total and let the user understand
    // that historical aggregation isn't available via REST API.
    const lines = [
      `## Energie-Sensoren: ${label}`,
      '',
      '*Hinweis: Für diesen Zeitraum sind keine History-Daten verfügbar. Zeige aktuelle Zählerstände.*',
      '',
      '| Sensor | Aktueller Stand | Einheit |',
      '|--------|----------------|---------|',
    ];

    for (const eid of entityIds) {
      try {
        const state = await this.api<any>('GET', `/api/states/${eid}`);
        const name = state.attributes?.friendly_name ?? eid;
        const unit = state.attributes?.unit_of_measurement ?? '';
        const val = state.state;
        lines.push(`| ${name} | ${val} | ${unit} |`);
      } catch {
        lines.push(`| ${eid} | Fehler | - |`);
      }
    }

    return { success: true, data: [], display: lines.join('\n') };
  }

  /**
   * Parse friendly period names into ISO start/end timestamps.
   */
  private parseEnergyPeriod(period: string): { start: string; end: string; label: string } {
    const now = new Date();

    switch (period.toLowerCase().replace(/\s+/g, '_')) {
      case 'today':
      case 'heute': {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        return { start: start.toISOString(), end: now.toISOString(), label: 'Heute' };
      }
      case 'yesterday':
      case 'gestern': {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
        const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        return { start: start.toISOString(), end: end.toISOString(), label: 'Gestern' };
      }
      case 'this_week':
      case 'diese_woche': {
        const day = now.getDay();
        const mondayOffset = day === 0 ? -6 : 1 - day;
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
        return { start: start.toISOString(), end: now.toISOString(), label: 'Diese Woche' };
      }
      case 'last_week':
      case 'letzte_woche': {
        const day = now.getDay();
        const mondayOffset = day === 0 ? -6 : 1 - day;
        const thisMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
        const lastMonday = new Date(thisMonday.getTime() - 7 * 86_400_000);
        return { start: lastMonday.toISOString(), end: thisMonday.toISOString(), label: 'Letzte Woche' };
      }
      case 'this_month':
      case 'dieser_monat': {
        const start = new Date(now.getFullYear(), now.getMonth(), 1);
        return { start: start.toISOString(), end: now.toISOString(), label: 'Dieser Monat' };
      }
      case 'last_month':
      case 'letzter_monat': {
        const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const end = new Date(now.getFullYear(), now.getMonth(), 1);
        return { start: start.toISOString(), end: end.toISOString(), label: 'Letzter Monat' };
      }
      default: {
        // Fall back to parsePeriod-style: "24h", "7d", etc.
        const startTs = parsePeriod(period);
        return { start: startTs, end: now.toISOString(), label: period };
      }
    }
  }

  // ── Config API (create/delete automations, scripts, scenes) ──

  private async createConfig(
    type: 'automation' | 'script' | 'scene',
    configId?: string,
    configDataStr?: string,
  ): Promise<SkillResult> {
    if (!configId) {
      return { success: false, error: `Missing required "configId" for create_${type}` };
    }
    if (!configDataStr) {
      return { success: false, error: `Missing required "configData" for create_${type}` };
    }

    let configData: Record<string, unknown>;
    try {
      configData = JSON.parse(configDataStr);
    } catch {
      return { success: false, error: 'Invalid "configData" — must be valid JSON' };
    }

    // HA Config API: POST /api/config/{type}/config/{id}
    const result = await this.apiPost(`/api/config/${type}/config/${configId}`, configData);

    return {
      success: true,
      data: result,
      display: `**${type} created:** \`${configId}\`\n\n${configData.alias ?? configData.name ?? configId}`,
    };
  }

  private async deleteConfig(
    type: 'automation' | 'script' | 'scene',
    configId?: string,
  ): Promise<SkillResult> {
    if (!configId) {
      return { success: false, error: `Missing required "configId" for delete_${type}` };
    }

    await this.apiDelete(`/api/config/${type}/config/${configId}`);

    return {
      success: true,
      data: { deleted: configId },
      display: `**${type} deleted:** \`${configId}\``,
    };
  }

  private async apiPost<T = unknown>(path: string, body: unknown): Promise<T> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.accessToken}`,
      'Content-Type': 'application/json',
    };

    const skipTls = this.config.verifyTls === false;
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    if (skipTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } finally {
      if (skipTls) {
        if (prev === undefined) {
          delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        } else {
          process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
        }
      }
    }

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 500); } catch { /* ignore */ }
      throw new Error(`HTTP ${res.status} ${res.statusText} — ${detail}`);
    }

    return (await res.json()) as T;
  }

  private async apiDelete(path: string): Promise<void> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.accessToken}`,
    };

    const skipTls = this.config.verifyTls === false;
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    if (skipTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'DELETE',
        headers,
        signal: AbortSignal.timeout(15_000),
      });
    } finally {
      if (skipTls) {
        if (prev === undefined) {
          delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        } else {
          process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
        }
      }
    }

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 500); } catch { /* ignore */ }
      throw new Error(`HTTP ${res.status} ${res.statusText} — ${detail}`);
    }
  }
}
