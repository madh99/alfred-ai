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
  | 'error_log';

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
      'for automations, "notify" for notifications, "calendar_events" for calendars, "template" for Jinja2 queries, "error_log" for HA logs.',
    riskLevel: 'write',
    version: '2.0.0',
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
          description: 'Time period for history/logbook, e.g. 1h, 24h, 7d (default: 1h)',
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
    const params = entityId ? `?filter_entity_id=${entityId}` : '';
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
    const params = entityId ? `?entity=${entityId}` : '';
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
}
