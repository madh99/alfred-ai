import { describe, expect, it } from 'vitest';
import { kaefigText } from './fernzugriff-skill.js';
import { normalisiereBefehl } from './regeln.js';

describe('v1722 — Heredoc im Lese-Käfig', () => {
  it('mehrzeilige Befehle behalten ihre Zeilen, einzeilige bleiben normalisiert', () => {
    const heredoc = "python3 - <<'PY'\nimport json\nprint(json.dumps({'a': 1}))\nPY";
    expect(kaefigText(heredoc, normalisiereBefehl(heredoc))).toBe(heredoc);
    expect(kaefigText('sudo -n ' + heredoc, normalisiereBefehl(heredoc))).toBe(heredoc);
    expect(kaefigText('ls   -la  /srv', normalisiereBefehl('ls   -la  /srv'))).toBe('ls -la /srv');
    expect(kaefigText(undefined, 'uptime')).toBe('uptime');
  });
});
