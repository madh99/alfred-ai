import { describe, it, expect } from 'vitest';
import { planungsKandidaten, planungsAuftrag, neuerChange, type PlanProblem } from './planung.js';
import type { Komponente, Treffer } from './bewertung.js';

const t = (id: string, stufe: Treffer['stufe'], x: Partial<Treffer> = {}): Treffer => ({ id, aliase: [id], titel: '', schwere: 'hoch', link: '', quellen: ['trivy'], paket: 'p', installiert: '1', stufe, basis: true, behoben: '2', erkannt: '2026-11-25T05:00:00Z', ...x });
const k = (host: string, name: string, treffer: Treffer[], erreichbar = false, art: Komponente['art'] = 'container'): Komponente =>
  ({ schluessel: `${host}/${name}`, host, name, art, erreichbar, treffer, nichtGeprueft: [], geprueft: [], quellenFehler: false });
const p = (host: string, name: string, x: Partial<PlanProblem> = {}): PlanProblem => ({ id: `p-${name}-0000`, schluessel: `sicherheit:${host}:${name}`, text: `${host}: KRITISCH — ${name}`, affectedAssetIds: [`a-${name}`], ...x });

describe('Schwachstellen A2 — Planungskandidaten', () => {
  const komp = [
    k('h', 'nur-krit', [t('C1', 'kritisch')]),
    k('h', 'kev-aussen', [t('C2', 'kritisch', { kev: '2023-01-01' })], true),
    k('h', 'aussen', [t('C3', 'kritisch'), t('C4', 'kritisch')], true),
    k('h', 'kev', [t('C5', 'kritisch', { kev: '2023-01-01' })]),
    k('h', 'hoch', [t('H1', 'hoch')]),
    k('h', 'ohne-fix', [t('CVE-2011-3389', 'kritisch', { behoben: undefined })], true),
    k('h', 'sicherheitsupdates', [t('C6', 'kritisch', { basis: false })], false, 'host'),
  ];
  const probs = komp.map(c => p(c.host, c.name));

  it('kritische zuerst: KEV und erreichbar, dann KEV, dann erreichbar, dann Rest; ohne Fix und Host-Pakete nie', () => {
    expect(planungsKandidaten(komp, probs, []).map(x => x.name)).toEqual(['kev-aussen', 'kev', 'aussen', 'nur-krit']);
  });
  it('hohe erst, wenn kein kritischer Kandidat mehr offen ist (nach frühester Erkennung)', () => {
    const changes = ['kev-aussen', 'kev', 'aussen', 'nur-krit'].map(n => ({ id: `c-${n}`, status: 'submitted', affectedAssetIds: [`a-${n}`] }));
    expect(planungsKandidaten(komp, probs, changes).map(x => x.name)).toEqual(['hoch']);
  });
  it('offener Change über gemeinsames Asset (auch Entwurf) oder verknüpfter, nicht abgeschlossener Change → kein zweiter Plan', () => {
    const ein = [komp[0]!];
    expect(planungsKandidaten(ein, [p('h', 'nur-krit')], [{ id: 'x', status: 'draft', affectedAssetIds: ['a-nur-krit'] }])).toEqual([]);
    for (const status of ['cancelled', 'failed', 'rolled_back', 'approved']) {
      expect(planungsKandidaten(ein, [p('h', 'nur-krit', { linkedChangeRequestId: 'y', affectedAssetIds: [] })], [{ id: 'y', status, affectedAssetIds: [] }])).toEqual([]);
    }
    expect(planungsKandidaten(ein, [p('h', 'nur-krit', { linkedChangeRequestId: 'y' })], [{ id: 'y', status: 'completed', affectedAssetIds: ['a-nur-krit'] }])).toHaveLength(1);
    expect(planungsKandidaten(ein, [p('h', 'nur-krit', { linkedChangeRequestId: 'geloescht' })], [])).toHaveLength(1);
  });
  it('ohne Problem kein Kandidat', () => {
    expect(planungsKandidaten(komp, [], [])).toEqual([]);
  });
  it('Auftrag: fester Text, genau ein Change, Freigabe anfragen, nichts ausführen', () => {
    const [x] = planungsKandidaten([komp[1]!], [probs[1]!], []);
    const a = planungsAuftrag(x!, 'guacamole/guacamole:latest');
    expect(a).toContain('Problem p-kev-au');
    expect(a).toContain('Container kev-aussen auf h (Image guacamole/guacamole:latest)');
    expect(a).toContain('genau EINEN Change');
    expect(a).toContain('danach freigabe_anfragen. Nichts ausführen.');
  });
  it('neuer Change: genau ein neuer offener Change mit gemeinsamem Asset oder Namen im Titel', () => {
    const [x] = planungsKandidaten([komp[0]!], [probs[0]!], []);
    const alt = new Set(['alt']);
    expect(neuerChange(x!, ['a-nur-krit'], alt, [{ id: 'alt', status: 'submitted', affectedAssetIds: ['a-nur-krit'], title: '' }, { id: 'neu', status: 'submitted', affectedAssetIds: ['a-nur-krit'], title: 'Image' }])).toBe('neu');
    expect(neuerChange(x!, [], alt, [{ id: 'neu', status: 'draft', affectedAssetIds: [], title: 'nur-krit aktualisieren' }])).toBe('neu');
    expect(neuerChange(x!, ['a-nur-krit'], alt, [{ id: 'n1', status: 'submitted', affectedAssetIds: ['a-nur-krit'], title: '' }, { id: 'n2', status: 'submitted', affectedAssetIds: ['a-nur-krit'], title: '' }])).toBeUndefined();
    expect(neuerChange(x!, ['a-nur-krit'], alt, [])).toBeUndefined();
  });
});
