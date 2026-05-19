/**
 * Error-Extractor — turns the raw, often-truncated build output into a focused,
 * user-friendly diagnosis. Replaces the v603 `output.slice(-500)` heuristic which
 * frequently chopped off the actual error message (alpbyte-games 19.05.).
 *
 * Strategy:
 *  1. Walk the output looking for known error markers (EACCES, ENOENT, etc.)
 *  2. Capture a window of context (3 lines before, 5 lines after) around the marker
 *  3. Run pattern recognizers to produce a human-readable summary
 *  4. Fall back to the last 500 chars if no marker found (preserves v603 behavior)
 */

export interface ExtractedError {
  /** Human-readable summary of what went wrong. */
  summary: string;
  /** Context window around the error (for diagnostics). */
  contextSnippet: string;
  /** Machine-readable error code if recognized (EACCES, ENOENT, ETIMEDOUT, ENOSPC, NPM_REGISTRY, BUILD_FAIL). */
  code?: string;
  /** True if the extractor recognized a known pattern; false if fell back. */
  recognized: boolean;
}

const ERROR_MARKERS = [
  // Filesystem / permission
  /EACCES.*permission denied/i,
  /EPERM.*operation not permitted/i,
  /ENOENT.*no such file/i,
  /ENOSPC.*no space left/i,
  /ENOTDIR/i,
  // Network / timeout
  /ETIMEDOUT/i,
  /ECONNREFUSED/i,
  /EHOSTUNREACH/i,
  // npm specific
  /npm\s+error/i,
  /npm\s+ERR/i,
  // Build / compile
  /error TS\d+/i,
  /SyntaxError/i,
  /Module not found/i,
  /Cannot find module/i,
  // Generic
  /^\s*Error:\s/im,
  /failed with exit code \d+/i,
];

/**
 * Find the first occurrence of any error marker in the output, return its
 * line index. Returns -1 if no marker found.
 */
function findErrorLine(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    for (const marker of ERROR_MARKERS) {
      if (marker.test(lines[i])) return i;
    }
  }
  return -1;
}

/**
 * Pattern-recognizers — each takes the full output + the context snippet and
 * returns a friendly summary + code, or null if no match. Order matters: most
 * specific first.
 */
type Recognizer = (output: string, context: string) => { summary: string; code: string } | null;

const recognizers: Recognizer[] = [
  // EACCES with a /root/ path — almost always the "wrong-user-for-root-cwd" trap
  (out) => {
    const m = out.match(/EACCES.*?(?:mkdir|open|access)['\s,]+(['"]?(\/root\/[^'"\s]+))/i);
    if (!m) return null;
    return {
      summary: `Permission denied: Pfad ${m[2]} liegt unter /root/ und der Build-User darf ihn nicht beschreiben. ` +
        `Hinweis: Code-Agent läuft typischerweise als non-root User (z.B. 'madh'). /root selbst ist nicht traversierbar (drwx------). ` +
        `Lösung: Pfad auf /home/<user>/... wechseln, oder Agent als root konfigurieren.`,
      code: 'EACCES',
    };
  },
  // Generic EACCES
  (out) => {
    const m = out.match(/EACCES.*?(?:mkdir|open|access)['\s,]+(['"]?[^'"\s]+)/i);
    if (!m) return null;
    return {
      summary: `Permission denied beim Zugriff auf ${m[1].replace(/['"]/g, '')}. ` +
        `Prüfe Ownership und Permissions des Pfades und seiner Parent-Verzeichnisse.`,
      code: 'EACCES',
    };
  },
  // npm registry unreachable
  (out) => {
    if (/npm error.*?(registry|ETIMEDOUT|getaddrinfo)/i.test(out)) {
      return {
        summary: `npm konnte die Registry nicht erreichen. Prüfe Internet-Verbindung, Proxy-Einstellungen oder npm-Config.`,
        code: 'NPM_REGISTRY',
      };
    }
    return null;
  },
  // Disk full
  (out) => {
    if (/ENOSPC.*no space left/i.test(out)) {
      return {
        summary: `Disk voll — kein Platz für Build-Artefakte. Prüfe df -h und räume node_modules oder /tmp auf.`,
        code: 'ENOSPC',
      };
    }
    return null;
  },
  // Module not found
  (out) => {
    const m = out.match(/(?:Cannot find module|Module not found)[\s:'"]+([^\s'",)]+)/i);
    if (m) {
      return {
        summary: `Modul "${m[1]}" wurde nicht gefunden. Prüfe ob es in package.json steht und ob npm install vollständig durchlief.`,
        code: 'MODULE_NOT_FOUND',
      };
    }
    return null;
  },
  // TypeScript compile error
  (out) => {
    const m = out.match(/error (TS\d+):\s+(.+)/i);
    if (m) {
      return {
        summary: `TypeScript-Compile-Fehler ${m[1]}: ${m[2].trim()}. Quelltext anpassen oder Type-Definitionen prüfen.`,
        code: 'TS_COMPILE',
      };
    }
    return null;
  },
  // Generic non-zero exit
  (out) => {
    const m = out.match(/failed with exit code (\d+)/i);
    if (m) {
      return {
        summary: `Build-Command beendete mit Exit-Code ${m[1]}. Keine spezifische Ursache erkannt — siehe Kontext.`,
        code: 'BUILD_FAIL',
      };
    }
    return null;
  },
];

/**
 * Extract a focused error report from raw build/exec output.
 *
 * @param output - The full combined stdout+stderr from a failed build/exec.
 * @param maxContextChars - Max characters of context to include (default 800).
 */
export function extractBuildError(output: string, maxContextChars = 800): ExtractedError {
  if (!output || output.length === 0) {
    return {
      summary: 'Kein Output verfügbar.',
      contextSnippet: '',
      recognized: false,
    };
  }

  const lines = output.split(/\r?\n/);
  const errorLine = findErrorLine(lines);

  let contextSnippet = '';
  if (errorLine >= 0) {
    const start = Math.max(0, errorLine - 3);
    const end = Math.min(lines.length, errorLine + 6);
    contextSnippet = lines.slice(start, end).join('\n');
  } else {
    contextSnippet = output.slice(-maxContextChars);
  }
  if (contextSnippet.length > maxContextChars) {
    contextSnippet = '[...]\n' + contextSnippet.slice(-maxContextChars);
  }

  // Run recognizers against the full output (they look for specific patterns)
  for (const recognizer of recognizers) {
    const result = recognizer(output, contextSnippet);
    if (result) {
      return {
        summary: result.summary,
        contextSnippet,
        code: result.code,
        recognized: true,
      };
    }
  }

  // Fall back: no specific recognizer matched
  return {
    summary: errorLine >= 0
      ? `Fehler erkannt in Zeile: ${lines[errorLine].trim().slice(0, 200)}`
      : 'Build fehlgeschlagen. Keine spezifische Ursache aus dem Output erkennbar.',
    contextSnippet,
    recognized: false,
  };
}
