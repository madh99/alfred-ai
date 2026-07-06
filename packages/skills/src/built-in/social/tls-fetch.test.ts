import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { tlsFetch } from './tls-fetch.js';

/**
 * v1025 — Realfall 06.07.: undici v7 brand-checkt den Request-Body und
 * serialisierte die Node-globale FormData als "[object FormData]" (text/plain)
 * statt multipart — fussball.cc Media-Upload HTTP 400, Bild-Publishes standen.
 * Der Test fährt den insecure-Pfad (undici-Dispatcher) gegen einen lokalen
 * Server und prüft, dass ein ECHTER multipart-Body mit Datei ankommt.
 */
describe('tlsFetch (v1022/v1025)', () => {
  function startServer(): Promise<{ port: number; received: { ct?: string; body?: string }; close: () => void }> {
    const received: { ct?: string; body?: string } = {};
    return new Promise(resolve => {
      const srv = http.createServer((req, res) => {
        let raw = Buffer.alloc(0);
        req.on('data', c => { raw = Buffer.concat([raw, c]); });
        req.on('end', () => {
          received.ct = req.headers['content-type'];
          received.body = raw.toString('latin1');
          res.end('{"ok":true}');
        });
      }).listen(0, () => resolve({ port: (srv.address() as { port: number }).port, received, close: () => srv.close() }));
    });
  }

  it('insecure-Pfad: globale FormData kommt als multipart mit Datei-Feld an', async () => {
    const { port, received, close } = await startServer();
    try {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'bild.png');
      form.append('altText', 'Testbild');
      const res = await tlsFetch(`http://127.0.0.1:${port}/upload`, { method: 'POST', body: form }, true);
      expect(res.ok).toBe(true);
      expect(received.ct).toContain('multipart/form-data');
      expect(received.body).toContain('filename="bild.png"');
      expect(received.body).toContain('name="altText"');
      expect(received.body).not.toContain('[object FormData]');
    } finally {
      close();
    }
  });

  it('secure-Pfad (insecure=false) nutzt das globale fetch und bleibt multipart', async () => {
    const { port, received, close } = await startServer();
    try {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'x.png');
      const res = await tlsFetch(`http://127.0.0.1:${port}/upload`, { method: 'POST', body: form }, false);
      expect(res.ok).toBe(true);
      expect(received.ct).toContain('multipart/form-data');
      expect(received.body).toContain('filename="x.png"');
    } finally {
      close();
    }
  });
});
