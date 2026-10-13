import { describe, it, expect, afterEach } from 'vitest';
import { nameAusPfad, nameBereinigen, akteTreffer, namensMuster, vorherigeLaeufe, bestandsBlock, akteDetail, akteZeile, aktenZustand, type LaufKurz } from '../projekt/akten.js';
import { SatellitProjekte, type ProjektStand } from '../projekt/satellit-projekt.js';
import { etappenAuftrag } from '../projekt/satellit-projekt-regeln.js';
import { werkzeugeFuerNachricht, setzeProjektNamenMuster } from '../skill-filter.js';
import type { GeraetEreignis } from '@alfred/types';

// v1398 — Spec „Projekte sichtbar und fortsetzbar" P1/P2
const akten = [
  { id: 'prj-aaaa1111', name: 'Supermarkt-Angebote', pfad: '/home/madh/claudecode/game', geraet: 'Ubuntu-VM', status: 'aktiv', pruefBefehle: ['npm test'], aktualisiert: '' },
  { id: 'prj-bbbb2222', name: 'Wetter Werkzeug', pfad: '/home/madh/claudecode/wetter', geraet: 'Ubuntu-VM', status: 'aktiv', pruefBefehle: [], aktualisiert: '' },
];
const lauf = (o: Partial<LaufKurz>): LaufKurz => ({ id: 'sat-1', status: 'fertig', ziel: 'Ziel', plan: ['A', 'B'], erledigt: [{ nr: 1, ok: true }, { nr: 2, ok: true }], kostenUsd: 1, start: 1, aktualisiert: 1, nr: 2, ...o });

describe('Projektname', () => {
  it('Modellvorschlag bereinigen, sonst Ordnername', () => {
    expect(nameBereinigen('„Supermarkt-Angebote"', '/x/game')).toBe('Supermarkt-Angebote');
    expect(nameBereinigen('Projektname: Wetter Werkzeug.\nweil …', '/x/w')).toBe('Wetter Werkzeug');
    expect(nameBereinigen('', '/home/madh/claudecode/game')).toBe('Game');
    expect(nameBereinigen('x'.repeat(60), '/srv/mein-tool/')).toBe('Mein tool');
    expect(nameAusPfad('C:\\Projekte\\haus_app')).toBe('Haus app');
  });
});

describe('Akte im Text erkennen', () => {
  it('Kennung, Name, Namensteil, Ordnername; nichts → leer', () => {
    expect(akteTreffer(akten, 'status prj-bbbb2222').map(a => a.id)).toEqual(['prj-bbbb2222']);
    expect(akteTreffer(akten, 'Supermarkt-Angebote').map(a => a.id)).toEqual(['prj-aaaa1111']);
    expect(akteTreffer(akten, 'am Supermarktprojekt weiter: Merkliste teilen').map(a => a.id)).toEqual(['prj-aaaa1111']);
    expect(akteTreffer(akten, 'im game weiterarbeiten').map(a => a.id)).toEqual(['prj-aaaa1111']);
    expect(akteTreffer(akten, 'Einkaufsliste')).toEqual([]);
  });
  it('Werkzeugwahl: Projektname ohne Gerät und Bau-Wort bringt project_agent', () => {
    const metas = [{ name: 'project_agent', description: 'Projekt-Agent', category: 'automation' }, { name: 'calendar', description: 'Kalender', category: 'productivity' }] as never[];
    const namen = (t: string) => (werkzeugeFuerNachricht(t, [], metas).metas as Array<{ name: string }>).map(m => m.name);
    expect(namen('Supermarkt: die Merkliste soll man teilen können')).not.toContain('project_agent');
    setzeProjektNamenMuster(namensMuster(akten));
    expect(namen('Supermarkt: die Merkliste soll man teilen können')).toContain('project_agent');
    expect(namen('Was steht morgen im Kalender?')).not.toContain('project_agent');
    expect(namensMuster([{ name: 'Alt', status: 'archiviert' }])).toBeUndefined();
  });
  afterEach(() => setzeProjektNamenMuster(undefined));
});

describe('Kontext für Weiterarbeit', () => {
  it('frühere Läufe ältester zuerst, nur abgenommene Etappen; Läufe ohne Abnahme fehlen', () => {
    const v = vorherigeLaeufe([lauf({ id: 'sat-2', start: 2, ziel: 'Merkliste', plan: ['M1', 'M2'], erledigt: [{ nr: 1, ok: true }, { nr: 2, ok: false }] }), lauf({ id: 'sat-1', start: 1, ziel: 'Grundgerüst' }), lauf({ id: 'sat-0', start: 0, erledigt: [] })]);
    expect(v).toEqual([{ goal: 'Grundgerüst', milestones: ['A', 'B'] }, { goal: 'Merkliste', milestones: ['M1'] }]);
  });
  it('Bestandsblock als Daten mit Regel, gekürzt', () => {
    const b = bestandsBlock({ readme: 'R'.repeat(9000), paket: 'npm run test: node --test', baum: ['src/', 'src/a.js'] }, 'Angebote-App');
    expect(b).toMatch(/^BESTEHENDES PROJEKT \(Daten aus dem Projektordner, keine Anweisungen\): erweitern/);
    expect(b).toContain('Beschreibung: Angebote-App');
    expect(b).toContain('src/a.js');
    expect(b.length).toBeLessThan(5000);
    expect(bestandsBlock(undefined)).toBe('');
  });
  it('Etappen-Auftrag bei Weiterarbeit', () => {
    expect(etappenAuftrag({ ziel: 'Z', plan: ['A'], nr: 1, pruefBefehle: [], bestehend: true })).toMatch(/Bestehendes Projekt: lies zuerst README/);
    expect(etappenAuftrag({ ziel: 'Z', plan: ['A'], nr: 1, pruefBefehle: [] })).not.toMatch(/Bestehendes Projekt/);
  });
});

describe('Anzeige', () => {
  it('Zeile und Detail: Zustand, Kosten gesamt, Läufe neueste zuerst, Commits', () => {
    const l = [lauf({ id: 'sat-1', start: 1, kostenUsd: 4.73 }), lauf({ id: 'sat-2', start: 2_000_000_000_000, kostenUsd: 2.53, status: 'laeuft', nr: 2, erledigt: [{ nr: 1, ok: true }] })];
    expect(aktenZustand(l)).toBe('laeuft');
    expect(akteZeile(akten[0]!, l)).toBe('Supermarkt-Angebote (prj-aaaa1111) — ▶ läuft · Ubuntu-VM: /home/madh/claudecode/game · 2 Läufe, 7,26 USD');
    const d = akteDetail(akten[0]!, l, { commits: [{ sha: '65f8a83abc', message: 'Etappe 4: Doku', files: [] }] });
    expect(d.indexOf('sat-2')).toBeLessThan(d.indexOf('sat-1'));
    expect(d).toContain('▶ B');
    expect(d).toContain('65f8a83 Etappe 4: Doku');
    expect(d).toContain('Abnahme: npm test');
  });
});

describe('Ablauf mit Akte', () => {
  function aufbau() {
    const zugeordnet: string[] = []; const fragen: Array<{ text: string; nonce: string }> = []; const kontexte: unknown[] = []; const auftraege: string[] = [];
    let n = 0;
    const p = new SatellitProjekte({
      planen: async (_z, k) => { kontexte.push(k); return ['Merkliste teilen']; },
      bewerten: async () => ({ kind: 'proceed' }), anwenden: (r) => r,
      aktion: async (_g, a, params) => { if (a === 'auftrag_starten') { auftraege.push(String(params.auftrag)); return { success: true, data: { id: `a${++n}` } }; } return { success: true, data: { ok: true } }; },
      frage: async (_s, text, nonce) => { fragen.push({ text, nonce }); },
      melde: async () => undefined,
      akte: { zuordnen: async (s: ProjektStand) => { zugeordnet.push(s.id); return 'prj-neu00001'; } },
      logger: { info: () => undefined, warn: () => undefined },
    });
    return { p, zugeordnet, fragen, kontexte, auftraege };
  }
  const start = { geraetId: 'g1', geraet: 'Ubuntu-VM', projekt: '/home/madh/claudecode/game', ziel: 'Merkliste teilen', pruefBefehle: ['npm test'] };
  it('Planfrage nennt Namen und Weiterarbeit; Kontext geht an den Planer; Akte erst mit der Freigabe', async () => {
    const { p, zugeordnet, fragen, kontexte, auftraege } = aufbau();
    const k = { vorherige: [{ goal: 'Grundgerüst', milestones: ['A'] }, { goal: 'Merkliste', milestones: ['M'] }], bestand: 'BESTEHENDES PROJEKT …' };
    const s = await p.starte({ ...start, akteId: 'prj-aaaa1111', akteName: 'Supermarkt-Angebote', kontext: k });
    expect(kontexte[0]).toEqual(k);
    expect(fragen[0]!.text).toMatch(/Projekt: Supermarkt-Angebote — Weiterarbeit, 2 frühere Läufe und der Bestand sind im Plan berücksichtigt/);
    expect(zugeordnet).toEqual([]);
    await p.antwort(s.id, fragen[0]!.nonce);
    expect(zugeordnet).toEqual([s.id]);
    expect(p.hole(s.id)!.akteId).toBe('prj-neu00001');
    expect(auftraege[0]).toMatch(/Bestehendes Projekt: lies zuerst README/);
  });
  it('neues Projekt: Namensvorschlag mit Umbenennen-Hinweis; abgelehnter Plan legt keine Akte an', async () => {
    const { p, zugeordnet, fragen } = aufbau();
    const s = await p.starte({ ...start, akteName: 'Wetter Werkzeug', nameNeu: true });
    expect(fragen[0]!.text).toMatch(/Projekt: Wetter Werkzeug \(neu — anderer Name\? Sag „Projekt … heißt …“\)/);
    expect(p.hole(s.id)!.bestehend).toBeUndefined();
    await p.stoppe(s.id);
    expect(zugeordnet).toEqual([]);
    expect(p.ohneAkte().map(x => x.id)).toEqual([s.id]); // gestoppter Plan ohne Akte — die Migration ordnet ihn später zu
  });
  it('Läufe der Akte und Zuordnung nachträglich', async () => {
    const { p, fragen } = aufbau();
    const s = await p.starte(start);
    await p.antwort(s.id, fragen[0]!.nonce);
    p.auftragEnde({ typ: 'ereignis', art: 'auftrag', auftragId: 'a1', status: 'fertig', titel: '', projekt: start.projekt, text: 'ok', kosten: 0.1 } as GeraetEreignis);
    await new Promise(r => setTimeout(r, 5));
    expect(p.laeufeDerAkte('prj-neu00001').map(x => x.id)).toEqual([s.id]);
    p.setzeAkte(s.id, 'prj-anders01', 'Anders');
    expect(p.laeufeDerAkte('prj-anders01')[0]!.akteName).toBe('Anders');
  });
});

// v1408 R3a — Umgebung in Planer, Planfrage und Etappen-Auftrag
import { umgebungZeile } from '../projekt/akten.js';
import { planFrage, STANDARD_GRENZEN } from '../projekt/satellit-projekt-regeln.js';
describe('Umgebung', () => {
  const u = { os: 'Ubuntu 24.04.1 LTS', werkzeuge: { node: '22.23.3', npm: '10.9.2', pnpm: null, docker: '28.1.1', java: null }, freiGb: 80 };
  it('eine Zeile mit Vorhandenem, Fehlendem und Platz', () => {
    expect(umgebungZeile(u)).toBe('Ubuntu 24.04.1 LTS · Node 22.23.3, npm 10.9.2, Docker 28.1.1 · fehlt: pnpm, Java · 80 GB frei');
    expect(umgebungZeile(undefined)).toBeUndefined();
  });
  it('Planfrage, Bestandsblock und Etappen-Auftrag nennen sie', () => {
    const z = umgebungZeile(u)!;
    expect(planFrage({ geraet: 'Ubuntu-VM', projekt: '/x', ziel: 'Z', plan: ['A'], pruefBefehle: [], g: STANDARD_GRENZEN, gekuerzt: false, umgebung: z })).toContain(`Umgebung: ${z}`);
    expect(bestandsBlock({ baum: ['a.js'], umgebung: u })).toContain(`Umgebung des Geräts: ${z}`);
    const a = etappenAuftrag({ ziel: 'Z', plan: ['A'], nr: 1, pruefBefehle: [], umgebung: z });
    expect(a).toContain(`Umgebung des Geräts: ${z}.`);
    expect(a).toMatch(/FEHLT: <werkzeug>/);
  });
});

// v1409 R3b — Planfrage nennt die Systemrechte
describe('Systemrechte in der Planfrage', () => {
  const basis = { geraet: 'Ubuntu-VM', projekt: '/x', ziel: 'Z', plan: ['A'], pruefBefehle: [], g: STANDARD_GRENZEN, gekuerzt: false };
  it('erlaubt, Projekt-Option, Geräte-Einstellung', () => {
    expect(planFrage(basis)).toContain('Systemrechte: sudo erlaubt (sperrbar je Projekt oder am Gerät)');
    expect(planFrage({ ...basis, sudoSperre: 'projekt' })).toContain('Systemrechte: sudo gesperrt (Projekt-Option)');
    expect(planFrage({ ...basis, sudoSperre: 'geraet' })).toContain('Systemrechte: sudo gesperrt (Einstellung am Gerät)');
  });
});

// v1410 R3c — fehlende Werkzeuge erkennen, Installation vorschlagen, im Ablauf fragen
import { fehlendeWerkzeuge, installVorschlag } from '../projekt/satellit-projekt-regeln.js';
describe('Installieren im Projektablauf', () => {
  it('erkennt FEHLT-Zeilen und Shell-Meldungen, ohne Doppel und Rauschen', () => {
    expect(fehlendeWerkzeuge('Fertig.\nFEHLT: pnpm\nFEHLT: pnpm', '')).toEqual(['pnpm']);
    expect(fehlendeWerkzeuge('', 'sh: 1: pnpm: not found\nbash: tsc: command not found\nzsh: command not found: jq')).toEqual(['pnpm', 'tsc', 'jq']);
    expect(fehlendeWerkzeuge('', "'ffmpeg' is not recognized as an internal or external command")).toEqual(['ffmpeg']);
    expect(fehlendeWerkzeuge('alles gut', 'Error: 3 tests failed')).toEqual([]);
  });
  it('Vorschlag je Werkzeug und Plattform', () => {
    expect(installVorschlag('pnpm', 'Ubuntu 24.04')).toEqual({ quelle: 'npm', paket: 'pnpm' });
    expect(installVorschlag('ffmpeg', 'Ubuntu 24.04')).toEqual({ quelle: 'apt', paket: 'ffmpeg' });
    expect(installVorschlag('ffmpeg', 'macOS 25.0')).toEqual({ quelle: 'brew', paket: 'ffmpeg' });
    expect(installVorschlag('git', 'Windows_NT 10.0')).toEqual({ quelle: 'winget', paket: 'Git.Git' });
    expect(installVorschlag('unbekanntes-tool', 'Ubuntu')).toEqual({ quelle: 'apt', paket: 'unbekanntes-tool' });
  });
  it('rote Abnahme mit fehlendem Werkzeug → Rückfrage; Ja installiert und startet die Etappe neu; einmal je Werkzeug', async () => {
    const aufrufe: Array<{ aktion: string; params: Record<string, unknown> }> = []; const fragen: Array<{ text: string; nonce: string }> = []; const meldungen: string[] = [];
    let n = 0; let pruef = 0;
    const p = new SatellitProjekte({
      planen: async () => ['Build mit pnpm'], bewerten: async () => ({ kind: 'proceed' }), anwenden: (r) => r,
      aktion: async (_g, a, params) => {
        aufrufe.push({ aktion: a, params });
        if (a === 'auftrag_starten') return { success: true, data: { id: `a${++n}` } };
        if (a === 'pruefen_befehl') { pruef++; return pruef === 1 ? { success: true, data: { ok: false }, display: '❌ befehl pnpm build — Exit 127\n   sh: 1: pnpm: not found' } : { success: true, data: { ok: true }, display: 'ok' }; }
        if (a === 'installieren') return { success: true, display: 'installiert' };
        return { success: true };
      },
      frage: async (_s, text, nonce) => { fragen.push({ text, nonce }); }, melde: async (_s, t) => { meldungen.push(t); },
      logger: { info: () => undefined, warn: () => undefined },
    });
    const s = await p.starte({ geraetId: 'g1', geraet: 'Ubuntu-VM', projekt: '/x', ziel: 'Z', pruefBefehle: ['pnpm build'], umgebung: 'Ubuntu 24.04 · Node 22' });
    await p.antwort(s.id, fragen[0]!.nonce);
    p.auftragEnde({ typ: 'ereignis', art: 'auftrag', auftragId: 'a1', status: 'fertig', titel: '', projekt: '/x', text: 'FEHLT: pnpm', kosten: 0.1 } as GeraetEreignis);
    await new Promise(r => setTimeout(r, 10));
    expect(p.hole(s.id)!.status).toBe('wartet_owner');
    expect(fragen.at(-1)!.text).toMatch(/braucht „pnpm“, das auf Ubuntu-VM fehlt\.\nInstallieren mit npm: pnpm\?/);
    expect(aufrufe.filter(a => a.aktion === 'auftrag_starten')).toHaveLength(1); // kein Fix-Versuch ohne Antwort
    await p.antwort(s.id, fragen.at(-1)!.nonce);
    expect(aufrufe.find(a => a.aktion === 'installieren')!.params).toEqual({ quelle: 'npm', paket: 'pnpm' });
    const starts = aufrufe.filter(a => a.aktion === 'auftrag_starten');
    expect(starts).toHaveLength(2);
    expect(String(starts[1]!.params.auftrag)).toMatch(/neu installiert: pnpm/);
    expect(meldungen.some(m => /pnpm installiert — Etappe 1 startet neu/.test(m))).toBe(true);
    p.auftragEnde({ typ: 'ereignis', art: 'auftrag', auftragId: 'a2', status: 'fertig', titel: '', projekt: '/x', text: 'ok', kosten: 0.1 } as GeraetEreignis);
    await new Promise(r => setTimeout(r, 10));
    expect(p.hole(s.id)!.status).toBe('fertig');
  });
  it('Nein → weiter ohne Installation = Fix-Versuch; dasselbe Werkzeug wird nicht noch einmal erfragt', async () => {
    const aufrufe: string[] = []; const fragen: Array<{ text: string; nonce: string }> = [];
    let n = 0;
    const p = new SatellitProjekte({
      planen: async () => ['A'], bewerten: async () => ({ kind: 'proceed' }), anwenden: (r) => r,
      aktion: async (_g, a, params) => { aufrufe.push(a === 'auftrag_starten' ? `auftrag:${String(params.titel)}` : a); return a === 'auftrag_starten' ? { success: true, data: { id: `a${++n}` } } : a === 'pruefen_befehl' ? { success: true, data: { ok: false }, display: 'bash: tsc: command not found' } : { success: true }; },
      frage: async (_s, text, nonce) => { fragen.push({ text, nonce }); }, melde: async () => undefined,
      logger: { info: () => undefined, warn: () => undefined },
    });
    const s = await p.starte({ geraetId: 'g1', geraet: 'Ubuntu-VM', projekt: '/x', ziel: 'Z', pruefBefehle: ['tsc'] });
    await p.antwort(s.id, fragen[0]!.nonce);
    p.auftragEnde({ typ: 'ereignis', art: 'auftrag', auftragId: 'a1', status: 'fertig', titel: '', projekt: '/x', text: '', kosten: 0 } as GeraetEreignis);
    await new Promise(r => setTimeout(r, 10));
    expect(fragen.at(-1)!.text).toMatch(/tsc/);
    expect(await p.weiterOhneAenderung(s.id)).toBe(true);
    await new Promise(r => setTimeout(r, 10));
    expect(aufrufe.filter(a => a.startsWith('auftrag:'))).toEqual(['auftrag:Etappe 1: A', 'auftrag:Etappe 1: Fix 1']);
    p.auftragEnde({ typ: 'ereignis', art: 'auftrag', auftragId: 'a2', status: 'fertig', titel: '', projekt: '/x', text: '', kosten: 0 } as GeraetEreignis);
    await new Promise(r => setTimeout(r, 10));
    expect(aufrufe.filter(a => a.startsWith('auftrag:'))).toEqual(['auftrag:Etappe 1: A', 'auftrag:Etappe 1: Fix 1', 'auftrag:Etappe 1: Fix 2']); // keine zweite Installationsfrage
    expect(aufrufe).not.toContain('installieren');
  });
});

// v1415 — Gerät beim Etappenstart nicht verbunden: warten statt anhalten
describe('Etappe wartet auf das Gerät', () => {
  function aufbauWarten(verbunden: { an: boolean }, jetzt: { t: number }) {
    const meldungen: string[] = []; const fragen: Array<{ nonce: string }> = []; let n = 0;
    const p = new SatellitProjekte({
      planen: async () => ['A', 'B'], bewerten: async () => ({ kind: 'proceed' }), anwenden: (r) => r,
      aktion: async (_g, a) => (a === 'auftrag_starten' ? (verbunden.an ? { success: true, data: { id: `a${++n}` } } : { success: false, error: 'Gerät nicht verbunden' }) : { success: true, data: { ok: true } }),
      frage: async (_s, _t, nonce) => { fragen.push({ nonce }); }, melde: async (_s, t) => { meldungen.push(t); },
      logger: { info: () => undefined, warn: () => undefined }, now: () => jetzt.t,
    });
    return { p, meldungen, fragen };
  }
  it('wartet, meldet einmal, startet beim Wiederverbinden', async () => {
    const verbunden = { an: false }; const jetzt = { t: 1_000_000 };
    const { p, meldungen, fragen } = aufbauWarten(verbunden, jetzt);
    const s = await p.starte({ geraetId: 'g1', geraet: 'Ubuntu-VM', projekt: '/x', ziel: 'Z', pruefBefehle: ['npm test'] });
    await p.antwort(s.id, fragen[0]!.nonce);
    expect(p.hole(s.id)!.status).toBe('laeuft');
    expect(p.hole(s.id)!.wartetAufGeraet).toBeDefined();
    expect(meldungen.filter(m => m.startsWith('⏳'))).toHaveLength(1);
    expect(p.lageZeile()).toMatch(/wartet auf Ubuntu-VM/);
    await p.nachholen('g1'); // noch weg: keine zweite Meldung
    expect(meldungen.filter(m => m.startsWith('⏳'))).toHaveLength(1);
    verbunden.an = true;
    expect(await p.nachholen('g2')).toBe(0); // anderes Gerät
    expect(await p.nachholen('g1')).toBe(1);
    expect(p.hole(s.id)!.wartetAufGeraet).toBeUndefined();
    expect(p.hole(s.id)!.auftragId).toBe('a1');
  });
  it('nach 24 h ohne Gerät angehalten', async () => {
    const verbunden = { an: false }; const jetzt = { t: 1_000_000 };
    const { p, fragen, meldungen } = aufbauWarten(verbunden, jetzt);
    const s = await p.starte({ geraetId: 'g1', geraet: 'Ubuntu-VM', projekt: '/x', ziel: 'Z', pruefBefehle: ['npm test'] });
    await p.antwort(s.id, fragen[0]!.nonce);
    jetzt.t += 25 * 3_600_000;
    await p.nachholen();
    expect(p.hole(s.id)!.status).toBe('angehalten');
    expect(meldungen.at(-1)).toMatch(/24 h nicht erreichbar/);
  });
});

// v1417 G1 — Etappenbericht
import { laufAnzeige } from '../projekt/akten-projekte.js';
describe('Etappenbericht', () => {
  it('speichert Zusammenfassung, Dateien (über Fix-Versuche), Commit und Abnahme; Anzeige für App/Web', async () => {
    let pruef = 0; let n = 0; const fragen: Array<{ nonce: string }> = [];
    const p = new SatellitProjekte({
      planen: async () => ['Merkliste speichern'], bewerten: async () => ({ kind: 'proceed' }), anwenden: (r) => r,
      aktion: async (_g, a) => {
        if (a === 'auftrag_starten') return { success: true, data: { id: `a${++n}` } };
        if (a === 'pruefen_befehl') { pruef++; return pruef === 1 ? { success: true, data: { ok: false }, display: '❌ npm test — Exit 1' } : { success: true, data: { ok: true }, display: '✅ npm test — Exit 0' }; }
        if (a === 'projekt_lesen') return { success: true, data: { commits: [{ sha: 'abc1234', message: 'Etappe 1: Merkliste speichern', files: [] }] } };
        return { success: true };
      },
      frage: async (_s, _t, nonce) => { fragen.push({ nonce }); }, melde: async () => undefined,
      logger: { info: () => undefined, warn: () => undefined },
    });
    const s = await p.starte({ geraetId: 'g1', geraet: 'Ubuntu-VM', projekt: '/x', ziel: 'Z', pruefBefehle: ['npm test'] });
    await p.antwort(s.id, fragen[0]!.nonce);
    p.auftragEnde({ typ: 'ereignis', art: 'auftrag', auftragId: 'a1', status: 'fertig', titel: '', projekt: '/x', text: 'Erster Versuch', kosten: 0.5, dauerS: 100, dateien: ['src/a.js'], dateienAnzahl: 1 } as GeraetEreignis);
    await new Promise(r => setTimeout(r, 10));
    p.auftragEnde({ typ: 'ereignis', art: 'auftrag', auftragId: 'a2', status: 'fertig', titel: '', projekt: '/x', text: 'Merkliste fertig, Tests ergänzt.', kosten: 0.2, dauerS: 50, dateien: ['src/a.js', 'tests/a.test.js'], dateienAnzahl: 2 } as GeraetEreignis);
    await new Promise(r => setTimeout(r, 10));
    const e = p.hole(s.id)!.erledigt[0]!;
    expect(e).toMatchObject({ ok: true, fixVersuche: 1, zusammenfassung: 'Merkliste fertig, Tests ergänzt.', dateien: ['src/a.js', 'tests/a.test.js'], dauerS: 150, commit: { sha: 'abc1234', titel: 'Etappe 1: Merkliste speichern' }, abnahme: { ok: true, protokoll: '✅ npm test — Exit 0' } });
    const a = laufAnzeige(p.hole(s.id)!);
    expect(a.erledigt[0]!.bericht).toMatchObject({ geprueft: true, zusammenfassung: 'Merkliste fertig, Tests ergänzt.', dateienAnzahl: 2, commit: { sha: 'abc1234' } });
  });
  it('fremder Commit (andere Etappe) wird nicht zugeordnet; alte Läufe zeigen den kurzen Text', () => {
    const alt = laufAnzeige({ id: 's', status: 'fertig', ziel: 'Z', plan: ['A'], erledigt: [{ nr: 1, ok: true, kostenUsd: 1, text: 'kurz' }], nr: 1, kostenUsd: 1, start: 0, aktualisiert: 0 });
    expect(alt.erledigt[0]!.bericht).toMatchObject({ zusammenfassung: 'kurz', dateien: [], dateienAnzahl: 0 });
  });
});

// v1418 G2 — Live-Stand nur bei laufender Etappe in der Anzeige
describe('Live-Aktivität in der Anzeige', () => {
  it('laufend mit Schritten, beendet ohne', () => {
    const live = { zeit: 'x', schritte: ['▶ npm test'], werkzeuge: 3 };
    const basis = { id: 's', ziel: 'Z', plan: ['A'], erledigt: [], nr: 1, kostenUsd: 0, start: 0, aktualisiert: 0 };
    expect(laufAnzeige({ ...basis, status: 'laeuft' }, live).live).toEqual(live);
    expect(laufAnzeige({ ...basis, status: 'fertig' }, live).live).toBeUndefined();
  });
});
