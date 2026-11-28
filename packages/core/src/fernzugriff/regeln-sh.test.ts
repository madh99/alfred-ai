import { describe, it, expect } from 'vitest';
import { bashEigenheit, ohneHeredocs } from './regeln.js';

// Realfall 28.11. (811c766d Schritt 2): „sh: 1: set: Illegal option -o pipefail“ — als root läuft ein Befehl in sudo -n sh -c (dash)
describe('bashEigenheit', () => {
  it('erkennt die Eigenheiten aus dem Realfall und gängige weitere', () => {
    expect(bashEigenheit('set -euo pipefail\numask 077\ntrue')).toBe('set -o pipefail');
    expect(bashEigenheit('grep -qi x <<< "$body"')).toBe('Here-String <<<');
    expect(bashEigenheit('if [[ -f /x ]]; then echo ja; fi')).toBe('[[ … ]]');
    expect(bashEigenheit('function f { :; }\nf')).toBe('function name');
    expect(bashEigenheit('echo ${v//a/b}; true')).toBe('${var/…/…}');
    expect(bashEigenheit('source /etc/x; true')).toBe('source (in sh: .)');
    expect(bashEigenheit('a=(1 2); echo x')).toBe('Array-Zuweisung');
  });

  it('POSIX-Befehle bleiben frei (auch POSIX-Klassen, $(…), case, Heredoc-Inhalte)', () => {
    expect(bashEigenheit("set -eu\nv=$(cat db-app)\ncase \"$v\" in ''|*[!0-9a-f]*) exit 1;; esac\ngrep -E '[[:space:]]$' x || true")).toBeUndefined();
    expect(bashEigenheit("docker ps --format '{{.Names}}'; echo ok")).toBeUndefined();
    // die im Realfall gewählte Umhüllung: bash-Skript als Heredoc in eine Datei, dann bash
    const umhuellt = `f=$(mktemp /root/x-XXXXXX.sh); cat > "$f" <<'GUACSKRIPT'\nset -euo pipefail\ngrep -q x <<< "$b"\nGUACSKRIPT\nbash "$f"; rc=$?; rm -f "$f"; exit $rc`;
    expect(bashEigenheit(umhuellt)).toBeUndefined();
    expect(bashEigenheit("python3 - <<'PY'\nimport json\nx = [[1]]\nPY")).toBeUndefined();
  });

  it('ohneHeredocs: <<-, Anführungszeichen, mehrere Heredocs; <<< ist kein Heredoc', () => {
    expect(ohneHeredocs('cat <<-EOF\n\tinhalt\n\tEOF\nweiter')).toBe('cat <<-EOF\nweiter');
    expect(ohneHeredocs('a <<"X"\n1\nX\nb <<Y\n2\nY\nc')).toBe('a <<"X"\nb <<Y\nc');
    expect(ohneHeredocs('grep x <<< "$b"\nz')).toBe('grep x <<< "$b"\nz');
  });
});
