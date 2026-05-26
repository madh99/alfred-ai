import { describe, it, expect, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import { IdentityResolver } from './resolver.js';
import { isUserUUID, asUserUUID } from '@alfred/types';

/**
 * v804 — IdentityResolver Unit Tests.
 *
 * Verifiziert die zentrale User-ID-Resolution die in v798/v800/v803 mehrfach
 * fehlerhaft war. Diese Tests sind die erste Multi-User-Test-Suite im
 * codebase und sollen Regression verhindern.
 */

const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {},
  child: () => noopLogger, level: 'info',
} as any;

// Stubs für UserRepository + ProjectRepository
function makeUsersStub(opts: {
  findByIdReturns?: { id: string; masterUserId?: string } | null;
  findOrCreateReturns?: { id: string; masterUserId?: string };
  masterUserIdReturns?: string;
} = {}) {
  return {
    findById: async (_id: string) => opts.findByIdReturns ?? null,
    findOrCreate: async (_platform: string, _platformUserId: string) =>
      opts.findOrCreateReturns ?? { id: '00000000-0000-0000-0000-000000000000' },
    getMasterUserId: async (userId: string) => opts.masterUserIdReturns ?? userId,
  } as any;
}

function makeProjectsStub(opts: { getByIdAnyOwnerReturns?: { id: string; userId: string } | null } = {}) {
  return {
    getByIdAnyOwner: async (_id: string) => opts.getByIdAnyOwnerReturns ?? null,
  } as any;
}

const VALID_UUID = 'f165df7a-8689-49b6-9318-41839913846f';
const ANOTHER_UUID = 'a1b2c3d4-e5f6-1234-5678-9abcdef01234';
const TELEGRAM_ID = '5060785419';
const MATRIX_ID = '@madh:chat.3033.at';

describe('IdentityResolver.resolveOwnerFromConfig', () => {
  let resolver: IdentityResolver;

  describe('input ist bereits UUID', () => {
    beforeEach(() => {
      resolver = new IdentityResolver(
        makeUsersStub({ findByIdReturns: { id: VALID_UUID } }),
        makeProjectsStub(),
        noopLogger,
      );
    });

    it('akzeptiert valide UUID direkt', async () => {
      const r = await resolver.resolveOwnerFromConfig(VALID_UUID);
      expect(r).toBe(VALID_UUID);
      expect(isUserUUID(r)).toBe(true);
    });

    it('case-insensitive UUID akzeptiert', async () => {
      const upper = VALID_UUID.toUpperCase();
      const r = await resolver.resolveOwnerFromConfig(upper);
      expect(r.toLowerCase()).toBe(VALID_UUID);
    });

    it('akzeptiert UUID auch wenn keine users-Row existiert (nur Warning)', async () => {
      resolver = new IdentityResolver(
        makeUsersStub({ findByIdReturns: null }),
        makeProjectsStub(),
        noopLogger,
      );
      const r = await resolver.resolveOwnerFromConfig(VALID_UUID);
      expect(r).toBe(VALID_UUID);
    });
  });

  describe('input ist Platform-ID (Telegram numerisch)', () => {
    it('resolved zu UUID via findOrCreate', async () => {
      const resolver = new IdentityResolver(
        makeUsersStub({ findOrCreateReturns: { id: VALID_UUID } }),
        makeProjectsStub(),
        noopLogger,
      );
      const r = await resolver.resolveOwnerFromConfig(TELEGRAM_ID, 'telegram');
      expect(r).toBe(VALID_UUID);
    });

    it('auto-detect platform=telegram bei rein numerischen IDs', async () => {
      const resolver = new IdentityResolver(
        makeUsersStub({ findOrCreateReturns: { id: VALID_UUID } }),
        makeProjectsStub(),
        noopLogger,
      );
      // KEIN platform-hint → Resolver erkennt aus Format
      const r = await resolver.resolveOwnerFromConfig(TELEGRAM_ID);
      expect(r).toBe(VALID_UUID);
    });

    it('auto-detect platform=matrix bei @user:server-Format', async () => {
      const resolver = new IdentityResolver(
        makeUsersStub({ findOrCreateReturns: { id: VALID_UUID } }),
        makeProjectsStub(),
        noopLogger,
      );
      const r = await resolver.resolveOwnerFromConfig(MATRIX_ID);
      expect(r).toBe(VALID_UUID);
    });

    it('wirft wenn Platform nicht erkennbar UND kein hint', async () => {
      const resolver = new IdentityResolver(makeUsersStub(), makeProjectsStub(), noopLogger);
      await expect(resolver.resolveOwnerFromConfig('weird_input_no_format')).rejects.toThrow(/keine platform-hint/);
    });
  });

  describe('error cases', () => {
    it('wirft bei leerem envValue', async () => {
      const resolver = new IdentityResolver(makeUsersStub(), makeProjectsStub(), noopLogger);
      await expect(resolver.resolveOwnerFromConfig('')).rejects.toThrow(/empty/);
    });

    it('wirft wenn findOrCreate non-UUID id zurückgibt (defekter UserRepository)', async () => {
      const resolver = new IdentityResolver(
        makeUsersStub({ findOrCreateReturns: { id: 'not-a-uuid' } }),
        makeProjectsStub(),
        noopLogger,
      );
      await expect(resolver.resolveOwnerFromConfig(TELEGRAM_ID, 'telegram')).rejects.toThrow(/non-UUID/);
    });
  });
});

describe('IdentityResolver.resolveMasterId', () => {
  it('returns same UUID wenn keine linked accounts', async () => {
    const resolver = new IdentityResolver(
      makeUsersStub({ masterUserIdReturns: VALID_UUID }),
      makeProjectsStub(),
      noopLogger,
    );
    const r = await resolver.resolveMasterId(asUserUUID(VALID_UUID));
    expect(r).toBe(VALID_UUID);
  });

  it('returns linked master-UUID wenn vorhanden', async () => {
    const resolver = new IdentityResolver(
      makeUsersStub({ masterUserIdReturns: ANOTHER_UUID }),
      makeProjectsStub(),
      noopLogger,
    );
    const r = await resolver.resolveMasterId(asUserUUID(VALID_UUID));
    expect(r).toBe(ANOTHER_UUID);
  });

  it('returns original userId bei DB-Fehler', async () => {
    const stub = makeUsersStub();
    stub.getMasterUserId = async () => { throw new Error('db down'); };
    const resolver = new IdentityResolver(stub, makeProjectsStub(), noopLogger);
    const r = await resolver.resolveMasterId(asUserUUID(VALID_UUID));
    expect(r).toBe(VALID_UUID);
  });
});

describe('IdentityResolver.findProjectOwner', () => {
  it('returns owner-UUID via getByIdAnyOwner (User-Filter ignoriert)', async () => {
    const resolver = new IdentityResolver(
      makeUsersStub(),
      makeProjectsStub({ getByIdAnyOwnerReturns: { id: 'p1', userId: VALID_UUID } }),
      noopLogger,
    );
    const r = await resolver.findProjectOwner('p1');
    expect(r).toBe(VALID_UUID);
  });

  it('returns null wenn project nicht existiert', async () => {
    const resolver = new IdentityResolver(
      makeUsersStub(),
      makeProjectsStub({ getByIdAnyOwnerReturns: null }),
      noopLogger,
    );
    const r = await resolver.findProjectOwner('p-missing');
    expect(r).toBe(null);
  });

  it('returns null wenn ProjectRepository nicht initialisiert', async () => {
    const resolver = new IdentityResolver(makeUsersStub(), undefined, noopLogger);
    const r = await resolver.findProjectOwner('p1');
    expect(r).toBe(null);
  });

  it('returns null wenn project.userId non-UUID-Format (defekter DB-Eintrag)', async () => {
    const resolver = new IdentityResolver(
      makeUsersStub(),
      makeProjectsStub({ getByIdAnyOwnerReturns: { id: 'p1', userId: 'corrupt-id' } }),
      noopLogger,
    );
    const r = await resolver.findProjectOwner('p1');
    expect(r).toBe(null);
  });
});

describe('Regression-Tests für v798/v800/v803-Szenarien', () => {
  it('v798/v800-Szenario: env-var=Telegram-ID, project.user_id=UUID → resolved zu UUID', async () => {
    // Vor v804: getById(telegramId, projectId) → null → orphan-create.
    // Nach v804: resolveOwnerFromConfig macht findOrCreate → returns UUID.
    const resolver = new IdentityResolver(
      makeUsersStub({ findOrCreateReturns: { id: VALID_UUID } }),
      makeProjectsStub(),
      noopLogger,
    );
    const r = await resolver.resolveOwnerFromConfig(TELEGRAM_ID, 'telegram');
    expect(r).toBe(VALID_UUID);
    expect(isUserUUID(r)).toBe(true);
  });

  it('v803-Szenario: sandbox owned by admin, project owned by madh → findProjectOwner returns madh', async () => {
    // sandbox.userId = admin-UUID, sandbox.project_id = AlpbyteId
    // findProjectOwner(AlpbyteId) → soll Alpbyte.user_id (madh) zurückgeben
    const madhUUID = 'f165df7a-8689-49b6-9318-41839913846f';
    const resolver = new IdentityResolver(
      makeUsersStub(),
      makeProjectsStub({ getByIdAnyOwnerReturns: { id: 'alpbyte', userId: madhUUID } }),
      noopLogger,
    );
    const r = await resolver.findProjectOwner('alpbyte');
    expect(r).toBe(madhUUID);
  });
});
