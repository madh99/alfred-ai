import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { ladeKonfig, type GeraetKonfig } from './pair.js';
import { starteSatellit } from './satellit.js';
import { dienstLogPfad, satellitDienstLaeuft } from './satellit-dienst.js';
import { getVersion } from '../version.js';
import { Audio, type Aufnahme } from './satellit-audio.js'; // v1241
import { audioMimeAusBytes, sprachBloecke, schneideSaetze, SatzendeErkenner, pruefeAktivierung } from '@alfred/core'; // v1243, v1247, v1248, v1252
import { mikrofonStrom, type MikrofonStrom } from './satellit-audio.js'; // v1252
import { HoerClient } from './satellit-hoeren.js'; // v1252
import { verbindeIpc, type IpcClient } from './satellit-ipc.js'; // v1302
import { ReadlineOberflaeche, type Oberflaeche, type SitzungStatus } from './sitzung-oberflaeche.js'; // v1303

/**
 * v1232 — Die Sitzung: EIN Terminal für Chat, Bestätigungen und den Satelliten.
 * Chat als Owner über das Gerätetoken (der Server erkennt das gekoppelte Gerät), Bestätigungen per
 * `/ja n` und `/nein n`, der Satellit läuft mit (Dienst wird mitgelesen, sonst im Prozess gestartet).
 * v1302 — hängt sich per IPC an den laufenden Satelliten (Status, Ereignisse, Bestätigungen sofort).
 * v1303 — Ausgabe und Eingabe laufen über `Oberflaeche`: Ink mit Statuszeile im Terminal, readline als Rückfall.
 */
interface Bestaetigung { id: string; description?: string; skillName?: string; createdAt?: string; source?: string }
interface SseEreignis { type: string; text?: string; attachmentType?: string; fileName?: string; data?: string; caption?: string; kind?: string; tool?: string }

function anfrage(k: GeraetKonfig, methode: 'GET' | 'POST', pfad: string, body?: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(pfad, k.server);
    const daten = body === undefined ? undefined : JSON.stringify(body);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: methode,
      headers: { Authorization: `Bearer ${k.token}`, 'Content-Type': 'application/json', ...(daten ? { 'Content-Length': Buffer.byteLength(daten) } : {}) },
      rejectUnauthorized: !k.insecure,
      timeout: 20_000,
    }, (res) => {
      let text = '';
      res.on('data', (c: Buffer) => { text += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Zeitüberschreitung')); });
    if (daten) req.write(daten);
    req.end();
  });
}

function anfrageStrom(k: GeraetKonfig, pfad: string, body: unknown, aufEreignis: (e: SseEreignis) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const u = new URL(pfad, k.server);
    const daten = JSON.stringify(body);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'POST',
      headers: { Authorization: `Bearer ${k.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(daten) },
      rejectUnauthorized: !k.insecure,
    }, (res) => {
      if (res.statusCode !== 200) { let t = ''; res.on('data', (c: Buffer) => { t += c.toString(); }); res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${t.slice(0, 200)}`))); return; }
      let puffer = '';
      const verarbeite = (teil: string) => {
        const zeile = teil.split('\n').find(l => l.startsWith('data: '));
        if (!zeile) return;
        try { aufEreignis(JSON.parse(zeile.slice(6)) as SseEreignis); } catch { /* unvollständig */ }
      };
      res.on('data', (c: Buffer) => {
        puffer += c.toString();
        const teile = puffer.split('\n\n');
        puffer = teile.pop() ?? '';
        for (const t of teile) verarbeite(t);
      });
      res.on('end', () => { if (puffer.trim()) verarbeite(puffer); resolve(); });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(daten);
    req.end();
  });
}

/** v1241 — Rohdaten senden (Audio zur Transkription) und Rohdaten empfangen (Sprachsynthese). */
function anfrageRoh(k: GeraetKonfig, pfad: string, body: Buffer | string, contentType: string): Promise<{ status: number; data: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(pfad, k.server);
    const mod = u.protocol === 'https:' ? https : http;
    const daten = typeof body === 'string' ? Buffer.from(body) : body;
    const req = mod.request(u, {
      method: 'POST',
      headers: { Authorization: `Bearer ${k.token}`, 'Content-Type': contentType, 'Content-Length': daten.length },
      rejectUnauthorized: !k.insecure,
      timeout: 120_000,
    }, (res) => {
      const teile: Buffer[] = [];
      res.on('data', (c: Buffer) => teile.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, data: Buffer.concat(teile), contentType: String(res.headers['content-type'] ?? '') }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Zeitüberschreitung')); });
    req.write(daten);
    req.end();
  });
}

function protokollLeser(pfad: string, aufZeile: (z: string) => void): () => void {
  let position = existsSync(pfad) ? statSync(pfad).size : 0;
  const t = setInterval(() => {
    try {
      if (!existsSync(pfad)) return;
      const groesse = statSync(pfad).size;
      if (groesse < position) position = 0;
      if (groesse === position) return;
      const fd = openSync(pfad, 'r');
      const buf = Buffer.alloc(groesse - position);
      readSync(fd, buf, 0, buf.length, position);
      closeSync(fd);
      position = groesse;
      for (const z of buf.toString('utf8').split('\n')) { const s = z.trim(); if (s) aufZeile(s.replace(/^\S+Z\s+/, '')); }
    } catch { /* nächste Runde */ }
  }, 1000);
  return () => clearInterval(t);
}

const HILFE = 'Schreiben = Chat als Owner · Strg+T oder /talk = sprechen · /hören [aus] = zuhören mit Aktivierungswort · /stimme an|aus · /tier fast|default|strong · /ja [n] · /nein [n] · /offen · /geraete · /lage · /quit';

export async function sitzungCommand(opts: { ohneSatellit?: boolean; einfach?: boolean }): Promise<void> {
  const k = ladeKonfig();
  if (!k) { console.error('Nicht gekoppelt. Zuerst: alfred pair --server https://host:3420 --code <Code>'); process.exit(1); }

  // v1303 — Oberfläche: Ink im echten Terminal, readline für Skripte/Tests/--einfach
  const status: SitzungStatus = { geraet: k.name, version: getVersion(), server: k.server, satellit: 'aus', offen: 0, modus: 'bereit', stimme: false, hoeren: false };
  let ui: Oberflaeche;
  let inkAktiv = false;
  if (!opts.einfach && !process.env.ALFRED_SITZUNG_EINFACH) {
    try {
      const { InkOberflaeche, inkMoeglich } = await import('./sitzung-ink.js');
      if (inkMoeglich()) { const ink = new InkOberflaeche(status); ink.start(); ui = ink; inkAktiv = true; }
    } catch (err) { console.error(`Ink-Oberfläche nicht verfügbar (${(err as Error).message}) — readline`); }
  }
  ui ??= new ReadlineOberflaeche();
  const drucke = (text: string) => ui.drucke(text);
  let antwortLaeuft = false;
  const setzeModus = (m: SitzungStatus['modus']) => { status.modus = m; ui.status({ modus: m }); };

  // Bestätigungen: Liste und Meldung (per IPC sofort, per Abfrage als Rückfall und für Erledigtes)
  const offen: Bestaetigung[] = [];
  const gemeldet = new Set<string>();
  // v1305 — Feld der offenen Bestätigungen in der Ink-Oberfläche
  const offenStatus = () => ui.status({ offen: offen.length, offenListe: offen.map(b => ({ id: b.id, text: b.description ?? b.skillName ?? '', quelle: b.source, seit: b.createdAt })) });
  const meldeNeu = (b: Bestaetigung) => {
    if (gemeldet.has(b.id)) return;
    gemeldet.add(b.id); offen.push(b);
    offenStatus();
    drucke(`\n🔔 Bestätigung [${offen.length}] ${b.source === 'geraet' ? '(Gerät) ' : ''}${b.description ?? b.skillName ?? ''}\n   → /ja ${offen.length} oder /nein ${offen.length}${inkAktiv ? ' (Alt+J / Alt+N für die jüngste)' : ''}`);
  };

  // Satellit: per IPC anhängen (v1302), sonst Protokoll mitlesen, sonst selbst betreiben
  let satellitStop: (() => void) | undefined;
  let satellitArt = 'aus';
  let ipc: IpcClient | undefined;
  if (!opts.ohneSatellit) {
    if (satellitDienstLaeuft()) {
      ipc = await verbindeIpc((n) => {
        if (n.typ === 'status') {
          ui.status({ verbunden: n.status.verbunden, satellit: `Dienst ${n.status.version}` });
          drucke(`⚙ Satellit ${n.status.version} (PID ${n.status.pid}) ${n.status.verbunden ? `verbunden mit Alfred ${n.status.serverVersion ?? ''}` : 'nicht verbunden'}${n.status.aktionenLaufend ? `, ${n.status.aktionenLaufend} Aktion(en) laufen` : ''}`);
        }
        else if (n.typ === 'ereignis') { if (n.art === 'verbunden') ui.status({ verbunden: true }); if (n.art === 'getrennt') ui.status({ verbunden: false }); drucke(`⚙ ${n.text}`); }
        else if (n.typ === 'bestaetigung') meldeNeu(n.bestaetigung as Bestaetigung);
      }, () => { ui.status({ verbunden: undefined, satellit: 'Verbindung beendet' }); drucke('⚙ Verbindung zum Satelliten beendet'); });
      if (ipc) { satellitArt = 'Dienst läuft, angehängt über IPC'; satellitStop = ipc.close; }
      else {
        satellitArt = 'Dienst läuft (älter, ohne IPC), Protokoll wird mitgelesen';
        satellitStop = protokollLeser(dienstLogPfad(), z => { if (/Aktion |→ |Verbunden|Verbindung|Fehler/.test(z)) drucke(`⚙ ${z}`); });
      }
    } else {
      satellitArt = 'in dieser Sitzung gestartet';
      const s = starteSatellit(k, { log: z => drucke(`⚙ ${z}`), fehler: z => drucke(`⚙ ${z}`) });
      satellitStop = s.stop;
    }
  }
  ui.status({ satellit: satellitArt });

  drucke(`\nAlfred-Sitzung auf ${k.name} (v${getVersion()}) → ${k.server}`);
  drucke(`Satellit: ${satellitArt}`);
  drucke(HILFE);
  ui.prompt('Du: ');

  // Bestätigungen: alle 4 s abholen — neue melden (Rückfall ohne IPC), erledigte entfernen
  const holeBestaetigungen = async () => {
    try {
      const r = await anfrage(k, 'GET', '/api/confirmations/pending');
      if (r.status !== 200) return;
      const liste = (JSON.parse(r.text) as { confirmations?: Bestaetigung[] }).confirmations ?? [];
      const ids = new Set(liste.map(b => b.id));
      for (let i = offen.length - 1; i >= 0; i--) if (!ids.has(offen[i].id)) { drucke(`✓ Bestätigung erledigt: ${(offen[i].description ?? '').slice(0, 80)}`); offen.splice(i, 1); offenStatus(); }
      for (const b of liste) meldeNeu(b);
    } catch { /* nächste Runde */ }
  };
  void holeBestaetigungen();
  const bestaetigungsTimer = setInterval(() => { void holeBestaetigungen(); }, 4000);

  const entscheide = async (arg: string, entscheidung: 'approve' | 'reject') => {
    const n = arg ? parseInt(arg, 10) : offen.length;
    const b = offen[n - 1];
    if (!b) { drucke(offen.length ? `Keine Bestätigung mit Nummer ${arg}. Offen: 1–${offen.length}` : 'Keine offene Bestätigung.'); return; }
    const r = await anfrage(k, 'POST', `/api/confirmations/${encodeURIComponent(b.id)}/${entscheidung}`);
    if (r.status === 200) { offen.splice(n - 1, 1); offenStatus(); drucke(`${entscheidung === 'approve' ? '✅ Freigegeben' : '❌ Abgelehnt'}: ${(b.description ?? '').slice(0, 100)}`); }
    else drucke(`Entscheidung nicht angenommen (HTTP ${r.status}): ${r.text.slice(0, 120)}`);
  };

  const ablage = path.join(os.homedir(), '.alfred', 'sitzung');
  const chatId = `sitzung:${k.geraetId}`;
  // v1241 — Sprache: Push-to-Talk und vorgelesene Antworten
  const audio = new Audio();
  let aufnahme: Aufnahme | undefined;
  let stimme = false;
  let tier: string | undefined; // v1248 — Modellstufe je Nachricht (/tier)
  // v1252 — Zuhören ohne Taste: Mikrofonstrom → Satzende → Relais → Aktivierungswort → Nachricht
  const aktivierungswort = String((k as GeraetKonfig & { aktivierungswort?: string }).aktivierungswort ?? 'Alfred');
  let hoeren: { strom: MikrofonStrom; client: HoerClient; erkenner: SatzendeErkenner } | undefined;
  let gespraechsfensterBis = 0;
  let gehoert = '';
  // v1247 — Streaming-Sprache Stufe 1: Block für Block — der nächste wird synthetisiert, während der vorige läuft
  const synthetisiere = async (block: string): Promise<{ data: Buffer; mimeType: string }> => {
    const r = await anfrageRoh(k, '/api/sprich', JSON.stringify({ text: block, knapp: false }), 'application/json');
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.data.toString('utf8').slice(0, 120)}`);
    return { data: r.data, mimeType: r.contentType || 'audio/mpeg' };
  };
  const sprich = async (text: string) => {
    const bloecke = sprachBloecke(text);
    if (bloecke.length === 0) return;
    const start = Date.now();
    let naechster = synthetisiere(bloecke[0]);
    try {
      for (let i = 0; i < bloecke.length; i++) {
        const a = await naechster;
        if (i + 1 < bloecke.length) naechster = synthetisiere(bloecke[i + 1]);
        if (i === 0) ui.fluechtig(`🔊 ${bloecke.length} ${bloecke.length === 1 ? 'Block' : 'Blöcke'}, erster Ton nach ${((Date.now() - start) / 1000).toFixed(1)} s`);
        await audio.abspielen(a.data, a.mimeType);
      }
    } catch (err) { drucke(`🔇 Sprachausgabe fehlgeschlagen: ${(err as Error).message}`); }
    ui.fluechtig('');
  };

  const hoerenStart = async () => {
    if (hoeren) { drucke(`🎧 Höre schon zu (Wort: „${aktivierungswort}")`); return; }
    const erkenner = new SatzendeErkenner();
    let client: HoerClient;
    try {
      client = new HoerClient(k, (e) => {
        if (e.typ === 'delta') { gehoert += e.text ?? ''; ui.fluechtig(`🎧 ${gehoert.slice(-100)}`); }
        else if (e.typ === 'fertig') {
          const text = (e.text ?? '').trim(); gehoert = '';
          ui.fluechtig('');
          if (!text) { ui.prompt(); return; }
          const a = pruefeAktivierung(text, aktivierungswort, Date.now() < gespraechsfensterBis);
          if (a.art === 'ignoriert') { drucke(`(nicht an mich: ${text})`); return; }
          if (a.art === 'stopp') { audio.abbrechen(); drucke('⏹ gestoppt'); gespraechsfensterBis = Date.now() + 20_000; return; }
          if (a.art === 'nur_wort') { gespraechsfensterBis = Date.now() + 20_000; drucke(`Du (gesprochen): ${text}`); void sprich('Ja?'); return; }
          drucke(`Du (gesprochen): ${a.text}`);
          void sende(a.text, true).then(() => { gespraechsfensterBis = Date.now() + 20_000; });
        }
        else if (e.typ === 'limit' || e.typ === 'fehler') drucke(`🎧 ${e.typ}: ${e.grund ?? ''}`);
      }, (grund) => { drucke(`🎧 Relais: ${grund} — Zuhören beendet`); void hoerenStop(); });
      await client.verbinde();
    } catch (err) { drucke(`🎧 Relais nicht erreichbar: ${(err as Error).message}`); return; }
    const strom = await mikrofonStrom((pcm) => {
      // Halbduplex: während Alfred spricht oder antwortet, nicht hören (sonst transkribiert er sich selbst)
      if (antwortLaeuft || audio.spielt) { return; }
      for (const ev of erkenner.schiebe(pcm)) {
        if (ev.art === 'start') { client.start(); client.audio(ev.audio); }
        else if (ev.art === 'ende') { client.ende(); }
      }
      if (erkenner.spricht) client.audio(pcm);
    }, (grund) => { drucke(`🎧 Mikrofon: ${grund}`); void hoerenStop(); });
    hoeren = { strom, client, erkenner };
    ui.status({ hoeren: true });
    ui.prompt(`🎧 ${aktivierungswort}: `);
    drucke(`🎧 Höre zu — sag „${aktivierungswort}, …". Nach einer Antwort 20 s ohne Wort. „${aktivierungswort}, stopp" bricht die Wiedergabe ab. /hören aus beendet.`);
  };
  const hoerenStop = async () => {
    if (!hoeren) return;
    const h = hoeren; hoeren = undefined;
    try { h.strom.stop(); } catch { /* */ }
    try { h.client.schluss(); } catch { /* */ }
    ui.status({ hoeren: false });
    ui.prompt('Du: ');
    drucke('🎧 Zuhören aus.');
  };

  const sende = async (text: string, gesprochen = false) => {
    antwortLaeuft = true; setzeModus('antwort');
    const sendeStart = Date.now();
    let antwortText = '';
    // v1243 — Sprachantworten des Modells (text_to_speech / Voice) werden abgespielt statt als .bin abgelegt
    let sprachAnhang: { data: Buffer; mimeType: string } | undefined;
    const dateiAnhaenge: string[] = [];
    // v1248 — Streaming: Textstücke sofort zeigen; fertige Sätze sofort sprechen (Synthese im Hintergrund, Wiedergabe der Reihe nach)
    const sprechen = gesprochen || stimme;
    let gezeigt = '';
    let puffer = '';
    let erstesWort = 0;
    let wiedergabe: Promise<void> = Promise.resolve();
    let gesprochenBloecke = 0;
    const spiele = (block: string) => {
      const synth = synthetisiere(block);
      wiedergabe = wiedergabe.then(async () => { const a = await synth; await audio.abspielen(a.data, a.mimeType); }).catch(err => { drucke(`🔇 ${(err as Error).message}`); });
      gesprochenBloecke += 1;
    };
    const zeigeDelta = (t: string) => {
      if (!gezeigt) erstesWort = Date.now();
      ui.antwortDelta(t);
      gezeigt += t;
      if (sprechen) {
        puffer += t;
        const { bloecke, rest } = schneideSaetze(puffer, 60);
        for (const b of bloecke) spiele(b);
        puffer = rest;
      }
    };
    const neuerAnlauf = () => { ui.antwortNeuerAnlauf(); gezeigt = ''; puffer = ''; };
    try {
      await anfrageStrom(k, '/api/message', { text, chatId, stream: true, ...(tier ? { tier } : {}) }, (e) => {
        if (e.type === 'progress' && e.kind === 'delta') { zeigeDelta(e.text ?? ''); return; }
        if (e.type === 'progress' && (e.kind === 'tool_call' || e.kind === 'thinking')) { if (gezeigt) neuerAnlauf(); ui.fluechtig(`… ${(e.text ?? '').slice(0, 100)}`); }
        if (e.type === 'status') { if (!gezeigt) ui.fluechtig(`… ${(e.text ?? '').slice(0, 100)}`); }
        else if (e.type === 'response') { antwortText = e.text ?? ''; }
        else if (e.type === 'attachment' && e.data) {
          const data = Buffer.from(e.data, 'base64');
          const mime = audioMimeAusBytes(data);
          if (e.attachmentType === 'voice' || e.attachmentType === 'audio' || mime.startsWith('audio/')) { sprachAnhang = { data, mimeType: mime.startsWith('audio/') ? mime : 'audio/mpeg' }; return; }
          try {
            mkdirSync(ablage, { recursive: true });
            const name = e.fileName ?? `${new Date().toISOString().replace(/[:.]/g, '-')}.${e.attachmentType === 'image' ? 'jpg' : 'bin'}`;
            const ziel = path.join(ablage, name);
            writeFileSync(ziel, data);
            dateiAnhaenge.push(`📎 ${e.caption ? e.caption + ' → ' : ''}${ziel}`);
          } catch (err) { dateiAnhaenge.push(`📎 Anhang nicht gespeichert: ${(err as Error).message}`); }
        }
        else if (e.type === 'error') { drucke(`Fehler: ${e.text ?? 'unbekannt'}`); }
      });
    } catch (err) { drucke(`Fehler: ${(err as Error).message}`); }
    ui.fluechtig('');
    const hatText = antwortText && antwortText !== '(no response)';
    // v1248 — stand die Antwort schon stückweise da: nur abschließen; sonst Endtext zeigen
    const endtext = gezeigt && hatText && antwortText.trim() === gezeigt.trim() ? undefined : (hatText ? antwortText : (sprachAnhang ? '🔊 (Sprachantwort)' : antwortText));
    ui.antwortEnde(endtext, dateiAnhaenge);
    if (sprachAnhang) {
      // Sprachantwort vom Modell: immer abspielen (sie IST die Antwort), kein zweites Vorlesen
      ui.fluechtig('🔊 …');
      try { await audio.abspielen(sprachAnhang.data, sprachAnhang.mimeType); } catch (err) { drucke(`🔇 Wiedergabe fehlgeschlagen: ${(err as Error).message}`); }
      ui.fluechtig('');
    } else if (sprechen && hatText) {
      if (gesprochenBloecke > 0 && antwortText.trim() === gezeigt.trim()) {
        // Rest, der noch keinen Satzschluss hatte, jetzt sprechen; dann auf die laufende Wiedergabe warten
        const rest = puffer.trim();
        if (rest) spiele(rest);
        ui.fluechtig(`🔊 ${gesprochenBloecke} ${gesprochenBloecke === 1 ? 'Block' : 'Blöcke'} während des Schreibens${erstesWort ? `, erstes Wort nach ${((erstesWort - sendeStart) / 1000).toFixed(1)} s` : ''}`);
        await wiedergabe;
        ui.fluechtig('');
      } else {
        ui.fluechtig('🔊 …'); await sprich(antwortText); ui.fluechtig('');
      }
    }
    antwortLaeuft = false; setzeModus('bereit');
    ui.prompt();
  };

  const talkStart = async () => {
    try {
      aufnahme = await audio.aufnehmen();
      setzeModus('aufnahme');
      ui.prompt('● Aufnahme läuft — Strg+T oder Enter zum Stoppen ');
    } catch (err) { drucke(`🎙 ${(err as Error).message}`); }
  };
  const talkStop = async (a: Aufnahme) => {
    ui.prompt('Du: ');
    antwortLaeuft = true; setzeModus('antwort');
    ui.fluechtig('… höre zu');
    const abbruch = (text: string) => { antwortLaeuft = false; setzeModus('bereit'); ui.fluechtig(''); drucke(text); };
    try {
      const { data, mimeType } = await a.stop();
      if (data.length < 2000) { abbruch('🎙 Aufnahme zu kurz — nichts gesendet.'); return; }
      const r = await anfrageRoh(k, '/api/transcribe', data, mimeType);
      if (r.status !== 200) { abbruch(`🎙 Transkription fehlgeschlagen (HTTP ${r.status}): ${r.data.toString('utf8').slice(0, 120)}`); return; }
      const text = String((JSON.parse(r.data.toString('utf8')) as { text?: string }).text ?? '').trim();
      if (!text) { abbruch('🎙 Nichts verstanden.'); return; }
      ui.fluechtig('');
      drucke(`Du (gesprochen): ${text}`);
      antwortLaeuft = false;
      await sende(text, true);
    } catch (err) { abbruch(`🎙 ${(err as Error).message}`); }
  };

  const beende = () => {
    clearInterval(bestaetigungsTimer);
    void hoerenStop();
    audio.stop();
    satellitStop?.();
    ui.drucke('\nSitzung beendet.');
    ui.schliessen();
    process.exit(0);
  };

  ui.aufTaste((t, nr) => {
    if (t === 'strg+t') {
      if (aufnahme) { const a = aufnahme; aufnahme = undefined; void talkStop(a); return; }
      if (!antwortLaeuft) void talkStart();
      return;
    }
    if (t === 'ende') { beende(); return; }
    if (t === 'lage') { void zeigeLage().catch(err => drucke(`Fehler: ${(err as Error).message}`)); return; }
    if (t === 'ja') { void entscheide(nr ? String(nr) : '', 'approve').catch(err => drucke(`Fehler: ${(err as Error).message}`)); return; }
    if (t === 'nein') { void entscheide(nr ? String(nr) : '', 'reject').catch(err => drucke(`Fehler: ${(err as Error).message}`)); return; }
  });

  const zeigeLage = async () => {
    const r = await anfrage(k, 'GET', '/api/lebenszeichen');
    const lage = r.status === 200 ? (JSON.parse(r.text) as { lage?: { stand?: string; text?: string } }).lage : undefined;
    drucke(lage?.text ? `Lage (${lage.stand ?? ''}):\n${lage.text}` : 'Keine Lage vorhanden.');
  };

  ui.aufEingabe((zeile) => {
    const t = zeile.trim();
    // v1241 — während einer Aufnahme stoppt jede Eingabe (Enter) die Aufnahme
    if (aufnahme) { const a = aufnahme; aufnahme = undefined; void talkStop(a); return; }
    if (!t) { ui.prompt(); return; }
    if (inkAktiv) drucke(`Du: ${t}`);
    const [befehl, ...rest] = t.split(/\s+/);
    const arg = rest.join(' ');
    void (async () => {
      switch (befehl.toLowerCase()) {
        case '/quit': case '/exit': case '/ende': beende(); return;
        case '/talk': case '/sprechen': await talkStart(); return;
        case '/hören': case '/hoeren': case '/listen': { // v1252
          const w = arg.trim().toLowerCase();
          if (w === 'aus' || w === 'off' || w === 'stop') await hoerenStop(); else await hoerenStart();
          return;
        }
        case '/stimme': stimme = arg ? /^(an|on|ja|1)$/i.test(arg) : !stimme; ui.status({ stimme }); drucke(`🔊 Vorgelesene Antworten: ${stimme ? 'an' : 'aus'}`); return;
        case '/tier': { // v1248 — Modellstufe wie überall: default · strong · medium · fast
          const w = arg.trim().toLowerCase();
          if (!w || w === 'auto' || w === 'server') { tier = undefined; ui.status({ tier: undefined }); drucke('Modellstufe: Server-Standard'); return; }
          if (!['default', 'strong', 'medium', 'fast'].includes(w)) { drucke('Modellstufe: default · strong · medium · fast · auto'); return; }
          tier = w; ui.status({ tier: w }); drucke(`Modellstufe: ${w}`); return;
        }
        case '/ja': await entscheide(arg, 'approve'); return;
        case '/nein': await entscheide(arg, 'reject'); return;
        case '/offen': drucke(offen.length ? offen.map((b, i) => `[${i + 1}] ${b.description ?? b.skillName ?? ''}`).join('\n') : 'Keine offene Bestätigung.'); return;
        case '/geraete': {
          const r = await anfrage(k, 'GET', '/api/geraete');
          const liste = r.status === 200 ? (JSON.parse(r.text) as { geraete?: Array<{ name: string; plattform: string; online: boolean }> }).geraete ?? [] : [];
          drucke(liste.length ? liste.map(g => `${g.online ? '●' : '○'} ${g.name} (${g.plattform})`).join('\n') : `Keine Geräte (HTTP ${r.status}).`);
          return;
        }
        case '/lage': await zeigeLage(); return;
        case '/hilfe': case '/help': drucke(HILFE); return;
        default: await sende(t);
      }
    })().catch(err => drucke(`Fehler: ${(err as Error).message}`));
  });

  process.on('SIGINT', beende);
  await new Promise(() => undefined);
}
