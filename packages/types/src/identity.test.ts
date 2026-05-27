import { describe, it, expect } from 'vitest';
import {
  isUserUUID,
  asUserUUID,
  tryUserUUID,
  asMasterUserId,
  asPlatformUserId,
  classifyUserIdFormat,
} from './identity.js';

/**
 * v807 — Tests für Branded-Type-Helpers.
 *
 * Komplementiert die IdentityResolver-Tests in @alfred/core. Hier nur die
 * pure-function-Validierungen (kein DB-State).
 */

const VALID_UUID = 'f165df7a-8689-49b6-9318-41839913846f';
const UPPER_UUID = 'F165DF7A-8689-49B6-9318-41839913846F';
const TELEGRAM_ID = '5060785419';
const MATRIX_ID = '@madh:chat.3033.at';

describe('isUserUUID', () => {
  it('akzeptiert valide UUID', () => {
    expect(isUserUUID(VALID_UUID)).toBe(true);
  });

  it('akzeptiert Uppercase-UUID (case-insensitive)', () => {
    expect(isUserUUID(UPPER_UUID)).toBe(true);
  });

  it('rejected Telegram-ID', () => {
    expect(isUserUUID(TELEGRAM_ID)).toBe(false);
  });

  it('rejected Matrix-ID', () => {
    expect(isUserUUID(MATRIX_ID)).toBe(false);
  });

  it('rejected leeren String', () => {
    expect(isUserUUID('')).toBe(false);
  });

  it('rejected UUID ohne Bindestriche', () => {
    expect(isUserUUID('f165df7a868949b6931841839913846f')).toBe(false);
  });

  it('rejected zu kurze Strings', () => {
    expect(isUserUUID('f165df7a')).toBe(false);
  });

  it('rejected Strings mit invaliden Zeichen', () => {
    expect(isUserUUID('z165df7a-8689-49b6-9318-41839913846f')).toBe(false);
  });
});

describe('asUserUUID', () => {
  it('cast UUID erfolgreich', () => {
    const r = asUserUUID(VALID_UUID);
    expect(r).toBe(VALID_UUID);
  });

  it('wirft bei non-UUID Format', () => {
    expect(() => asUserUUID(TELEGRAM_ID)).toThrow(/not a valid UUID/);
  });

  it('wirft mit truncated input in Fehlermeldung (kein Daten-Leak)', () => {
    const longBadInput = 'x'.repeat(500);
    try {
      asUserUUID(longBadInput);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message.length).toBeLessThan(120);
    }
  });
});

describe('tryUserUUID', () => {
  it('returns UUID bei valid input', () => {
    expect(tryUserUUID(VALID_UUID)).toBe(VALID_UUID);
  });

  it('returns undefined bei non-UUID', () => {
    expect(tryUserUUID(TELEGRAM_ID)).toBe(undefined);
  });

  it('returns undefined bei null', () => {
    expect(tryUserUUID(null)).toBe(undefined);
  });

  it('returns undefined bei undefined', () => {
    expect(tryUserUUID(undefined)).toBe(undefined);
  });

  it('returns undefined bei non-string', () => {
    expect(tryUserUUID(123 as any)).toBe(undefined);
  });
});

describe('asMasterUserId', () => {
  it('cast UserUUID → MasterUserId (semantic-only)', () => {
    const uuid = asUserUUID(VALID_UUID);
    const master = asMasterUserId(uuid);
    expect(master).toBe(uuid);
    // Strukturell identisch — der Cast ist nur ein Marker für linked-account-Aware-Code
  });
});

describe('asPlatformUserId', () => {
  it('akzeptiert Telegram-ID', () => {
    const r = asPlatformUserId(TELEGRAM_ID);
    expect(r).toBe(TELEGRAM_ID);
  });

  it('akzeptiert Matrix-ID', () => {
    const r = asPlatformUserId(MATRIX_ID);
    expect(r).toBe(MATRIX_ID);
  });

  it('wirft bei leerem String', () => {
    expect(() => asPlatformUserId('')).toThrow(/invalid/);
  });

  it('wirft bei zu langem Input (> 200 chars)', () => {
    const tooLong = 'x'.repeat(201);
    expect(() => asPlatformUserId(tooLong)).toThrow(/invalid/);
  });
});

describe('classifyUserIdFormat', () => {
  it('uuid für UUID-Format', () => {
    expect(classifyUserIdFormat(VALID_UUID)).toBe('uuid');
  });

  it('platform für Telegram-ID', () => {
    expect(classifyUserIdFormat(TELEGRAM_ID)).toBe('platform');
  });

  it('platform für Matrix-ID', () => {
    expect(classifyUserIdFormat(MATRIX_ID)).toBe('platform');
  });

  it('platform für ungültigen String (default-bucket)', () => {
    expect(classifyUserIdFormat('weird_value')).toBe('platform');
  });
});

describe('Regression-Tests für v798/v800/v803-Bug-Quellen', () => {
  it('Compiler-Check: asUserUUID(TelegramID) wirft → fängt Bug-Quelle zur Laufzeit ab', () => {
    // Diesen Aufruf hätten v798-v803 silent-fail-Pfade ausgeführt mit Telegram-ID
    // Jetzt wirft asUserUUID explizit → Fehler sichtbar statt silent null-rückgabe
    expect(() => asUserUUID(TELEGRAM_ID)).toThrow();
  });

  it('tryUserUUID returns undefined bei Telegram-ID — sichere Defensive', () => {
    // Statt silent-fallback-zu-raw-string: explicit undefined
    expect(tryUserUUID(TELEGRAM_ID)).toBeUndefined();
  });

  it('classifyUserIdFormat ermöglicht Pre-Resolve-Routing', () => {
    // Bei env-var-Loading: erkennen ob direkt-cast oder UserRepository-Lookup
    expect(classifyUserIdFormat(VALID_UUID)).toBe('uuid'); // → direct cast
    expect(classifyUserIdFormat(TELEGRAM_ID)).toBe('platform'); // → UserRepository.findOrCreate
  });
});
