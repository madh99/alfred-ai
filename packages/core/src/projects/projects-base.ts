import path from 'node:path';

// Projekt-Pfade sind IMMER Posix (Alfred-Server laufen auf Linux) — path.posix
// statt path, damit die Ableitung auch unter Windows-Dev korrekte "/"-Pfade liefert.
const posixJoin = path.posix.join;

/**
 * v887 — Zentrale Ableitung des Projekt-Basis-Pfads.
 *
 * Vorher gab es DREI verschiedene Ableitungen (Wizard, localBase-Default,
 * ProjectMoveService), die alle `os.homedir()` = das Home des PROZESS-Users
 * (root) nutzten — obwohl die Code-Agents als ANDERER User laufen
 * (`sudo -u madh`). Ergebnis: Projekte landeten unter `/root/...`, das für
 * den Agent-User per `drwx------` nicht traversierbar ist → EACCES + dubious
 * ownership (Vorfall 13.06., fussball-cc unter /root/.alfred/projects).
 *
 * Diese Funktion richtet die Base am Home des AGENT-Users aus — konsistent
 * mit der bereits etablierten L4-Konvention in project-agent-skill.ts
 * (`/home/<runAsUser>/projects/...`).
 *
 * Priorität:
 *   1. envBase (ALFRED_PROJECTS_BASE) — expliziter Operator-Override
 *   2. localBase (config.projects.localBase) — expliziter Config-Override
 *   3. /home/<agentRunAsUser>/projects — wenn ein non-root Agent-User existiert
 *   4. <processHome>/projects — Single-User-Fall (Agent läuft als Prozess-User)
 */
export interface ProjectsBaseOpts {
  /** config.projects.localBase */
  localBase?: string;
  /** runAsUser der Code-Agents (aus codeAgents.agents[0]), z.B. 'madh' */
  agentRunAsUser?: string;
  /** process.env.ALFRED_PROJECTS_BASE */
  envBase?: string;
  /** os.homedir() — injiziert für Testbarkeit */
  processHome: string;
}

export function resolveProjectsBase(o: ProjectsBaseOpts): string {
  if (o.envBase && o.envBase.trim()) return o.envBase.trim();
  if (o.localBase && o.localBase.trim()) return o.localBase.trim();
  if (o.agentRunAsUser && o.agentRunAsUser !== 'root') return `/home/${o.agentRunAsUser}/projects`;
  return posixJoin(o.processHome, 'projects');
}

/**
 * v887 — runAsUser aus einer Code-Agent-Definition ableiten (gleiche Logik wie
 * L4 in project-agent-skill.ts): `command: sudo, argsTemplate: ['-u', 'madh', …]`.
 */
export function deriveAgentRunAsUser(agent?: { command?: string; argsTemplate?: string[] }): string | undefined {
  if (agent?.command === 'sudo' && agent.argsTemplate?.[0] === '-u' && agent.argsTemplate?.[1]) {
    return agent.argsTemplate[1];
  }
  return undefined;
}

/**
 * v887 — Pre-Check: Ist `base` für den (non-root) Agent-User strukturell
 * unzugänglich? Trifft zu, wenn die Base unter `/root/` liegt (drwx------),
 * der Agent aber als non-root läuft. Der Wizard bricht dann mit Klartext ab,
 * statt ein totes Projekt zu erzeugen.
 */
export function projectsBaseUnreachableForAgent(base: string, agentRunAsUser?: string): boolean {
  return !!agentRunAsUser && agentRunAsUser !== 'root' && /^\/root(\/|$)/.test(base);
}
