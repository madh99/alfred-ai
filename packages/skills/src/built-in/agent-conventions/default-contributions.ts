/**
 * v831 Phase 3.6 — Default-Skill-Contributions.
 *
 * Anstatt jeden Alfred-Skill zu zwingen eine conventionsContribution()-Methode
 * zu implementieren (intrusiv, hard to maintain), zentralisieren wir die
 * bekannten Alfred-spezifischen Konventionen hier. Werden beim Skill-Setup in
 * alfred.ts via `agentConventionsSkill.addSkillContribution()` registriert.
 *
 * Jede Contribution hat:
 * - `skillName` für Tracking + allowedSkillContributions-Filter
 * - `detectIfUsed(scan)` — eigener Check ob die Konvention relevant ist
 * - `contribution` — Section + Markdown der in CLAUDE.md gemerged wird
 *
 * Erweiterbar: weitere bekannte Patterns (z.B. fastify-Server, Prisma-Migration,
 * better-sqlite3 Native-Module, etc.) können einfach hier hinzugefügt werden.
 */

import type { SkillConventionsContribution } from './agent-conventions-skill.js';
import type { ConventionsScanSnapshot } from '@alfred/types';

function hasDep(scan: ConventionsScanSnapshot, depNamePart: string): boolean {
  // Wir haben deps nicht direkt im snapshot — Heuristik via packageManager + scripts
  const scripts = scan.packageJsonScripts ?? {};
  for (const cmd of Object.values(scripts)) {
    if (cmd.includes(depNamePart)) return true;
  }
  return false;
}

function hasFile(scan: ConventionsScanSnapshot, relPath: string): boolean {
  return (scan.testSetupFiles ?? []).some(f => f.includes(relPath))
    || (scan.migrationDirs ?? []).some(d => relPath.startsWith(d));
}

export const DEFAULT_CONTRIBUTIONS: SkillConventionsContribution[] = [
  {
    skillName: 'next-js-dev-server',
    detectIfUsed: (scan) => scan.framework === 'nextjs',
    contribution: {
      section: 'gotchas',
      markdown: `- **Next.js Dev-Server in Sandbox:** Bei laufender Sandbox NIE \`npm run build\` ausführen. Das überschreibt \`.next/build-manifest.json\` und der dev-server crasht mit ENOENT. Stattdessen \`npm run typecheck\` für Validierung.
- **HMR + node_modules-Mount:** Native Modules (better-sqlite3, sharp) müssen für die Container-glibc/musl rebuilt sein. Beim ersten Container-Start läuft \`pnpm rebuild\` automatisch.`,
    },
  },
  {
    skillName: 'vitest-test-db-setup',
    detectIfUsed: (scan) => scan.testRunner === 'vitest' && (scan.testSetupFiles?.length ?? 0) > 0,
    contribution: {
      section: 'testSetup',
      markdown: `- **In-Memory-Test-DB:** \`src/__tests__/setup.ts\` (oder analog) initialisiert die Test-DB. Wenn du Migrations in \`migrations/*.sql\` hinzufügst MUSST du die neuen Tabellen-Definitionen + Cleanup-Statements dort mit-pflegen — sonst failen alle Tests die diese Tabellen anfragen mit "no such table".
- **Test-Isolation:** Test-Setup wird vor jedem Test-File neu hochgezogen. Globale State (Singletons, Process-ENV) gehört in \`afterEach\`-Cleanup.`,
    },
  },
  {
    skillName: 'better-sqlite3-native',
    detectIfUsed: (scan) => hasDep(scan, 'better-sqlite3'),
    contribution: {
      section: 'gotchas',
      markdown: `- **better-sqlite3 ABI:** Native-Module wird beim Host/Container-Mismatch crashen. \`pnpm rebuild better-sqlite3\` löst das (passiert automatisch beim Container-Start, aber NICHT bei host-validation).`,
    },
  },
  {
    skillName: 'merge-gate-host-tests',
    detectIfUsed: (scan) => scan.hasTests === true,
    contribution: {
      section: 'gotchas',
      markdown: `- **Merge-Gate läuft \`npm test\` auf dem HOST:** Pre-merge wird \`npm rebuild + npm test\` als worktree-owner auf dem Host ausgeführt (Container ist gestoppt). Tests müssen Host-tauglich sein — wenn sie eine echte DB brauchen die nur im Container läuft, müssen sie In-Memory-Mocks anbieten.`,
    },
  },
  {
    skillName: 'pnpm-workspace-monorepo',
    detectIfUsed: (scan) => (scan.workspaces?.length ?? 0) > 0,
    contribution: {
      section: 'commands',
      markdown: `- **Monorepo Build:** Nutze \`pnpm -r build\` (rekursiv) statt einzelnem \`npm run build\`. Specific package: \`pnpm --filter @scope/package build\`.
- **Cross-Package-Deps:** Imports zwischen Workspace-Packages verwenden \`workspace:*\` in package.json — nicht relativ-paths.`,
    },
  },
  {
    skillName: 'typescript-strict-mode',
    detectIfUsed: (scan) => scan.hasTypescript === true,
    contribution: {
      section: 'style',
      markdown: `- **TS strict-mode:** Nie \`any\` ohne explizite eslint-disable + Begründung. \`unknown\` wenn Type wirklich offen ist.
- **Imports:** ESM-Style mit \`.js\` Suffix für lokale Imports (auch bei .ts-Source). NIE Bare-Imports ohne Suffix.`,
    },
  },
  {
    skillName: 'env-example-secrets',
    detectIfUsed: (scan) => (scan.envExampleKeys?.length ?? 0) > 0,
    contribution: {
      section: 'doNotTouch',
      markdown: `- **.env-Files:** NIE \`.env\` / \`.env.local\` / \`.env.production\` in den Diff aufnehmen (sind in \`.gitignore\`). Bei neuen ENV-Variablen IMMER \`.env.example\` mit-aktualisieren — sonst weiß niemand was zu setzen ist.`,
    },
  },
];
