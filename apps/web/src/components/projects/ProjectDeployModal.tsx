'use client';

import { useEffect, useState, useCallback } from 'react';
import { useConfig } from '@/context/ConfigContext';
import type { ProjectLastDeploy } from '@/lib/alfred-client';

interface Props {
  projectId: string;
  projectName: string;
  defaultRepoUrl?: string;
  onClose: () => void;
}

type ProcessManager = 'pm2' | 'docker-compose' | 'systemd';
type Runtime = 'node' | 'python' | 'docker' | 'static';

/**
 * v659 — Deploy-Trigger pro Projekt mit Form-basierten Parametern.
 * Zeigt die letzten Deploys aus deploy_*-Memory (auch chat-getriggerte) als
 * One-Click-Reuse-Buttons. Form-Defaults werden aus dem letzten Deploy auf
 * dem gewählten Host vorbelegt.
 */
export function ProjectDeployModal({ projectId, projectName, defaultRepoUrl, onClose }: Props) {
  const { client } = useConfig();
  const [lastDeploys, setLastDeploys] = useState<ProjectLastDeploy[]>([]);
  const [loadingDeploys, setLoadingDeploys] = useState(false);
  // v659 — Auto-Detected Runtime aus Projekt-cwd (z.B. Dockerfile, package.json …)
  const [detectedRuntime, setDetectedRuntime] = useState<string | undefined>();
  const [detectionReason, setDetectionReason] = useState<string | undefined>();
  const [runtimeOverridden, setRuntimeOverridden] = useState(false);

  // Form state
  const [host, setHost] = useState('');
  const [user, setUser] = useState('root');
  const [processManager, setProcessManager] = useState<ProcessManager>('docker-compose');
  const [runtime, setRuntime] = useState<Runtime>('node');
  const [appPort, setAppPort] = useState<string>('');
  // v801 — Branch wird aus project.defaultBranch initialisiert (fallback 'main')
  const [branch, setBranch] = useState('main');
  const [branchTouched, setBranchTouched] = useState(false);
  const [repoUrl, setRepoUrl] = useState(defaultRepoUrl ?? '');
  // v736 — ENV-Stage-Wahl
  const [envStage, setEnvStage] = useState<string>('prod');
  const [skipEnv, setSkipEnv] = useState<boolean>(false);
  const [envStages, setEnvStages] = useState<Array<{ stage: string; keyCount: number }>>([]);

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; display?: string; error?: string; data?: unknown } | null>(null);
  // v738 — Preview-Toggle (zeigt was passieren würde, ohne Submit)
  const [previewOpen, setPreviewOpen] = useState(false);

  const loadDeploys = useCallback(async () => {
    if (!client) return;
    setLoadingDeploys(true);
    try {
      const r = await client.fetchProjectLastDeploys(projectId);
      setLastDeploys(r.deploys);
      setDetectedRuntime(r.detectedRuntime);
      setDetectionReason(r.detectionReason);
      // Auto-Prefill: bevorzugt letzter Deploy, sonst detected Runtime
      if (r.deploys.length > 0 && !host) {
        applyDeploy(r.deploys[0]);
      } else if (r.detectedRuntime && !runtimeOverridden) {
        // Detected Runtime als Default setzen
        if (r.detectedRuntime === 'node' || r.detectedRuntime === 'python' || r.detectedRuntime === 'docker' || r.detectedRuntime === 'static') {
          setRuntime(r.detectedRuntime);
        }
        // Bei docker-Runtime ist docker-compose der natürliche pm
        if (r.detectedRuntime === 'docker') setProcessManager('docker-compose');
      }
    } finally {
      setLoadingDeploys(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, projectId]);

  useEffect(() => { loadDeploys(); }, [loadDeploys]);

  // v801 — Branch-Default aus project.defaultBranch (statt hardcoded 'main')
  useEffect(() => {
    if (!client || branchTouched) return;
    let cancelled = false;
    client.fetchProject(projectId).then(detail => {
      if (cancelled || !detail?.project?.defaultBranch) return;
      setBranch(detail.project.defaultBranch);
    }).catch(() => { /* */ });
    return () => { cancelled = true; };
  }, [client, projectId, branchTouched]);

  // v736 — Verfügbare ENV-Stages laden für Select
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await client.fetchEnvironmentStages(projectId);
        if (!cancelled) setEnvStages(s);
      } catch { /* */ }
    })();
    return () => { cancelled = true; };
  }, [client, projectId]);

  function applyDeploy(d: ProjectLastDeploy) {
    setHost(d.host);
    setUser(d.user || 'root');
    if (d.processManager) {
      // 'docker compose' → 'docker-compose' für select
      const pm = d.processManager.replace(/\s+/g, '-');
      if (pm === 'pm2' || pm === 'docker-compose' || pm === 'systemd') setProcessManager(pm);
    }
    if (d.runtime === 'node' || d.runtime === 'python' || d.runtime === 'docker' || d.runtime === 'static') {
      setRuntime(d.runtime);
    }
    if (d.port != null) setAppPort(String(d.port));
  }

  async function submit() {
    if (!client || !host.trim() || submitting) return;
    setSubmitting(true);
    setResult(null);
    try {
      const r = await client.triggerProjectDeploy(projectId, {
        host: host.trim(),
        user: user.trim() || 'root',
        process_manager: processManager,
        runtime,
        app_port: appPort ? Number(appPort) : undefined,
        branch: branch.trim() || undefined,
        repo_url: repoUrl.trim() || undefined,
        // v736 — ENV-Stage als .env aufs Target
        env_stage: skipEnv ? undefined : envStage,
        skip_env: skipEnv,
      });
      setResult(r);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-[#111] border border-[#2a2a2a] rounded-lg p-5 max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-100">🚀 Deploy — {projectName}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-red-400 text-lg">✕</button>
        </div>

        {/* Letzte Deploys */}
        <div className="mb-4">
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">
            Letzte Deploys {loadingDeploys && <span className="italic">(lade…)</span>}
          </div>
          {lastDeploys.length === 0 && !loadingDeploys && (
            <div className="text-xs text-gray-600 italic">Noch keine deploy-Memories für dieses Projekt.</div>
          )}
          <div className="space-y-1.5">
            {lastDeploys.slice(0, 5).map((d, i) => (
              <button
                key={`${d.host}-${i}`}
                onClick={() => applyDeploy(d)}
                className={`w-full text-left bg-[#0d0d0d] border rounded px-3 py-2 hover:border-blue-500/60 transition-colors ${
                  d.failed
                    ? (host === d.host ? 'border-red-500/60' : 'border-red-500/30')
                    : (host === d.host ? 'border-blue-500/60' : 'border-[#2a2a2a]')
                }`}
              >
                <div className="flex items-center gap-2 text-xs">
                  {d.failed && <span className="text-red-400">❌</span>}
                  <span className="font-mono text-blue-400">{d.host}</span>
                  <span className="text-gray-500">·</span>
                  <span className="text-gray-300">{d.user}</span>
                  <span className="text-gray-500">·</span>
                  <span className="text-gray-300">{d.processManager ?? 'pm2'}</span>
                  {d.runtime && (<><span className="text-gray-500">·</span><span className="text-gray-300">{d.runtime}</span></>)}
                  {d.port && (<><span className="text-gray-500">·</span><span className="text-gray-300">:{d.port}</span></>)}
                  {d.verified && <span className="ml-auto text-emerald-400 text-[10px]">✓ verified</span>}
                  {d.date && <span className={`text-[10px] ${d.verified ? '' : 'ml-auto'} text-gray-600`}>{d.date}</span>}
                </div>
                {/* v677 — Bei failed-Memory den Fehler-Snippet als Sub-Zeile zeigen */}
                {d.failed && d.error && (
                  <div className="text-[10px] text-red-300/80 mt-1 truncate" title={d.error}>↳ {d.error}</div>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="border-t border-[#222] pt-3 space-y-2.5">
          {/* Host + User in einer Zeile */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-0.5">Host *</label>
              <input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="z.B. 192.168.1.96"
                className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200 font-mono focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-0.5">User</label>
              <input
                value={user}
                onChange={(e) => setUser(e.target.value)}
                placeholder="root / ubuntu / ..."
                className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200 font-mono focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          {/* PM + Runtime + Port in einer Zeile */}
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-0.5">Process-Manager</label>
              <select
                value={processManager}
                onChange={(e) => setProcessManager(e.target.value as ProcessManager)}
                className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
              >
                <option value="docker-compose">🐳 docker-compose</option>
                <option value="pm2">⚙️ pm2</option>
                <option value="systemd">🛠 systemd</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-0.5 flex items-center justify-between gap-1">
                <span>Runtime</span>
                {processManager === 'docker-compose' ? (
                  // v801 — Bei docker-compose definiert das Dockerfile die runtime; UI-Wahl irrelevant
                  <span className="text-gray-500 text-[9px] normal-case italic" title="Bei docker-compose definiert das Dockerfile die Runtime — diese Wahl ist inaktiv">via Dockerfile</span>
                ) : detectedRuntime && (
                  <span
                    className={runtime === detectedRuntime ? 'text-emerald-400 text-[9px] normal-case' : 'text-amber-400 text-[9px] normal-case'}
                    title={detectionReason ?? 'aus cwd erkannt'}
                  >
                    {runtime === detectedRuntime ? `🔍 ${detectedRuntime}` : `⚠ detected: ${detectedRuntime}`}
                  </span>
                )}
              </label>
              <select
                value={runtime}
                onChange={(e) => { setRuntime(e.target.value as Runtime); setRuntimeOverridden(true); }}
                disabled={processManager === 'docker-compose'}
                className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <option value="node">Node.js{detectedRuntime === 'node' ? ' (detected)' : ''}</option>
                <option value="python">Python{detectedRuntime === 'python' ? ' (detected)' : ''}</option>
                <option value="docker">Docker{detectedRuntime === 'docker' ? ' (detected)' : ''}</option>
                <option value="static">Static{detectedRuntime === 'static' ? ' (detected)' : ''}</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-0.5">App-Port</label>
              <input
                type="number"
                value={appPort}
                onChange={(e) => setAppPort(e.target.value)}
                placeholder="3000"
                className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200 font-mono focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          {/* Branch + Repo-URL */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-0.5">Branch</label>
              <input
                value={branch}
                onChange={(e) => { setBranch(e.target.value); setBranchTouched(true); }}
                placeholder="main"
                className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200 font-mono focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-0.5">Repo-URL (optional)</label>
              <input
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder={defaultRepoUrl ?? 'https://…'}
                className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1.5 text-xs text-gray-200 font-mono focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          {/* v736 — ENV-Stage-Wahl: schreibt project_environments[stage] als .env aufs Target */}
          <div className="border-t border-[#1a1a1a] pt-3 mt-3">
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">🔐 ENV-Injection</div>
            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center gap-1.5 text-[11px] text-gray-300">
                <input type="checkbox" checked={skipEnv} onChange={(e) => setSkipEnv(e.target.checked)} />
                <span>ENV-Injection überspringen</span>
              </label>
              {!skipEnv && (
                <>
                  <label className="text-[11px] text-gray-500">aus Stage:</label>
                  <select
                    value={envStage}
                    onChange={(e) => setEnvStage(e.target.value)}
                    className="bg-[#0d0d0d] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-gray-200"
                  >
                    {Array.from(new Set(['prod', 'staging', 'dev', 'sandbox', ...envStages.map(s => s.stage)])).map(s => {
                      const info = envStages.find(x => x.stage === s);
                      return <option key={s} value={s}>{s}{info ? ` (${info.keyCount} Keys)` : ' (leer)'}</option>;
                    })}
                  </select>
                  <span className="text-[10px] text-gray-500">
                    → wird als <code>.env</code> aufs Target geschrieben (chmod 600)
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* v738 — Deploy-Vorschau */}
        {previewOpen && (() => {
          const stageInfo = envStages.find(s => s.stage === envStage);
          const stageKeys = skipEnv ? 0 : (stageInfo?.keyCount ?? 0);
          // v801 — Bei docker-compose laufen install + build IM Container, nicht auf Host
          const skipHostInstall = processManager === 'docker-compose';
          const installCmd = skipHostInstall ? null
            : runtime === 'node' ? 'npm install'
            : runtime === 'python' ? 'pip install -r requirements.txt'
            : '(none)';
          const buildCmd = skipHostInstall ? null
            : runtime === 'node' ? 'npm run build --if-present'
            : '(none)';
          const startCmd = processManager === 'pm2' ? `pm2 start … --name ${projectName}`
            : processManager === 'docker-compose' ? 'docker compose up -d --build'
            : processManager === 'systemd' ? `systemctl restart ${projectName}.service`
            : '(custom)';
          return (
            <div className="mt-3 p-3 bg-cyan-500/5 border border-cyan-500/30 rounded text-xs space-y-1.5">
              <div className="font-semibold text-cyan-300 mb-2 flex items-center justify-between">
                <span>🔍 Deploy-Vorschau (kein Submit)</span>
                <button onClick={() => setPreviewOpen(false)} className="text-gray-500 hover:text-gray-300">✕</button>
              </div>
              <div className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1 text-[11px]">
                <div className="text-gray-500">Target:</div>
                <div className="text-gray-200 font-mono">{user || 'root'}@{host || '???'}</div>
                <div className="text-gray-500">Project-Dir:</div>
                <div className="text-gray-200 font-mono">/home/{user || 'root'}/{projectName}</div>
                <div className="text-gray-500">Branch:</div>
                <div className="text-gray-200 font-mono">{branch || 'main'}</div>
                {repoUrl && <><div className="text-gray-500">Repo:</div><div className="text-gray-200 font-mono truncate" title={repoUrl}>{repoUrl}</div></>}
                <div className="text-gray-500">Runtime:</div>
                <div className="text-gray-200">{runtime} · {processManager}{appPort ? ` · port ${appPort}` : ''}</div>
                <div className="text-gray-500">ENV-Stage:</div>
                <div className="text-gray-200">
                  {skipEnv ? <span className="text-amber-300">übersprungen (skip_env)</span> :
                    stageKeys > 0
                      ? <><span className="text-emerald-300">{envStage}</span> · {stageKeys} Keys werden als .env (chmod 600)</>
                      : <span className="text-amber-300">{envStage} · keine Keys gesetzt</span>}
                </div>
              </div>
              <div className="pt-2 border-t border-cyan-500/20">
                <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Befehlsabfolge auf Remote</div>
                <ol className="space-y-0.5 text-[11px] list-decimal pl-5">
                  <li className="text-gray-300">SSH-Test zu <code>{user || 'root'}@{host || '???'}</code></li>
                  <li className="text-gray-300">git clone (oder pull) Branch <code>{branch || 'main'}</code></li>
                  {!skipEnv && stageKeys > 0 && (
                    <li className="text-emerald-300">.env-File mit {stageKeys} Keys schreiben (chmod 600)</li>
                  )}
                  {installCmd && <li className="text-gray-300">{installCmd}</li>}
                  {buildCmd && <li className="text-gray-300">{buildCmd}</li>}
                  {skipHostInstall && (
                    <li className="text-gray-500 italic">Host-side install/build übersprungen — Container baut sich selbst</li>
                  )}
                  <li className="text-gray-300">{startCmd}</li>
                </ol>
              </div>
            </div>
          );
        })()}

        {/* Result */}
        {result && (
          <div className={`mt-3 p-3 rounded text-xs ${result.success ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-200' : 'bg-red-500/10 border border-red-500/30 text-red-200'}`}>
            <div className="font-semibold mb-1">{result.success ? '✅ Deploy erfolgreich' : '❌ Deploy fehlgeschlagen'}</div>
            {result.display && <div className="whitespace-pre-wrap text-gray-300">{result.display}</div>}
            {!result.success && result.error && <div className="text-red-300">{result.error}</div>}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-[#222]">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 border border-[#2a2a2a] rounded"
          >Schließen</button>
          {/* v738 — Vorschau-Button */}
          <button
            onClick={() => setPreviewOpen(v => !v)}
            disabled={!host.trim()}
            className="px-3 py-1.5 text-xs text-cyan-300 hover:bg-cyan-500/10 border border-cyan-500/40 rounded disabled:opacity-40"
          >{previewOpen ? '✕ Vorschau schließen' : '🔍 Vorschau'}</button>
          <button
            onClick={submit}
            disabled={!host.trim() || submitting}
            className="px-4 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded font-semibold"
          >{submitting ? '⏳ Deploying…' : '🚀 Deploy starten'}</button>
        </div>
      </div>
    </div>
  );
}
