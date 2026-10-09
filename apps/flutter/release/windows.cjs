#!/usr/bin/env node
/**
 * Phase 4 M6 — Windows-Release der Alfred-App: bauen, signieren (Azure Key Vault über AzureSignTool), Inno-Setup
 * packen, Setup signieren, Prüfsumme schreiben, auf den Alfred-Server in data/app-releases/windows/ legen.
 *
 *   node release/windows.cjs            komplette Kette
 *   node release/windows.cjs --kein-upload
 *   node release/windows.cjs --nur-signieren   (bereits gebaute Dateien signieren und packen)
 *
 * Zugangsdaten in apps/flutter/.env.release (gitignored; Vorlage: F:/sources/eda/eda-billing/.env.release.example):
 *   AZURE_KEY_VAULT_URL, AZURE_KEY_VAULT_CERT_NAME, AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
 * Werkzeuge: tools/AzureSignTool-x64.exe (gitignored), Inno Setup 6 (ISCC.exe), Flutter im PATH.
 */
const { execFileSync, spawnSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync, readdirSync, statSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');

const APP = path.resolve(__dirname, '..');
const BUNDLE = path.join(APP, 'build', 'windows', 'x64', 'runner', 'Release');
const AUSGABE = path.join(APP, 'build', 'installer');
const SERVER = process.env.ALFRED_RELEASE_SERVER || 'madh@192.168.1.92';
const ZIEL = '/root/alfred/data/app-releases/windows';
const args = new Set(process.argv.slice(2));

function env() {
  const f = path.join(APP, '.env.release');
  if (!existsSync(f)) throw new Error('.env.release fehlt (Zugangsdaten für den Key Vault)');
  for (const z of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(z.trim()); if (!m || z.trim().startsWith('#')) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  for (const k of ['AZURE_KEY_VAULT_URL', 'AZURE_KEY_VAULT_CERT_NAME', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']) if (!process.env[k]) throw new Error(`${k} fehlt in .env.release`);
}
function version() {
  const m = /^version:\s*([0-9]+\.[0-9]+\.[0-9]+)/m.exec(readFileSync(path.join(APP, 'pubspec.yaml'), 'utf8'));
  if (!m) throw new Error('version in pubspec.yaml nicht gefunden');
  return m[1];
}
function werkzeug(kandidaten, name) {
  const t = kandidaten.find(p => existsSync(p));
  if (!t) throw new Error(`${name} nicht gefunden: ${kandidaten.join(' | ')}`);
  return t;
}
function signiere(dateien) {
  const tool = werkzeug([path.join(APP, 'tools', 'AzureSignTool-x64.exe'), path.join(APP, 'tools', 'AzureSignTool.exe')], 'AzureSignTool');
  const a = ['sign', '-kvu', process.env.AZURE_KEY_VAULT_URL, '-kvc', process.env.AZURE_KEY_VAULT_CERT_NAME, '-kvt', process.env.AZURE_TENANT_ID, '-kvi', process.env.AZURE_CLIENT_ID, '-kvs', process.env.AZURE_CLIENT_SECRET,
    '-tr', 'http://timestamp.digicert.com', '-td', 'sha256', '-fd', 'sha256', '-d', 'Alfred', '-du', 'https://alfred.lokalkraft.at', ...dateien];
  const r = spawnSync(tool, a, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`AzureSignTool: ${(r.stderr || r.stdout || '').split('\n').filter(l => !/secret/i.test(l)).slice(-6).join('\n')}`);
  console.log(`signiert: ${dateien.length} Datei(en) (AzureSignTool Exit 0)`);
}
function sha256(f) { return createHash('sha256').update(readFileSync(f)).digest('hex'); }

(function main() {
  const v = version();
  console.log(`Alfred ${v} — Windows-Release`);
  if (!args.has('--nur-signieren')) {
    console.log('flutter build windows --release …');
    execFileSync('flutter', ['build', 'windows', '--release'], { cwd: APP, stdio: 'inherit', shell: true });
  }
  if (!existsSync(path.join(BUNDLE, 'Alfred.exe'))) throw new Error('Alfred.exe fehlt im Bundle');
  env();
  const exes = readdirSync(BUNDLE).filter(f => /\.(exe|dll)$/i.test(f) && !/^flutter_windows\.dll$/i.test(f)).map(f => path.join(BUNDLE, f));
  signiere(exes);
  const iscc = werkzeug([path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'), 'C:/Program Files (x86)/Inno Setup 6/ISCC.exe'], 'Inno Setup (ISCC.exe)');
  console.log('Inno Setup …');
  execFileSync(iscc, [`/DVersion=${v}`, `/DQuelle=${BUNDLE}`, '/Qp', path.join(__dirname, 'alfred.iss')], { stdio: 'inherit' });
  const setup = path.join(AUSGABE, `Alfred-${v}-setup.exe`);
  if (!existsSync(setup)) throw new Error(`Setup fehlt: ${setup}`);
  signiere([setup]);
  const sha = sha256(setup);
  writeFileSync(`${setup}.sha256`, `${sha}  ${path.basename(setup)}\n`);
  console.log(`${path.basename(setup)}  ${(statSync(setup).size / 1024 / 1024).toFixed(1)} MB  sha256 ${sha.slice(0, 16)}…`);
  if (args.has('--kein-upload')) return;
  console.log(`Upload → ${SERVER}:${ZIEL}`);
  execFileSync('scp', ['-q', setup, `${setup}.sha256`, `${SERVER}:/tmp/`], { stdio: 'inherit' });
  const b = path.basename(setup);
  execFileSync('ssh', [SERVER, `sudo mkdir -p ${ZIEL} && sudo mv /tmp/${b} /tmp/${b}.sha256 ${ZIEL}/ && ls -la ${ZIEL}/${b}`], { stdio: 'inherit' });
  console.log('fertig — der Server meldet die Version beim nächsten Abruf von /api/app/update?plattform=windows');
})();
