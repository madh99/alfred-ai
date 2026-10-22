import { describe, it, expect } from 'vitest';
import { webMasterAus } from './web-master.js';

const users: Record<string, { id: string; masterUserId?: string }> = {
  'telegram:5060785419': { id: 'f165', masterUserId: 'f165' },
  'matrix:@madh': { id: '12d8', masterUserId: 'f165' },
  'api:5060785419': { id: '6814', masterUserId: 'f165' },
  'matrix:@alex': { id: 'e9af' },
};
const finde = async (p: string, id: string) => users[`${p}:${id}`];

describe('webMasterAus', () => {
  it('Realfall 22.10.: admin mit allen Verknüpfungen → Owner-Master', async () => {
    expect(await webMasterAus([
      { platform: 'telegram', platformUserId: '5060785419' }, { platform: 'api', platformUserId: '5060785419' },
      { platform: 'matrix', platformUserId: '@madh' }, { platform: 'discord', platformUserId: '5060785419' },
      { platform: 'api', platformUserId: 'web-pending-1775081926164' },
    ], finde)).toBe('f165');
  });
  it('Eintrag ohne master_user_id ist selbst der Master', async () => {
    expect(await webMasterAus([{ platform: 'matrix', platformUserId: '@alex' }], finde)).toBe('e9af');
  });
  it('mehrdeutig oder ohne Verknüpfung → keiner', async () => {
    expect(await webMasterAus([{ platform: 'telegram', platformUserId: '5060785419' }, { platform: 'matrix', platformUserId: '@alex' }], finde)).toBeUndefined();
    expect(await webMasterAus([{ platform: 'api', platformUserId: 'web-pending-1' }], finde)).toBeUndefined();
    expect(await webMasterAus([], finde)).toBeUndefined();
  });
  it('Fehler beim Nachschlagen zählt nicht', async () => {
    expect(await webMasterAus([{ platform: 'telegram', platformUserId: '5060785419' }, { platform: 'x', platformUserId: 'y' }],
      async (p, id) => { if (p === 'x') throw new Error('db'); return finde(p, id); })).toBe('f165');
  });
});
