import { describe, it, expect } from 'vitest';
import { fortschrittAus, parseErgebnis } from './satellit-auftrag.js';

// v1392 — stream-json von Claude Code: Fortschritt lesbar, Ergebnis nur aus der result-Zeile
const strom = [
  '{"type":"system","subtype":"init","session_id":"s1","tools":["Bash","Edit"]}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Ich lege zuerst das Grundgerüst an."},{"type":"tool_use","name":"Write","input":{"file_path":"/home/madh/claudecode/game/src/app.js","content":"x"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test"}},{"type":"tool_use","name":"Edit","input":{"file_path":"/home/madh/claudecode/game/package.json"}},{"type":"tool_use","name":"TodoWrite","input":{}}]}}',
];

describe('Fortschritt aus stream-json', () => {
  it('eine Zeile je Schritt, Pfade kurz', () => {
    const f = fortschrittAus(strom.join('\n'));
    expect(f.werkzeuge).toBe(4);
    expect(f.schritte).toEqual(['💬 Ich lege zuerst das Grundgerüst an.', '✏️ schreibt src/app.js', '▶ npm test', '✏️ ändert game/package.json', '📝 aktualisiert die Aufgabenliste']);
    expect(fortschrittAus(strom.join('\n'), 2).schritte).toHaveLength(2);
    expect(fortschrittAus('kein json\n{kaputt').schritte).toEqual([]);
  });
  it('Ergebnis: init-Zeile zählt nicht, result-Zeile schon', () => {
    expect(parseErgebnis(strom.join('\n')).fehler).toBeTruthy(); // noch läuft: kein Ergebnis
    expect(parseErgebnis(strom.join('\n')).text).not.toBe('(init)');
    const fertig = parseErgebnis([...strom, '{"type":"result","subtype":"success","is_error":false,"result":"Fertig: App angelegt","total_cost_usd":0.31,"duration_ms":90000,"session_id":"s1"}'].join('\n'));
    expect(fertig).toMatchObject({ text: 'Fertig: App angelegt', kosten: 0.31, dauerMs: 90000 });
    expect(fertig.fehler).toBeUndefined();
  });
});
