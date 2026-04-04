import type { SkillMetadata, SkillContext, SkillResult, CloudflareConfig } from '@alfred/types';
import { Skill } from '../skill.js';

type Action = 'list_zones' | 'list_records' | 'create_record' | 'update_record' | 'delete_record';

const CF_API = 'https://api.cloudflare.com/client/v4';

export class CloudflareDnsSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'cloudflare_dns',
    category: 'infrastructure',
    description:
      'Cloudflare DNS-Verwaltung. ' +
      '"list_zones" zeigt alle DNS-Zonen. ' +
      '"list_records" zeigt Records einer Domain (domain angeben). ' +
      '"create_record" erstellt einen DNS-Record (domain, type, name, content, proxied). ' +
      '"update_record" aktualisiert einen Record (record_id, content, proxied). ' +
      '"delete_record" löscht einen Record (record_id, domain). ' +
      'Typen: A, AAAA, CNAME, TXT, MX, NS. proxied=true für Cloudflare-Proxy.',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list_zones', 'list_records', 'create_record', 'update_record', 'delete_record'] },
        domain: { type: 'string', description: 'Domain/Zone (z.B. uboot.cc) — wird automatisch zur Zone-ID aufgelöst' },
        type: { type: 'string', description: 'Record-Typ: A, AAAA, CNAME, TXT, MX, NS' },
        name: { type: 'string', description: 'Record-Name (z.B. @ für root, www, sub.domain)' },
        content: { type: 'string', description: 'Record-Wert (IP, CNAME-Target, TXT-Value)' },
        proxied: { type: 'boolean', description: 'Cloudflare Proxy aktivieren (default: true für A/AAAA/CNAME)' },
        ttl: { type: 'number', description: 'TTL in Sekunden (default: 1 = auto)' },
        record_id: { type: 'string', description: 'Record-ID für update/delete' },
        priority: { type: 'number', description: 'MX Priority' },
      },
      required: ['action'],
    },
  };

  private readonly apiToken: string;
  private zoneCache = new Map<string, string>(); // domain → zoneId

  constructor(config: CloudflareConfig) {
    super();
    this.apiToken = config.apiToken;
  }

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    const action = input.action as Action;
    switch (action) {
      case 'list_zones': return this.listZones();
      case 'list_records': return this.listRecords(input);
      case 'create_record': return this.createRecord(input);
      case 'update_record': return this.updateRecord(input);
      case 'delete_record': return this.deleteRecord(input);
      default: return { success: false, error: `Unknown action: ${String(action)}` };
    }
  }

  private async cfFetch(path: string, options?: RequestInit): Promise<any> {
    const res = await fetch(`${CF_API}${path}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
        ...(options?.headers ?? {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json() as { success: boolean; result: unknown; errors?: Array<{ message: string }> };
    if (!data.success) {
      const msg = data.errors?.map(e => e.message).join(', ') ?? 'Unknown error';
      throw new Error(`Cloudflare API: ${msg}`);
    }
    return data.result;
  }

  /** Resolve domain to zone ID (cached). */
  private async resolveZoneId(domain: string): Promise<string> {
    // Extract root domain (uboot.cc from sub.uboot.cc)
    const parts = domain.split('.');
    const rootDomain = parts.length > 2 ? parts.slice(-2).join('.') : domain;

    if (this.zoneCache.has(rootDomain)) return this.zoneCache.get(rootDomain)!;

    const zones = await this.cfFetch(`/zones?name=${encodeURIComponent(rootDomain)}`) as Array<{ id: string; name: string }>;
    if (zones.length === 0) throw new Error(`Zone für "${rootDomain}" nicht gefunden`);
    this.zoneCache.set(rootDomain, zones[0].id);
    return zones[0].id;
  }

  private async listZones(): Promise<SkillResult> {
    const zones = await this.cfFetch('/zones?per_page=50') as Array<{ id: string; name: string; status: string }>;
    const lines = zones.map(z => `- **${z.name}** (${z.status}) — ID: ${z.id.slice(0, 8)}`);
    return { success: true, data: zones, display: `## Cloudflare Zonen\n\n${lines.join('\n')}` };
  }

  private async listRecords(input: Record<string, unknown>): Promise<SkillResult> {
    const domain = input.domain as string;
    if (!domain) return { success: false, error: 'domain erforderlich' };

    const zoneId = await this.resolveZoneId(domain);
    const records = await this.cfFetch(`/zones/${zoneId}/dns_records?per_page=100`) as Array<{
      id: string; type: string; name: string; content: string; proxied: boolean; ttl: number;
    }>;

    const lines = records.map(r =>
      `| ${r.type} | ${r.name} | ${r.content} | ${r.proxied ? '☁️' : '⬜'} | ${r.ttl === 1 ? 'auto' : r.ttl + 's'} | ${r.id.slice(0, 8)} |`
    );
    const display = `## DNS Records: ${domain}\n\n| Typ | Name | Wert | Proxy | TTL | ID |\n|-----|------|------|-------|-----|----|\n${lines.join('\n')}`;
    return { success: true, data: records, display };
  }

  private async createRecord(input: Record<string, unknown>): Promise<SkillResult> {
    const domain = input.domain as string;
    const type = input.type as string;
    const name = input.name as string;
    const content = input.content as string;
    if (!domain || !type || !name || !content) {
      return { success: false, error: 'domain, type, name und content erforderlich' };
    }

    const zoneId = await this.resolveZoneId(domain);
    const body: Record<string, unknown> = {
      type: type.toUpperCase(),
      name,
      content,
      ttl: (input.ttl as number) ?? 1,
      proxied: input.proxied !== undefined ? input.proxied : ['A', 'AAAA', 'CNAME'].includes(type.toUpperCase()),
    };
    if (input.priority !== undefined) body.priority = input.priority;

    const result = await this.cfFetch(`/zones/${zoneId}/dns_records`, {
      method: 'POST',
      body: JSON.stringify(body),
    }) as { id: string; type: string; name: string; content: string };

    return {
      success: true,
      data: result,
      display: `✅ DNS Record erstellt: ${result.type} ${result.name} → ${result.content} (ID: ${result.id.slice(0, 8)})`,
    };
  }

  private async updateRecord(input: Record<string, unknown>): Promise<SkillResult> {
    const recordId = input.record_id as string;
    const domain = input.domain as string;
    if (!recordId || !domain) return { success: false, error: 'record_id und domain erforderlich' };

    const zoneId = await this.resolveZoneId(domain);
    const body: Record<string, unknown> = {};
    if (input.content !== undefined) body.content = input.content;
    if (input.proxied !== undefined) body.proxied = input.proxied;
    if (input.ttl !== undefined) body.ttl = input.ttl;
    if (input.name !== undefined) body.name = input.name;
    if (input.type !== undefined) body.type = (input.type as string).toUpperCase();

    const result = await this.cfFetch(`/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }) as { id: string; type: string; name: string; content: string };

    return {
      success: true,
      data: result,
      display: `✅ DNS Record aktualisiert: ${result.type} ${result.name} → ${result.content}`,
    };
  }

  private async deleteRecord(input: Record<string, unknown>): Promise<SkillResult> {
    const recordId = input.record_id as string;
    const domain = input.domain as string;
    if (!recordId || !domain) return { success: false, error: 'record_id und domain erforderlich' };

    const zoneId = await this.resolveZoneId(domain);
    await this.cfFetch(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
    return { success: true, display: `✅ DNS Record ${recordId.slice(0, 8)} gelöscht` };
  }
}
