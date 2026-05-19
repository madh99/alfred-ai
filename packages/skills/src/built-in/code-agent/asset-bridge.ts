import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { FileStore } from '@alfred/storage';

/**
 * FileStore-Asset-Bridge — extracts file-store keys from a project-agent goal
 * text and stages them into the project's cwd/uploads/ directory so the code
 * agent can actually USE the attached files (instead of being told "Datei liegt
 * unter <userId>/<some-timestamped-key>" which the agent can't read).
 *
 * Pattern: file-store keys look like `<userId>/<timestamp>_<filename>.<ext>`
 * (e.g. `5060785419/2026-05-19T14-25-02-603Z_file_92.MP4`).
 *
 * Behavior:
 *  - Scan the goal text for matching keys
 *  - For each found key: read from FileStore, write to <cwd>/uploads/<filename>
 *  - Strip the timestamp prefix so the resulting filename is human-readable
 *  - Return the goal text rewritten with concrete uploads/-paths replacing the keys
 */

/**
 * Regex to find file-store-style keys in arbitrary text.
 *
 * Matches structure: `<digits>/<iso-timestamp-like>_<filename>.<2-5-letter-extension>`
 * Captures: full match. Won't match URLs (http://), only bare key-style strings.
 */
const FILESTORE_KEY_RE = /\b(\d{4,}\/[\d\-TZ:.]+_[^\s'"`,()<>]+\.[a-zA-Z0-9]{2,5})\b/g;

export interface ExtractedAsset {
  /** Original key in the file store. */
  key: string;
  /** Local filename written to <cwd>/uploads/. */
  localFileName: string;
  /** Absolute path of the written file. */
  localPath: string;
  /** Path relative to cwd, with forward slashes (for use in prompts). */
  relativePath: string;
  /** Byte size written. */
  size: number;
}

export interface StageAssetsResult {
  /** Assets that were successfully staged. */
  staged: ExtractedAsset[];
  /** Goal text with key references replaced by local paths. */
  rewrittenGoal: string;
  /** Errors per key (failed reads, etc.). */
  errors: Array<{ key: string; reason: string }>;
}

/**
 * Strip the timestamp prefix from a file-store filename to get something
 * human-readable. e.g. "2026-05-19T14-25-02-603Z_file_92.MP4" → "file_92.MP4"
 */
function humanFileName(rawName: string): string {
  // Remove leading ISO-timestamp prefix (with milliseconds + Z, then underscore)
  const stripped = rawName.replace(/^[\d\-TZ:.]+_/, '');
  return stripped || rawName;
}

/**
 * Find all file-store keys in arbitrary text.
 */
export function findAssetKeys(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(FILESTORE_KEY_RE)) {
    out.add(m[1]);
  }
  return [...out];
}

/**
 * Stage all assets referenced in the goal text into <cwd>/uploads/.
 *
 * On success, the returned `rewrittenGoal` replaces each file-store key with
 * a relative path like `uploads/file_92.MP4` so the agent gets actionable info.
 *
 * Failures (e.g. file not found in store) are logged into `errors` and the
 * original key is left in the goal text — code-agent will see the error
 * description appended at the end of the rewritten goal.
 */
export async function stageAssetsForProject(
  goalText: string,
  cwd: string,
  fileStore: FileStore,
  /** Optional user-ID for access verification — when provided, only keys
   *  owned by this user are accepted. */
  requestingUserId?: string,
): Promise<StageAssetsResult> {
  const keys = findAssetKeys(goalText);
  const result: StageAssetsResult = {
    staged: [],
    rewrittenGoal: goalText,
    errors: [],
  };
  if (keys.length === 0) return result;

  const uploadsDir = path.join(cwd, 'uploads');
  if (!existsSync(uploadsDir)) {
    mkdirSync(uploadsDir, { recursive: true });
  }

  // Track filename collisions — if two keys resolve to the same human name,
  // append a counter.
  const usedNames = new Set<string>();
  const nextFreeName = (base: string): string => {
    if (!usedNames.has(base)) { usedNames.add(base); return base; }
    const ext = path.extname(base);
    const stem = base.slice(0, -ext.length || undefined);
    let i = 2;
    while (usedNames.has(`${stem}_${i}${ext}`)) i++;
    const name = `${stem}_${i}${ext}`;
    usedNames.add(name);
    return name;
  };

  let rewritten = goalText;

  for (const key of keys) {
    try {
      const data = await fileStore.read(key, requestingUserId);
      const rawName = path.basename(key);
      const cleanName = nextFreeName(humanFileName(rawName));
      const localPath = path.join(uploadsDir, cleanName);
      writeFileSync(localPath, data);
      const relativePath = path.relative(cwd, localPath).replace(/\\/g, '/');
      result.staged.push({
        key, localFileName: cleanName, localPath, relativePath, size: data.length,
      });
      // Replace key in goal text (escape regex special chars)
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      rewritten = rewritten.replace(new RegExp(escaped, 'g'), relativePath);
    } catch (err) {
      result.errors.push({
        key, reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Append a one-line notice with the staged assets at the end (helps the agent
  // notice that uploads/ exists)
  if (result.staged.length > 0) {
    const notice = `\n\nAngehängte Dateien wurden bereits unter <cwd>/uploads/ abgelegt:\n` +
      result.staged.map(a => `  - ${a.relativePath} (${a.size} bytes)`).join('\n');
    rewritten = rewritten + notice;
  }
  if (result.errors.length > 0) {
    const notice = `\n\nFolgende referenzierte Dateien konnten nicht geladen werden:\n` +
      result.errors.map(e => `  - ${e.key}: ${e.reason}`).join('\n');
    rewritten = rewritten + notice;
  }

  result.rewrittenGoal = rewritten;
  return result;
}
