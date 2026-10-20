import { describe, it, expect } from 'vitest';
import { EigeneUploads, ablageOhneRueckfrage, EIGENER_UPLOAD_MS } from '../geraete/ablage-regel.js';
import { GeraetSkill, dateiNameAusQuelle, nichtSchreibfreigegeben } from '../geraete/geraet-skill.js';
import { Freigaben } from '../geraete/freigaben.js';

const DL = 'C:\\Users\\madh\\Downloads';
const KEY = 'f165df7a/2026-10-20T09-06-51-330Z_foto-1.jpg';

describe('v1529 B — Ablage ohne Rückfrage', () => {
  it('eigene Uploads gelten 30 Minuten', () => {
    let t = 0;
    const e = new EigeneUploads(() => t);
    e.merke(KEY);
    expect(e.istEigen(KEY)).toBe(true);
    expect(e.istEigen('fremd')).toBe(false);
    t = EIGENER_UPLOAD_MS + 1;
    expect(e.istEigen(KEY)).toBe(false);
  });
  it('nur eigener Upload + Ablage-Ordner + Gespräch', () => {
    const eigen = (q: string) => q === KEY;
    const basis = { quelle: KEY, ziel: `${DL}\\foto-1.jpg`, eigen, ordner: [DL], mitHerkunft: true, win: true };
    expect(ablageOhneRueckfrage(basis)).toBe(DL);
    expect(ablageOhneRueckfrage({ ...basis, ziel: 'c:/users/madh/downloads' })).toBe(DL); // Windows: Groß/klein und Trenner egal
    expect(ablageOhneRueckfrage({ ...basis, quelle: 'anderer/key.js' })).toBeUndefined(); // nicht selbst geschickt
    expect(ablageOhneRueckfrage({ ...basis, ziel: 'C:\\Users\\madh\\Documents\\x.jpg' })).toBeUndefined(); // anderer Ordner
    expect(ablageOhneRueckfrage({ ...basis, ziel: `${DL}\\..\\Desktop\\x.jpg` })).toBeUndefined(); // kein Ausbruch
    expect(ablageOhneRueckfrage({ ...basis, mitHerkunft: false })).toBeUndefined();
    expect(ablageOhneRueckfrage({ ...basis, ordner: undefined })).toBeUndefined(); // Gerät meldet keine Ablage-Ordner
  });
  it('Dateiname aus dem FileStore-Schlüssel', () => {
    expect(dateiNameAusQuelle(KEY)).toBe('foto-1.jpg');
    expect(dateiNameAusQuelle('/root/alfred/data/x.pdf')).toBe('x.pdf');
  });
});

describe('v1529 A — gebündelte Bestätigung im Geräte-Skill', () => {
  function skill(o: { eigen?: string[]; ordner?: string[]; frei?: string[] } = {}) {
    const gesendet: Array<Record<string, unknown>> = [];
    const fragen: Array<{ description: string; aktion: string; params: Record<string, unknown> }> = [];
    const fg = new Freigaben();
    const s = new GeraetSkill({
      geraetId: 'g', name: 'PC-madh', skillName: 'geraet_pc', istOwner: () => true, sammelMs: 5,
      manifest: { plattform: 'windows', aktionen: [{ name: 'datei_ablegen', beschreibung: 'x', autonomie: 'bestaetigen', parameter: { path: { type: 'string', description: '' }, quelle: { type: 'string', description: '' } } }] },
      pruefeFreigabe: (n: unknown, a: string, p: Record<string, unknown>) => fg.verbrauche(n, 'geraet_pc', a, p),
      vorhaben: { erzeuge: () => ({}), aktiviere: () => undefined, deckt: () => undefined },
      bestaetigung: async (f: { description: string; aktion: string; params: Record<string, unknown> }) => { fragen.push({ ...f, params: { ...f.params, freigabe: fg.erzeuge('geraet_pc', f.aktion, f.params) } }); return true; },
      sendeAktion: async (_a: string, p: Record<string, unknown>) => { gesendet.push(p); return { success: true, display: 'abgelegt', dauerMs: 1 }; },
      dateien: { lade: async (q: string) => ({ name: q.split('/').pop()!.replace(/^.*Z_/, ''), data: Buffer.from('bild') }), speichere: async () => 'k' },
      ablageOrdner: () => o.ordner,
      eigenerUpload: (q: string) => (o.eigen ?? []).includes(q),
      schreibFreigaben: () => o.frei,
    } as never);
    return { s, gesendet, fragen };
  }
  const ctx = { userId: 'u', masterUserId: 'u', chatId: 'c', platform: 'api' } as never;
  const warte = () => new Promise(r => setTimeout(r, 30));
  const keys = [1, 2, 3, 4].map(i => `u/2026-10-20T09-06-51-33${i}Z_foto-${i}.jpg`);

  it('Realfall 11:07: vier Fotos fremder Herkunft → eine Bestätigung, nach dem Ja alle vier abgelegt', async () => {
    const { s, gesendet, fragen } = skill({ ordner: [DL] });
    const r = await Promise.all(keys.map((k, i) => s.execute({ action: 'datei_ablegen', quelle: k, path: `${DL}\\foto-${i + 1}.jpg` }, ctx)));
    expect(r.every(x => x.success)).toBe(true);
    await warte();
    expect(fragen).toHaveLength(1);
    expect(fragen[0]!.aktion).toBe('datei_ablegen_mehrere');
    expect(fragen[0]!.description).toContain('4 Dateien ablegen in C:\\Users\\madh\\Downloads');
    expect(fragen[0]!.description).toContain('foto-1.jpg, foto-2.jpg');
    expect(gesendet).toHaveLength(0);
    const ja = await s.execute(fragen[0]!.params, ctx); // Owner tippt Ja → Queue ruft mit Einmal-Freigabe auf
    expect(ja.success).toBe(true);
    expect(ja.display).toContain('4 von 4 Dateien');
    expect(gesendet.map(p => p.dateiName)).toEqual(['foto-1.jpg', 'foto-2.jpg', 'foto-3.jpg', 'foto-4.jpg']);
    expect(gesendet[0]!.inhaltBase64).toBe(Buffer.from('bild').toString('base64'));
    // dieselbe Freigabe nicht zweimal
    expect((await s.execute(fragen[0]!.params, ctx)).success).toBe(false);
  });
  it('eine Datei: Bestätigung wie bisher (datei_ablegen)', async () => {
    const { s, fragen, gesendet } = skill({ ordner: [DL] });
    await s.execute({ action: 'datei_ablegen', quelle: keys[0], path: 'C:\\Users\\madh\\Documents' }, ctx);
    await warte();
    expect(fragen.map(f => f.aktion)).toEqual(['datei_ablegen']);
    await s.execute(fragen[0]!.params, ctx);
    expect(gesendet).toHaveLength(1);
  });
  it('B: eigene Uploads in die Downloads ohne Rückfrage, andere Ordner gebündelt gefragt', async () => {
    const { s, fragen, gesendet } = skill({ ordner: [DL], eigen: keys });
    await Promise.all(keys.slice(0, 3).map(k => s.execute({ action: 'datei_ablegen', quelle: k, path: DL }, ctx)));
    expect(gesendet).toHaveLength(3);
    await s.execute({ action: 'datei_ablegen', quelle: keys[3], path: 'C:\\Users\\madh\\Desktop' }, ctx);
    await warte();
    expect(fragen).toHaveLength(1);
    expect(gesendet).toHaveLength(3);
  });
  it('v1530: Ziel ohne Schreibfreigabe → sofort Hinweis, keine Bestätigung (Realfall Schreibtisch 12:59)', async () => {
    const { s, fragen, gesendet } = skill({ ordner: [DL], frei: ['C:\\Users\\madh\\Documents', DL] });
    const r = await s.execute({ action: 'datei_ablegen', quelle: keys[0], path: 'C:\\Users\\madh\\Desktop\\foto-1.jpg' }, ctx);
    await warte();
    expect(r.success).toBe(false);
    expect(r.error).toContain('nicht zum Schreiben freigegeben');
    expect(r.error).toContain('freigabe_aendern');
    expect(fragen).toHaveLength(0);
    expect(gesendet).toHaveLength(0);
    // freigegebener Ordner (Groß/klein egal) fragt wie gewohnt
    await s.execute({ action: 'datei_ablegen', quelle: keys[0], path: 'c:/users/madh/documents/x.jpg' }, ctx);
    await warte();
    expect(fragen).toHaveLength(1);
  });
  it('v1530: ohne gemeldete Freigaben (älterer Satellit) und bei ~-Pfaden entscheidet das Gerät', () => {
    expect(nichtSchreibfreigegeben('C:\\x\\y.jpg', undefined, true)).toBeUndefined();
    expect(nichtSchreibfreigegeben('~/Desktop/y.jpg', ['/home/madh/Documents'], false)).toBeUndefined();
    expect(nichtSchreibfreigegeben('/home/madh/Desktop/y.jpg', ['/home/madh/Documents'], false)?.ziel).toBe('/home/madh/Desktop/y.jpg');
    expect(nichtSchreibfreigegeben('/home/madh/Documents/a/y.jpg', ['/home/madh/Documents'], false)).toBeUndefined();
  });
  it('datei_ablegen_mehrere ohne Freigabe wird abgewiesen (das Modell kann es nicht selbst auslösen)', async () => {
    const { s, gesendet } = skill();
    const r = await s.execute({ action: 'datei_ablegen_mehrere', dateien: [{ quelle: keys[0], path: DL }] }, ctx);
    expect(r.success).toBe(false);
    expect(gesendet).toHaveLength(0);
  });
});
