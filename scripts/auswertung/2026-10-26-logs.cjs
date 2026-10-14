#!/usr/bin/env node
// Auswertungsblock ~26.10.2026 — beobachtende Logzeilen aus den pino-Logs zählen. NUR LESEN.
// Aufruf auf .92: sudo node 2026-10-26-logs.cjs [ab=2026-10-12] [logordner=/root/alfred/data/logs]
'use strict';
const fs = require('fs');
const path = require('path');

const ab = process.argv[2] || '2026-10-12';
const ordner = process.argv[3] || '/root/alfred/data/logs';
const dateien = fs.readdirSync(ordner).filter(n => /^alfred\.\d{4}-\d{2}-\d{2}\.\d+\.log$/.test(n) && n.slice(7, 17) >= ab).sort();

const MSG = {
  e2Frist: 'v1362 E2 Haltefrist (beobachtend)',
  e2Entfallen: 'v1362 E2 Vorgang wäre entfallen',
  hausOk: 'v1359 Haus-Check abgeglichen',
  hausUnvollstaendig: 'v1359 Haus-Check unvollständig — kein Abgleich',
  k1Bekannt: 'v1364 Hinweis wäre als bekannt gesperrt (beobachtend)',
  k1Reaktion: 'v1364 Hinweis-Reaktion',
  vkTreffer: 'v1367 Verknüpfung: Beitrag wäre Hinweis geworden (beobachtend)',
  vkLauf: 'v1367 Verknüpfung gelaufen',
  l0Signal: 'v1374 Anfrage-Folgesignal',
};
const zeilen = Object.fromEntries(Object.keys(MSG).map(k => [k, []]));
const nachMsg = new Map(Object.entries(MSG).map(([k, m]) => [m, k]));
let gelesen = 0;
for (const d of dateien) {
  for (const z of fs.readFileSync(path.join(ordner, d), 'utf8').split('\n')) {
    if (!z.includes('"msg":"v13')) continue;
    let j; try { j = JSON.parse(z); } catch { continue; }
    const k = nachMsg.get(j.msg);
    if (k) { zeilen[k].push(j); gelesen++; }
  }
}

const zaehle = (liste, fn) => { const m = new Map(); for (const x of liste) { const k = fn(x); m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]); };
const tabelle = (titel, eintraege) => { console.log(`\n=== ${titel} ===`); if (!eintraege.length) { console.log('(keine Zeilen)'); return; } for (const [k, n] of eintraege) console.log(`${String(n).padStart(5)}  ${k}`); };
const tag = (j) => new Date(j.time).toISOString().slice(0, 10);
const woche = (j) => { const t = new Date(j.time); const mo = new Date(t); mo.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return mo.toISOString().slice(0, 10); };

console.log(`Logs ab ${ab}: ${dateien.length} Dateien (${dateien[0] ?? '-'} … ${dateien.at(-1) ?? '-'}), ${gelesen} beobachtende Zeilen`);

// E2 — Ziel: Befund-Vorgänge 77 → ≤ 15/Woche ohne echten Handlungsbedarf zu verlieren
tabelle('E2 Haltefrist gesetzt — je Woche · Quelle · Frist', zaehle(zeilen.e2Frist, j => `${woche(j)}  ${j.quelle}  ${j.haltefristMin} min`));
tabelle('E2 Vorgang wäre entfallen — je Woche · Quelle', zaehle(zeilen.e2Entfallen, j => `${woche(j)}  ${j.quelle}`));
tabelle('E2 wäre entfallen — häufigste Gegenstände', zaehle(zeilen.e2Entfallen, j => `${j.quelle}:${j.gegenstand}`).slice(0, 15));

// Haus-Check — Läufe und Stabilität
console.log('\n=== Haus-Check Läufe (Zeit · Anlass · neu/offen/erledigt) ===');
for (const j of zeilen.hausOk) console.log(`${new Date(j.time).toISOString().slice(0, 16)}  ${j.anlass ?? '-'}  ${j.neu}/${j.offen}/${j.erledigt}`);
if (!zeilen.hausOk.length) console.log('(keine Zeilen)');
console.log(`unvollständige Läufe (kein Abgleich): ${zeilen.hausUnvollstaendig.length}`);

// K1 — Sperrdauer: an welchem Tag nach „bekannt“ kommt derselbe Hinweis wieder, und mit gleichem oder geändertem Inhalt?
const eimer = (t) => t <= 1 ? '0–1 Tage' : t <= 3 ? '2–3 Tage' : t <= 7 ? '4–7 Tage' : '8–14 Tage';
tabelle('K1 wäre als bekannt gesperrt — Tage seit Markierung · Inhalt', zaehle(zeilen.k1Bekannt, j => `${eimer(Number(j.tag))}  ${j.inhalt}`));
tabelle('K1 Reaktionen — Quelle · Reaktion', zaehle(zeilen.k1Reaktion, j => `${j.quelle ?? '-'}  ${j.reaktion}`));

// Verknüpfung — Treffer je Anker/Art, Anteil stark; Läufe
tabelle('Verknüpfung Treffer — Anker · Art · stark', zaehle(zeilen.vkTreffer, j => `${j.anker}  ${j.art}  ${j.stark ? 'stark' : 'schwach'}`).slice(0, 25));
tabelle('Verknüpfung Treffer je Tag', zaehle(zeilen.vkTreffer, tag).sort((a, b) => a[0].localeCompare(b[0])));
const summe = (k) => zeilen.vkLauf.reduce((s, j) => s + (Number(j[k]) || 0), 0);
console.log(`Verknüpfung Läufe: ${zeilen.vkLauf.length} · Beiträge ${summe('beitraege')} · Treffer ${summe('treffer')} · gewählt ${summe('gewaehlt')} · stark ${summe('stark')}`);

// L0 — Folgesignale (Ergänzung zur Tabelle anfrage_protokoll)
tabelle('L0 Folgesignale', zaehle(zeilen.l0Signal, j => j.signal));
