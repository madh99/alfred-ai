import http from 'node:http';
import https from 'node:https';
import type { GeraetKonfig } from './pair.js';

/**
 * v1249 — HTTP mit Gerätetoken (Satellit und Sitzung): JSON oder Rohdaten senden, Rohdaten empfangen.
 * Selbstsignierte Server nur mit `insecure` in ~/.alfred/geraet.json.
 */
export interface GeraetAntwort { status: number; data: Buffer; headers: http.IncomingHttpHeaders }

export function geraetAnfrage(
  k: GeraetKonfig,
  methode: 'GET' | 'POST' | 'PUT' | 'DELETE',
  pfad: string,
  body?: Buffer | string | Record<string, unknown>,
  opts: { contentType?: string; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<GeraetAntwort> {
  return new Promise((resolve, reject) => {
    const u = new URL(pfad, k.server);
    const mod = u.protocol === 'https:' ? https : http;
    const daten = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const contentType = opts.contentType ?? (Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json');
    const req = mod.request(u, {
      method: methode,
      headers: { Authorization: `Bearer ${k.token}`, ...(daten ? { 'Content-Type': contentType, 'Content-Length': daten.length } : {}), ...(opts.headers ?? {}) },
      rejectUnauthorized: !k.insecure,
      timeout: opts.timeoutMs ?? 120_000,
    }, (res) => {
      res.setTimeout(opts.timeoutMs ?? 120_000, () => { try { res.destroy(new Error('Antwort-Zeitüberschreitung')); } catch { /* */ } }); // v1264
      const teile: Buffer[] = [];
      res.on('data', (c: Buffer) => teile.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, data: Buffer.concat(teile), headers: res.headers }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Zeitüberschreitung')); });
    // v1264 — Gesamtfrist unabhängig von Socket-Aktivität (hängende Anfrage im Dienstmodus beobachtet)
    const frist = setTimeout(() => { try { req.destroy(new Error('Gesamt-Zeitüberschreitung')); } catch { /* */ } }, (opts.timeoutMs ?? 120_000) + 5_000);
    req.on('close', () => clearTimeout(frist));
    if (daten) req.write(daten);
    req.end();
  });
}

export async function geraetJson<T = Record<string, unknown>>(k: GeraetKonfig, methode: 'GET' | 'POST' | 'PUT' | 'DELETE', pfad: string, body?: Record<string, unknown>): Promise<T> {
  const r = await geraetAnfrage(k, methode, pfad, body);
  let j: unknown;
  try { j = JSON.parse(r.data.toString('utf8')); } catch { j = undefined; }
  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}${j && typeof j === 'object' && 'error' in j ? ': ' + String((j as { error: unknown }).error) : ''}`);
  return j as T;
}
