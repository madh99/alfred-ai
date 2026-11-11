import { describe, it, expect } from 'vitest';
import { vmNameAufloesen, zusatzPlatten } from './proxmox.js';

// v1537 — VM über den Namen (Realfall 21.10.: vm_status mit vm=git-server)
const vms = [
  { vmid: 101, name: 'git-server', node: 'pve' },
  { vmid: 102, name: 'git-server-alt', node: 'pve2' },
  { vmid: 110, name: 'homeassistant', node: 'pve' },
  { vmid: 111, name: 'web-a', node: 'pve' },
  { vmid: 112, name: 'web-b', node: 'pve2' },
];

describe('v1537 vmNameAufloesen', () => {
  it('genauer Name gewinnt vor Teiltreffern, Groß/Klein egal', () => {
    expect(vmNameAufloesen(vms, 'git-server')).toEqual({ vmid: 101 });
    expect(vmNameAufloesen(vms, 'HomeAssistant')).toEqual({ vmid: 110 });
  });
  it('eindeutiger Teiltreffer, mehrdeutig und unbekannt melden klar', () => {
    expect(vmNameAufloesen(vms, 'home')).toEqual({ vmid: 110 });
    expect(vmNameAufloesen(vms, 'web')).toMatchObject({ fehler: expect.stringContaining('mehrdeutig') });
    expect(vmNameAufloesen(vms, 'nas')).toMatchObject({ fehler: expect.stringContaining('Keine VM') });
  });
  it('v1538 verändernde Aktionen: nur genauer Name, nie Teiltreffer', () => {
    expect(vmNameAufloesen(vms, 'home', { nurGenau: true })).toMatchObject({ fehler: expect.stringContaining('genau') });
    expect(vmNameAufloesen(vms, 'git-server', { nurGenau: true })).toEqual({ vmid: 101 });
  });
});

describe('I8d Zusatzplatten', () => {
  it('proxmox extra_disks: verschiedene Größen, höchstens 6, nicht zusammen mit extra_disk_size', () => {
    expect(zusatzPlatten({ extra_disks: [50, 20, 15, 30] })).toEqual([50, 20, 15, 30]);
    expect(zusatzPlatten({ extra_disk_size: 64 })).toEqual([64]);
    expect(zusatzPlatten({})).toEqual([]);
    expect(() => zusatzPlatten({ extra_disks: [20, 20] })).toThrow('verschieden');
    expect(() => zusatzPlatten({ extra_disks: [1, 2, 3, 4, 5, 6, 7] })).toThrow('höchstens 6');
    expect(() => zusatzPlatten({ extra_disks: [8], extra_disk_size: 200 })).toThrow('nicht beides');
  });
});
