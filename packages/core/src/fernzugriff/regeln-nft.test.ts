import { describe, expect, it } from 'vitest';
import { befehlsklasse } from './regeln.js';

describe('v1714 — nft nur lesend auf der Leseliste', () => {
  it('list ist lesen', () => {
    for (const b of ['nft list ruleset', 'nft -a list ruleset', 'nft list tables', 'nft list table inet pg_restore_guard', 'nft list chain inet pg_restore_guard input'])
      expect(befehlsklasse(b), b).toBe('lesen');
  });
  it('alles Verändernde braucht Bestätigung', () => {
    for (const b of ['nft flush ruleset', 'nft add rule inet f input accept', 'nft delete table inet pg_restore_guard', 'nft -f /tmp/x', 'nft list ruleset; nft flush ruleset'])
      expect(befehlsklasse(b), b).not.toBe('lesen');
  });
});
