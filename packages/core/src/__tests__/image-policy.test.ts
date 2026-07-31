import { describe, it, expect, vi } from 'vitest';
import {
  resolveImagePolicy, extractNameCandidates, scrubMotif, scrubTextDirectives,
  buildSafeImagePrompt, strictRetryPrompt, verifyImagePolicy, resolveSymbolMotif,
  SYMBOLIC_FALLBACK_MOTIF,
} from '../image-policy.js';

describe('resolveImagePolicy (v950)', () => {
  it('Default ist symbolic (sicher by default); people_ok nur explizit', () => {
    expect(resolveImagePolicy({})).toBe('symbolic');
    expect(resolveImagePolicy({ image_policy: 'symbolic' })).toBe('symbolic');
    expect(resolveImagePolicy({ image_policy: 'people_ok' })).toBe('people_ok');
    expect(resolveImagePolicy({ image_policy: 'quatsch' })).toBe('symbolic');
  });
});

describe('extractNameCandidates (v950 Schicht 2a)', () => {
  it('findet Namens-Sequenzen (≥2 kapitalisierte Wörter) inkl. Umlaute', () => {
    const names = extractNameCandidates(
      'Marko Arnautovic beendet Nationalteam-Karriere',
      'Während David Alaba sich alle Optionen offen hält, wechselt Unai Glasner.',
    );
    expect(names).toContain('Marko Arnautovic');
    expect(names).toContain('David Alaba');
    expect(names).toContain('Unai Glasner');
  });

  it('einzelne kapitalisierte Wörter (deutsche Substantive) werden NICHT geblockt', () => {
    const names = extractNameCandidates('Das Stadion und der Ball im Fokus der Analyse');
    expect(names).toEqual([]);
  });

  it('undefined-Texte sind ok', () => {
    expect(extractNameCandidates(undefined, 'Nur Kleinschreibung hier')).toEqual([]);
  });
});

describe('scrubMotif (v950 Schicht 2b)', () => {
  it('entfernt Namen aus dem Motiv, Rest bleibt brauchbar', () => {
    const r = scrubMotif(
      'Marko Arnautovic jubelnd im Stadion vor österreichischen Fans',
      ['Marko Arnautovic'],
    );
    expect(r.scrubbed).toBe(true);
    expect(r.motif).not.toContain('Arnautovic');
    expect(r.motif).toContain('Stadion');
  });

  it('bleibt kein tragfähiges Motiv → generisches Symbolmotiv (v1129: markenneutral)', () => {
    const r = scrubMotif('David Alaba Porträt', ['David Alaba']);
    expect(r.scrubbed).toBe(true);
    expect(r.motif).toContain('Symbolbild');
    expect(r.motif).not.toContain('Fußball');
    expect(r.motif).toContain('ohne Menschen');
  });

  it('v1129: das Kanal-Symbolmotiv übersteuert das neutrale Fallback', () => {
    const energie = 'Symbolbild: PV-Module und Strommasten in österreichischer Landschaft, ohne Menschen';
    const r = scrubMotif('David Alaba Porträt', ['David Alaba'], energie);
    expect(r.motif).toBe(energie);
  });

  it('ohne Treffer unverändert', () => {
    const r = scrubMotif('Taktiktafel mit Spielzügen, Kreide-Optik', ['Marko Arnautovic']);
    expect(r.scrubbed).toBe(false);
    expect(r.motif).toBe('Taktiktafel mit Spielzügen, Kreide-Optik');
  });
});

describe('buildSafeImagePrompt (v950 Schicht 1)', () => {
  it('symbolic: harte Bildnisrecht-Regeln im Prompt', () => {
    const p = buildSafeImagePrompt('Stadion bei Nacht', 'locker', 'symbolic');
    expect(p).toContain('KEINE realen oder identifizierbaren Personen');
    expect(p).toContain('Lookalikes');
    expect(p).toContain('Logos');
    expect(p).toContain('Stadion bei Nacht');
    // v958 — Nationalflaggen sind erlaubt (Vision wertete rot-weiß-rot als „Logo")
    expect(p).toContain('Nationalflaggen');
  });

  it('v1037: Flaggen-Regel lädt nicht mehr zu fremden Flaggen ein', () => {
    // Realfall 07.07.: das Beispiel „(rot-weiß-rot etc.)" im Prompt ließ das
    // Bildmodell eine Österreich-Flagge in einen US-Artikel malen
    const p = buildSafeImagePrompt('Trainerbank am Spielfeldrand', 'stil', 'symbolic');
    expect(p).not.toContain('rot-weiß-rot');
    expect(p).toContain('NUR verwenden, wenn das Motiv sie AUSDRÜCKLICH nennt');
    // v1129 — die Symbolik-Zeile ist markenneutral (vorher hartkodiert „Stadion, Ball, Rasen …")
    expect(p).not.toContain('Stadion, Ball, Rasen');
    expect(p).toContain('Wenn Symbolik nötig ist');
  });

  it('v1129: symbolMotif des Kanals landet als Symbolik-Empfehlung im Prompt (ohne Marker-Präfix)', () => {
    const p = buildSafeImagePrompt('Stromzähler-Nahaufnahme', 'stil', 'symbolic',
      'Symbolbild: PV-Module und Strommasten in österreichischer Landschaft');
    expect(p).toContain('PV-Module und Strommasten');
    expect(p).not.toContain('Wenn Symbolik nötig ist, im Sinne von: Symbolbild');
  });

  it('people_ok: nur Basis-Prompt, keine Regeln', () => {
    const p = buildSafeImagePrompt('Spieler-Porträt', undefined, 'people_ok');
    expect(p).not.toContain('KEINE realen');
    expect(p).toContain('Spieler-Porträt');
  });

  it('strictRetryPrompt: Symbolmotiv ganz ohne Menschen', () => {
    const p = strictRetryPrompt('modern');
    expect(p).toContain('keine Menschen');
    expect(p).toContain('KEINE realen oder identifizierbaren Personen');
  });

  it('v1129: strictRetryPrompt nutzt das Kanal-Symbolmotiv statt der Konstante', () => {
    const p = strictRetryPrompt('modern', 'Symbolbild: Batteriespeicher und Smart Meter, ohne Menschen');
    expect(p).toContain('Batteriespeicher und Smart Meter');
    expect(p).not.toContain('Fußball');
  });

  it('v1140: Verbandsflaggen/Wimpel/Schilder sind explizit verboten (Realfall 30./31.07.: UEFA/FIFA-Flaggen, Vereinswappen-Wimpel und Länderschilder fraßen die YT-Rettungsbilder)', () => {
    const p = buildSafeImagePrompt('Verhandlungstisch der Verbände', 'stil', 'symbolic');
    expect(p).toContain('KEINE Verbands- oder Vereinsflaggen, Wimpel, Wappen oder Banner');
    expect(p).toContain('KEINE Schilder, Namensschilder oder beschrifteten Tafeln');
    // Nationalflaggen-Regel (v958/v1037) bleibt unverändert daneben bestehen
    expect(p).toContain('Nationalflaggen und Länderfarben sind rechtlich unbedenklich');
    const retry = strictRetryPrompt('modern');
    expect(retry).toContain('keine Flaggen, Wimpel, Wappen oder Schilder');
  });
});

describe('resolveSymbolMotif (v1129 — Marken-Symbolmotiv je Kanal)', () => {
  it('leer/fehlend → markenneutrales Default (kein Fußball)', () => {
    expect(resolveSymbolMotif({})).toBe(SYMBOLIC_FALLBACK_MOTIF);
    expect(resolveSymbolMotif({ image_symbol_motif: '   ' })).toBe(SYMBOLIC_FALLBACK_MOTIF);
    expect(SYMBOLIC_FALLBACK_MOTIF).not.toContain('Fußball');
    expect(SYMBOLIC_FALLBACK_MOTIF).toMatch(/^Symbolbild/);
  });

  it('config-Motiv wird übernommen, „Symbolbild"-Marker wird ergänzt (Reuse-Karenz v1038)', () => {
    expect(resolveSymbolMotif({ image_symbol_motif: 'PV-Module in Landschaft, ohne Menschen' }))
      .toBe('Symbolbild: PV-Module in Landschaft, ohne Menschen');
    expect(resolveSymbolMotif({ image_symbol_motif: 'Symbolbild Fußball: Stadion unter Flutlicht' }))
      .toBe('Symbolbild Fußball: Stadion unter Flutlicht');
  });
});

describe('verifyImagePolicy (v950 Schicht 3)', () => {
  const IMG = Buffer.from('fake-png');

  it('parst das Vision-Verdict (person/logo/begruendung)', async () => {
    const llm = { complete: vi.fn(async () => ({ content: '{"person": true, "logo": false, "begruendung": "zeigt erkennbar einen Fußballprofi"}' })) };
    const v = await verifyImagePolicy(llm as any, IMG);
    expect(v).toEqual({ person: true, logo: false, text: false, begruendung: 'zeigt erkennbar einen Fußballprofi' });
    // Vision-Call enthält das Bild als base64-Block
    const msg = (llm.complete as any).mock.calls[0][0].messages[0];
    expect(msg.content[0].type).toBe('image');
    expect(msg.content[0].source.data).toBe(IMG.toString('base64'));
  });

  it('kaputte/fehlende Antwort → null (Aufrufer entscheidet fail-closed)', async () => {
    expect(await verifyImagePolicy({ complete: vi.fn(async () => ({ content: 'kein json' })) } as any, IMG)).toBeNull();
    expect(await verifyImagePolicy({ complete: vi.fn(async () => { throw new Error('down'); }) } as any, IMG)).toBeNull();
    expect(await verifyImagePolicy({ complete: vi.fn(async () => ({ content: '{"person": "vielleicht"}' })) } as any, IMG)).toBeNull();
  });

  it('v982: text-Kriterium wird geparst (halluzinierte Daten im Bild)', async () => {
    const llm = { complete: vi.fn(async () => ({ content: '{"person": false, "logo": false, "text": true, "begruendung": "zeigt Datum 23.04. und Uhrzeit 21:00"}' })) };
    const v = await verifyImagePolicy(llm as any, IMG);
    expect(v?.text).toBe(true);
    // Prompt fragt explizit nach gerendertem Text
    const q = (llm.complete as any).mock.calls[0][0].messages[0].content[1].text as string;
    expect(q).toContain('text:');
  });

  it('v1040: motiv wird geparst — die Beschreibung dessen, was das Bild WIRKLICH zeigt', async () => {
    const llm = { complete: vi.fn(async () => ({ content: '{"person": false, "logo": false, "text": false, "begruendung": "ok", "motiv": "Stadion bei Nacht, Ball im Vordergrund auf dem Rasen"}' })) };
    const v = await verifyImagePolicy(llm as any, IMG);
    expect(v?.motiv).toBe('Stadion bei Nacht, Ball im Vordergrund auf dem Rasen');
    const q = (llm.complete as any).mock.calls[0][0].messages[0].content[1].text as string;
    expect(q).toContain('motiv:');
    // Leeres/zu kurzes motiv → undefined (Aufrufer behält das Prompt-Motiv)
    const v2 = await verifyImagePolicy({ complete: vi.fn(async () => ({ content: '{"person": false, "logo": false, "text": false, "motiv": "x"}' })) } as any, IMG);
    expect(v2?.motiv).toBeUndefined();
  });
});

describe('scrubTextDirectives (v982)', () => {
  it('Realfall 04.07.: „Datum & Uhrzeit als Overlay" fliegt raus, das Motiv bleibt', () => {
    const r = scrubTextDirectives('Split-Screen mit Flaggen Kanada/Marokko vor Pub-Kulisse, Datum & Uhrzeit als Overlay');
    expect(r.scrubbed).toBe(true);
    expect(r.motif).toBe('Split-Screen mit Flaggen Kanada/Marokko vor Pub-Kulisse');
  });

  it('konkrete Datums- und Uhrzeitangaben werden entfernt', () => {
    const r = scrubTextDirectives('Stadion-Panorama mit Anzeige 04.07.2026 und 19:00 Uhr, dramatisches Flutlicht');
    expect(r.scrubbed).toBe(true);
    expect(r.motif).not.toMatch(/04\.07|19:00/);
    expect(r.motif).toContain('Flutlicht');
  });

  it('bleibt nach dem Schrubben nichts Tragfähiges → Symbolmotiv (v1129: Kanal-Motiv möglich)', () => {
    const r = scrubTextDirectives('Countdown 12:00 Uhr Overlay');
    expect(r.motif).toContain('Symbolbild');
    expect(r.motif).not.toContain('Fußball');
    const r2 = scrubTextDirectives('Countdown 12:00 Uhr Overlay', 'Symbolbild: Windräder im Morgenlicht');
    expect(r2.motif).toBe('Symbolbild: Windräder im Morgenlicht');
  });

  it('Motiv ohne Text-Direktiven bleibt unverändert', () => {
    const motif = 'Aufgeschlagenes Sammelalbum mit bunten Stickern auf Holztisch';
    expect(scrubTextDirectives(motif)).toEqual({ motif, scrubbed: false });
  });
});

describe('extractNameCandidates — Motiv-Substantive (v982)', () => {
  it('Realfall: „Flaggen Kanada" ist kein Personenname — Kanada bleibt im Bild', () => {
    const names = extractNameCandidates('Split-Screen mit Flaggen Kanada/Marokko vor Pub-Kulisse');
    expect(names).not.toContain('Flaggen Kanada');
  });

  it('echte Personennamen werden weiter erkannt', () => {
    expect(extractNameCandidates('David Alaba jubelt vor Flaggen Kanadas')).toContain('David Alaba');
  });
});

describe('extractNameCandidates — Adjektive/Licht-Begriffe (v1129)', () => {
  it('Realfälle 19.07.: Bildideen-Phrasen sind keine Personennamen', () => {
    const names = extractNameCandidates(
      'Mehrere Batteriespeicher im Technikraum, Helles Vormittagslicht fällt seitlich ein.',
      'Natürliches Fensterlicht auf dem Tisch, Seitliches Sonnenlicht am Abend, die Wiener Stadthalle im Hintergrund',
    );
    expect(names).toEqual([]);
  });

  it('Personennamen neben Licht-Phrasen bleiben erkannt', () => {
    const names = extractNameCandidates('Leonore Gewessler eröffnet, Helles Vormittagslicht im Saal');
    expect(names).toContain('Leonore Gewessler');
  });
});
