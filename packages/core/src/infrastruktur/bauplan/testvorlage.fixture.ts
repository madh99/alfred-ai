// Gemeinsame Test-Vorlage für die Bauplan-Tests (kein Produktivcode).
export function testVorlage(): Record<string, unknown> {
  return {
    schema: 1,
    key: 'test_lab',
    titel: 'Test-Lab',
    zweck: 'Isoliertes Lab für Tests',
    dokumentart: 'testprotokoll',
    parameter: [
      { name: 'vlan', typ: 'vlan', pflicht: true, beschreibung: 'VLAN-ID', beispiel: 832 },
      { name: 'netz', typ: 'cidr', pflicht: true, beschreibung: 'Lab-Netz', beispiel: '10.203.32.0/28' },
      { name: 'gateway', typ: 'ipv4', pflicht: false, beschreibung: 'Gateway', ableitung: { funktion: 'erste_adresse', von: 'netz' } },
      { name: 'vmid', typ: 'vmid', pflicht: true, beschreibung: 'VMID Server', beispiel: 157 },
      { name: 'name_server', typ: 'name', pflicht: true, beschreibung: 'Servername', beispiel: 'labsrv01' },
    ],
    annahmen: [
      { id: 'vmid_frei', text: 'VMID ist frei', pruefung: { typ: 'skill', skill: 'proxmox', aktion: 'vm_status', parameter: { vmid: '{{param.vmid}}' }, nichtEnthalten: 'existiert' } },
    ],
    changes: [
      {
        schluessel: 'aufbau', titel: 'Aufbau VLAN {{param.vlan}}', begruendung: 'Lab aufbauen', typ: 'normal', risiko: 'high', abhaengigVon: [],
        schritte: [
          { nr: 1, titel: 'Netz anlegen', art: 'aktion', skill: 'unifi', aktion: 'create_network', parameter: { vlan: '{{param.vlan}}', gateway: '{{param.gateway}}', name: 'lab-{{param.vlan}}' }, zeitlimitS: 300, beiFehler: 'anhalten', kapitel: '3' },
          { nr: 2, titel: 'VM anlegen', art: 'aktion', skill: 'proxmox', aktion: 'create_vm', parameter: { vmid: '{{param.vmid}}', name: '{{param.name_server}}', netz_id: '{{schritt1.id}}' }, zeitlimitS: 600, beiFehler: 'anhalten' },
        ],
      },
      {
        schluessel: 'abbau', titel: 'Abbau', begruendung: 'Lab abbauen', typ: 'normal', risiko: 'medium', abhaengigVon: ['aufbau'],
        schritte: [
          { nr: 1, titel: 'Netz löschen', art: 'aktion', skill: 'unifi', aktion: 'delete_network', parameter: { id: '{{change:aufbau.schritt1.id}}' }, zeitlimitS: 300, beiFehler: 'anhalten' },
        ],
      },
    ],
  };
}
