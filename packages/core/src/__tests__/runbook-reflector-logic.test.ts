import { describe, it, expect } from 'vitest';

/**
 * Confidence routing logic mirrors ChatSessionRunbookReflector.processCandidate().
 * Pure function for testability — the reflector applies these thresholds directly.
 */
function routeByConfidence(parsed: {
  is_runbook_candidate?: boolean;
  confidence?: number;
  title?: string;
  steps?: string[];
}): 'skip' | 'auto-draft' | 'confirmation' {
  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
  const isCandidate = parsed.is_runbook_candidate === true;
  const hasMinimumStructure = Boolean(parsed.title) && Array.isArray(parsed.steps) && parsed.steps.length >= 2;

  if (!isCandidate || !hasMinimumStructure || confidence < 0.5) return 'skip';
  if (confidence >= 0.8) return 'confirmation';
  return 'auto-draft';
}

describe('Runbook-Reflector confidence routing', () => {
  it('skips when not flagged as candidate', () => {
    expect(routeByConfidence({ is_runbook_candidate: false, confidence: 0.9, title: 'X', steps: ['a', 'b'] }))
      .toBe('skip');
  });

  it('skips low confidence (<0.5)', () => {
    expect(routeByConfidence({ is_runbook_candidate: true, confidence: 0.4, title: 'X', steps: ['a', 'b'] }))
      .toBe('skip');
  });

  it('skips when steps fewer than 2', () => {
    expect(routeByConfidence({ is_runbook_candidate: true, confidence: 0.9, title: 'X', steps: ['only one'] }))
      .toBe('skip');
  });

  it('skips when no title', () => {
    expect(routeByConfidence({ is_runbook_candidate: true, confidence: 0.9, steps: ['a', 'b'] }))
      .toBe('skip');
  });

  it('auto-drafts at 0.5 confidence', () => {
    expect(routeByConfidence({ is_runbook_candidate: true, confidence: 0.5, title: 'X', steps: ['a', 'b'] }))
      .toBe('auto-draft');
  });

  it('auto-drafts at 0.79 confidence', () => {
    expect(routeByConfidence({ is_runbook_candidate: true, confidence: 0.79, title: 'X', steps: ['a', 'b'] }))
      .toBe('auto-draft');
  });

  it('enqueues confirmation at 0.8 confidence (boundary)', () => {
    expect(routeByConfidence({ is_runbook_candidate: true, confidence: 0.8, title: 'X', steps: ['a', 'b'] }))
      .toBe('confirmation');
  });

  it('enqueues confirmation at 0.95 confidence', () => {
    expect(routeByConfidence({ is_runbook_candidate: true, confidence: 0.95, title: 'X', steps: ['a', 'b', 'c'] }))
      .toBe('confirmation');
  });

  it('handles missing confidence (treated as 0)', () => {
    expect(routeByConfidence({ is_runbook_candidate: true, title: 'X', steps: ['a', 'b'] }))
      .toBe('skip');
  });
});

/**
 * Trigger A gate (alfred.ts ITSM-wrapper) mirrors: only suggest runbook when
 * incident closes with substantial root_cause + resolution + status flip.
 */
function shouldSuggestIncidentRunbook(input: {
  action: string;
  status?: string;
  rootCause?: string;
  resolution?: string;
}): boolean {
  const isResolveAction = input.action === 'update_incident' || input.action === 'close_incident';
  const newStatus = input.status ?? '';
  const becomesResolved = isResolveAction && (newStatus === 'resolved' || newStatus === 'closed');
  return becomesResolved
    && (input.rootCause?.length ?? 0) >= 20
    && (input.resolution?.length ?? 0) >= 20;
}

describe('Trigger A — Incident-Runbook gate', () => {
  it('triggers on proper resolution', () => {
    expect(shouldSuggestIncidentRunbook({
      action: 'update_incident', status: 'resolved',
      rootCause: 'UniFi IPS-Regel im Block-Modus statt Alert',
      resolution: 'Regel auf Alert+Log umgestellt, 24h beobachtet, keine neuen FP',
    })).toBe(true);
  });

  it('skips on incomplete root_cause', () => {
    expect(shouldSuggestIncidentRunbook({
      action: 'update_incident', status: 'resolved',
      rootCause: 'kurz',
      resolution: 'Regel auf Alert+Log umgestellt, 24h beobachtet',
    })).toBe(false);
  });

  it('skips when status is not resolved/closed', () => {
    expect(shouldSuggestIncidentRunbook({
      action: 'update_incident', status: 'investigating',
      rootCause: 'UniFi IPS-Regel im Block-Modus statt Alert',
      resolution: 'Regel auf Alert+Log umgestellt, 24h beobachtet',
    })).toBe(false);
  });

  it('triggers also for close_incident action', () => {
    expect(shouldSuggestIncidentRunbook({
      action: 'close_incident', status: 'closed',
      rootCause: 'BMW MQTT Token expired due to 24h refresh window',
      resolution: 'Re-authorized via bmw.authorize, container recreated with new token',
    })).toBe(true);
  });
});

/**
 * Trigger B gate (project-agent): success + ≥3 milestones.
 */
function shouldSuggestProjectAgentRunbook(success: boolean, milestonesCount: number): boolean {
  return success && milestonesCount >= 3;
}

describe('Trigger B — Project-Agent-Runbook gate', () => {
  it('triggers on success with 3 milestones', () => {
    expect(shouldSuggestProjectAgentRunbook(true, 3)).toBe(true);
  });

  it('skips on failure even with many milestones', () => {
    expect(shouldSuggestProjectAgentRunbook(false, 10)).toBe(false);
  });

  it('skips with insufficient milestones', () => {
    expect(shouldSuggestProjectAgentRunbook(true, 2)).toBe(false);
  });

  it('triggers on 5 milestones', () => {
    expect(shouldSuggestProjectAgentRunbook(true, 5)).toBe(true);
  });
});

/**
 * v592 — Trigger C triage logic widened: total ≥6 AND (tool-msgs ≥1 OR assistant-msgs ≥3).
 * Mirrors the SQL HAVING clause in ChatSessionRunbookReflector.tick().
 */
function passesTriage(totalMessages: number, toolMessages: number, assistantMessages: number, minMessages = 6): boolean {
  if (totalMessages < minMessages) return false;
  return toolMessages >= 1 || assistantMessages >= 3;
}

describe('v592 Trigger C — widened triage', () => {
  it('passes pure-conversation problem-solving (no tool calls)', () => {
    // Bewerbungs-Brainstorming: 4 user, 4 assistant, 0 tool — 8 total
    expect(passesTriage(8, 0, 4)).toBe(true);
  });

  it('passes infra-debugging (tool calls present)', () => {
    // BMW-Debug: 3 user, 2 assistant, 5 tool — 10 total
    expect(passesTriage(10, 5, 2)).toBe(true);
  });

  it('skips too-short conversation (< 6 msgs)', () => {
    expect(passesTriage(5, 1, 2)).toBe(false);
  });

  it('skips long conversation without engagement (no tool + few assistant)', () => {
    // Random user-only ramble (rare but possible): 8 user, 2 assistant, 0 tool
    expect(passesTriage(10, 0, 2)).toBe(false);
  });

  it('passes boundary case: exactly 6 msgs with 3 assistant', () => {
    expect(passesTriage(6, 0, 3)).toBe(true);
  });

  it('passes single tool-call even with 1 assistant', () => {
    expect(passesTriage(7, 1, 1)).toBe(true);
  });
});
