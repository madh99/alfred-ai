/**
 * Threshold check for orphan delegate / code-agent / chat sessions.
 *
 * Sessions only get persisted into the Project-Manager when they are "substantial",
 * else the project list would drown in trivial 1-2 tool-call lookups. A session is
 * substantial when ANY of these hold:
 *
 *  - tool_calls >= toolCallsThreshold       (default 5)
 *  - files_changed >= 1                     (any persisted file write is substantial)
 *  - duration_ms >= minutesThreshold * 60_000
 *
 * Returns true if the session crosses the threshold and should be persisted.
 */
export interface ThresholdInput {
  toolCalls?: number;
  filesChanged?: number;
  durationMs?: number;
}

export interface ThresholdConfig {
  toolCallsThreshold?: number;
  minutesThreshold?: number;
}

export function isSubstantialSession(
  input: ThresholdInput,
  config: ThresholdConfig = {},
): boolean {
  const tcLimit = config.toolCallsThreshold ?? 5;
  const minLimit = config.minutesThreshold ?? 3;
  const tc = input.toolCalls ?? 0;
  const fc = input.filesChanged ?? 0;
  const dur = input.durationMs ?? 0;
  return tc >= tcLimit || fc >= 1 || dur >= minLimit * 60_000;
}
