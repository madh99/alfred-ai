import { describe, it, expect } from 'vitest';
import { shouldBlockMainlinePush } from './project-agent-runner.js';

/**
 * v867 — Push-Guard gegen Hauptbranch-Verwechslung.
 * Vorfall alpbyte 11.06.: Workspace stand auf `main`, Projekt deployed von
 * `master` — alle Runner-Pushes des Tages gingen still auf main.
 */
describe('shouldBlockMainlinePush', () => {
  it('blockiert den alpbyte-Vorfall: main gepusht, Projekt deployed von master', () => {
    const v = shouldBlockMainlinePush({ currentBranch: 'main', deployBranch: 'master' });
    expect(v.block).toBe(true);
    expect(v.reason).toContain('"main"');
    expect(v.reason).toContain('"master"');
  });

  it('blockiert auch die umgekehrte Richtung (master → Projekt deployed von main)', () => {
    expect(shouldBlockMainlinePush({ currentBranch: 'master', deployBranch: 'main' }).block).toBe(true);
  });

  it('erlaubt Push wenn Branch == Deploy-Branch', () => {
    expect(shouldBlockMainlinePush({ currentBranch: 'master', deployBranch: 'master' }).block).toBe(false);
    expect(shouldBlockMainlinePush({ currentBranch: 'main', deployBranch: 'main' }).block).toBe(false);
  });

  it('erlaubt Feature-Branches (kein Mainline-Name) immer', () => {
    expect(shouldBlockMainlinePush({ currentBranch: 'feature/agent-abc123', deployBranch: 'master' }).block).toBe(false);
    expect(shouldBlockMainlinePush({ currentBranch: 'hotfix/ugc-500', deployBranch: 'main' }).block).toBe(false);
  });

  it('erlaubt branchPerSession-Runs (Feature-Branch ist gewollt)', () => {
    expect(shouldBlockMainlinePush({ currentBranch: 'main', deployBranch: 'master', branchPerSession: true }).block).toBe(false);
  });

  it('erlaubt selfHeal-Runs (Hotfix-Branch + MR-Flow)', () => {
    expect(shouldBlockMainlinePush({ currentBranch: 'main', deployBranch: 'master', selfHeal: true }).block).toBe(false);
  });

  it('ohne bekannten Deploy-Branch: keine Blockade (kein Raten)', () => {
    expect(shouldBlockMainlinePush({ currentBranch: 'main', deployBranch: undefined }).block).toBe(false);
    expect(shouldBlockMainlinePush({ currentBranch: 'main', deployBranch: '' }).block).toBe(false);
  });

  it('trunk zählt als Mainline', () => {
    expect(shouldBlockMainlinePush({ currentBranch: 'trunk', deployBranch: 'master' }).block).toBe(true);
  });
});
