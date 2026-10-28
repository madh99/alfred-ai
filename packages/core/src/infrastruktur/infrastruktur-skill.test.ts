import { describe, it, expect } from 'vitest';
import { InfrastrukturSkill, BESTAND_QUELLEN } from './infrastruktur-skill.js';
import type { SkillContext } from '@alfred/types';

// I1 — Skill infrastruktur.bestand: Discovery der Quellen, Bericht, Ablage als CMDB-Dokument; nur der Owner
describe('I1 InfrastrukturSkill', () => {
  it('bestand: entdeckt die Quellen, baut den Bericht, legt ihn ab und meldet Auffälligkeiten', async () => {
    const entdeckt: string[][] = []; let gespeichert = '';
    const s = new InfrastrukturSkill({
      istOwner: (c) => c.userId === 'owner',
      entdecke: async (q) => { entdeckt.push(q); return q.map(x => `${x}: 1 Assets, 0 Relationen`); },
      hosts: () => [{ zugang: 'dockerhost', host: '192.168.1.211', dateisysteme: [], dienste: ['docker'], ports: [], container: [{ name: 'noah', image: 'x', zustand: 'running', status: 'Up (unhealthy)', gesundheit: 'unhealthy', ports: '', netze: [], mounts: [] }], compose: [], volumes: [], fehler: [] }],
      vms: async () => [{ name: 'docker-host', typ: 'vm', status: 'active', vmid: 120 }],
      proxy: async () => [], netze: async () => [],
      backups: async () => ({ jeVm: {}, ohne: [{ vmid: 120, name: 'docker-host' }], unerreichbar: [] }),
      speichereBericht: async (_t, m) => { gespeichert = m; return 'doc-1'; },
    });
    const r = await s.execute({ action: 'bestand' }, { userId: 'owner' } as SkillContext);
    expect(r.success).toBe(true);
    expect(entdeckt[0]).toEqual(BESTAND_QUELLEN);
    expect(gespeichert).toContain('# Bestandsbericht');
    expect(gespeichert).toContain('## Discovery');
    expect(r.display).toContain('Container noah ist unhealthy');
    expect(r.display).toContain('VM/CT 120 (docker-host) hat keine Sicherung');
    expect(r.display).toContain('doc-1');
    expect((await s.execute({ action: 'bestand' }, { userId: 'fremd' } as SkillContext)).success).toBe(false);
  });
});

describe('v1653 Planungshinweise', () => {
  it('Container-Nachbau verlangt originalgetreue Netze mit IPAM und festen Container-IPs', () => {
    const s = new InfrastrukturSkill({ istOwner: () => true } as never);
    expect(s.metadata.description).toContain('CONTAINER-NACHBAU');
    expect(s.metadata.description).toContain('IPAMConfig');
  });
});

// I2 — Vorhaben: anlegen, Grundlage, Architektur (abgewiesen → gültig), Entscheidung
describe('I2 Vorhaben im Skill', () => {
  it('führt durch den Ablauf und hält die Statusregeln ein', async () => {
    const { InfrastrukturSkill: S } = await import('./infrastruktur-skill.js');
    type V = import('./infrastruktur-skill.js').VorhabenDaten;
    const db = new Map<string, V>();
    let entdeckt = 0; const docs: string[] = [];
    const host = { zugang: 'dockerhost', host: '192.168.1.211', dateisysteme: [], dienste: ['docker'], ports: [], fehler: [], compose: [], volumes: [], erfasst: new Date().toISOString(),
      container: [{ name: 'dashy', image: 'lissy93/dashy', zustand: 'running', status: 'Up', ports: '0.0.0.0:4000->8080/tcp', netze: [], mounts: [], ramBytes: 80 * 1024 ** 2 }] };
    const s = new S({
      istOwner: c => c.userId === 'owner', ownerId: () => 'o1',
      entdecke: async () => { entdeckt++; return []; }, hosts: () => [host],
      vms: async () => [], proxy: async () => [], netze: async () => [{ quelle: 'unifi', name: 'Default', vlan: 1 }], speichereBericht: async () => 'x',
      aktiveZugaenge: async () => ['pve', 'dockerhost'],
      knoten: async () => [{ name: 'pve', online: true, ramGesamt: 64 * 1024 ** 3, ramBelegt: 10 * 1024 ** 3 }], speicher: async () => [],
      letzterBestandDocId: async () => 'bestand-1',
      speichereArchitektur: async (_id, _t, md) => { docs.push(md); return `arch-${docs.length}`; },
      vorhaben: {
        liste: async () => [...db.values()],
        finde: async (_u, k) => db.get(k) ?? [...db.values()].find(v => v.id.startsWith(k) || v.titel === k) ?? null,
        anlegen: async (_u, e) => { const v: V = { id: 'v-123456789', ...e, status: 'entwurf', architekturVersion: 0, entscheidungen: [], changeIds: [], erstellt: 'jetzt' }; db.set(v.id, v); return v; },
        setzeArchitektur: async (_u, id, _a, docId) => { const v = db.get(id)!; Object.assign(v, { architekturDocId: docId, architekturVersion: v.architekturVersion + 1, status: 'architektur_vorgeschlagen' }); return v; },
        entscheide: async (_u, id, e, status) => { const v = db.get(id)!; v.entscheidungen.push({ zeit: 'jetzt', ...e }); v.status = status; return v; },
      },
    });
    const ctx = { userId: 'owner' } as SkillContext;
    expect((await s.execute({ action: 'vorhaben_anlegen', titel: 'Aufteilen', ziel: 'dockerhost auf neue VMs verteilen', hosts: ['gibtsnicht'] }, ctx)).error).toContain('Kein aktiver Fernzugang');
    const an = await s.execute({ action: 'vorhaben_anlegen', titel: 'Aufteilen', ziel: 'dockerhost auf neue VMs verteilen', hosts: ['DockerHost'] }, ctx);
    expect(an.success).toBe(true);
    expect(db.get('v-123456789')).toMatchObject({ hosts: ['dockerhost'], bestandDocId: 'bestand-1' });
    const g = await s.execute({ action: 'grundlage', vorhaben: 'v-1234' }, ctx);
    expect(g.display).toContain('| dashy | container | dockerhost |');
    expect(entdeckt).toBe(0); // frischer Bestand → keine neue Erfassung
    expect((await s.execute({ action: 'entscheiden', vorhaben: 'v-1234', entscheidung: 'annehmen', wortlaut: 'ja' }, ctx)).error).toContain('nur bei vorgeschlagener Architektur');
    const schlecht = await s.execute({ action: 'architektur_vorschlagen', vorhaben: 'v-1234', architektur: { gruppen: [] } }, ctx);
    expect(schlecht.success).toBe(false);
    expect(schlecht.error).toContain('Nicht zugeordnete Einheiten');
    expect(docs).toEqual([]);
    const arch = {
      zusammenfassung: 'Dashy zieht in eine kleine eigene VM, der Host bleibt vorerst stehen.',
      gruppen: [
        { name: 'Web', zweck: 'Dashboards', begruendung: 'klein, unkritisch', einheiten: ['dashy'], ziel: 'vm', vmName: 'web1', knoten: 'pve', vcpu: 1, ramGb: 2, diskGb: 20, distribution: 'debian-12', distributionBegruendung: 'Standard', netz: 'Default' },
        { name: 'Alt', zweck: 'Altsystem', begruendung: 'bleibt bis zur Stilllegung', einheiten: ['dockerhost'], ziel: 'bleibt' },
      ],
      sicherung: 'Snapshot vor Change', updates: 'automatisch', reihenfolge: [{ gruppe: 'Web', ausfallMinuten: 5 }], risiken: [{ risiko: 'Port belegt', massnahme: 'vorher prüfen' }],
    };
    const ok = await s.execute({ action: 'architektur_vorschlagen', vorhaben: 'Aufteilen', architektur: JSON.stringify(arch) }, ctx);
    expect(ok.success).toBe(true);
    expect(docs[0]).toContain('# Zielarchitektur: Aufteilen (Version 1)');
    expect(db.get('v-123456789')!.status).toBe('architektur_vorgeschlagen');
    expect((await s.execute({ action: 'entscheiden', vorhaben: 'v-1234', entscheidung: 'annehmen', wortlaut: '' }, ctx)).success).toBe(false);
    const ja = await s.execute({ action: 'entscheiden', vorhaben: 'v-1234', entscheidung: 'annehmen', wortlaut: 'passt so' }, ctx);
    expect(ja.display).toContain('Architektur angenommen');
    expect((await s.execute({ action: 'architektur_vorschlagen', vorhaben: 'v-1234', architektur: arch }, ctx)).error).toContain('bereits angenommen');
    expect((await s.execute({ action: 'vorhaben_zeigen', vorhaben: 'v-1234' }, ctx)).display).toContain('annehmen (Version 1): „passt so“');
  });
});

// Realfall 22.10. (4dc47fa3): das Ja zum Rückweg landete in der Vorhaben-Suche („Vorhaben „“ nicht gefunden“)
describe('Owner-Antworten an den Motor', () => {
  it('rueckweg_ausfuehren und owner_schritt_erledigt erreichen den Motor', async () => {
    const { InfrastrukturSkill: S } = await import('./infrastruktur-skill.js');
    const aufrufe: string[] = [];
    const s = new S({
      istOwner: (c: SkillContext) => c.userId === 'owner', ownerId: () => 'o1',
      entdecke: async () => [], hosts: () => [], vms: async () => [], proxy: async () => [], netze: async () => [], speichereBericht: async () => 'x',
      aktiveZugaenge: async () => [], knoten: async () => [], speicher: async () => [], letzterBestandDocId: async () => undefined,
      vorhaben: { liste: async () => [], finde: async () => null } as never,
      changes: { finde: async (_o: string, k: string) => (k.startsWith('4dc47fa3') ? { id: '4dc47fa3-x' } : null) } as never,
      motor: {
        rueckwegNachJa: async (_o: string, id: string, f: unknown) => { aufrufe.push(`rueckweg:${id}:${String(f)}`); return 'Rückweg läuft (1 Schritt).'; },
        ownerSchrittErledigt: async (_o: string, id: string, n: number) => { aufrufe.push(`owner:${id}:${n}`); return 'Schritt 2 erledigt — der Change läuft weiter.'; },
      } as never,
    } as never);
    const ctx = { userId: 'owner' } as SkillContext;
    const r = await s.execute({ action: 'rueckweg_ausfuehren', change: '4dc47fa3-855d', freigabe: 'n1' }, ctx);
    expect(r.success).toBe(true);
    expect(r.display).toContain('Rückweg läuft');
    expect((await s.execute({ action: 'owner_schritt_erledigt', change: '4dc47fa3', schritt: 2, freigabe: 'n2' }, ctx)).success).toBe(true);
    expect(aufrufe).toEqual(['rueckweg:4dc47fa3-x:n1', 'owner:4dc47fa3-x:2']);
  });
});

// v1695 (K4) — große Pläne und Architektur ohne Umweg vollständig abrufbar
describe('v1695 change_zeigen nur_schritte / vorhaben_zeigen abschnitt', () => {
  const schritte = Array.from({ length: 56 }, (_, i) => ({ nr: i + 1, titel: `Schritt ${i + 1}`, art: 'aktion', skill: 'fernzugriff', aktion: 'ausfuehren', parameter: { name: 'pve', befehl: `python3 -c 'print(${'x'.repeat(400)})'` }, beiFehler: 'anhalten' }));
  const change = { id: 'a3982e74-xxxx', title: 'Restoretest', status: 'submitted', type: 'normal', riskLevel: 'low', schritte, affectedAssetIds: [] };
  const vorhaben = { id: 'cf82f3f2-xxxx', titel: 'Dockerhost', ziel: 'z', hosts: [], status: 'angenommen', architekturVersion: 12, entscheidungen: [], changeIds: [], erstellt: 'x',
    architektur: { zusammenfassung: 'Z', reihenfolge: [{ gruppe: 'A' }, { gruppe: 'B' }, { gruppe: 'C' }] } };
  const s = new InfrastrukturSkill({ istOwner: () => true, ownerId: () => 'o', changes: { finde: async () => change }, vorhaben: { finde: async () => vorhaben } } as never);
  const ctx = { userId: 'owner' } as SkillContext;
  it('einzelne Schritte vollständig, unbekannte Nummern klar abgewiesen, lange Übersicht mit Hinweis', async () => {
    const r = await s.execute({ action: 'change_zeigen', change: 'a3982e74', nur_schritte: [8, 19] }, ctx);
    expect(r.success).toBe(true);
    expect(r.display).toContain('### Schritt 8');
    expect(r.display).toContain('x'.repeat(400));
    expect((r.data as unknown[]).length).toBe(2);
    expect((await s.execute({ action: 'change_zeigen', change: 'a3982e74', nur_schritte: [99] }, ctx)).error).toContain('1–56');
    expect((await s.execute({ action: 'change_zeigen', change: 'a3982e74' }, ctx)).display).toContain('nur_schritte');
  });
  it('Architektur-Abschnitt vollständig, Listen mit von/bis, unbekannter Abschnitt nennt die vorhandenen', async () => {
    const r = await s.execute({ action: 'vorhaben_zeigen', vorhaben: 'cf82f3f2', abschnitt: 'reihenfolge', von: 2, bis: 3 }, ctx);
    expect(r.data).toEqual([{ gruppe: 'B' }, { gruppe: 'C' }]);
    expect(r.display).toContain('3 Einträge, gezeigt 2–3');
    expect((await s.execute({ action: 'vorhaben_zeigen', vorhaben: 'cf82f3f2', abschnitt: 'gruppen' }, ctx)).error).toContain('zusammenfassung, reihenfolge');
  });
});

describe('v1695 (K5) Planen/Freigeben nie im Unteragenten', () => {
  it('changes_planen und freigabe_anfragen aus delegate abgewiesen, Lesen erlaubt', async () => {
    const vorhaben = { id: 'cf82f3f2-xxxx', titel: 'D', ziel: 'z', hosts: [], status: 'angenommen', architekturVersion: 1, entscheidungen: [], changeIds: [], erstellt: 'x', architektur: { zusammenfassung: 'Z' } };
    const s = new InfrastrukturSkill({ istOwner: () => true, ownerId: () => 'o', vorhaben: { finde: async () => vorhaben } } as never);
    const sub = { userId: 'owner', unteragent: true } as SkillContext;
    expect((await s.execute({ action: 'changes_planen', changes: [] }, sub)).error).toContain('nur im Hauptgespräch');
    expect((await s.execute({ action: 'freigabe_anfragen', ids: ['x'] }, sub)).error).toContain('nur im Hauptgespräch');
    expect((await s.execute({ action: 'vorhaben_zeigen', vorhaben: 'cf82f3f2', abschnitt: 'zusammenfassung' }, sub)).success).toBe(true);
  });
});

describe('v1701 change_aendern geplant_ab allein', () => {
  it('ändert nur den Termin, Schritte bleiben gleich', async () => {
    const schritte = [{ nr: 1, titel: 'a', art: 'pruefung', pruefung: { typ: 'ping', ziel: 'x' }, beiFehler: 'anhalten' }];
    const c = { id: '89b972b8-xxxx', title: 'I9 – 144', status: 'submitted', type: 'normal', riskLevel: 'high', schritte, affectedAssetIds: ['a1'], scheduledAt: '2026-10-27T23:30:00.000Z' };
    let geaendert: Record<string, unknown> | undefined;
    const s = new InfrastrukturSkill({ istOwner: () => true, ownerId: () => 'o', vorhaben: { finde: async () => null }, changes: { finde: async () => c, aendern: async (_o: string, _id: string, plan: Record<string, unknown>) => { geaendert = plan; return { ok: true, change: { ...c, fingerabdruck: 'f'.repeat(12) }, freigabeVerfallen: true }; } } } as never);
    const r = await s.execute({ action: 'change_aendern', change: '89b972b8', geplant_ab: '2026-10-29T00:30:00+01:00' }, { userId: 'owner' } as SkillContext);
    expect(r.success, r.error).toBe(true);
    expect(geaendert!.geplantAb).toBe('2026-10-29T00:30:00+01:00');
    expect(geaendert!.schritte).toEqual(schritte);
  });
});
