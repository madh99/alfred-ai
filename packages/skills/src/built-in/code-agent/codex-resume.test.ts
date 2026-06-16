import { describe, it, expect } from 'vitest';
import { isCodexAtCapacity, toCodexResumeArgsTemplate } from './agent-executor.js';
import { createParserState, parseLine } from './agent-output-parser.js';

/**
 * v906 — codex „at capacity" wird NICHT von vorn neu gestartet, sondern per
 * `codex exec resume <sessionId>` fortgesetzt. Diese Tests sichern die drei
 * Bausteine: Klassifikation, Session-ID-Extraktion, Resume-Args-Bau.
 */
describe('v906 codex at-capacity resume', () => {
  describe('isCodexAtCapacity', () => {
    it('erkennt „Selected model is at capacity"', () => {
      expect(isCodexAtCapacity({ exitCode: 1, stdout: 'Selected model is at capacity. Please try a different model.', stderr: '' })).toBe(true);
    });
    it('matcht NICHT das Wort „capacity" im Prompt/Output', () => {
      expect(isCodexAtCapacity({ exitCode: 1, stdout: 'Datenmodell: capacity optional, ageRestriction optional.', stderr: '' })).toBe(false);
    });
    it('exitCode 0 ist nie at-capacity', () => {
      expect(isCodexAtCapacity({ exitCode: 0, stdout: 'model is at capacity', stderr: '' })).toBe(false);
    });
  });

  describe('parseLine — thread.started liefert sessionId', () => {
    it('extrahiert thread_id als sessionId', () => {
      const st = createParserState('codex-jsonl');
      const chunk = parseLine(st, '{"type":"thread.started","thread_id":"019ecfe9-1234-7700-aaaa-bbbbbbbbbbbb"}');
      expect(chunk.sessionId).toBe('019ecfe9-1234-7700-aaaa-bbbbbbbbbbbb');
    });
    it('andere Events liefern keine sessionId', () => {
      const st = createParserState('codex-jsonl');
      const chunk = parseLine(st, '{"type":"turn.started"}');
      expect(chunk.sessionId).toBeUndefined();
    });
  });

  describe('toCodexResumeArgsTemplate', () => {
    it('wandelt exec-Args in resume-Form (resume + sessionId vor dem Prompt)', () => {
      const upgraded = ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '{{prompt}}'];
      expect(toCodexResumeArgsTemplate(upgraded, 'SID-123')).toEqual([
        'exec', 'resume', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', 'SID-123', '{{prompt}}',
      ]);
    });
    it('ist idempotent (kein doppeltes resume)', () => {
      const once = toCodexResumeArgsTemplate(['exec', '--json', '{{prompt}}'], 'SID');
      expect(toCodexResumeArgsTemplate(once, 'SID')).toEqual(once);
    });
    it('ohne {{prompt}} hängt sessionId hinten an', () => {
      expect(toCodexResumeArgsTemplate(['exec', '--json'], 'SID')).toEqual(['exec', 'resume', '--json', 'SID']);
    });
  });
});
