#!/usr/bin/env node
/**
 * v1509 — einmaliger Nachtrag der Claude-Code-Kosten eines Monats in llm_usage_zweck (Owner 19.10.: „beides umsetzen“).
 *
 * Die Herkunft der Kosten wird erst seit v1506 erfasst. Die Kosten der Satelliten-Projekte stehen aber je Etappe in den
 * Projektdateien (data/projekte-satellit/*.json), einzelne Aufträge mit Kosten in den Logzeilen „v1382 Auftragsende“ /
 * „v1432 Antwort auf Projektfrage“. Das Skript bucht sie nachträglich als `agent:claude-code` mit Modell `gerät:<Name>` —
 * aber nur, was VOR dem Start von v1506 endete (alles danach ist schon live verbucht).
 *
 * Tag einer Etappe: Ende ihres letzten Auftrags aus den Logs („v1387 Etappe gestartet“ → Auftrag, „v1342 Auftrag beendet“).
 * Ohne Logs (älter als die Aufbewahrung): geschätzt aus Projektstart + Summe der Etappendauern (im Bericht markiert).
 *
 * Aufruf: node scripts/nachtrag-agent-kosten.mjs --projekte <dir> --logs <dir> --dsn <postgres-url> [--monat 2026-10]
 *         [--zeitzone Europe/Vienna] [--schreiben]
 * Ohne --schreiben nur Bericht. Ein zweiter Lauf für denselben Monat bricht ab (Markierung in der Tabelle `nachtraege`).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const PROJEKTE = arg('projekte'); const LOGS = arg('logs'); const DSN = arg('dsn');
const MONAT = arg('monat', '2026-10'); const TZ = arg('zeitzone', 'Europe/Vienna');
const SCHREIBEN = process.argv.includes('--schreiben');
if (!PROJEKTE || !LOGS || !DSN) { console.error('Aufruf: --projekte <dir> --logs <dir> --dsn <url> [--monat JJJJ-MM] [--schreiben]'); process.exit(2); }

const tag = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

// 1. Logs lesen
const starts = new Map();   // auftragId → { projekt, etappe }
const enden = new Map();    // auftragId → Zeit (ms)
const einzel = [];          // { zeit, geraet, kosten, auftrag }
let erfassungAb;            // Start von v1506 (erste „Alfred is ready“ mit Version ≥ 1506)
for (const f of readdirSync(LOGS).filter(f => /^alfred\.\d{4}-\d{2}-\d{2}\.\d+\.log$/.test(f)).sort()) {
  for (const z of readFileSync(join(LOGS, f), 'utf8').split('\n')) {
    if (!z.includes('"msg"')) continue;
    let j; try { j = JSON.parse(z); } catch { continue; }
    const msg = String(j.msg ?? '');
    if (msg === 'Alfred is ready' && /jarvis\.(\d+)/.test(j.version ?? '') && Number(/jarvis\.(\d+)/.exec(j.version)[1]) >= 1506) {
      if (erfassungAb === undefined || j.time < erfassungAb) erfassungAb = j.time;
    } else if (msg === 'v1387 Etappe gestartet' && j.auftrag) starts.set(j.auftrag, { projekt: j.id, etappe: j.etappe });
    else if (msg === 'v1342 Auftrag beendet' && j.auftrag) enden.set(j.auftrag, j.time);
    else if ((msg.startsWith('v1382 Auftragsende') || msg.startsWith('v1432 Antwort auf Projektfrage')) && typeof j.kosten === 'number' && j.kosten > 0) {
      einzel.push({ zeit: j.time, geraet: j.geraet, kosten: j.kosten, auftrag: j.auftrag });
    }
  }
}
if (erfassungAb === undefined) { console.error('Start von v1506 nicht in den Logs gefunden — Abbruch.'); process.exit(1); }
console.log(`Erfassung live seit ${new Date(erfassungAb).toISOString()} — nur davor endende Läufe werden nachgetragen.`);

// 2. Etappen der Projekte
const buchungen = []; // { datum, geraet, kosten, quelle, geschaetzt }
const uebersprungen = [];
for (const f of readdirSync(PROJEKTE).filter(f => f.endsWith('.json'))) {
  let s; try { s = JSON.parse(readFileSync(join(PROJEKTE, f), 'utf8')); } catch { continue; }
  let lauf = s.start ?? 0;
  for (const e of s.erledigt ?? []) {
    lauf += (e.dauerS ?? 0) * 1000;
    if (!(e.kostenUsd > 0)) continue;
    const auftraege = [...starts.entries()].filter(([, v]) => v.projekt === s.id && v.etappe === e.nr).map(([a]) => enden.get(a)).filter(t => typeof t === 'number');
    let ende; let geschaetzt = false;
    if (auftraege.length) {
      ende = Math.max(...auftraege);
      if (Math.min(...auftraege) < erfassungAb && ende >= erfassungAb) { uebersprungen.push(`${s.id} Etappe ${e.nr}: Aufträge vor UND nach dem Erfassungsbeginn (${e.kostenUsd.toFixed(2)} $) — nicht nachgetragen`); continue; }
    } else { ende = Math.min(lauf, s.aktualisiert ?? lauf); geschaetzt = true; }
    if (ende >= erfassungAb) continue; // schon live verbucht
    const datum = tag(ende);
    if (!datum.startsWith(MONAT)) continue;
    buchungen.push({ datum, geraet: s.geraet, kosten: e.kostenUsd, quelle: `${s.id} (${s.akteName ?? s.projekt}) Etappe ${e.nr}`, geschaetzt });
  }
}
// 3. Einzelne Aufträge (nicht Teil eines Projekts)
const gesehen = new Set(); // ein Auftrag kann in zwei Logzeilen stehen (Antwort auf Projektfrage + Auftragsende)
for (const a of einzel) {
  if (a.zeit >= erfassungAb || starts.has(a.auftrag) || (a.auftrag && gesehen.has(a.auftrag))) continue;
  if (a.auftrag) gesehen.add(a.auftrag);
  const datum = tag(a.zeit);
  if (datum.startsWith(MONAT)) buchungen.push({ datum, geraet: a.geraet, kosten: a.kosten, quelle: `Auftrag ${a.auftrag}`, geschaetzt: false });
}

buchungen.sort((a, b) => a.datum.localeCompare(b.datum));
for (const b of buchungen) console.log(`${b.datum}  ${String(b.geraet).padEnd(12)} ${b.kosten.toFixed(4).padStart(9)} $  ${b.quelle}${b.geschaetzt ? '  [Datum geschätzt]' : ''}`);
for (const u of uebersprungen) console.log('ÜBERSPRUNGEN: ' + u);
const summe = buchungen.reduce((x, b) => x + b.kosten, 0);
console.log(`Summe ${MONAT}: ${summe.toFixed(2)} $ in ${buchungen.length} Buchungen (${buchungen.filter(b => b.geschaetzt).length} mit geschätztem Datum)`);

// 4. Schreiben
const require = createRequire(import.meta.url);
const pg = require(process.env.PG_MODUL ?? 'pg');
const c = new pg.Client({ connectionString: DSN });
await c.connect();
// Wiederholungsschutz: Markierung je Monat (Buchungen vom Erfassungstag selbst wären sonst nicht von Live-Zeilen zu unterscheiden)
await c.query('CREATE TABLE IF NOT EXISTS nachtraege (name TEXT PRIMARY KEY, zeit TEXT NOT NULL, info TEXT)');
const MARKE = `agent-kosten-${MONAT}`;
const vorher = await c.query('SELECT zeit FROM nachtraege WHERE name = $1', [MARKE]);
if (vorher.rows.length) { console.error(`Abbruch: Nachtrag ${MARKE} lief bereits (${vorher.rows[0].zeit}).`); await c.end(); process.exit(1); }
if (!SCHREIBEN) { console.log('Probelauf — nichts geschrieben (mit --schreiben buchen).'); await c.end(); process.exit(0); }
await c.query('BEGIN');
for (const b of buchungen) {
  await c.query(`INSERT INTO llm_usage_zweck (date, zweck, model, calls, input_tokens, output_tokens, cost_usd) VALUES ($1, 'agent:claude-code', $2, 1, 0, 0, $3)
    ON CONFLICT (date, zweck, model) DO UPDATE SET calls = llm_usage_zweck.calls + 1, cost_usd = llm_usage_zweck.cost_usd + excluded.cost_usd`,
    [b.datum, `gerät:${b.geraet}`, b.kosten]);
}
await c.query('INSERT INTO nachtraege (name, zeit, info) VALUES ($1, $2, $3)', [MARKE, new Date().toISOString(), `${buchungen.length} Buchungen, ${summe.toFixed(2)} $`]);
await c.query('COMMIT');
console.log(`${buchungen.length} Buchungen geschrieben.`);
await c.end();
