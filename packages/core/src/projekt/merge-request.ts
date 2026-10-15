/**
 * v1455 — Etappen über Branch und Merge Request (Spec Jarvis „Regel im Projektvorgang“, R5-Vorstufe; Owner 15.10.: „ok, aber optional
 * einschaltbar — Web, App und per Chat, pro Projekt“). Schalter je Projekt: Tag `merge-requests` (Standard aus).
 *
 * Ablauf: vor der ersten Etappe Zweig `alfred/<lauf>` am Gerät; nach jeder abgenommenen Etappe Push (wie bisher) und MR anlegen bzw.
 * Beschreibung nachführen (Ziel: Standardzweig des GitLab-Projekts); vor jeder weiteren Etappe neue Kommentare des Owners im MR als
 * Hinweise in den Auftrag; am Ende mit allen Etappen grün abgenommen: MR in GitLab zusammenführen, sonst bleibt er offen.
 *
 * Nur GitLab auf dem eigenen Host (wie die Tokens, v1439), nur über https. Reine Funktionen mit austauschbarem fetch (Tests ohne Netz).
 */

export const MR_TAG = 'merge-requests';
/** v1458 — Owner 15.10.: Zusammenführen standardmäßig erst nach seinem Ja; dieser Tag schaltet das automatische Zusammenführen bei grünem Lauf ein. */
export const MR_AUTO_TAG = 'mr-auto-merge';

/** Zweig eines Laufs am Gerät (je Lauf ein Zweig, ein Merge Request). */
export function mrZweig(laufId: string): string { return `alfred/${laufId.replace(/[^A-Za-z0-9._-]/g, '-')}`; }

/** `https://git.example/madh/x.git` → `madh/x`, nur wenn der Host der GitLab-Instanz gehört; sonst undefined. */
export function gitlabPfadAus(repoUrl: string, baseUrl: string): string | undefined {
  try {
    const r = new URL(repoUrl); const b = new URL(baseUrl);
    if (r.host.toLowerCase() !== b.host.toLowerCase()) return undefined;
    const p = r.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    return /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/.test(p) ? p : undefined;
  } catch { return undefined; }
}

export interface MrEtappe { nr: number; ok: boolean; geprueft: boolean; etappe: string; zusammenfassung?: string; commit?: string; kostenUsd: number }

/** Beschreibung des Merge Requests: Ziel, Plan mit Stand je Etappe, Abnahme, Hinweis auf Kommentare. Rein aus dem Laufstand. */
export function mrBeschreibung(o: { projekt: string; lauf: string; ziel: string; plan: string[]; erledigt: MrEtappe[]; pruefBefehle: string[]; fortsetzungVon?: string[]; auto?: boolean }): string {
  const z = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
  const zeilen = o.plan.map((p, i) => {
    const e = [...o.erledigt].reverse().find(x => x.nr === i + 1);
    const zeichen = !e ? '⏳' : !e.ok ? '❌' : e.geprueft ? '✅' : '⚠️';
    return `${i + 1}. ${zeichen} ${z(p, 160)}${e?.commit ? ` — \`${e.commit}\`` : ''}${e?.zusammenfassung ? `\n   ${z(e.zusammenfassung, 300)}` : ''}`;
  });
  return [
    `**Ziel:** ${z(o.ziel, 600)}`, '',
    ...(o.fortsetzungVon?.length ? [`_Fortsetzung von Lauf ${o.fortsetzungVon.join(', ')} auf demselben Zweig — deren Etappen stehen in den Commits._`, ''] : []),
    `**Etappen** (✅ abgenommen · ⚠️ ohne Abnahme · ❌ rot · ⏳ offen):`, ...zeilen, '',
    `**Abnahme:** ${o.pruefBefehle.length ? o.pruefBefehle.map(b => `\`${b}\``).join(' ; ') : 'keine Prüfbefehle — der Owner prüft selbst'}`, '',
    `_Lauf ${o.lauf} · ${o.projekt} · von Alfred nachgeführt. Kommentare hier liest Alfred vor der nächsten Etappe als Hinweise. ${o.auto === false ? 'Sind alle Etappen grün, fragt Alfred den Owner, ob zusammengeführt wird._' : 'Zusammengeführt wird automatisch, wenn alle Etappen grün abgenommen sind._'}`,
  ].join('\n');
}

type F = typeof fetch;
const kopf = (token: string, json = false): Record<string, string> => ({ 'PRIVATE-TOKEN': token, ...(json ? { 'Content-Type': 'application/json' } : {}) });
function basis(baseUrl: string): string | undefined { try { const u = new URL(baseUrl); return u.protocol === 'https:' ? u.origin : undefined; } catch { return undefined; } }
const api = (b: string, pfad: string) => `${b}/api/v4/projects/${encodeURIComponent(pfad)}`;
/** v1456 — Link auf derselben Instanz immer https (Realfall 15.10.: web_url kam als http://git.lokalkraft.at/…). */
export function linkSicher(url: string | undefined, b: string): string { try { if (!url) return ''; const u = new URL(url); if (u.host.toLowerCase() !== new URL(b).host.toLowerCase()) return url; u.protocol = 'https:'; return u.toString(); } catch { return url ?? ''; } }

/** Standardzweig des GitLab-Projekts (Ziel des Merge Requests). */
export async function gitlabStandardZweig(baseUrl: string, token: string, pfad: string, f: F = fetch): Promise<string | undefined> {
  const b = basis(baseUrl); if (!b) return undefined;
  const r = await f(api(b, pfad), { headers: kopf(token) });
  if (!r.ok) return undefined;
  const j = await r.json().catch(() => ({})) as { default_branch?: string };
  return typeof j.default_branch === 'string' && /^[A-Za-z0-9._\/-]+$/.test(j.default_branch) ? j.default_branch : undefined;
}

/** Benutzername des Tokens (nur dessen Kommentare zählen als Hinweise des Owners). */
export async function gitlabBenutzer(baseUrl: string, token: string, f: F = fetch): Promise<string | undefined> {
  const b = basis(baseUrl); if (!b) return undefined;
  const r = await f(`${b}/api/v4/user`, { headers: kopf(token) });
  if (!r.ok) return undefined;
  return ((await r.json().catch(() => ({}))) as { username?: string }).username || undefined;
}

/** MR anlegen oder (gleicher Quellzweig, offen) weiterverwenden und die Beschreibung nachführen. */
export async function gitlabMrSichern(baseUrl: string, token: string, pfad: string, mr: { quelle: string; ziel: string; titel: string; beschreibung: string; iid?: number }, f: F = fetch): Promise<{ ok: true; iid: number; url: string; neu: boolean } | { ok: false; fehler: string }> {
  const b = basis(baseUrl); if (!b) return { ok: false, fehler: 'GitLab nur über https' };
  let iid = mr.iid;
  if (!iid) {
    const s = await f(`${api(b, pfad)}/merge_requests?state=opened&source_branch=${encodeURIComponent(mr.quelle)}`, { headers: kopf(token) });
    const offen = s.ok ? await s.json().catch(() => []) as Array<{ iid?: number }> : [];
    iid = offen.find(x => typeof x.iid === 'number')?.iid;
  }
  if (iid) {
    const u = await f(`${api(b, pfad)}/merge_requests/${iid}`, { method: 'PUT', headers: kopf(token, true), body: JSON.stringify({ description: mr.beschreibung }) });
    const j = await u.json().catch(() => ({})) as { web_url?: string; state?: string; message?: unknown };
    if (!u.ok) return { ok: false, fehler: `GitLab ${u.status}: ${JSON.stringify(j.message ?? '').slice(0, 200)}` };
    return { ok: true, iid, url: linkSicher(j.web_url, b), neu: false };
  }
  const c = await f(`${api(b, pfad)}/merge_requests`, { method: 'POST', headers: kopf(token, true), body: JSON.stringify({ source_branch: mr.quelle, target_branch: mr.ziel, title: mr.titel.slice(0, 250), description: mr.beschreibung, remove_source_branch: true }) });
  const j = await c.json().catch(() => ({})) as { iid?: number; web_url?: string; message?: unknown };
  if (!c.ok || typeof j.iid !== 'number') return { ok: false, fehler: `GitLab ${c.status}: ${JSON.stringify(j.message ?? '').slice(0, 200)}` };
  return { ok: true, iid: j.iid, url: linkSicher(j.web_url, b), neu: true };
}

/** Neue Kommentare (nach `seit`) des Owners im MR — ohne Systemnotizen, nur vom Token-Benutzer. */
export async function gitlabMrKommentare(baseUrl: string, token: string, pfad: string, iid: number, owner: string, seit: number, f: F = fetch): Promise<Array<{ id: number; text: string }>> {
  const b = basis(baseUrl); if (!b) return [];
  const r = await f(`${api(b, pfad)}/merge_requests/${iid}/notes?sort=asc&order_by=created_at&per_page=100`, { headers: kopf(token) });
  if (!r.ok) return [];
  const j = await r.json().catch(() => []) as Array<{ id?: number; body?: string; system?: boolean; author?: { username?: string } }>;
  return j.filter(n => typeof n.id === 'number' && n.id > seit && !n.system && n.author?.username === owner && typeof n.body === 'string' && n.body.trim())
    .map(n => ({ id: n.id!, text: n.body!.trim().slice(0, 2000) }));
}

/** v1458 — Zustand eines MR (opened, merged, closed …); undefined bei Fehler. */
export async function gitlabMrStatus(baseUrl: string, token: string, pfad: string, iid: number, f: F = fetch): Promise<string | undefined> {
  const b = basis(baseUrl); if (!b) return undefined;
  const r = await f(`${api(b, pfad)}/merge_requests/${iid}`, { headers: kopf(token) });
  if (!r.ok) return undefined;
  const j = await r.json().catch(() => ({})) as { state?: string };
  return typeof j.state === 'string' ? j.state : undefined;
}

/** MR in GitLab zusammenführen (Quellzweig danach entfernen). */
export async function gitlabMrZusammenfuehren(baseUrl: string, token: string, pfad: string, iid: number, f: F = fetch): Promise<{ ok: true; sha?: string } | { ok: false; fehler: string }> {
  const b = basis(baseUrl); if (!b) return { ok: false, fehler: 'GitLab nur über https' };
  const r = await f(`${api(b, pfad)}/merge_requests/${iid}/merge`, { method: 'PUT', headers: kopf(token, true), body: JSON.stringify({ should_remove_source_branch: true }) });
  const j = await r.json().catch(() => ({})) as { state?: string; merge_commit_sha?: string; message?: unknown };
  if (r.ok && j.state === 'merged') return { ok: true, ...(j.merge_commit_sha ? { sha: j.merge_commit_sha.slice(0, 8) } : {}) };
  return { ok: false, fehler: `GitLab ${r.status}: ${JSON.stringify(j.message ?? j.state ?? '').slice(0, 200)}` };
}

/** Kommentare als Block für den Etappenauftrag (Daten des Owners; Steuerzeichen raus, gekürzt). */
export function mrHinweisBlock(kommentare: string[]): string {
  if (!kommentare.length) return '';
  const sauber = kommentare.map(k => k.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 2000));
  return `\n\nHinweise des Owners aus dem Merge Request (seit der letzten Etappe, berücksichtigen):\n${sauber.map(k => `- ${k.replace(/\n/g, '\n  ')}`).join('\n')}`;
}
