/**
 * I4 — Netz-Prüfungen des Change-Motors vom Server aus: HTTP(S) (selbstsignierte Zertifikate erlaubt — es geht um Erreichbarkeit,
 * nicht um Vertrauen; je Anfrage, nie prozessweit), TCP-Port, DNS-Auflösung, Ping.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import { promises as dns } from 'node:dns';
import { execFile } from 'node:child_process';

const MAX_TEXT = 200_000;

export function http(url: string, timeoutMs: number): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, { method: 'GET', timeout: timeoutMs, ...(u.protocol === 'https:' ? { rejectUnauthorized: false } : {}) }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => { if (text.length < MAX_TEXT) text += d; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`Zeitüberschreitung nach ${Math.round(timeoutMs / 1000)} s`)));
    req.on('error', reject);
    req.end();
  });
}

export function port(host: string, p: number, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = connect({ host, port: p });
    const ende = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => ende(false));
    s.once('connect', () => ende(true));
    s.once('error', () => ende(false));
  });
}

export async function aufloesen(name: string): Promise<string[]> {
  try { return (await dns.lookup(name, { all: true })).map(a => a.address); } catch { return []; }
}

export function ping(host: string): Promise<boolean> {
  if (!/^[\w.:-]+$/.test(host)) return Promise.resolve(false);
  return new Promise(resolve => execFile('ping', ['-c', '1', '-W', '2', host], { timeout: 5_000 }, err => resolve(!err)));
}
