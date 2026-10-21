import { describe, it, expect } from 'vitest';
import { betroffeneVmids, wiederherstellbarkeitText, commvaultFuerVm } from './wiederherstellbarkeit.js';

// v1543 — Realfall 21.10.: zfs-nvme002 auf pve, permanente Fehler in VM 100/115 (Snapshots) und vm-106-disk-1
const ZPOOL = `  pool: zfs-nvme002
 state: DEGRADED
errors: Permanent errors have been detected in the following files:

        zfs-nvme002/vm-100-disk-0@autosnap_2026-07-01:<0x1>
        zfs-nvme002/vm-115-disk-1@vor-update:<0x2>
        zfs-nvme002/vm-106-disk-1:<0x1>
        zfs-nvme002/subvol-120-disk-0:<0x5>
`;

describe('v1543 Wiederherstellbarkeit', () => {
  it('VM-IDs nur aus dem Abschnitt „Permanent errors“', () => {
    expect(betroffeneVmids(ZPOOL)).toEqual([100, 106, 115, 120]);
    expect(betroffeneVmids('pool: rpool\n state: ONLINE\n config: vm-999-disk-0\nerrors: No known data errors')).toEqual([]);
  });

  it('Text: neueste Sicherung, veraltet-Warnung, Commvault, nicht erreichbare Speicher, ohne Sicherung', () => {
    const t = wiederherstellbarkeitText([
      { vmid: 106, name: 'dsc01t', backups: [{ speicher: 'backupshare', volid: 'x', zeit: '2026-01-10T01:10:22Z' }], unerreichbar: [{ speicher: 'pbs-unas', grund: 'nicht aktiv (nicht erreichbar)' }], speicher: ['backupshare', 'pbs-unas'], commvault: null },
      { vmid: 115, backups: [], unerreichbar: [], speicher: ['backupshare'], commvault: { status: 'Protected', letzte: '2026-10-20T22:00:00Z' } },
      { vmid: 100, backups: [], unerreichbar: [], speicher: ['backupshare'], commvault: { fehler: 'HTTP 401' } },
    ], new Date('2026-10-22T08:00:00Z'));
    expect(t).toContain('**VM 106 (dsc01t)**: neueste Proxmox-Sicherung 10.01.2026 auf backupshare (vor 285 Tagen ⚠️ veraltet)');
    expect(t).toContain('nicht geprüft: pbs-unas (nicht aktiv (nicht erreichbar))');
    expect(t).toContain('Commvault: Protected, letzte Sicherung 21.10.2026');
    expect(t).toContain('Ohne nachgewiesene Sicherung: VM 100');
    expect(t).not.toContain('Ohne nachgewiesene Sicherung: VM 106'); // hat eine (alte) Proxmox-Sicherung
  });

  it('Commvault: Name ohne Groß/Klein, letzte Sicherung aus Zeitfeld (Sekunden oder Objekt)', () => {
    const vms = [{ name: 'DSC01T', vmStatus: 'Protected', lastBackupTime: 1792540800 }, { vmName: 'web', protectionStatus: 'Not protected', lastBackup: { time: 1760000000 } }];
    expect(commvaultFuerVm(vms, 'dsc01t')).toEqual({ status: 'Protected', letzte: new Date(1792540800 * 1000).toISOString() });
    expect(commvaultFuerVm(vms, 'web')?.letzte).toBe(new Date(1760000000 * 1000).toISOString());
    expect(commvaultFuerVm(vms, 'nas')).toBeNull();
    expect(commvaultFuerVm(vms, undefined)).toBeNull();
  });
});
