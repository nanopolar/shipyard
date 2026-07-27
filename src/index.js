import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import multer from 'multer';
import unzipper from 'unzipper';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────

const PORT            = parseInt(process.env.PORT || '3000', 10);
const PASSWORD        = process.env.AGENT_PASSWORD;
const SESSION_SECRET  = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const AGENT_API_KEY   = process.env.AGENT_API_KEY;
const NTFY_TOPIC      = process.env.NTFY_TOPIC || '';
const NTFY_URL        = (process.env.NTFY_URL || 'https://ntfy.sh').replace(/\/$/, '');
const DEPLOYMENTS_DIR = process.env.DEPLOYMENTS_DIR || '/opt/shipyard-agent/deployments';

if (!PASSWORD)      { console.error('FATAL: AGENT_PASSWORD not set'); process.exit(1); }
if (!AGENT_API_KEY) { console.error('FATAL: AGENT_API_KEY not set');  process.exit(1); }

fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
fs.mkdirSync('/tmp/sa-uploads', { recursive: true });

// ── Deploy tracking ───────────────────────────────────────────────────────────

const activeDeployments = new Map();
const deployEmitter = new EventEmitter();
deployEmitter.setMaxListeners(50);

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseEnvFile(content) {
  const vars = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) vars[key] = value;
  }
  return vars;
}

function writeEnvFile(vars) {
  return Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

function safeProjectName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase().replace(/^-+|-+$/g, '');
}

function composeProjectName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getProjectEnvVars(projectName) {
  const deployPath = path.join(DEPLOYMENTS_DIR, projectName);
  const envPath    = path.join(deployPath, '.env');
  const envExPath  = path.join(deployPath, '.env.example');
  let vars = {};
  if (fs.existsSync(envExPath)) vars = parseEnvFile(fs.readFileSync(envExPath, 'utf8'));
  if (fs.existsSync(envPath)) {
    const existing = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
    for (const k of Object.keys(vars))    { if (existing[k] !== undefined) vars[k] = existing[k]; }
    for (const k of Object.keys(existing)){ if (vars[k] === undefined) vars[k] = existing[k]; }
  }
  return vars;
}

async function sendNtfy(title, body, priority = 3, tags = []) {
  if (!NTFY_TOPIC) return;
  const asciiTitle = title.replace(/[^\x00-\x7F]/g, '').trim();
  try {
    await fetch(`${NTFY_URL}/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: {
        'Title':    asciiTitle,
        'Priority': String(priority),
        'Tags':     tags.join(',')
      },
      body
    });
  } catch (err) { console.error('[ntfy] Failed:', err.message); }
}

// ── Core compose runner ───────────────────────────────────────────────────────

function runCompose(project, deployId, args, actionLabel) {
  const deployPath = path.join(DEPLOYMENTS_DIR, project);
  const record = { project, status: 'running', output: '', startedAt: new Date(), endedAt: null, code: null };
  activeDeployments.set(deployId, record);

  const proc = spawn('docker', ['compose', '--project-name', composeProjectName(project), ...args], {
    cwd: deployPath,
    env: { ...process.env, DOCKER_BUILDKIT: '1', COMPOSE_DOCKER_CLI_BUILD: '1' }
  });

  const onData = (chunk) => {
    const text = chunk.toString();
    record.output += text;
    deployEmitter.emit(`log:${deployId}`, text);
  };

  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  proc.on('error', async (err) => {
    const msg = `Failed to start docker: ${err.message}\nIs the Docker socket mounted?\n`;
    record.output += msg;
    record.status  = 'failed';
    record.code    = -1;
    record.endedAt = new Date();
    deployEmitter.emit(`log:${deployId}`, msg);
    deployEmitter.emit(`done:${deployId}`, { success: false, code: -1 });
    await sendNtfy(`❌ ${project} - ${actionLabel} error`, err.message, 5, ['rotating_light']);
  });

  proc.on('close', async (code) => {
    const success  = code === 0;
    record.status  = success ? 'success' : 'failed';
    record.code    = code;
    record.endedAt = new Date();
    deployEmitter.emit(`done:${deployId}`, { success, code });

    const title = success
      ? `✅ ${project} ${actionLabel} succeeded`
      : `❌ ${project} ${actionLabel} failed (exit ${code})`;
    const body = success
      ? `${actionLabel} successful.`
      : `${actionLabel} failed.\n\nLast output:\n${record.output.slice(-600)}`;
    await sendNtfy(title, body, success ? 3 : 5, success ? ['white_check_mark'] : ['rotating_light']);
  });
}

function runDeploy(project, deployId) {
  runCompose(project, deployId, ['up', '--build', '--detach', '--remove-orphans'], 'Deploy');
}

function runStart(project, deployId) {
  runCompose(project, deployId, ['up', '--detach'], 'Start');
}

// ── SSE helper ────────────────────────────────────────────────────────────────

function sseStream(req, res, project, deployId, label) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (type, data) => res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  send('log', `${label} "${project}"...\n\n`);

  deployEmitter.on(`log:${deployId}`, text => send('log', text));
  deployEmitter.once(`done:${deployId}`, ({ success, code }) => {
    send('done', { success, code });
    deployEmitter.removeAllListeners(`log:${deployId}`);
    res.end();
  });
  req.on('close', () => deployEmitter.removeAllListeners(`log:${deployId}`));
}

// ── Express ───────────────────────────────────────────────────────────────────

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true }
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  const wantsJson = req.headers.accept?.includes('application/json')
    || req.headers.accept?.includes('text/event-stream') || req.xhr;
  if (wantsJson) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!key) return res.status(401).json({ error: 'Missing API key' });
  const valid = key.length === AGENT_API_KEY.length &&
    crypto.timingSafeEqual(Buffer.from(key), Buffer.from(AGENT_API_KEY));
  if (!valid) return res.status(403).json({ error: 'Invalid API key' });
  next();
}

const upload = multer({
  storage: multer.diskStorage({
    destination: '/tmp/sa-uploads',
    filename: (_req, _file, cb) => cb(null, `upload-${Date.now()}.zip`)
  }),
  limits: { fileSize: 200 * 1024 * 1024 }
});

// ── Auth ──────────────────────────────────────────────────────────────────────

app.get('/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const given = (req.body.password || '').trim();
  const valid = given.length > 0 &&
    crypto.timingSafeEqual(Buffer.from(given.padEnd(128)), Buffer.from(PASSWORD.padEnd(128)));
  if (valid) { req.session.authenticated = true; return res.redirect('/'); }
  res.redirect('/login?error=1');
});

app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

// ── UI ────────────────────────────────────────────────────────────────────────

app.get('/', requireAuth, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

// ── API: Projects list ────────────────────────────────────────────────────────

app.get('/api/projects', requireAuth, (_req, res) => {
  try {
    const projects = fs.readdirSync(DEPLOYMENTS_DIR)
      .filter(name => {
        const p = path.join(DEPLOYMENTS_DIR, name);
        return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'docker-compose.yml'));
      })
      .map(name => ({
        name,
        hasEnv: fs.existsSync(path.join(DEPLOYMENTS_DIR, name, '.env')),
        hasEnvExample: fs.existsSync(path.join(DEPLOYMENTS_DIR, name, '.env.example'))
      }));
    res.json(projects);
  } catch { res.json([]); }
});

// ── API: Project status ───────────────────────────────────────────────────────

app.get('/api/projects/:project/status', requireAuth, (req, res) => {
  const { project } = req.params;
  const deployPath = path.join(DEPLOYMENTS_DIR, project);
  if (!fs.existsSync(deployPath)) return res.status(404).json({ error: 'Not found' });

  const proc = spawn('docker', [
    'compose', '--project-name', composeProjectName(project),
    'ps', '--status', 'running', '-q'
  ], { cwd: deployPath, env: process.env });

  let output = '';
  proc.stdout.on('data', d => output += d.toString());
  proc.stderr.on('data', () => {});
  proc.on('close', () => res.json({ running: output.trim().length > 0 }));
  proc.on('error', ()  => res.json({ running: false }));
});

// ── API: Stop project ─────────────────────────────────────────────────────────

app.post('/api/projects/:project/stop', requireAuth, (req, res) => {
  const { project } = req.params;
  const deployPath = path.join(DEPLOYMENTS_DIR, project);
  if (!fs.existsSync(deployPath)) return res.status(404).json({ error: 'Not found' });

  const proc = spawn('docker', [
    'compose', '--project-name', composeProjectName(project), 'down'
  ], { cwd: deployPath, env: process.env });

  let output = '';
  proc.stdout.on('data', d => output += d.toString());
  proc.stderr.on('data', d => output += d.toString());
  proc.on('close', code => code === 0
    ? res.json({ ok: true })
    : res.status(500).json({ error: output || `Exit ${code}` })
  );
  proc.on('error', err => res.status(500).json({ error: err.message }));
});

// ── API: Start project (SSE, no rebuild) ─────────────────────────────────────

app.get('/api/start/:project', requireAuth, (req, res) => {
  const { project } = req.params;
  const deployPath = path.join(DEPLOYMENTS_DIR, project);
  if (!fs.existsSync(deployPath)) return res.status(404).end();
  const deployId = crypto.randomUUID();
  runStart(project, deployId);
  sseStream(req, res, project, deployId, '▶️  Starting');
});

// ── API: Deploy project (SSE, with rebuild) ───────────────────────────────────

app.get('/api/deploy/:project', requireAuth, (req, res) => {
  const { project } = req.params;
  const deployPath = path.join(DEPLOYMENTS_DIR, project);
  if (!fs.existsSync(deployPath)) return res.status(404).end();
  const deployId = crypto.randomUUID();
  runDeploy(project, deployId);
  sseStream(req, res, project, deployId, '🚀  Deploying');
});

// ── API: Remove project ───────────────────────────────────────────────────────

app.delete('/api/projects/:project', requireAuth, async (req, res) => {
  const { project } = req.params;
  const deployPath = path.join(DEPLOYMENTS_DIR, project);
  if (!fs.existsSync(deployPath)) return res.status(404).json({ error: 'Not found' });

  // Stop first - ignore errors (might not be running)
  await new Promise(resolve => {
    const proc = spawn('docker', [
      'compose', '--project-name', composeProjectName(project), 'down'
    ], { cwd: deployPath, env: process.env });
    proc.on('close', resolve);
    proc.on('error', resolve);
  });

  try {
    fs.rmSync(deployPath, { recursive: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Deploy status by ID ──────────────────────────────────────────────────

app.get('/api/deploys/:deployId', requireAuth, (req, res) => {
  const record = activeDeployments.get(req.params.deployId);
  if (!record) return res.status(404).json({ error: 'Deploy not found.' });
  res.json(record);
});

// ── API: Upload zip ───────────────────────────────────────────────────────────

app.post('/api/upload', requireAuth, upload.single('artifact'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  const extractDir = `/tmp/sa-extract-${Date.now()}`;
  fs.mkdirSync(extractDir, { recursive: true });
  try {
    const directory = await unzipper.Open.file(req.file.path);
    for (const file of directory.files) {
      const destPath = path.join(extractDir, file.path);
      if (file.type === 'Directory') { fs.mkdirSync(destPath, { recursive: true }); continue; }
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      await new Promise((resolve, reject) => {
        file.stream().pipe(fs.createWriteStream(destPath)).on('finish', resolve).on('error', reject);
      });
    }
    const entries = fs.readdirSync(extractDir);
    const folderName = entries.find(e => fs.statSync(path.join(extractDir, e)).isDirectory());
    if (!folderName) throw new Error('No folder found inside the zip.');
    const srcPath = path.join(extractDir, folderName);
    if (!fs.existsSync(path.join(srcPath, 'docker-compose.yml')))
      throw new Error('No docker-compose.yml found inside the project folder.');
    const projectName = safeProjectName(folderName);
    const deployPath  = path.join(DEPLOYMENTS_DIR, projectName);

    // Save existing .env before wiping - restored after copy so values
    // survive a redeploy. New keys from .env.example are added as empty defaults.
    const existingEnvPath = path.join(deployPath, '.env');
    const savedEnv = fs.existsSync(existingEnvPath)
      ? fs.readFileSync(existingEnvPath, 'utf8')
      : null;

    if (fs.existsSync(deployPath)) fs.rmSync(deployPath, { recursive: true });
    fs.cpSync(srcPath, deployPath, { recursive: true });

    if (savedEnv !== null) {
      fs.writeFileSync(path.join(deployPath, '.env'), savedEnv);
    }

    res.json({ projectName, vars: getProjectEnvVars(projectName) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.unlinkSync(req.file.path); } catch {}
    try { fs.rmSync(extractDir, { recursive: true }); } catch {}
  }
});

// ── API: Env vars ─────────────────────────────────────────────────────────────

app.get('/api/projects/:project/env', requireAuth, (req, res) => {
  const deployPath = path.join(DEPLOYMENTS_DIR, req.params.project);
  if (!fs.existsSync(deployPath)) return res.status(404).json({ error: 'Not found.' });
  res.json({ vars: getProjectEnvVars(req.params.project) });
});

app.post('/api/projects/:project/env', requireAuth, (req, res) => {
  const deployPath = path.join(DEPLOYMENTS_DIR, req.params.project);
  if (!fs.existsSync(deployPath)) return res.status(404).json({ error: 'Not found.' });
  fs.writeFileSync(path.join(deployPath, '.env'), writeEnvFile(req.body.vars || {}));
  res.json({ ok: true });
});

// ── MCP Server ────────────────────────────────────────────────────────────────

const mcpServer = new McpServer({ name: 'shipyard', version: '2.0.0' });

mcpServer.tool(
  'deploy_project',
  'Write project files to the server and deploy via docker compose. ' +
  'Pass every file in the project. Returns immediately - deploy runs in background.',
  {
    project_name: z.string().describe('Project name - lowercase, hyphens ok.'),
    files: z.array(z.object({
      path: z.string().describe('Relative file path e.g. "docker-compose.yml"'),
      content: z.string().describe('Full file content')
    })).describe('All project files. Must include docker-compose.yml at the root.'),
    env_vars: z.record(z.string()).optional()
      .describe('Known env var values. Omit secrets - user configures those in the UI.')
  },
  async ({ project_name, files, env_vars = {} }) => {
    const name = safeProjectName(project_name);
    if (!name) return { content: [{ type: 'text', text: 'Invalid project name.' }] };
    if (!files.some(f => f.path === 'docker-compose.yml'))
      return { content: [{ type: 'text', text: 'No docker-compose.yml in files list.' }] };

    const deployPath = path.join(DEPLOYMENTS_DIR, name);
    if (fs.existsSync(deployPath)) fs.rmSync(deployPath, { recursive: true });
    for (const file of files) {
      const filePath = path.join(deployPath, file.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, file.content, 'utf8');
    }

    const vars = getProjectEnvVars(name);
    for (const [k, v] of Object.entries(env_vars)) { vars[k] = v; }
    fs.writeFileSync(path.join(deployPath, '.env'), writeEnvFile(vars));

    const unset = Object.entries(vars).filter(([, v]) => !v).map(([k]) => k);
    const deployId = crypto.randomUUID();
    runDeploy(name, deployId);

    return { content: [{ type: 'text', text: [
      `✅ Files written and deployment started for **${name}**.`,
      `Deploy ID: \`${deployId}\``,
      '',
      unset.length > 0
        ? `⚠️  Unset env vars: ${unset.map(k => `\`${k}\``).join(', ')} - configure in Shipyard UI.`
        : '✅ All environment variables configured.',
      '',
      `You'll receive an ntfy notification on completion.`
    ].join('\n') }] };
  }
);

mcpServer.tool(
  'list_projects',
  'List all projects on Shipyard with their env var configuration status.',
  {},
  async () => {
    let projects = [];
    try {
      projects = fs.readdirSync(DEPLOYMENTS_DIR).filter(name => {
        const p = path.join(DEPLOYMENTS_DIR, name);
        return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'docker-compose.yml'));
      });
    } catch {}
    if (!projects.length) return { content: [{ type: 'text', text: 'No projects deployed yet.' }] };
    const lines = projects.map(name => {
      const hasEnv = fs.existsSync(path.join(DEPLOYMENTS_DIR, name, '.env'));
      const vars   = getProjectEnvVars(name);
      const unset  = Object.entries(vars).filter(([, v]) => !v).map(([k]) => k);
      const status = !hasEnv ? '⚠️  no .env'
        : unset.length > 0 ? `⚠️  unset: ${unset.join(', ')}`
        : '✅ configured';
      return `• **${name}** - ${status}`;
    });
    return { content: [{ type: 'text', text: `Projects:\n\n${lines.join('\n')}` }] };
  }
);

mcpServer.tool(
  'update_env',
  'Update environment variables for an existing project, then optionally restart it.',
  {
    project_name: z.string(),
    env_vars: z.record(z.string()),
    restart: z.boolean().optional().describe('Restart containers with new env vars (no rebuild). Default false.')
  },
  async ({ project_name, env_vars, restart = false }) => {
    const name = safeProjectName(project_name);
    const deployPath = path.join(DEPLOYMENTS_DIR, name);
    if (!fs.existsSync(deployPath))
      return { content: [{ type: 'text', text: `Project "${name}" not found.` }] };
    const vars = getProjectEnvVars(name);
    for (const [k, v] of Object.entries(env_vars)) { vars[k] = v; }
    fs.writeFileSync(path.join(deployPath, '.env'), writeEnvFile(vars));
    if (!restart) return { content: [{ type: 'text', text: `Env vars updated for "${name}".` }] };
    const deployId = crypto.randomUUID();
    runStart(name, deployId);
    return { content: [{ type: 'text', text: `Env vars updated and restart started for "${name}".\nDeploy ID: \`${deployId}\`` }] };
  }
);

mcpServer.tool(
  'get_deploy_status',
  'Check the status of a deployment by its deploy ID.',
  { deploy_id: z.string() },
  async ({ deploy_id }) => {
    const record = activeDeployments.get(deploy_id);
    if (!record) return { content: [{ type: 'text', text: 'Deploy ID not found (may be from a previous server session).' }] };
    const duration = record.endedAt
      ? `${Math.round((record.endedAt - record.startedAt) / 1000)}s`
      : `${Math.round((Date.now() - record.startedAt) / 1000)}s elapsed`;
    const statusLine = record.status === 'running' ? `🔄 Running (${duration})`
      : record.status === 'success' ? `✅ Succeeded (${duration})`
      : `❌ Failed with exit code ${record.code} (${duration})`;
    return { content: [{ type: 'text', text:
      `**${record.project}** - ${statusLine}\n\nRecent output:\n\`\`\`\n${record.output.slice(-800)}\n\`\`\``
    }] };
  }
);

// ── MCP SSE transport ─────────────────────────────────────────────────────────

const mcpTransports = {};

app.get('/mcp/sse', requireApiKey, async (req, res) => {
  const transport = new SSEServerTransport('/mcp/messages', res);
  mcpTransports[transport.sessionId] = transport;
  res.on('close', () => delete mcpTransports[transport.sessionId]);
  await mcpServer.connect(transport);
});

app.post('/mcp/messages', requireApiKey, async (req, res) => {
  const transport = mcpTransports[req.query.sessionId];
  if (!transport) return res.status(404).json({ error: 'No active MCP session.' });
  await transport.handlePostMessage(req, res);
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Shipyard v2 on :${PORT}`);
  console.log(`Deployments: ${DEPLOYMENTS_DIR}`);
  console.log(`MCP: http://localhost:${PORT}/mcp/sse`);
  console.log(`ntfy: ${NTFY_TOPIC ? `${NTFY_URL}/${NTFY_TOPIC}` : 'disabled'}`);
});
