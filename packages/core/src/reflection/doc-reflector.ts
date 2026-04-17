import type { Logger } from 'pino';
import type { CmdbRepository } from '@alfred/storage';
import type { ReflectionResult } from './types.js';

export interface DocReflectorConfig {
  configSnapshotIntervalDays: number;
  staleDocWarningDays: number;
  runbookValidation: boolean;
}

export class DocReflector {
  constructor(
    private readonly cmdbRepo: CmdbRepository | undefined,
    private readonly logger: Logger,
    private readonly config: DocReflectorConfig,
  ) {}

  async reflect(userId: string): Promise<ReflectionResult[]> {
    if (!this.cmdbRepo) return [];
    const results: ReflectionResult[] = [];

    // 1. Stale doc detection
    try {
      const docs = await this.cmdbRepo.listDocuments(userId, { limit: 200 });
      const now = Date.now();
      const staleMs = this.config.staleDocWarningDays * 86_400_000;
      for (const doc of docs) {
        const age = now - new Date(doc.createdAt).getTime();
        if (age > staleMs) {
          const ageDays = Math.round(age / 86_400_000);
          results.push({
            target: { type: 'suggestion', id: doc.id, name: doc.title },
            finding: `Dokument "${doc.title}" [${doc.docType}] ist ${ageDays} Tage alt`,
            action: 'suggest',
            risk: 'proactive',
            reasoning: `Doku aelter als ${this.config.staleDocWarningDays} Tage — Update empfohlen.`,
          });
        }
      }
    } catch {
      this.logger.debug('DocReflector: stale doc check failed');
    }

    // 2. Runbook validation (check if linked entities still exist)
    if (this.config.runbookValidation) {
      try {
        const runbooks = await this.cmdbRepo.listDocuments(userId, { docType: 'runbook' as any, limit: 100 });
        const assets = await this.cmdbRepo.listAssets(userId, {});
        const assetIds = new Set(assets.map(a => a.id));

        for (const rb of runbooks) {
          if (rb.linkedEntityType === 'asset' && rb.linkedEntityId && !assetIds.has(rb.linkedEntityId)) {
            results.push({
              target: { type: 'suggestion', id: rb.id, name: rb.title },
              finding: `Runbook "${rb.title}" referenziert geloeschtes/decommissioned Asset`,
              action: 'suggest',
              risk: 'proactive',
              reasoning: 'Verknuepftes Asset existiert nicht mehr. Runbook pruefen/aktualisieren.',
            });
          }
        }
      } catch {
        this.logger.debug('DocReflector: runbook validation failed');
      }
    }

    // 3. Config snapshot freshness (suggest snapshot for assets without recent one)
    try {
      const assets = await this.cmdbRepo.listAssets(userId, { status: 'active' });
      const now = Date.now();
      const snapshotMs = this.config.configSnapshotIntervalDays * 86_400_000;

      for (const asset of assets.slice(0, 50)) {
        try {
          const docs = await this.cmdbRepo.getDocumentsForEntity(userId, 'asset' as any, asset.id);
          const latestDoc = docs[0]; // already sorted by version DESC

          if (!latestDoc || (now - new Date(latestDoc.createdAt).getTime()) > snapshotMs) {
            results.push({
              target: { type: 'suggestion', id: asset.id, name: asset.name },
              finding: `Asset "${asset.name}" hat keine aktuelle Dokumentation`,
              action: 'suggest',
              params: { asset_id: asset.id, asset_name: asset.name },
              risk: 'confirm',
              reasoning: latestDoc
                ? `Letzte Doku ${Math.round((now - new Date(latestDoc.createdAt).getTime()) / 86_400_000)} Tage alt (Schwellwert: ${this.config.configSnapshotIntervalDays}).`
                : 'Keine Dokumentation vorhanden.',
            });
          }
        } catch { /* skip individual asset */ }
      }
    } catch {
      this.logger.debug('DocReflector: config snapshot check failed');
    }

    return results;
  }
}
