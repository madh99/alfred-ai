import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { exec } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { ConfigLoader } from '@alfred/config';

const REDIRECT_URI = 'http://localhost:3000/callback';
const SCOPES = [
  'offline_access',
  'Mail.Read', 'Mail.ReadWrite', 'Mail.Send',
  'Contacts.Read', 'Contacts.ReadWrite',
  'Calendars.Read', 'Calendars.ReadWrite',
  'Tasks.ReadWrite',
].join(' ');

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Alfred — Auth erfolgreich</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0d1117;color:#e6edf3}
.card{text-align:center;padding:2rem;border:1px solid #30363d;border-radius:12px;background:#161b22}
h1{color:#3fb950;margin-bottom:.5rem}p{color:#8b949e}</style></head>
<body><div class="card"><h1>Authentifizierung erfolgreich!</h1><p>Du kannst dieses Fenster schliessen und zum Terminal zurückkehren.</p></div></body></html>`;

interface Credentials {
  clientId: string;
  clientSecret: string;
  tenantId: string;
}

async function askQuestion(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function resolveCredentials(): Partial<Credentials> {
  const result: Partial<Credentials> = {};

  // Try loading from config
  try {
    const loader = new ConfigLoader();
    const config = loader.loadConfig() as unknown as Record<string, unknown>;
    // Check email.microsoft, calendar.microsoft, contacts.microsoft
    for (const section of ['email', 'calendar', 'contacts']) {
      const sectionObj = config[section] as Record<string, unknown> | undefined;
      if (!sectionObj) continue;
      const ms = sectionObj['microsoft'] as Record<string, string> | undefined;
      if (!ms) continue;
      if (!result.clientId && ms.clientId) result.clientId = ms.clientId;
      if (!result.clientSecret && ms.clientSecret) result.clientSecret = ms.clientSecret;
      if (!result.tenantId && ms.tenantId) result.tenantId = ms.tenantId;
    }
    // Check todo (flat keys, no nested 'microsoft' sub-object)
    const todo = config['todo'] as Record<string, string> | undefined;
    if (todo) {
      if (!result.clientId && todo.clientId) result.clientId = todo.clientId;
      if (!result.clientSecret && todo.clientSecret) result.clientSecret = todo.clientSecret;
      if (!result.tenantId && todo.tenantId) result.tenantId = todo.tenantId;
    }
    // Also check email.accounts[].microsoft
    const email = config['email'] as Record<string, unknown> | undefined;
    if (email?.accounts && Array.isArray(email.accounts)) {
      for (const acct of email.accounts as Array<Record<string, unknown>>) {
        const ms = acct['microsoft'] as Record<string, string> | undefined;
        if (!ms) continue;
        if (!result.clientId && ms.clientId) result.clientId = ms.clientId;
        if (!result.clientSecret && ms.clientSecret) result.clientSecret = ms.clientSecret;
        if (!result.tenantId && ms.tenantId) result.tenantId = ms.tenantId;
      }
    }
  } catch { /* config not available */ }

  // ENV overrides — check multiple prefixes
  const prefixes = [
    'ALFRED_MICROSOFT_EMAIL',
    'ALFRED_MICROSOFT_CALENDAR',
    'ALFRED_MICROSOFT_CONTACTS',
    'ALFRED_MICROSOFT_TODO',
  ];
  for (const prefix of prefixes) {
    if (!result.clientId) result.clientId = process.env[`${prefix}_CLIENT_ID`];
    if (!result.clientSecret) result.clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
    if (!result.tenantId) result.tenantId = process.env[`${prefix}_TENANT_ID`];
  }

  return result;
}

async function ensureCredentials(): Promise<Credentials> {
  const partial = resolveCredentials();

  const clientId = partial.clientId || await askQuestion('  Client ID: ');
  const clientSecret = partial.clientSecret || await askQuestion('  Client Secret: ');
  const tenantId = partial.tenantId || await askQuestion('  Tenant ID (oder "common"): ');

  if (!clientId || !clientSecret || !tenantId) {
    console.error('Fehler: Client ID, Client Secret und Tenant ID werden benötigt.');
    process.exit(1);
  }

  return { clientId, clientSecret, tenantId };
}

function buildAuthUrl(creds: Credentials): string {
  const params = new URLSearchParams({
    client_id: creds.clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    response_mode: 'query',
    scope: SCOPES,
    prompt: 'consent',
  });
  return `https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/authorize?${params}`;
}

async function exchangeCode(code: string, creds: Credentials): Promise<string> {
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    code,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
    scope: SCOPES,
  });

  const res = await fetch(
    `https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token-Austausch fehlgeschlagen (${res.status}): ${text}`);
  }

  const data = await res.json() as { refresh_token?: string };
  if (!data.refresh_token) {
    throw new Error('Kein Refresh Token in der Antwort. Stelle sicher, dass "offline_access" als Scope erlaubt ist.');
  }
  return data.refresh_token;
}

function openBrowser(url: string): void {
  const cmds: Record<string, string> = {
    win32: `start "" "${url}"`,
    darwin: `open "${url}"`,
    linux: `xdg-open "${url}"`,
  };
  const cmd = cmds[process.platform];
  if (cmd) exec(cmd, () => { /* ignore errors */ });
}

function updateEnvFile(creds: Credentials, refreshToken: string): void {
  const envPath = resolve(process.cwd(), '.env');
  let lines: string[] = [];
  if (existsSync(envPath)) {
    lines = readFileSync(envPath, 'utf-8').split('\n');
  }

  // Keys to set: provider flags + same credentials for email, calendar, contacts
  const entries: Record<string, string> = {
    ALFRED_EMAIL_PROVIDER: 'microsoft',
    ALFRED_CALENDAR_PROVIDER: 'microsoft',
    ALFRED_CONTACTS_PROVIDER: 'microsoft',
    ALFRED_MICROSOFT_EMAIL_CLIENT_ID: creds.clientId,
    ALFRED_MICROSOFT_EMAIL_CLIENT_SECRET: creds.clientSecret,
    ALFRED_MICROSOFT_EMAIL_TENANT_ID: creds.tenantId,
    ALFRED_MICROSOFT_EMAIL_REFRESH_TOKEN: refreshToken,
    ALFRED_MICROSOFT_CALENDAR_CLIENT_ID: creds.clientId,
    ALFRED_MICROSOFT_CALENDAR_CLIENT_SECRET: creds.clientSecret,
    ALFRED_MICROSOFT_CALENDAR_TENANT_ID: creds.tenantId,
    ALFRED_MICROSOFT_CALENDAR_REFRESH_TOKEN: refreshToken,
    ALFRED_MICROSOFT_CONTACTS_CLIENT_ID: creds.clientId,
    ALFRED_MICROSOFT_CONTACTS_CLIENT_SECRET: creds.clientSecret,
    ALFRED_MICROSOFT_CONTACTS_TENANT_ID: creds.tenantId,
    ALFRED_MICROSOFT_CONTACTS_REFRESH_TOKEN: refreshToken,
    ALFRED_MICROSOFT_TODO_CLIENT_ID: creds.clientId,
    ALFRED_MICROSOFT_TODO_CLIENT_SECRET: creds.clientSecret,
    ALFRED_MICROSOFT_TODO_TENANT_ID: creds.tenantId,
    ALFRED_MICROSOFT_TODO_REFRESH_TOKEN: refreshToken,
  };

  const remaining = new Set(Object.keys(entries));

  // Update existing lines (including commented-out ones like "# KEY=value")
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^#?\s*([A-Z_]+)=/);
    if (match && remaining.has(match[1])) {
      lines[i] = `${match[1]}=${entries[match[1]]}`;
      remaining.delete(match[1]);
    }
  }

  // Append missing keys
  if (remaining.size > 0) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    for (const key of remaining) {
      lines.push(`${key}=${entries[key]}`);
    }
  }

  // Ensure trailing newline so appended keys don't glue to the last line
  const content = lines.join('\n').replace(/\n*$/, '\n');
  writeFileSync(envPath, content);
}

function waitForCallback(creds: Credentials): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://localhost:3000`);
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>Fehler: ${error}</h1><p>${url.searchParams.get('error_description') ?? ''}</p>`);
        server.close();
        reject(new Error(`OAuth-Fehler: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Fehler: Kein Auth-Code erhalten</h1>');
        return;
      }

      try {
        const refreshToken = await exchangeCode(code, creds);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(SUCCESS_HTML);
        server.close();
        resolve(refreshToken);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>Fehler beim Token-Austausch</h1><p>${(err as Error).message}</p>`);
        server.close();
        reject(err);
      }
    });

    server.listen(3000, () => {
      console.log('  Callback-Server gestartet auf http://localhost:3000');
    });

    server.on('error', (err) => {
      reject(new Error(`Server konnte nicht gestartet werden: ${err.message}`));
    });
  });
}

export async function authCommand(provider: string): Promise<void> {
  if (!provider) {
    console.error('Usage: alfred auth <provider>');
    console.error('  Unterstützte Provider: microsoft');
    process.exit(1);
  }

  if (provider !== 'microsoft') {
    console.error(`Unbekannter Provider: ${provider}`);
    console.error('  Unterstützte Provider: microsoft');
    process.exit(1);
  }

  console.log('');
  console.log('  Microsoft 365 OAuth — Automatischer Token-Flow');
  console.log('  ================================================');
  console.log('');

  const creds = await ensureCredentials();

  const authUrl = buildAuthUrl(creds);
  console.log('');
  console.log('  Öffne diese URL im Browser:');
  console.log(`  ${authUrl}`);
  console.log('');

  openBrowser(authUrl);

  try {
    const refreshToken = await waitForCallback(creds);
    console.log('');
    console.log('  Refresh Token erhalten! Schreibe in .env ...');
    updateEnvFile(creds, refreshToken);
    console.log('  .env aktualisiert (Email, Calendar, Contacts, To Do).');
    console.log('');
    console.log('  Fertig! Du kannst Alfred jetzt mit Microsoft 365 nutzen.');
    console.log('');
  } catch (err) {
    console.error(`\n  Fehler: ${(err as Error).message}`);
    process.exit(1);
  }

  process.exit(0);
}
