import type { HealthProbe, HealthStatus } from '@alfred/storage';

export interface ProbeResult {
  probe: HealthProbe;
  status: HealthStatus;
  details?: string;
  durationMs: number;
}

export interface ProbeContext {
  cwd?: string;
  repoUrl?: string;
  timeoutMs?: number;
}
