import type { ProbeContext, ProbeResult } from './probe-types.js';

const DEFAULT_HTTP_TIMEOUT = 15_000;

/**
 * http-probe — checks if the project's repoUrl/deploymentUrl responds.
 *
 * Only runs when repoUrl is a real http(s) URL — skips git+ssh, ssh://, file:// etc.
 *
 * Returns:
 *  - 'ok'      : 2xx response
 *  - 'warning' : 3xx-4xx response (redirect or client error — may be intentional)
 *  - 'error'   : 5xx or network failure
 *  - 'skipped' : no usable URL
 */
export async function httpProbe(ctx: ProbeContext): Promise<ProbeResult> {
  const startedAt = Date.now();
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_HTTP_TIMEOUT;

  const url = ctx.repoUrl;
  if (!url) {
    return { probe: 'http', status: 'skipped', details: 'no repoUrl configured', durationMs: Date.now() - startedAt };
  }
  if (!/^https?:\/\//i.test(url)) {
    return { probe: 'http', status: 'skipped', details: `non-http url: ${url.slice(0, 60)}`, durationMs: Date.now() - startedAt };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'manual' });
    clearTimeout(timer);
    const code = res.status;
    let status: 'ok' | 'warning' | 'error';
    if (code >= 200 && code < 300) status = 'ok';
    else if (code >= 500) status = 'error';
    else status = 'warning';
    return {
      probe: 'http', status,
      details: `${url} → HTTP ${code}`,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    return {
      probe: 'http', status: 'error',
      details: `${url} → ${msg.slice(0, 200)}`,
      durationMs: Date.now() - startedAt,
    };
  }
}
