/**
 * v862 — Self-Healing-Pipeline.
 *
 * Vorfall 10.06.2026: Auf den User-Auftrag „behebe das vollumfänglich" hat
 * Alfred claude-code direkt auf seine eigene Installation
 * (/usr/lib/node_modules/@madh-io/alfred-ai) losgelassen und bundle/index.js
 * (minified!) live gepatcht. Der Fix funktionierte — war aber unreviewt,
 * lief gegen keine Test-Suite, existierte nicht im Source-Repo und wurde
 * beim nächsten `npm install -g` kommentarlos überschrieben.
 *
 * Design-Ziel (mit User abgestimmt): Das Verhalten NICHT verbieten, sondern
 * in den offiziellen Kanal lenken — Repo-Checkout, Hotfix-Branch, Tests,
 * MR/PR. Der User reviewed und released wie gewohnt.
 *
 * Drei Schichten:
 *  1. isSelfInstallPath(): erkennt cwds die auf die eigene Installation zeigen
 *  2. prepareSelfHealCheckout(): frischer Checkout (clone/fetch+reset) + Lock
 *  3. Hard-Guard in agent-executor (letzte Verteidigung, falls Redirect umgangen)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const exec = promisify(execFile);

export interface SelfHealingConfig {
  repoUrl: string;
  checkoutPath: string;
  baseBranch: string;
  secondaryRemoteUrl?: string;
}

/**
 * Pfade die Alfreds EIGENE Installation/Daten darstellen. Code-Agents dürfen
 * dort nie arbeiten — Patches sind flüchtig (npm install überschreibt) und
 * der minified Bundle ist kein review-barer Source.
 *
 * Erkannt werden:
 *  - der globale npm-Installationspfad (plattformübergreifende Varianten)
 *  - das Verzeichnis des laufenden Entrypoints (process.argv[1])
 *  - das Daten-Verzeichnis (DB, Tokens, Logs) — Schutz vor "fix the database"
 */
export function isSelfInstallPath(cwd: string, dataDir?: string): boolean {
  if (!cwd) return false;
  let resolved: string;
  try {
    resolved = fs.realpathSync(path.resolve(cwd));
  } catch {
    resolved = path.resolve(cwd);
  }
  const normalized = resolved.replace(/\\/g, '/').toLowerCase();

  // 1. npm-Global-Installation (Linux/macOS/Windows-Pfad-Varianten)
  if (/node_modules\/@madh-io\/alfred-ai(\/|$)/.test(normalized)) return true;

  // 2. Verzeichnis des laufenden Bundles (robust gegen exotische Install-Orte)
  try {
    const entry = process.argv[1];
    if (entry) {
      const entryDir = fs.realpathSync(path.dirname(entry)).replace(/\\/g, '/').toLowerCase();
      // bundle/ liegt direkt unter dem Paket-Root → Paket-Root = dirname(entryDir)
      const pkgRoot = path.dirname(entryDir).replace(/\\/g, '/').toLowerCase();
      if (normalized === entryDir || normalized.startsWith(entryDir + '/')) return true;
      if (pkgRoot.includes('alfred') && (normalized === pkgRoot || normalized.startsWith(pkgRoot + '/'))) return true;
    }
  } catch { /* argv-Pfad nicht auflösbar — überspringen */ }

  // 3. Daten-Verzeichnis
  if (dataDir) {
    const dataNorm = path.resolve(dataDir).replace(/\\/g, '/').toLowerCase();
    if (normalized === dataNorm || normalized.startsWith(dataNorm + '/')) return true;
  }

  return false;
}

const LOCK_FILE = '.alfred-selfheal.lock';
/** Lock gilt als stale nach 6h (abgestürzter Lauf soll nicht ewig blockieren). */
const LOCK_STALE_MS = 6 * 60 * 60 * 1000;

export interface CheckoutResult {
  ok: true;
  checkoutPath: string;
  baseBranch: string;
  /** Lock wieder freigeben — vom Caller nach Run-Ende aufrufen (best effort). */
  releaseLock: () => void;
}
export interface CheckoutFailure {
  ok: false;
  reason: string;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
  return stdout.trim();
}

/**
 * Bereitet den Self-Healing-Checkout vor:
 *  1. Lock acquire (ein Self-Heal zur Zeit — der Checkout ist geteilt)
 *  2. Clone falls nicht vorhanden, sonst fetch
 *  3. Existenz-Guard: baseBranch MUSS remote existieren (kein stiller Fallback —
 *     Lektion aus dem Email-Default-Bug: implizite Fallbacks verschieben sich still)
 *  4. Hard-Reset auf origin/<baseBranch> + clean (Checkout ist Wegwerf-Arbeitsfläche;
 *     node_modules bleibt als Build-Cache erhalten)
 */
export async function prepareSelfHealCheckout(cfg: SelfHealingConfig): Promise<CheckoutResult | CheckoutFailure> {
  const lockPath = path.join(cfg.checkoutPath, LOCK_FILE);

  // 1. Lock
  try {
    if (fs.existsSync(lockPath)) {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) {
        const holder = fs.readFileSync(lockPath, 'utf8').slice(0, 80);
        return { ok: false, reason: `Self-Healing läuft bereits (${holder}). Bitte warten oder Lock prüfen: ${lockPath}` };
      }
      // stale lock — übernehmen
    }
  } catch { /* lock-Prüfung best effort */ }

  // 2. Clone oder Fetch
  try {
    if (!fs.existsSync(path.join(cfg.checkoutPath, '.git'))) {
      fs.mkdirSync(path.dirname(cfg.checkoutPath), { recursive: true });
      await exec('git', ['clone', cfg.repoUrl, cfg.checkoutPath], { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
    } else {
      await git(['fetch', 'origin', '--prune'], cfg.checkoutPath);
    }
  } catch (err) {
    return { ok: false, reason: `Repo-Checkout fehlgeschlagen (${cfg.repoUrl} → ${cfg.checkoutPath}): ${err instanceof Error ? err.message.slice(0, 200) : String(err)}` };
  }

  // 3. Existenz-Guard für baseBranch
  try {
    const remoteBranch = await git(['ls-remote', '--heads', 'origin', cfg.baseBranch], cfg.checkoutPath);
    if (!remoteBranch) {
      return { ok: false, reason: `Self-Healing baseBranch "${cfg.baseBranch}" existiert nicht auf origin. Config prüfen: codeAgents.selfHealing.baseBranch` };
    }
  } catch (err) {
    return { ok: false, reason: `Branch-Check fehlgeschlagen: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}` };
  }

  // 4. Frischer Stand — Wegwerf-Arbeitsfläche
  try {
    await git(['checkout', '-f', cfg.baseBranch], cfg.checkoutPath).catch(async () => {
      await git(['checkout', '-fb', cfg.baseBranch, `origin/${cfg.baseBranch}`], cfg.checkoutPath);
    });
    await git(['reset', '--hard', `origin/${cfg.baseBranch}`], cfg.checkoutPath);
    // -e node_modules: Build-Cache erhalten (pnpm install dauert sonst Minuten)
    await git(['clean', '-fd', '-e', 'node_modules', '-e', LOCK_FILE], cfg.checkoutPath);
  } catch (err) {
    return { ok: false, reason: `Checkout-Reset fehlgeschlagen: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}` };
  }

  // Lock schreiben (nach erfolgreichem Setup)
  try {
    fs.writeFileSync(lockPath, `pid=${process.pid} started=${new Date().toISOString()}`, 'utf8');
  } catch { /* best effort */ }

  return {
    ok: true,
    checkoutPath: cfg.checkoutPath,
    baseBranch: cfg.baseBranch,
    releaseLock: () => { try { fs.unlinkSync(lockPath); } catch { /* gone */ } },
  };
}
