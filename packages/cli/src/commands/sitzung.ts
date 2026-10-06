import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { ladeKonfig, type GeraetKonfig } from './pair.js';
import { starteSatellit } from './satellit.js';
import { dienstLogPfad, satellitDienstLaeuft } from './satellit-dienst.js';
import { getVersion } from '../version.js';
import { Audio, type Aufnahme } from './satellit-audio.js'; // v1241
import { audioMimeAusBytes } from '@alfred/core'; // v1243

/**
 * v1232 — Die Sitzung: EIN Terminal für Chat, Bestätigungen und den Satelliten.
 *
 * Owner-Wunsch (06.10.): nicht drei CLIs für drei Arten. Die Sitzung weist sich mit dem
 * Gerätetoken aus (~/.alfred/geraet.json), spricht als Owner mit Alfred, zeigt offene
 * Bestätigungen zum Beantworten mit /ja und /nein und lässt die Aktionen des Satelliten
 * mitlaufen — als Dienst (Protokoll wird mitgelesen) oder, wenn keiner läuft, im selben Prozess.
 * Sprache (Talk) folgt in Phase 2 der Geräte-Architektur.
 */
interface Bestaetigung { id: string; description?: string; skillName?: string; createdAt?: string; source?: string }
interface SseEreignis { type: string; text?: string; attachmentType?: string; fileName?: string; data?: string; caption?: string }

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

function zeit(): string { return new Date().toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' }); }

/** Liest neue Zeilen des Dienst-Protokolls (ab Start der Sitzung). */
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

export async function sitzungCommand(opts: { ohneSatellit?: boolean }): Promise<void> {
  const k = ladeKonfig();
  if (!k) { console.error('Nicht gekoppelt. Zuerst: alfred pair --server https://host:3420 --code <Code>'); process.exit(1); }

  // Ausweis prüfen
  try {
    const r = await anfrage(k, 'GET', '/api/lebenszeichen');
    if (r.status === 401) { console.error('Gerätetoken wird nicht mehr angenommen — bitte neu koppeln (alfred pair).'); process.exit(1); }
    if (r.status !== 200) { console.error(`Alfred antwortet mit HTTP ${r.status} — läuft der Server unter ${k.server}?`); process.exit(1); }
  } catch (err) { console.error(`Keine Verbindung zu ${k.server}: ${(err as Error).message}`); process.exit(1); }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'Du: ' });
  // v1245 — Strg+T startet und stoppt die Aufnahme (statt /talk + Enter)
  readline.emitKeypressEvents(process.stdin, rl);
  let antwortLaeuft = false;
  const drucke = (text: string) => {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(text + '\n');
    if (!antwortLaeuft) rl.prompt(true);
  };

  // Satellit: Dienst mitlesen oder selbst betreiben
  let satellitStop: (() => void) | undefined;
  let satellitArt = 'aus';
  if (!opts.ohneSatellit) {
    if (satellitDienstLaeuft()) {
      satellitArt = 'Dienst läuft, Protokoll wird mitgelesen';
      satellitStop = protokollLeser(dienstLogPfad(), z => { if (/Aktion |→ |Verbunden|Verbindung|Fehler/.test(z)) drucke(`⚙ ${z}`); });
    } else {
      satellitArt = 'in dieser Sitzung gestartet';
      const s = starteSatellit(k, { log: z => drucke(`⚙ ${z}`), fehler: z => drucke(`⚙ ${z}`) });
      satellitStop = s.stop;
    }
  }

  console.log(`\nAlfred-Sitzung auf ${k.name} (v${getVersion()}) → ${k.server}`);
  console.log(`Satellit: ${satellitArt}`);
  console.log('Schreiben = Chat als Owner · Strg+T oder /talk = sprechen (Strg+T/Enter stoppt) · /stimme an|aus · /ja [n] · /nein [n] · /offen · /geraete · /lage · /quit\n');
  rl.prompt();

  // Bestätigungen: alle 4 s abholen, neue melden
  const offen: Bestaetigung[] = [];
  const gemeldet = new Set<string>();
  const holeBestaetigungen = async () => {
    try {
      const r = await anfrage(k, 'GET', '/api/confirmations/pending');
      if (r.status !== 200) return;
      const liste = (JSON.parse(r.text) as { confirmations?: Bestaetigung[] }).confirmations ?? [];
      const ids = new Set(liste.map(b => b.id));
      for (let i = offen.length - 1; i >= 0; i--) if (!ids.has(offen[i].id)) { drucke(`✓ Bestätigung erledigt: ${(offen[i].description ?? '').slice(0, 80)}`); offen.splice(i, 1); }
      for (const b of liste) {
        if (gemeldet.has(b.id)) continue;
        gemeldet.add(b.id); offen.push(b);
        drucke(`\n🔔 Bestätigung [${offen.length}] ${b.source === 'geraet' ? '(Gerät) ' : ''}${b.description ?? b.skillName ?? ''}\n   → /ja ${offen.length} oder /nein ${offen.length}`);
      }
    } catch { /* nächste Runde */ }
  };
  void holeBestaetigungen();
  const bestaetigungsTimer = setInterval(() => { void holeBestaetigungen(); }, 4000);

  const entscheide = async (arg: string, entscheidung: 'approve' | 'reject') => {
    const n = arg ? parseInt(arg, 10) : offen.length;
    const b = offen[n - 1];
    if (!b) { drucke(offen.length ? `Keine Bestätigung mit Nummer ${arg}. Offen: 1–${offen.length}` : 'Keine offene Bestätigung.'); return; }
    const r = await anfrage(k, 'POST', `/api/confirmations/${encodeURIComponent(b.id)}/${entscheidung}`);
    if (r.status === 200) { offen.splice(n - 1, 1); drucke(`${entscheidung === 'approve' ? '✅ Freigegeben' : '❌ Abgelehnt'}: ${(b.description ?? '').slice(0, 100)}`); }
    else drucke(`Entscheidung nicht angenommen (HTTP ${r.status}): ${r.text.slice(0, 120)}`);
  };

  const ablage = path.join(os.homedir(), '.alfred', 'sitzung');
  const chatId = `sitzung:${k.geraetId}`;
  // v1241 — Sprache: Push-to-Talk und vorgelesene Antworten
  const audio = new Audio();
  let aufnahme: Aufnahme | undefined;
  let stimme = false;
  const sprich = async (text: string) => {
    try {
      const r = await anfrageRoh(k, '/api/sprich', JSON.stringify({ text, knapp: true }), 'application/json');
      if (r.status !== 200) { drucke(`🔇 Sprachausgabe nicht möglich (HTTP ${r.status}): ${r.data.toString('utf8').slice(0, 120)}`); return; }
      await audio.abspielen(r.data, r.contentType || 'audio/mpeg');
    } catch (err) { drucke(`🔇 Sprachausgabe fehlgeschlagen: ${(err as Error).message}`); }
  };

  const sende = async (text: string, gesprochen = false) => {
    antwortLaeuft = true;
    let status = '';
    let antwortText = '';
    // v1243 — Sprachantworten des Modells (text_to_speech / Voice) werden abgespielt statt als .bin abgelegt
    let sprachAnhang: { data: Buffer; mimeType: string } | undefined;
    const dateiAnhaenge: string[] = [];
    try {
      await anfrageStrom(k, '/api/message', { text, chatId }, (e) => {
        if (e.type === 'status') { status = e.text ?? ''; readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0); process.stdout.write(`… ${status.slice(0, 100)}`); }
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
        else if (e.type === 'error') { process.stdout.write(`\nFehler: ${e.text ?? 'unbekannt'}\n`); }
      });
    } catch (err) { process.stdout.write(`\nFehler: ${(err as Error).message}\n`); }
    readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0);
    const hatText = antwortText && antwortText !== '(no response)';
    process.stdout.write(`\nAlfred (${zeit()}): ${hatText ? antwortText : (sprachAnhang ? '🔊 (Sprachantwort)' : antwortText)}\n`);
    for (const z of dateiAnhaenge) process.stdout.write(z + '\n');
    process.stdout.write('\n');
    if (sprachAnhang) {
      // Sprachantwort vom Modell: immer abspielen (sie IST die Antwort), kein zweites Vorlesen
      process.stdout.write('🔊 …');
      try { await audio.abspielen(sprachAnhang.data, sprachAnhang.mimeType); } catch (err) { process.stdout.write(`\n🔇 Wiedergabe fehlgeschlagen: ${(err as Error).message}\n`); }
      readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0);
    } else if ((gesprochen || stimme) && hatText) {
      process.stdout.write('🔊 …'); await sprich(antwortText); readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0);
    }
    antwortLaeuft = false;
    rl.prompt(true);
  };

  const talkStart = async () => {
    try {
      aufnahme = await audio.aufnehmen();
      rl.setPrompt('● Aufnahme läuft — Strg+T oder Enter zum Stoppen ');
      rl.prompt(true);
    } catch (err) { drucke(`🎙 ${(err as Error).message}`); }
  };
  const talkStop = async (a: Aufnahme) => {
    rl.setPrompt('Du: ');
    antwortLaeuft = true;
    process.stdout.write('… höre zu');
    try {
      const { data, mimeType } = await a.stop();
      if (data.length < 2000) { antwortLaeuft = false; drucke('🎙 Aufnahme zu kurz — nichts gesendet.'); return; }
      const r = await anfrageRoh(k, '/api/transcribe', data, mimeType);
      if (r.status !== 200) { antwortLaeuft = false; drucke(`🎙 Transkription fehlgeschlagen (HTTP ${r.status}): ${r.data.toString('utf8').slice(0, 120)}`); return; }
      const text = String((JSON.parse(r.data.toString('utf8')) as { text?: string }).text ?? '').trim();
      if (!text) { antwortLaeuft = false; drucke('🎙 Nichts verstanden.'); return; }
      readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0);
      process.stdout.write(`Du (gesprochen): ${text}\n`);
      antwortLaeuft = false;
      await sende(text, true);
    } catch (err) { antwortLaeuft = false; drucke(`🎙 ${(err as Error).message}`); }
  };

  process.stdin.on('keypress', (_ch: string, key: { ctrl?: boolean; name?: string } | undefined) => {
    if (!key?.ctrl || key.name !== 't') return;
    if (aufnahme) { const a = aufnahme; aufnahme = undefined; void talkStop(a); return; }
    if (!antwortLaeuft) void talkStart();
  });

  rl.on('line', (zeile) => {
    const t = zeile.trim();
    // v1241 — während einer Aufnahme stoppt jede Eingabe (Enter) die Aufnahme
    if (aufnahme) { const a = aufnahme; aufnahme = undefined; void talkStop(a); return; }
    if (!t) { rl.prompt(); return; }
    const [befehl, ...rest] = t.split(/\s+/);
    const arg = rest.join(' ');
    void (async () => {
      switch (befehl.toLowerCase()) {
        case '/quit': case '/exit': case '/ende': beende(); return;
        case '/talk': case '/sprechen': await talkStart(); return;
        case '/stimme': stimme = arg ? /^(an|on|ja|1)$/i.test(arg) : !stimme; drucke(`🔊 Vorgelesene Antworten: ${stimme ? 'an' : 'aus'}`); return;
        case '/ja': await entscheide(arg, 'approve'); return;
        case '/nein': await entscheide(arg, 'reject'); return;
        case '/offen': drucke(offen.length ? offen.map((b, i) => `[${i + 1}] ${b.description ?? b.skillName ?? ''}`).join('\n') : 'Keine offene Bestätigung.'); return;
        case '/geraete': {
          const r = await anfrage(k, 'GET', '/api/geraete');
          const liste = r.status === 200 ? (JSON.parse(r.text) as { geraete?: Array<{ name: string; plattform: string; online: boolean }> }).geraete ?? [] : [];
          drucke(liste.length ? liste.map(g => `${g.online ? '●' : '○'} ${g.name} (${g.plattform})`).join('\n') : `Keine Geräte (HTTP ${r.status}).`);
          return;
        }
        case '/lage': {
          const r = await anfrage(k, 'GET', '/api/lebenszeichen');
          const lage = r.status === 200 ? (JSON.parse(r.text) as { lage?: { stand?: string; text?: string } }).lage : undefined;
          drucke(lage?.text ? `Lage (${lage.stand ?? ''}):\n${lage.text}` : 'Keine Lage vorhanden.');
          return;
        }
        case '/hilfe': case '/help': drucke('Schreiben = Chat als Owner · Strg+T oder /talk = sprechen (Strg+T/Enter stoppt) · /stimme an|aus · /ja [n] · /nein [n] · /offen · /geraete · /lage · /quit'); return;
        default: await sende(t);
      }
    })().catch(err => drucke(`Fehler: ${(err as Error).message}`));
  });

  const beende = () => {
    clearInterval(bestaetigungsTimer);
    audio.stop();
    satellitStop?.();
    console.log('\nSitzung beendet.');
    rl.close();
    process.exit(0);
  };
  rl.on('close', beende);
  process.on('SIGINT', beende);
  await new Promise(() => undefined);
}
