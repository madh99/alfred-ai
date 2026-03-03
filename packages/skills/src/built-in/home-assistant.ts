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
  | 'config';

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
    description:
      'Control Home Assistant smart home devices. ' +
      'Use "states" to list entities, "turn_on"/"turn_off"/"toggle" to control devices, ' +
      '"call_service" for advanced service calls, "history" for entity state history.',
    riskLevel: 'write',
    version: '1.0.0',
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
}
