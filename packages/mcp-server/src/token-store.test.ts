import { describe, it, expect, afterEach } from 'vitest';
import { McpTokenStore } from './token-store.js';

describe('McpTokenStore', () => {
  let store: McpTokenStore | null = null;
  afterEach(() => { store?.destroy(); store = null; });

  it('issues unique tokens', () => {
    store = new McpTokenStore();
    const a = store.issue();
    const b = store.issue();
    expect(a).not.toBe(b);
    expect(a.length).toBe(64);
  });

  it('validates issued tokens', () => {
    store = new McpTokenStore();
    const t = store.issue();
    expect(store.validate(t)).toBe(true);
  });

  it('rejects unknown tokens', () => {
    store = new McpTokenStore();
    expect(store.validate('not-a-real-token')).toBe(false);
  });

  it('expires tokens after TTL', () => {
    store = new McpTokenStore(10); // 10ms TTL
    const t = store.issue();
    expect(store.validate(t)).toBe(true);
    // Force expire
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(store!.validate(t)).toBe(false);
      resolve();
    }, 30));
  });

  it('revokes explicitly', () => {
    store = new McpTokenStore();
    const t = store.issue();
    expect(store.revoke(t)).toBe(true);
    expect(store.validate(t)).toBe(false);
    expect(store.revoke(t)).toBe(false);
  });

  it('tracks size', () => {
    store = new McpTokenStore();
    expect(store.size()).toBe(0);
    store.issue();
    store.issue();
    expect(store.size()).toBe(2);
  });
});
