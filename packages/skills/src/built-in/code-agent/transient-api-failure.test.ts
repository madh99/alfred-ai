import { describe, it, expect } from 'vitest';
import { isTransientApiFailure } from './agent-executor.js';

/**
 * v864 — Klassifikation transienter LLM-API-Fehler.
 * Vorfall 494ae636 (11.06.): claude CLI bekam Anthropic 529 Overloaded,
 * exitete 1 — der Runner brach die ganze Session ab statt zu retryen.
 */
describe('isTransientApiFailure', () => {
  it('erkennt den echten 529-Fall aus Vorfall 494ae636', () => {
    expect(isTransientApiFailure({
      exitCode: 1,
      stdout: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CbvXEAeEMRU8PYWsuiVKJ"}',
      stderr: '',
    })).toBe(true);
  });

  it('erkennt Rate-Limit und 429', () => {
    expect(isTransientApiFailure({ exitCode: 1, stdout: 'API Error: 429 rate_limit_error', stderr: '' })).toBe(true);
    expect(isTransientApiFailure({ exitCode: 1, stdout: '', stderr: 'Too Many Requests' })).toBe(true);
  });

  it('erkennt Netzwerkfehler in stderr', () => {
    expect(isTransientApiFailure({ exitCode: 1, stdout: '', stderr: 'Error: fetch failed\n  cause: ECONNRESET' })).toBe(true);
    expect(isTransientApiFailure({ exitCode: 1, stdout: '', stderr: 'connect ETIMEDOUT 160.79.104.10:443' })).toBe(true);
  });

  it('exitCode 0 ist NIE transient-failure (auch mit Fehlertext im Output)', () => {
    expect(isTransientApiFailure({
      exitCode: 0,
      stdout: 'Der Server gab zwischendurch Overloaded zurück, Retry war erfolgreich.',
      stderr: '',
    })).toBe(false);
  });

  it('Auth-Fehler (401) ist permanent — kein Retry', () => {
    expect(isTransientApiFailure({ exitCode: 1, stdout: 'API Error: 401 {"type":"authentication_error"}', stderr: '' })).toBe(false);
    expect(isTransientApiFailure({ exitCode: 1, stdout: '', stderr: 'Unauthorized: Missing bearer token' })).toBe(false);
  });

  it('Binary fehlt ist permanent — kein Retry', () => {
    expect(isTransientApiFailure({ exitCode: 127, stdout: '', stderr: 'sudo: claude: command not found' })).toBe(false);
  });

  it('normaler Phase-Output ohne Fehler matched nicht', () => {
    expect(isTransientApiFailure({
      exitCode: 1,
      stdout: 'Phase abgeschlossen: Hovercard-Komponente erstellt, 12 Dateien geändert, Tests grün.',
      stderr: 'npm warn deprecated something',
    })).toBe(false);
  });

  it('prüft nur das Ende des Outputs (alter Fehlertext weit vorne zählt nicht)', () => {
    const longTail = 'x'.repeat(3000);
    expect(isTransientApiFailure({
      exitCode: 1,
      stdout: `API Error: 529 Overloaded\n${longTail}`,
      stderr: '',
    })).toBe(false);
  });
});
