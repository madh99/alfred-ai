import type { SkillMetadata, SkillContext, SkillResult, CmdbAssetType, CmdbRelationType } from '@alfred/types';
import type { CmdbRepository } from '@alfred/storage';
import { Skill } from '../skill.js';

type Action =
  | 'discover' | 'discover_source'
  | 'list_assets' | 'get_asset' | 'add_asset' | 'update_asset'
  | 'decommission_asset' | 'delete_asset'
  | 'add_relation' | 'remove_relation'
  | 'search' | 'topology' | 'stats';

interface DiscoveredAsset {
  name: string;
  assetType: CmdbAssetType;
  sourceSkill: string;
  sourceId: string;
  identifier?: string;
  ipAddress?: string;
  hostname?: string;
  fqdn?: string;
  status?: string;
  attributes?: Record<string, unknown>;
}

interface DiscoveredRelation {
  sourceKey: string; // source_skill:source_id
  targetKey: string;
  relationType: CmdbRelationType;
}

export type DiscoverySource = () => Promise<{ assets: DiscoveredAsset[]; relations: DiscoveredRelation[] }>;

export class CmdbSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'cmdb',
    category: 'infrastructure',
    description:
      'Configuration Management Database — Zentrales Inventar aller Infrastruktur-Assets. ' +
      '"discover" scannt alle konfigurierten Infra-Skills und aktualisiert das CMDB. ' +
      '"discover_source" scannt nur eine bestimmte Quelle (source: proxmox/docker/unifi/cloudflare_dns/npm/pfsense/homeassistant/mikrotik). ' +
      '"list_assets" zeigt Assets (filter: asset_type, status, environment, source_skill, search, tags). ' +
      '"get_asset" zeigt Asset-Details + Relationen + Change-History (asset_id). ' +
      '"add_asset" erstellt ein Asset manuell (name, asset_type, ip_address, hostname, environment, owner, purpose, tags). ' +
      '"update_asset" aktualisiert ein Asset (asset_id + Felder). ' +
      '"decommission_asset" markiert ein Asset als stillgelegt (asset_id). ' +
      '"delete_asset" entfernt ein Asset aus der CMDB (asset_id). ' +
      '"add_relation" erstellt eine Beziehung (source_asset_id, target_asset_id, relation_type). ' +
      '"remove_relation" löscht eine Beziehung (relation_id). ' +
      '"search" sucht Assets per Freitext (query). ' +
      '"topology" zeigt den Beziehungsgraph eines Assets (asset_id, depth). ' +
      '"stats" zeigt CMDB-Statistiken.',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['discover', 'discover_source', 'list_assets', 'get_asset', 'add_asset', 'update_asset', 'decommission_asset', 'delete_asset', 'add_relation', 'remove_relation', 'search', 'topology', 'stats'] },
        source: { type: 'string', description: 'Discovery-Quelle für discover_source' },
        asset_type: { type: 'string' },
        status: { type: 'string' },
        environment: { type: 'string' },
        source_skill: { type: 'string' },
        search: { type: 'string' },
        tags: { type: 'string' },
        asset_id: { type: 'string' },
        name: { type: 'string' },
        ip_address: { type: 'string' },
        hostname: { type: 'string' },
        fqdn: { type: 'string' },
        owner: { type: 'string' },
        purpose: { type: 'string' },
        notes: { type: 'string' },
        location: { type: 'string' },
        source_asset_id: { type: 'string' },
        target_asset_id: { type: 'string' },
        relation_type: { type: 'string' },
        relation_id: { type: 'string' },
        query: { type: 'string' },
        depth: { type: 'number' },
      },
      required: ['action'],
    },
    timeoutMs: 120_000,
  };

  private readonly repo: CmdbRepository;
  private readonly staleThresholdDays: number;
  private discoverySources: Map<string, DiscoverySource> = new Map();
  private kgSyncCallback?: (userId: string) => Promise<void>;
  private ipResolverCallback?: () => Promise<Array<{ mac: string; ip: string; hostname?: string; source: string }>>;

  constructor(repo: CmdbRepository, staleThresholdDays = 7) {
    super();
    this.repo = repo;
    this.staleThresholdDays = staleThresholdDays;
  }

  registerDiscoverySource(name: string, source: DiscoverySource): void {
    this.discoverySources.set(name, source);
  }

  setKgSyncCallback(cb: (userId: string) => Promise<void>): void {
    this.kgSyncCallback = cb;
  }

  setIpResolverCallback(cb: () => Promise<Array<{ mac: string; ip: string; hostname?: string; source: string }>>): void {
    this.ipResolverCallback = cb;
  }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = input.action as Action;
    const userId = context.masterUserId || context.userId;

    try {
      switch (action) {
        case 'discover': return await this.discover(userId);
        case 'discover_source': return await this.discoverSource(userId, input.source as string);
        case 'list_assets': return await this.listAssets(userId, input);
        case 'get_asset': return await this.getAsset(userId, input.asset_id as string);
        case 'add_asset': return await this.addAsset(userId, input);
        case 'update_asset': return await this.updateAsset(userId, input);
        case 'decommission_asset': return await this.decommissionAsset(userId, input.asset_id as string);
        case 'delete_asset': return await this.deleteAsset(userId, input.asset_id as string);
        case 'add_relation': return await this.addRelation(userId, input);
        case 'remove_relation': return await this.removeRelation(userId, input.relation_id as string);
        case 'search': return await this.searchAssets(userId, input.query as string);
        case 'topology': return await this.getTopology(userId, input.asset_id as string, input.depth as number | undefined);
        case 'stats': return await this.getStats(userId);
        default: return { success: false, error: `Unbekannte Aktion: ${String(action)}` };
      }
    } catch (err: any) {
      return { success: false, error: err.message ?? String(err) };
    }
  }

  // ── Discovery ──────────────────────────────────────────────

  private async discover(userId: string): Promise<SkillResult> {
    const runStart = new Date().toISOString();
    const results: string[] = [];
    let totalAssets = 0;
    let totalRelations = 0;

    for (const [name, source] of this.discoverySources) {
      try {
        const { assets, relations } = await source();
        for (const a of assets) {
          await this.repo.upsertAsset(userId, {
            name: a.name,
            assetType: a.assetType,
            sourceSkill: a.sourceSkill,
            sourceId: a.sourceId,
            identifier: a.identifier,
            ipAddress: a.ipAddress,
            hostname: a.hostname,
            fqdn: a.fqdn,
            status: (a.status as any) ?? 'active',
            attributes: a.attributes ?? {},
          });
        }
        totalAssets += assets.length;

        // Auto-relations from this source
        for (const rel of relations) {
          const srcAsset = await this.repo.getAssetBySource(userId, rel.sourceKey.split(':')[0], rel.sourceKey.split(':').slice(1).join(':'));
          const tgtAsset = await this.repo.getAssetBySource(userId, rel.targetKey.split(':')[0], rel.targetKey.split(':').slice(1).join(':'));
          if (srcAsset && tgtAsset) {
            await this.repo.upsertRelation(userId, srcAsset.id, tgtAsset.id, rel.relationType, true);
            totalRelations++;
          }
        }

        // Mark stale assets
        const stale = await this.repo.markStaleAssets(userId, name, runStart, this.staleThresholdDays);
        results.push(`${name}: ${assets.length} Assets${stale > 0 ? `, ${stale} stale` : ''}`);
      } catch (err: any) {
        results.push(`${name}: Fehler — ${err.message?.slice(0, 100)}`);
      }
    }

    // Cross-source IP resolution: fill missing IPs via ARP/DHCP MAC matching
    if (this.ipResolverCallback) {
      try {
        const macIpMap = await this.ipResolverCallback();
        const macToIp = new Map<string, string>();
        for (const entry of macIpMap) {
          if (entry.mac && entry.ip) macToIp.set(entry.mac.toLowerCase(), entry.ip);
        }
        // Find assets without IP that have a MAC in attributes
        const allAssets = await this.repo.listAssets(userId);
        let resolved = 0;
        for (const asset of allAssets) {
          if (asset.ipAddress) continue; // already has IP
          const mac = String(asset.attributes?.mac ?? '').toLowerCase();
          if (!mac) continue;
          const ip = macToIp.get(mac);
          if (ip) {
            await this.repo.updateAsset(userId, asset.id, { ipAddress: ip });
            resolved++;
          }
        }
        if (resolved > 0) results.push(`ip-resolution: ${resolved} IPs via MAC zugeordnet`);
      } catch { /* non-critical */ }
    }

    // Cross-source relation discovery
    try {
      const crossRels = await this.discoverCrossSourceRelations(userId);
      totalRelations += crossRels;
    } catch (err: any) {
      results.push(`cross-source: Fehler — ${err.message?.slice(0, 100)}`);
    }

    // KG sync
    if (this.kgSyncCallback) {
      try { await this.kgSyncCallback(userId); } catch { /* non-critical */ }
    }

    const display = `## CMDB Discovery\n\n${results.map(r => `- ${r}`).join('\n')}\n\n**Gesamt:** ${totalAssets} Assets, ${totalRelations} Relationen`;
    return { success: true, data: { totalAssets, totalRelations, sources: results }, display };
  }

  private async discoverSource(userId: string, source: string): Promise<SkillResult> {
    if (!source) return { success: false, error: 'source ist erforderlich' };
    const fn = this.discoverySources.get(source);
    if (!fn) return { success: false, error: `Unbekannte Quelle: ${source}. Verfügbar: ${[...this.discoverySources.keys()].join(', ')}` };

    const runStart = new Date().toISOString();
    const { assets, relations } = await fn();

    for (const a of assets) {
      await this.repo.upsertAsset(userId, {
        name: a.name, assetType: a.assetType, sourceSkill: a.sourceSkill, sourceId: a.sourceId,
        identifier: a.identifier, ipAddress: a.ipAddress, hostname: a.hostname, fqdn: a.fqdn,
        status: (a.status as any) ?? 'active', attributes: a.attributes ?? {},
      });
    }

    let relCount = 0;
    for (const rel of relations) {
      try {
        const srcAsset = await this.repo.getAssetBySource(userId, rel.sourceKey.split(':')[0], rel.sourceKey.split(':').slice(1).join(':'));
        const tgtAsset = await this.repo.getAssetBySource(userId, rel.targetKey.split(':')[0], rel.targetKey.split(':').slice(1).join(':'));
        if (srcAsset && tgtAsset) {
          await this.repo.upsertRelation(userId, srcAsset.id, tgtAsset.id, rel.relationType, true);
          relCount++;
        }
      } catch { /* skip failed relation */ }
    }

    let stale = 0;
    try { stale = await this.repo.markStaleAssets(userId, source, runStart, this.staleThresholdDays); } catch { /* non-critical */ }
    const display = `## CMDB Discovery: ${source}\n\n${assets.length} Assets, ${relCount} Relationen${stale > 0 ? `, ${stale} stale markiert` : ''}`;
    return { success: true, data: { assets: assets.length, relations: relCount, stale }, display };
  }

  private async discoverCrossSourceRelations(userId: string): Promise<number> {
    const allAssets = await this.repo.listAssets(userId);
    const byIp = new Map<string, typeof allAssets>();
    for (const a of allAssets) {
      if (!a.ipAddress) continue;
      const list = byIp.get(a.ipAddress) || [];
      list.push(a);
      byIp.set(a.ipAddress, list);
    }

    let count = 0;

    for (const a of allAssets) {
      // DNS resolves_to: DNS record content matches an asset IP
      if (a.assetType === 'dns_record' && a.attributes?.content) {
        const targetIp = a.attributes.content as string;
        const targets = byIp.get(targetIp);
        if (targets) {
          for (const t of targets) {
            if (t.id !== a.id && !['dns_record', 'firewall_rule'].includes(t.assetType)) {
              await this.repo.upsertRelation(userId, a.id, t.id, 'resolves_to', true);
              count++;
            }
          }
        }
      }

      // Proxy routes_to: forward_host matches an asset IP
      if (a.assetType === 'proxy_host' && a.attributes?.forward_host) {
        const targetIp = a.attributes.forward_host as string;
        const targets = byIp.get(targetIp);
        if (targets) {
          for (const t of targets) {
            if (t.id !== a.id && !['dns_record', 'proxy_host', 'firewall_rule'].includes(t.assetType)) {
              await this.repo.upsertRelation(userId, a.id, t.id, 'routes_to', true);
              count++;
            }
          }
        }
      }

      // Container runs_on: container host IP matches a VM/LXC
      if (a.assetType === 'container' && a.attributes?.host_ip) {
        const hostIp = a.attributes.host_ip as string;
        const hosts = byIp.get(hostIp);
        if (hosts) {
          for (const h of hosts) {
            if (['vm', 'lxc', 'server'].includes(h.assetType)) {
              await this.repo.upsertRelation(userId, a.id, h.id, 'runs_on', true);
              count++;
            }
          }
        }
      }

      // Firewall protects: rule destination matches an asset IP
      if (a.assetType === 'firewall_rule' && a.attributes?.destination_address) {
        const destIp = a.attributes.destination_address as string;
        const targets = byIp.get(destIp);
        if (targets) {
          for (const t of targets) {
            if (t.id !== a.id && t.assetType !== 'firewall_rule') {
              await this.repo.upsertRelation(userId, a.id, t.id, 'protects', true);
              count++;
            }
          }
        }
      }
    }

    return count;
  }

  // ── CRUD ───────────────────────────────────────────────────

  private async listAssets(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const assets = await this.repo.listAssets(userId, {
      assetType: input.asset_type as any, status: input.status as any,
      environment: input.environment as any, sourceSkill: input.source_skill as string,
      search: input.search as string, tags: input.tags as string,
    });

    if (assets.length === 0) return { success: true, data: [], display: 'Keine Assets gefunden.' };

    const lines = assets.map(a => {
      const status = a.status === 'active' ? '🟢' : a.status === 'degraded' ? '🟡' : a.status === 'decommissioned' ? '⚫' : a.status === 'unknown' ? '❓' : '🔴';
      return `| ${a.name} | ${a.assetType} | ${a.ipAddress ?? '—'} | ${status} ${a.status} | ${a.sourceSkill ?? 'manual'} | ${a.environment ?? '—'} |`;
    });

    const display = `## CMDB Assets (${assets.length})\n\n| Name | Typ | IP | Status | Quelle | Env |\n|------|-----|----|----|--------|-----|\n${lines.join('\n')}`;
    return { success: true, data: assets, display };
  }

  private async getAsset(userId: string, assetId: string): Promise<SkillResult> {
    if (!assetId) return { success: false, error: 'asset_id erforderlich' };
    const asset = await this.repo.getAssetById(userId, assetId);
    if (!asset) return { success: false, error: `Asset ${assetId} nicht gefunden` };

    const relations = await this.repo.getRelationsForAsset(userId, assetId);
    const changes = await this.repo.getChangesForAsset(userId, assetId, 10);

    const relLines = relations.map(r => {
      const dir = r.sourceAssetId === assetId ? '→' : '←';
      const otherId = r.sourceAssetId === assetId ? r.targetAssetId : r.sourceAssetId;
      return `- ${r.relationType} ${dir} ${otherId}${r.autoDiscovered ? ' (auto)' : ''}`;
    });

    const changeLines = changes.slice(0, 10).map(c =>
      `- ${c.createdAt?.slice(0, 16)} ${c.changeType}${c.fieldName ? `: ${c.fieldName}` : ''}${c.description ? ` — ${c.description}` : ''}`,
    );

    const display = [
      `## ${asset.name}`,
      `**Typ:** ${asset.assetType} | **Status:** ${asset.status} | **Env:** ${asset.environment ?? '—'}`,
      asset.ipAddress ? `**IP:** ${asset.ipAddress}` : '',
      asset.hostname ? `**Hostname:** ${asset.hostname}` : '',
      asset.fqdn ? `**FQDN:** ${asset.fqdn}` : '',
      asset.owner ? `**Owner:** ${asset.owner}` : '',
      asset.purpose ? `**Zweck:** ${asset.purpose}` : '',
      asset.tags ? `**Tags:** ${asset.tags}` : '',
      asset.notes ? `**Notizen:** ${asset.notes}` : '',
      asset.sourceSkill ? `**Quelle:** ${asset.sourceSkill}:${asset.sourceId}` : '',
      '',
      relLines.length > 0 ? `### Relationen\n${relLines.join('\n')}` : '',
      changeLines.length > 0 ? `### Letzte Änderungen\n${changeLines.join('\n')}` : '',
    ].filter(Boolean).join('\n');

    return { success: true, data: { asset, relations, changes }, display };
  }

  private async addAsset(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const name = input.name as string;
    const assetType = input.asset_type as CmdbAssetType;
    if (!name || !assetType) return { success: false, error: 'name und asset_type erforderlich' };

    const asset = await this.repo.upsertAsset(userId, {
      name, assetType,
      ipAddress: input.ip_address as string,
      hostname: input.hostname as string,
      fqdn: input.fqdn as string,
      environment: input.environment as any,
      owner: input.owner as string,
      purpose: input.purpose as string,
      tags: input.tags as string,
      notes: input.notes as string,
      location: input.location as string,
    });

    await this.repo.logChange(userId, asset.id, 'created', 'manual', undefined, undefined, undefined, `Asset ${name} erstellt`);
    return { success: true, data: asset, display: `✅ Asset erstellt: ${name} (${assetType}) — ID: ${asset.id}` };
  }

  private async updateAsset(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const assetId = input.asset_id as string;
    if (!assetId) return { success: false, error: 'asset_id erforderlich' };

    const updates: Record<string, unknown> = {};
    for (const key of ['name', 'status', 'environment', 'ip_address', 'hostname', 'fqdn', 'owner', 'purpose', 'tags', 'notes', 'location']) {
      const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (input[key] !== undefined) updates[camelKey] = input[key];
    }
    if (input.asset_type) updates.assetType = input.asset_type;

    const result = await this.repo.updateAsset(userId, assetId, updates as any);
    if (!result) return { success: false, error: `Asset ${assetId} nicht gefunden` };
    return { success: true, data: result, display: `✅ Asset ${result.name} aktualisiert` };
  }

  private async decommissionAsset(userId: string, assetId: string): Promise<SkillResult> {
    if (!assetId) return { success: false, error: 'asset_id erforderlich' };
    const ok = await this.repo.decommissionAsset(userId, assetId);
    if (!ok) return { success: false, error: `Asset ${assetId} nicht gefunden` };
    return { success: true, display: `✅ Asset ${assetId} dekommissioniert` };
  }

  private async deleteAsset(userId: string, assetId: string): Promise<SkillResult> {
    if (!assetId) return { success: false, error: 'asset_id erforderlich' };
    const ok = await this.repo.deleteAsset(userId, assetId);
    if (!ok) return { success: false, error: `Asset ${assetId} nicht gefunden` };
    return { success: true, display: `✅ Asset ${assetId} gelöscht` };
  }

  private async addRelation(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const src = input.source_asset_id as string;
    const tgt = input.target_asset_id as string;
    const type = input.relation_type as CmdbRelationType;
    if (!src || !tgt || !type) return { success: false, error: 'source_asset_id, target_asset_id und relation_type erforderlich' };

    const rel = await this.repo.upsertRelation(userId, src, tgt, type);
    return { success: true, data: rel, display: `✅ Relation erstellt: ${src} — ${type} → ${tgt}` };
  }

  private async removeRelation(userId: string, relationId: string): Promise<SkillResult> {
    if (!relationId) return { success: false, error: 'relation_id erforderlich' };
    const ok = await this.repo.removeRelation(userId, relationId);
    if (!ok) return { success: false, error: `Relation ${relationId} nicht gefunden` };
    return { success: true, display: `✅ Relation ${relationId} gelöscht` };
  }

  private async searchAssets(userId: string, query: string): Promise<SkillResult> {
    if (!query) return { success: false, error: 'query erforderlich' };
    const assets = await this.repo.searchAssets(userId, query);
    if (assets.length === 0) return { success: true, data: [], display: `Keine Assets für "${query}" gefunden.` };

    const lines = assets.map(a => `- **${a.name}** (${a.assetType}) — ${a.ipAddress ?? '—'} — ${a.status}`);
    return { success: true, data: assets, display: `## Suche: "${query}"\n\n${lines.join('\n')}` };
  }

  private async getTopology(userId: string, assetId: string, depth?: number): Promise<SkillResult> {
    if (!assetId) return { success: false, error: 'asset_id erforderlich' };
    const topo = await this.repo.getTopology(userId, assetId, depth ?? 3);

    const lines = topo.assets.map(a => `- ${a.name} (${a.assetType}) [${a.status}]`);
    const relLines = topo.relations.map(r => `- ${r.sourceAssetId} —${r.relationType}→ ${r.targetAssetId}`);

    const display = `## Topologie (${topo.assets.length} Assets, ${topo.relations.length} Relationen)\n\n### Assets\n${lines.join('\n')}\n\n### Relationen\n${relLines.join('\n')}`;
    return { success: true, data: topo, display };
  }

  private async getStats(userId: string): Promise<SkillResult> {
    const stats = await this.repo.getStats(userId);

    const typeLines = Object.entries(stats.byType).map(([k, v]) => `| ${k} | ${v} |`);
    const statusLines = Object.entries(stats.byStatus).map(([k, v]) => `| ${k} | ${v} |`);
    const sourceLines = Object.entries(stats.bySource).map(([k, v]) => `| ${k} | ${v} |`);

    const display = [
      `## CMDB Statistik — ${stats.total} Assets`,
      '',
      '### Nach Typ',
      '| Typ | Anzahl |', '|-----|--------|',
      ...typeLines,
      '',
      '### Nach Status',
      '| Status | Anzahl |', '|--------|--------|',
      ...statusLines,
      '',
      '### Nach Quelle',
      '| Quelle | Anzahl |', '|--------|--------|',
      ...sourceLines,
    ].join('\n');

    return { success: true, data: stats, display };
  }
}
