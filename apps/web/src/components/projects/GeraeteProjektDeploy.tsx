'use client';

/**
 * v1439 — Deploy eines Geräte-Projekts im Web (wie in der App): Ziel anzeigen und setzen, Deployen, Rollback, „automatisch in dev“.
 * Ziel, Deploy und Rollback gehen immer zur Bestätigung an den Owner (Telegram/App) — hier wird nur die Anfrage gestellt.
 */
import { useCallback, useEffect, useState } from 'react';
import type { AlfredClient, DeployInfo } from '@/lib/alfred-client';

const TOKEN: Record<string, string> = { projekt: 'Projekt-Token (Projektumgebung)', gitlab: 'vorhandenes GitLab-Token', github: 'vorhandenes GitHub-Token' };

export function GeraeteProjektDeploy({ client, projektId }: { client: AlfredClient; projektId: string }) {
  const [d, setD] = useState<DeployInfo | null>(null);
  const [bearbeiten, setBearbeiten] = useState(false);
  const [busy, setBusy] = useState(false);
  const [meldung, setMeldung] = useState<{ ok: boolean; text: string } | null>(null);
  const [f, setF] = useState({ host: '', user: '', process_manager: 'pm2', stufe: 'dev', app_port: '', branch: '', env_stage: '', auto_dev: false });

  const laden = useCallback(async () => { setD(await client.geraetProjektDeployInfo(projektId).catch(() => null)); }, [client, projektId]);
  useEffect(() => { void laden(); }, [laden]);

  const senden = async (aktion: 'ziel' | 'ziel_entfernen' | 'deploy' | 'rollback', felder: Record<string, unknown> = {}) => {
    setBusy(true); setMeldung(null);
    const r: { success: boolean; display?: string; error?: string } = await client.geraetProjektDeploy(projektId, aktion, felder).catch((e: Error) => ({ success: false, error: e.message }));
    setBusy(false);
    setMeldung({ ok: r.success, text: r.success ? (r.display ?? 'Gestellt.') : (r.error ?? 'Fehler') });
    if (r.success) { setBearbeiten(false); await laden(); }
  };
  const oeffnen = () => {
    const z = d?.ziel;
    setF({ host: z?.host ?? '', user: z?.user ?? '', process_manager: z?.prozess ?? 'pm2', stufe: z?.stufe ?? 'dev', app_port: z?.appPort ? String(z.appPort) : '', branch: z?.branch ?? '', env_stage: z?.envStage ?? '', auto_dev: !!z?.autoDev });
    setBearbeiten(true);
  };

  if (!d || 'error' in d) return null;
  const feld = 'bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1 text-gray-200 text-xs';
  const l = d.letzter;
  return (
    <div className="bg-[#141414] border border-[#2a2a2a] rounded p-3 space-y-2 text-xs text-gray-300">
      <div className="flex items-center gap-2">
        <div className="text-gray-100 text-sm flex-1">🚀 Deploy</div>
        <button disabled={busy} onClick={() => (bearbeiten ? setBearbeiten(false) : oeffnen())} className="px-2 py-1 text-xs text-gray-300 border border-[#2a2a2a] rounded hover:bg-[#222]">{bearbeiten ? 'Abbrechen' : d.ziel ? 'Ziel ändern' : 'Ziel festlegen'}</button>
      </div>
      <div className="text-gray-500">{d.repoUrl ? <>Repo: {d.repoUrl} · {d.token ? `Token: ${TOKEN[d.token] ?? d.token}` : 'kein Token gefunden (öffentliches Repo oder GIT_TOKEN in der Projektumgebung)'}</> : 'Kein Remote — der Deploy holt den Stand aus dem Repo.'}</div>
      {d.ziel ? <div>Ziel: {d.zielText}{d.bestaetigt ? '' : ' (nicht bestätigt)'}</div> : !bearbeiten && <div className="text-gray-500">Kein Deploy-Ziel — ohne Ziel bleibt alles wie bisher.</div>}
      {l && <div className={`whitespace-pre-wrap ${l.ok ? 'text-gray-300' : 'text-red-400'}`}>{l.ok ? '✅' : '❌'} Letzter Deploy {new Date(l.zeit).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}:{'\n'}{l.text}</div>}
      {bearbeiten && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <input className={`${feld} w-48`} placeholder="Zielrechner, z. B. 192.168.1.96" value={f.host} onChange={e => setF({ ...f, host: e.target.value })} />
            <input className={`${feld} w-36`} placeholder="SSH-Benutzer (root)" value={f.user} onChange={e => setF({ ...f, user: e.target.value })} />
            <select className={feld} value={f.process_manager} onChange={e => setF({ ...f, process_manager: e.target.value })}><option value="pm2">pm2</option><option value="systemd">systemd</option><option value="docker-compose">Docker Compose</option></select>
            <select className={feld} value={f.stufe} onChange={e => setF({ ...f, stufe: e.target.value, auto_dev: e.target.value === 'dev' ? f.auto_dev : false })}><option value="dev">dev</option><option value="test">test</option><option value="prod">prod</option></select>
            <input className={`${feld} w-24`} type="number" placeholder="Port" value={f.app_port} onChange={e => setF({ ...f, app_port: e.target.value })} />
            <input className={`${feld} w-32`} placeholder="Zweig (optional)" value={f.branch} onChange={e => setF({ ...f, branch: e.target.value })} />
            <input className={`${feld} w-36`} placeholder="ENV-Stage (optional)" value={f.env_stage} onChange={e => setF({ ...f, env_stage: e.target.value })} />
          </div>
          <label className="flex items-center gap-2"><input type="checkbox" disabled={f.stufe !== 'dev'} checked={f.auto_dev} onChange={e => setF({ ...f, auto_dev: e.target.checked })} />Automatisch in dev nach grüner Abnahme aller Etappen</label>
          <div className="flex items-center gap-2">
            {d.ziel && <button disabled={busy} onClick={() => void senden('ziel_entfernen')} className="text-red-400 hover:text-red-300">Ziel entfernen</button>}
            <div className="flex-1" />
            <button disabled={busy || !f.host.trim()} onClick={() => void senden('ziel', { host: f.host.trim(), user: f.user.trim(), process_manager: f.process_manager, stufe: f.stufe, auto_dev: f.auto_dev, ...(f.app_port ? { app_port: Number(f.app_port) } : {}), branch: f.branch.trim(), env_stage: f.env_stage.trim() })} className="px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded">Zur Bestätigung</button>
          </div>
          <div className="text-gray-500">Das Ziel wird erst nach deiner Bestätigung gespeichert — dieser Rechner bekommt Code, ggf. .env und beim Holen das Token.</div>
        </div>
      )}
      {d.ziel && !bearbeiten && (
        <div className="flex items-center gap-2">
          <button disabled={busy || !d.bestaetigt || !d.repoUrl} onClick={() => void senden('deploy')} className="px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded">Deployen</button>
          <button disabled={busy || !l?.vorher} onClick={() => void senden('rollback')} className="px-3 py-1 text-gray-200 border border-[#2a2a2a] rounded hover:bg-[#222] disabled:opacity-40">Rollback</button>
          <span className="text-gray-500">Deploy und Rollback brauchen deine Bestätigung; danach prüft Alfred Status, HTTP und Logs.</span>
        </div>
      )}
      {meldung && <div className={meldung.ok ? 'text-emerald-400' : 'text-red-400'}>{meldung.text}</div>}
    </div>
  );
}
