import { describe, it, expect } from 'vitest';
import { isDegradation } from './health-monitor.js';

describe('isDegradation', () => {
  it('detects ok → warning as degradation', () => {
    expect(isDegradation('ok', 'warning')).toBe(true);
  });
  it('detects ok → error as degradation', () => {
    expect(isDegradation('ok', 'error')).toBe(true);
  });
  it('detects warning → error as degradation', () => {
    expect(isDegradation('warning', 'error')).toBe(true);
  });
  it('does NOT consider warning → ok a degradation', () => {
    expect(isDegradation('warning', 'ok')).toBe(false);
  });
  it('does NOT consider error → warning a degradation (improvement)', () => {
    expect(isDegradation('error', 'warning')).toBe(false);
  });
  it('does NOT consider same status a degradation', () => {
    expect(isDegradation('error', 'error')).toBe(false);
    expect(isDegradation('ok', 'ok')).toBe(false);
  });
  it('unknown → error counts as degradation (new failure)', () => {
    expect(isDegradation('unknown', 'error')).toBe(true);
    expect(isDegradation('unknown', 'warning')).toBe(true);
  });
  it('unknown → ok is not degradation', () => {
    expect(isDegradation('unknown', 'ok')).toBe(false);
  });
  it('treats skipped same as ok (no noise)', () => {
    expect(isDegradation('skipped', 'ok')).toBe(false);
    expect(isDegradation('ok', 'skipped')).toBe(false);
  });
});
