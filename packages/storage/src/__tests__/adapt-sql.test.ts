import { describe, it, expect } from 'vitest';
import { adaptSqliteToPostgres } from '../db-adapter.js';

describe('adaptSqliteToPostgres (v947)', () => {
  it('konvertiert ? zu $n in Reihenfolge', () => {
    expect(adaptSqliteToPostgres('SELECT * FROM t WHERE a = ? AND b = ?'))
      .toBe('SELECT * FROM t WHERE a = $1 AND b = $2');
  });

  it('Realfall: leeres Literal \'\' kippt den Scanner NICHT mehr (COALESCE-Budget-Query)', () => {
    expect(adaptSqliteToPostgres(
      `SELECT id FROM channel_metrics WHERE channel_id = ? AND COALESCE(item_id, '') = ? AND date = ? AND kind = ?`,
    )).toBe(
      `SELECT id FROM channel_metrics WHERE channel_id = $1 AND COALESCE(item_id, '') = $2 AND date = $3 AND kind = $4`,
    );
  });

  it('? innerhalb von String-Literalen bleibt unangetastet', () => {
    expect(adaptSqliteToPostgres(`SELECT * FROM t WHERE a = 'was?' AND b = ?`))
      .toBe(`SELECT * FROM t WHERE a = 'was?' AND b = $1`);
  });

  it('escaptes Quote \'\' INNERHALB eines Strings hält den String offen', () => {
    expect(adaptSqliteToPostgres(`SELECT * FROM t WHERE a = 'it''s ok?' AND b = ?`))
      .toBe(`SELECT * FROM t WHERE a = 'it''s ok?' AND b = $1`);
  });

  it('mehrere leere Literale + Platzhalter gemischt', () => {
    expect(adaptSqliteToPostgres(`UPDATE t SET a = '', b = ?, c = '' WHERE d = ?`))
      .toBe(`UPDATE t SET a = '', b = $1, c = '' WHERE d = $2`);
  });

  it('SQLite-Funktionen werden weiterhin übersetzt', () => {
    expect(adaptSqliteToPostgres(`SELECT datetime('now'), date('now') WHERE x LIKE ?`))
      .toBe(`SELECT NOW(), CURRENT_DATE WHERE x ILIKE $1`);
  });
});
