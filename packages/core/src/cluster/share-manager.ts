import { existsSync, accessSync, constants } from 'node:fs';
import type { Logger } from 'pino';

/**
 * v665a — ShareManager: hält die konfigurierten Cluster-Shares im Speicher und
 * prüft beim Startup auf der jeweiligen Node ob die mountPaths existieren und
 * (falls nicht readOnly) beschreibbar sind.
 *
 * Wichtig: shares müssen auf ALLEN Nodes am selben mountPath verfügbar sein —
 * sonst funktionieren Projekt-cwds nicht universell. Mismatches werden gewarnt
 * aber NICHT hart fehlgeschlagen (Single-Node-Tests sollen weiter laufen).
 */
export interface ShareConfig {
  id: string;
  name?: string;
  mountPath: string;
  type: 'nfs' | 'smb' | 'virtiofs' | 'cephfs' | 'local-shared';
  readOnly?: boolean;
  preflightCheck?: boolean;
}

export interface ShareStatus {
  config: ShareConfig;
  available: boolean;
  writable: boolean;
  reason?: string;
  lastChecked: Date;
}

export class ShareManager {
  private readonly statuses = new Map<string, ShareStatus>();

  constructor(
    private readonly shares: ShareConfig[],
    private readonly logger: Logger,
  ) {}

  /** Startup-Check: jeder konfigurierte Share wird einmal probiert. */
  async checkAll(): Promise<void> {
    for (const share of this.shares) {
      this.checkOne(share);
    }
    const summary = [...this.statuses.values()].map(s => `${s.config.id}=${s.available ? '✓' : '✗'}`).join(', ');
    this.logger.info({ shareCount: this.shares.length, statuses: summary }, 'ShareManager startup-check done');
  }

  private checkOne(share: ShareConfig): void {
    const now = new Date();
    if (!existsSync(share.mountPath)) {
      this.statuses.set(share.id, {
        config: share, available: false, writable: false,
        reason: `mountPath nicht vorhanden: ${share.mountPath}`,
        lastChecked: now,
      });
      this.logger.warn({ shareId: share.id, mountPath: share.mountPath, type: share.type },
        'Share mountPath nicht vorhanden — Projekte auf diesem Share funktionieren auf dieser Node nicht');
      return;
    }
    // Writable-Check nur wenn nicht read-only
    let writable = false;
    if (share.readOnly) {
      writable = false;
    } else {
      try {
        accessSync(share.mountPath, constants.W_OK);
        writable = true;
      } catch (err) {
        this.logger.warn({ shareId: share.id, mountPath: share.mountPath, err: (err as Error).message },
          'Share nicht beschreibbar — Move-to-shared würde fehlschlagen');
      }
    }
    this.statuses.set(share.id, {
      config: share, available: true, writable, lastChecked: now,
      reason: writable || share.readOnly ? undefined : 'mountPath nicht beschreibbar',
    });
  }

  /** Gibt einen Share-Eintrag aus config zurück (oder undefined). */
  getShare(shareId: string): ShareConfig | undefined {
    return this.shares.find(s => s.id === shareId);
  }

  /** Status aller Shares (für /api/cluster/shares Endpoint). */
  listStatuses(): ShareStatus[] {
    return [...this.statuses.values()];
  }

  /** Ist der Share auf DIESER Node verfügbar und beschreibbar (oder readOnly OK)? */
  isUsable(shareId: string): boolean {
    const s = this.statuses.get(shareId);
    if (!s) return false;
    if (!s.available) return false;
    if (s.config.readOnly) return true;
    return s.writable;
  }

  /** Re-Check on-demand (z.B. nach mount/umount durch ops). */
  recheckAll(): void {
    for (const share of this.shares) this.checkOne(share);
  }
}
