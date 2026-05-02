import { describe, it, expect } from 'vitest';

/**
 * Mirrors the title-normalization logic in reasoning-context-collector.ts (Patch C).
 * Strips numbers/percentages so that "X RAM usage 95.1%" and "X RAM usage 95.2%"
 * collapse into the same recurrence group.
 */
function normalizeTitle(title: string): string {
  return title
    .replace(/\d+(?:[.,]\d+)?%/g, '')
    .replace(/\b\d+\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

describe('Recurrence grouping (Patch C)', () => {
  it('collapses RAM-usage variations into one group', () => {
    const titles = [
      'proxmox: git-server RAM usage 95.1%',
      'proxmox: git-server RAM usage 95.2%',
      'proxmox: git-server RAM usage 95.0%',
      'proxmox: git-server RAM usage 95.6%',
    ];
    const groups = new Map<string, number>();
    for (const t of titles) {
      const k = normalizeTitle(t);
      groups.set(k, (groups.get(k) ?? 0) + 1);
    }
    expect(groups.size).toBe(1);
    expect([...groups.values()][0]).toBe(4);
  });

  it('keeps different assets in separate groups', () => {
    const titles = [
      'proxmox: git-server RAM usage 95.1%',
      'proxmox: PGSql-P01 RAM usage 95.0%',
    ];
    const groups = new Map<string, number>();
    for (const t of titles) {
      const k = normalizeTitle(t);
      groups.set(k, (groups.get(k) ?? 0) + 1);
    }
    expect(groups.size).toBe(2);
  });

  it('treats integer counts and percentages as same group', () => {
    expect(normalizeTitle('500 alerts')).toBe(normalizeTitle('3000 alerts'));
    expect(normalizeTitle('Disk 80% full')).toBe(normalizeTitle('Disk 95% full'));
  });
});

/**
 * Mirrors the auto-change-suggestion gate in alfred.ts (Patch D).
 * Heuristic: don't suggest a change-request if the resolution describes a manual
 * workaround/restart — those are temporary fixes, not candidates for permanent change.
 */
function shouldSuggestChange(input: {
  action: string;
  status?: string;
  rootCause?: string;
  resolution?: string;
}): boolean {
  const isResolveAction = input.action === 'update_incident' || input.action === 'close_incident';
  const newStatus = input.status ?? '';
  const becomesResolved = isResolveAction && (newStatus === 'resolved' || newStatus === 'closed');
  const rootCause = input.rootCause ?? '';
  const resolution = input.resolution ?? '';
  const isManualWorkaround = /workaround|temporary|tempor[äa]r|kurzfristig|notfall|manuell.*neustart/i.test(resolution);
  return becomesResolved && rootCause.length >= 20 && resolution.length >= 20 && !isManualWorkaround;
}

describe('Auto-Change-Suggestion gate (Patch D)', () => {
  it('suggests change for permanent fix', () => {
    expect(shouldSuggestChange({
      action: 'update_incident',
      status: 'resolved',
      rootCause: 'RAM-Leak in git-server hooks-script wegen unbegrenzten Cache',
      resolution: 'Cache-Limit auf 2GB gesetzt, Service neu gestartet, Memory-Profile-Test bestanden',
    })).toBe(true);
  });

  it('skips for manual workaround', () => {
    expect(shouldSuggestChange({
      action: 'update_incident',
      status: 'resolved',
      rootCause: 'RAM voll, Service hängt',
      resolution: 'Workaround: Service manuell neustart durchgeführt, Problem temporär behoben',
    })).toBe(false);
  });

  it('skips when rootCause too short', () => {
    expect(shouldSuggestChange({
      action: 'update_incident',
      status: 'resolved',
      rootCause: 'Unbekannt',
      resolution: 'Problem ist verschwunden nach einem Tag, keine weitere Untersuchung erforderlich',
    })).toBe(false);
  });

  it('skips when not a resolve action', () => {
    expect(shouldSuggestChange({
      action: 'update_incident',
      status: 'investigating',
      rootCause: 'RAM-Leak in git-server hooks-script wegen unbegrenzten Cache',
      resolution: 'Cache-Limit auf 2GB gesetzt, Service neu gestartet',
    })).toBe(false);
  });

  it('detects various workaround terms', () => {
    const tempResolutions = [
      'temporärer Fix bis nächste Woche',
      'Notfall-Restart durchgeführt',
      'Kurzfristige Lösung — muss nochmal angeschaut werden',
      'Workaround eingerichtet — permanenter Fix folgt',
    ];
    for (const res of tempResolutions) {
      expect(shouldSuggestChange({
        action: 'update_incident', status: 'resolved',
        rootCause: 'Some root cause that is long enough to pass the gate',
        resolution: res + ' — alle Details hier ausreichend lang fuer die Pruefung',
      })).toBe(false);
    }
  });
});
