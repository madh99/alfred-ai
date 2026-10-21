import { describe, it, expect } from 'vitest';
import { vmNameAufloesen } from './proxmox.js';

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
