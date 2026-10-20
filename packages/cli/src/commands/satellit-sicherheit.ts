import type http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';
import { spkiHex, pruefeBefehl, type BefehlPruefung } from '@alfred/core';
import { speichereKonfig, type GeraetKonfig } from './pair.js';

/**
 * v1531 (Owner 20.10.: „1 und 2 gemeinsam wie empfohlen“) — Satelliten-Sicherheit.
 *
 * 1. Pinning: Der öffentliche Schlüssel des Servers (SHA-256 der SPKI, hex — wie die Handy-App) wird beim ersten Kontakt
 *    gemerkt und danach bei JEDER Verbindung geprüft — im Verbindungsaufbau, bevor ein Byte mit dem Token rausgeht
 *    (eigener https.Agent mit asynchronem createConnection). Gepinnt wird der Schlüssel, nicht das Zertifikat: Das
 *    Zertifikat läuft 03/2027 ab, eine Erneuerung mit demselben Schlüssel bricht nichts.
 * 2. Signierte Befehle: Aktionen und Beobachter-Regeln tragen eine Ed25519-Signatur des Servers (Schlüssel beim ersten
 *    Willkommen gemerkt, wie der Release-Schlüssel).
 *
 * Stufe a (Standard): lernen und prüfen — Abweichungen werden gemeldet (Sinne „sicherheit“), nichts abgewiesen.
 * Stufe b (`sicherheitStreng`): abweichender Server-Schlüssel → keine Verbindung; Befehl ohne gültige Signatur → abgelehnt.
 * Der Server schaltet b einseitig ein; zurück nur am Gerät (`alfred einstellungen sicherheit locker`).
 */

export interface SicherheitsStand {
  pin: 'ok' | 'gelernt' | 'abweichend' | 'unbekannt';
  signatur: BefehlPruefung | 'unbekannt';
  streng: boolean;
  befehleOk: number;
  befehleFehler: number;
}

const stand: SicherheitsStand = { pin: 'unbekannt', signatur: 'unbekannt', streng: false, befehleOk: 0, befehleFehler: 0 };
const gesehen = new Map<string, number>();
let gewarnt = '';

export function sicherheitsStand(k: GeraetKonfig): SicherheitsStand { return { ...stand, streng: !!k.sicherheitStreng }; }

/** Ergebnis der Pin-Prüfung für ein vom Server vorgelegtes Zertifikat (DER). Lernt beim ersten Kontakt. */
export function pruefePin(k: GeraetKonfig, der: Buffer, log?: (t: string) => void): 'ok' | 'gelernt' | 'abweichend' {
  const fp = spkiHex(der);
  const pins = k.serverSchluessel ?? [];
  if (pins.length === 0) {
    if (k.sicherheitStreng) { stand.pin = 'abweichend'; return 'abweichend'; } // streng ohne gemerkten Schlüssel: nichts lernen
    k.serverSchluessel = [fp];
    try { speichereKonfig(k); } catch { /* nur im Speicher */ }
    log?.(`Server-Schlüssel gemerkt: ${fp.slice(0, 16)}…`);
    stand.pin = 'gelernt';
    return 'gelernt';
  }
  if (pins.includes(fp)) { stand.pin = 'ok'; return 'ok'; }
  stand.pin = 'abweichend';
  if (gewarnt !== fp) { gewarnt = fp; log?.(`WARNUNG: Server-Schlüssel weicht ab (${fp.slice(0, 16)}… statt ${pins[0]!.slice(0, 16)}…)${k.sicherheitStreng ? ' — Verbindung abgelehnt' : ' — noch erlaubt (Stufe lernen)'}`); }
  return 'abweichend';
}

/** https.Agent, der den Server-Schlüssel prüft, bevor die Verbindung benutzt wird. */
class PinAgent extends https.Agent {
  constructor(private readonly k: GeraetKonfig, private readonly log?: (t: string) => void) { super({ keepAlive: false }); }
  // http-Client unterstützt das asynchrone createConnection (Callback): die Anfrage wartet auf die Prüfung
  override createConnection(optionen: http.RequestOptions, fertig?: (err: Error | null, stream: Duplex) => void): Duplex | undefined {
    const host = String(optionen.host ?? optionen.hostname ?? '');
    const s = tls.connect({ ...(optionen as tls.ConnectionOptions), servername: (optionen as tls.ConnectionOptions).servername ?? (host && !net.isIP(host) ? host : undefined), rejectUnauthorized: !this.k.insecure && !(this.k.serverSchluessel?.length) });
    let erledigt = false;
    const melde = (err: Error | null) => { if (erledigt) return; erledigt = true; if (err) s.destroy(); fertig?.(err, s); };
    s.once('secureConnect', () => {
      const c = s.getPeerCertificate(true);
      if (!c?.raw) { melde(new Error('Server legt kein Zertifikat vor')); return; }
      const r = pruefePin(this.k, c.raw, this.log);
      if (r === 'abweichend' && this.k.sicherheitStreng) melde(new Error('Server-Schlüssel unbekannt — Verbindung abgelehnt (neu koppeln, falls der Server wirklich gewechselt hat)'));
      else melde(null);
    });
    s.once('error', (err) => melde(err));
    return undefined;
  }
}

const agenten = new WeakMap<GeraetKonfig, PinAgent>();
let protokoll: ((t: string) => void) | undefined;
export function setzeSicherheitsLog(f: (t: string) => void): void { protokoll = f; }

/** TLS-Optionen für jede Verbindung zum Gehirn (HTTP, WebSocket): bei https der prüfende Agent. */
export function tlsOptionen(k: GeraetKonfig): { agent?: https.Agent; rejectUnauthorized?: boolean } {
  if (!/^https:/i.test(k.server)) return {};
  let a = agenten.get(k);
  if (!a) { a = new PinAgent(k, protokoll); agenten.set(k, a); }
  return { agent: a };
}

/** Befehls-Schlüssel aus dem Willkommen (beim ersten Kontakt gemerkt). Stufe b einseitig übernehmen. */
export function willkommenSicherheit(k: GeraetKonfig, n: { befehlsKey?: unknown; streng?: unknown }, log: (t: string) => void): void {
  let geaendert = false;
  const pem = typeof n.befehlsKey === 'string' && n.befehlsKey.includes('BEGIN PUBLIC KEY') ? n.befehlsKey : undefined;
  if (pem && !k.befehlsKey && !k.sicherheitStreng) { k.befehlsKey = pem; geaendert = true; log('Befehls-Schlüssel des Servers gemerkt'); }
  else if (pem && k.befehlsKey && pem !== k.befehlsKey) log('WARNUNG: Befehls-Schlüssel des Servers weicht vom gemerkten ab');
  // Stufe b nur, wenn Pin und Befehls-Schlüssel gelernt sind — sonst würde sich das Gerät aussperren
  if (n.streng === true && !k.sicherheitStreng && (k.serverSchluessel?.length ?? 0) > 0 && k.befehlsKey) { k.sicherheitStreng = true; geaendert = true; log('Sicherheit: ab jetzt streng (Server-Schlüssel und Befehlssignatur werden erzwungen)'); }
  if (geaendert) { try { speichereKonfig(k); } catch { /* nur im Speicher */ } }
}

/** Eingehenden Befehl prüfen. `erlaubt` = ausführen; in Stufe a immer, mit Vermerk. */
export function befehlPruefen(k: GeraetKonfig, n: Record<string, unknown>, log: (t: string) => void): { erlaubt: boolean; ergebnis: BefehlPruefung } {
  const ergebnis = pruefeBefehl(n, { schluesselPem: k.befehlsKey, geraetId: k.geraetId, gesehen });
  stand.signatur = ergebnis;
  if (ergebnis === 'ok') { stand.befehleOk++; return { erlaubt: true, ergebnis }; }
  stand.befehleFehler++;
  const streng = !!k.sicherheitStreng;
  log(`${streng ? 'Befehl abgelehnt' : 'WARNUNG: Befehl'} (${String(n.typ)}${n.aktion ? ' ' + String(n.aktion) : ''}): Signatur ${ergebnis}${streng ? '' : ' — noch ausgeführt (Stufe lernen)'}`);
  return { erlaubt: !streng, ergebnis };
}
