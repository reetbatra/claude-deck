#!/usr/bin/env node
/**
 * Claude Deck — local dashboard for Claude Code.
 * Zero dependencies: Node 18+ built-ins only.
 *
 *   node server.js [--open] [--port 4747]
 *
 * Reads (never writes) ~/.claude/projects session transcripts and
 * ~/.claude/skills. Runs skills/automations by spawning `claude -p`.
 * Binds to 127.0.0.1 only.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');

const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const SKILLS_DIR = path.join(CLAUDE_DIR, 'skills');
const DECK_DIR = __dirname;
const PUBLIC_DIR = path.join(DECK_DIR, 'public');
const DATA_DIR = path.join(DECK_DIR, 'data');
const RUNS_DIR = path.join(DATA_DIR, 'runs');
const CACHE_FILE = path.join(DATA_DIR, 'session-cache.json');
const AUTOMATIONS_FILE = path.join(DATA_DIR, 'automations.json');
const CLOUD_FILE = path.join(DATA_DIR, 'cloud.json');

const argv = process.argv.slice(2);
const PORT = Number(argv[argv.indexOf('--port') + 1]) || 4747;
const OPEN_BROWSER = argv.includes('--open');
const RUN_TIMEOUT_MS = 20 * 60 * 1000;

fs.mkdirSync(RUNS_DIR, { recursive: true });

/* ---------------------------------------------------------------- claude bin */

function findClaudeBin() {
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  const candidates = [
    path.join(HOME, '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try {
    return execFileSync('/bin/zsh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim() || 'claude';
  } catch {
    return 'claude';
  }
}
const CLAUDE_BIN = findClaudeBin();

/* ------------------------------------------------------------- session index */

// cache: { [relPath]: { mtimeMs, size, data } }
let sessionCache = {};
try { sessionCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { /* fresh */ }

let saveCacheTimer = null;
function saveCacheSoon() {
  clearTimeout(saveCacheTimer);
  saveCacheTimer = setTimeout(() => {
    fsp.writeFile(CACHE_FILE, JSON.stringify(sessionCache)).catch(() => {});
  }, 2000);
}

function decodeProjectDir(dirName) {
  // "-Users-reet-Developer-nudge" -> "/Users/reet/Developer/nudge" (best effort;
  // the cwd field parsed from the transcript is authoritative when present)
  return dirName.replace(/-/g, '/');
}

function firstTextOfUserLine(obj) {
  const c = obj.message && obj.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    for (const b of c) if (b && b.type === 'text' && typeof b.text === 'string') return b.text;
  }
  return null;
}

function isRealUserPrompt(obj, text) {
  if (obj.isMeta || obj.isSidechain) return false;
  if (text == null) return false;
  const t = text.trim();
  if (!t) return false;
  if (t.startsWith('<local-command-caveat>')) return false;
  if (t.startsWith('<local-command-stdout>')) return false;
  if (t.startsWith('<system-reminder>')) return false;
  if (t.startsWith('<command-message>')) return false;
  if (t.startsWith('Caveat:')) return false;
  if (t.startsWith('[Request interrupted')) return false;
  if (t.startsWith('[SYSTEM NOTIFICATION')) return false;      // background task events
  if (t.startsWith('<task-notification>')) return false;
  if (t.startsWith('Base directory for this skill')) return false; // injected skill content
  return true;
}

const BUILTIN_COMMANDS = new Set(['/model', '/login', '/logout', '/clear', '/compact', '/config', '/help', '/exit', '/status', '/cost', '/doctor', '/init', '/memory', '/resume', '/fast']);

function extractCommand(text) {
  const m = /<command-name>([^<]+)<\/command-name>/.exec(text || '');
  return m ? m[1].trim() : null;
}

// background/plumbing session dirs that would pollute the report
function isNoiseProjectDir(dirName) {
  return /observer-sessions|claude-worktrees/.test(dirName);
}

async function parseSessionFile(absPath) {
  const data = {
    firstPrompt: null,
    startTs: null,
    endTs: null,
    cwd: null,
    gitBranch: null,
    userMsgs: 0,
    assistantMsgs: 0,
    toolCalls: 0,
    skills: [],
    version: null,
  };
  const skills = new Set();
  const stream = fs.createReadStream(absPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.timestamp) {
      if (!data.startTs) data.startTs = obj.timestamp;
      data.endTs = obj.timestamp;
    }
    if (obj.cwd && !data.cwd) data.cwd = obj.cwd;
    if (obj.gitBranch && !data.gitBranch) data.gitBranch = obj.gitBranch;
    if (obj.version && !data.version) data.version = obj.version;

    if (obj.type === 'user' && obj.message) {
      const text = firstTextOfUserLine(obj);
      const cmd = extractCommand(text);
      if (cmd && !BUILTIN_COMMANDS.has(cmd)) skills.add(cmd);
      if (isRealUserPrompt(obj, text)) {
        data.userMsgs++;
        if (!data.firstPrompt) {
          data.firstPrompt = cmd
            ? `Ran ${cmd}`
            : text.trim().slice(0, 200);
        }
      }
    } else if (obj.type === 'assistant' && obj.message && !obj.isSidechain) {
      data.assistantMsgs++;
      const c = obj.message.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b && b.type === 'tool_use') {
            data.toolCalls++;
            if (b.name === 'Skill' && b.input && b.input.skill) skills.add('/' + String(b.input.skill).replace(/^\//, ''));
          }
        }
      }
    }
  }
  data.skills = [...skills];
  return data;
}

async function getSessionIndex() {
  const out = [];
  let dirs = [];
  try { dirs = await fsp.readdir(PROJECTS_DIR); } catch { return out; }
  for (const dir of dirs) {
    if (isNoiseProjectDir(dir)) continue;
    const dirAbs = path.join(PROJECTS_DIR, dir);
    let files;
    try { files = await fsp.readdir(dirAbs); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const rel = path.join(dir, f);
      const abs = path.join(dirAbs, f);
      let st;
      try { st = await fsp.stat(abs); } catch { continue; }
      let entry = sessionCache[rel];
      if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
        let parsed;
        try { parsed = await parseSessionFile(abs); } catch { continue; }
        entry = { mtimeMs: st.mtimeMs, size: st.size, data: parsed };
        sessionCache[rel] = entry;
        saveCacheSoon();
      }
      const d = entry.data;
      // skip empty shells (no real prompt and nearly no content)
      if (!d.firstPrompt && d.assistantMsgs === 0) continue;
      out.push({
        id: rel,
        sessionId: path.basename(f, '.jsonl'),
        project: d.cwd || decodeProjectDir(dir),
        projectName: path.basename(d.cwd || decodeProjectDir(dir)) || 'home',
        title: d.firstPrompt || '(no prompt recorded)',
        startTs: d.startTs,
        endTs: d.endTs,
        userMsgs: d.userMsgs,
        assistantMsgs: d.assistantMsgs,
        toolCalls: d.toolCalls,
        skills: d.skills,
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/* ----------------------------------------------------------------- transcript */

async function readTranscript(relPath) {
  const abs = path.resolve(PROJECTS_DIR, relPath);
  if (!abs.startsWith(PROJECTS_DIR + path.sep)) throw new Error('bad path');
  const messages = [];
  let skippedSidechain = 0;
  const stream = fs.createReadStream(abs, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.isSidechain) { skippedSidechain++; continue; }
    if (obj.type === 'user' && obj.message && !obj.isMeta) {
      const text = firstTextOfUserLine(obj);
      const cmd = extractCommand(text);
      if (cmd) {
        const argsM = /<command-args>([^<]*)<\/command-args>/.exec(text || '');
        messages.push({ role: 'command', ts: obj.timestamp, text: cmd + (argsM && argsM[1] ? ' ' + argsM[1] : '') });
      } else if (isRealUserPrompt(obj, text)) {
        messages.push({ role: 'user', ts: obj.timestamp, text: text.trim() });
      }
    } else if (obj.type === 'assistant' && obj.message) {
      const c = obj.message.content;
      let text = '';
      const tools = [];
      if (Array.isArray(c)) {
        for (const b of c) {
          if (!b) continue;
          if (b.type === 'text') text += (text ? '\n' : '') + b.text;
          else if (b.type === 'tool_use') {
            const input = b.input || {};
            const brief = input.description || input.command || input.file_path ||
              input.skill || input.prompt || input.query || input.url || '';
            tools.push({ name: b.name, brief: String(brief).slice(0, 160) });
          }
        }
      } else if (typeof c === 'string') text = c;
      if (text.trim() || tools.length) {
        messages.push({ role: 'assistant', ts: obj.timestamp, text: text.trim(), tools });
      }
    }
  }
  const truncated = messages.length > 800;
  return {
    messages: truncated ? messages.slice(0, 800) : messages,
    truncated,
    total: messages.length,
    skippedSidechain,
  };
}

/* --------------------------------------------------------------------- skills */

function parseFrontmatter(md) {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  if (!m) return {};
  const fm = m[1];
  const out = {};
  const nameM = /^name:\s*(.+)$/m.exec(fm);
  if (nameM) out.name = nameM[1].trim();
  // description: either inline or a `|` block
  const descBlock = /^description:\s*\|?\s*\n((?:[ \t]+.+\n?)+)/m.exec(fm);
  const descInline = /^description:\s*(?!\|)(.+)$/m.exec(fm);
  if (descBlock) {
    out.description = descBlock[1].split('\n').map(s => s.trim()).join(' ').trim();
  } else if (descInline) {
    out.description = descInline[1].trim();
  }
  return out;
}

async function listSkills() {
  const skills = [];
  let dirs = [];
  try { dirs = await fsp.readdir(SKILLS_DIR); } catch { return skills; }
  for (const dir of dirs) {
    const skillMd = path.join(SKILLS_DIR, dir, 'SKILL.md');
    let md;
    try { md = await fsp.readFile(skillMd, 'utf8'); } catch { continue; }
    const fm = parseFrontmatter(md);
    const desc = (fm.description || '').replace(/\s+/g, ' ');
    // first sentence-ish for the card; full text on hover
    const short = desc.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').slice(0, 220);
    skills.push({
      name: fm.name || dir,
      command: '/' + (fm.name || dir),
      description: short,
      fullDescription: desc.slice(0, 600),
      group: desc.includes('(gstack)') ? 'gstack' : 'personal',
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  // two dirs can declare the same frontmatter name (e.g. aliases) — keep one
  const seen = new Set();
  return skills.filter(s => !seen.has(s.command) && seen.add(s.command));
}

/* ------------------------------------------------------------- skill usage */

function bareName(s) {
  // "/vercel:deploy" -> "deploy", "/browse" -> "browse"
  const noSlash = s.replace(/^\//, '');
  const parts = noSlash.split(':');
  return parts[parts.length - 1].toLowerCase();
}

async function computeSkillUsage(index) {
  const skills = await listSkills();
  const byBare = new Map(skills.map(s => [bareName(s.command), s]));
  const counts = new Map();   // bare name -> {uses, lastUsed, rawNames:Set}
  for (const sess of index) {
    for (const raw of sess.skills) {
      const bare = bareName(raw);
      let e = counts.get(bare);
      if (!e) { e = { uses: 0, lastUsed: null, rawNames: new Set() }; counts.set(bare, e); }
      e.uses++;
      e.rawNames.add(raw);
      if (!e.lastUsed || sess.startTs > e.lastUsed) e.lastUsed = sess.startTs;
    }
  }
  const installed = skills.map(s => {
    const bare = bareName(s.command);
    const e = counts.get(bare);
    return {
      name: s.name, command: s.command, group: s.group, description: s.description,
      uses: e ? e.uses : 0, lastUsed: e ? e.lastUsed : null,
    };
  }).sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));

  const otherInvoked = [...counts.entries()]
    .filter(([bare]) => !byBare.has(bare))
    .map(([bare, e]) => ({ name: [...e.rawNames][0], uses: e.uses, lastUsed: e.lastUsed }))
    .sort((a, b) => b.uses - a.uses);

  return {
    installed,
    used: installed.filter(s => s.uses > 0),
    neverUsed: installed.filter(s => s.uses === 0),
    otherInvoked,
    totalSessions: index.length,
  };
}

/* ---------------------------------------------------------------- automations */

const DEFAULT_AUTOMATIONS = [
  {
    id: 'daily-report',
    name: 'Write my daily report',
    emoji: '📝',
    description: 'Summarizes everything Claude Code did today into a short, shareable report.',
    prompt: '__DAILY_REPORT__', // composed server-side at run time
    cwd: HOME,
    mode: 'default',
  },
  {
    id: 'health-check',
    name: 'Code health check',
    emoji: '🩺',
    description: 'Runs the /health quality dashboard on the selected project.',
    prompt: '/health',
    cwd: null, // ask
    mode: 'default',
  },
  {
    id: 'security-audit',
    name: 'Security audit',
    emoji: '🛡️',
    description: 'Runs the /cso daily security scan on the selected project.',
    prompt: '/cso daily',
    cwd: null,
    mode: 'default',
  },
];

function loadAutomations() {
  try { return JSON.parse(fs.readFileSync(AUTOMATIONS_FILE, 'utf8')); }
  catch {
    fs.writeFileSync(AUTOMATIONS_FILE, JSON.stringify(DEFAULT_AUTOMATIONS, null, 2));
    return DEFAULT_AUTOMATIONS.slice();
  }
}
function saveAutomations(list) {
  fs.writeFileSync(AUTOMATIONS_FILE, JSON.stringify(list, null, 2));
}

/* ----------------------------------------------------------------------- runs */

// { id, label, prompt, cwd, mode, status: running|done|failed|stopped, startedAt, endedAt, exitCode, logFile }
const runs = new Map();
const runProcs = new Map();

function startRun({ label, prompt, cwd, mode }) {
  const id = crypto.randomBytes(6).toString('hex');
  const logFile = path.join(RUNS_DIR, id + '.log');
  const logStream = fs.createWriteStream(logFile);
  const args = ['-p', prompt, '--output-format', 'text'];
  if (mode === 'acceptEdits') args.push('--permission-mode', 'acceptEdits');
  if (mode === 'bypassPermissions') args.push('--permission-mode', 'bypassPermissions');

  const rec = {
    id, label, prompt: prompt.slice(0, 400), cwd, mode,
    status: 'running', startedAt: Date.now(), endedAt: null, exitCode: null,
  };
  runs.set(id, rec);

  logStream.write(`▶ ${label}\n  in ${cwd}\n  mode: ${mode}\n  started ${new Date().toLocaleString()}\n\n`);

  let proc;
  try {
    proc = spawn(CLAUDE_BIN, args, { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    rec.status = 'failed';
    rec.endedAt = Date.now();
    logStream.end('Failed to launch claude: ' + e.message + '\n');
    return rec;
  }
  runProcs.set(id, proc);
  proc.stdout.pipe(logStream, { end: false });
  proc.stderr.pipe(logStream, { end: false });

  const timeout = setTimeout(() => {
    logStream.write('\n⏱ Timed out after 20 minutes — stopping.\n');
    proc.kill('SIGTERM');
  }, RUN_TIMEOUT_MS);

  proc.on('close', (code) => {
    clearTimeout(timeout);
    rec.endedAt = Date.now();
    rec.exitCode = code;
    if (rec.status === 'running') rec.status = code === 0 ? 'done' : 'failed';
    logStream.end(`\n${code === 0 ? '✅ Finished' : '⚠️ Exited with code ' + code} at ${new Date().toLocaleTimeString()}\n`);
    runProcs.delete(id);
  });
  proc.on('error', (e) => {
    rec.status = 'failed';
    logStream.write('Launch error: ' + e.message + '\n');
  });
  return rec;
}

/* --------------------------------------------------------------- daily report */

function localDateStr(ts) {
  return new Date(ts).toLocaleDateString('en-CA'); // YYYY-MM-DD, local tz
}

function buildReport(index, dateStr) {
  const sessions = index.filter(s => s.startTs && localDateStr(s.startTs) === dateStr);
  const projects = {};
  const skillCounts = {};
  let prompts = 0, toolCalls = 0;
  let firstTs = null, lastTs = null;
  for (const s of sessions) {
    projects[s.projectName] = (projects[s.projectName] || 0) + 1;
    prompts += s.userMsgs;
    toolCalls += s.toolCalls;
    for (const sk of s.skills) skillCounts[sk] = (skillCounts[sk] || 0) + 1;
    if (!firstTs || s.startTs < firstTs) firstTs = s.startTs;
    if (!lastTs || s.endTs > lastTs) lastTs = s.endTs;
  }
  // 14-day activity series ending on dateStr
  const series = [];
  const end = new Date(dateStr + 'T12:00:00');
  for (let i = 13; i >= 0; i--) {
    const d = new Date(end); d.setDate(d.getDate() - i);
    const ds = d.toLocaleDateString('en-CA');
    series.push({
      date: ds,
      count: index.filter(s => s.startTs && localDateStr(s.startTs) === ds).length,
    });
  }
  return {
    date: dateStr,
    sessionCount: sessions.length,
    projectCount: Object.keys(projects).length,
    prompts, toolCalls,
    firstTs, lastTs,
    projects: Object.entries(projects).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    skills: Object.entries(skillCounts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    sessions: sessions.map(s => ({
      id: s.id, title: s.title, projectName: s.projectName,
      startTs: s.startTs, endTs: s.endTs, userMsgs: s.userMsgs, toolCalls: s.toolCalls,
    })),
    series,
  };
}

function narrativePrompt(report) {
  const lines = report.sessions.map(s =>
    `- [${s.projectName}] ${new Date(s.startTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — "${s.title}" (${s.userMsgs} prompts, ${s.toolCalls} tool calls)`
  ).join('\n');
  return `You are writing a daily work report for ${report.date} based on Claude Code session logs. ` +
    `Write it for a non-technical teammate: plain language, no jargon, no file paths unless essential. ` +
    `Structure: 2-3 sentence overview, then "What got done" bullets grouped by project, then "Worth knowing" for anything notable. ` +
    `Keep it under 250 words. Do not invent details beyond what the log shows.\n\n` +
    `Sessions today (${report.sessionCount} across ${report.projectCount} projects, ${report.prompts} prompts):\n${lines}`;
}

/* ---------------------------------------------------------------- cloud sync */
// Aggregate-only: counts, project/skill names, timestamps. Never prompt
// text, transcripts, or file contents — those stay on this machine.

function loadCloudConfig() {
  try { return JSON.parse(fs.readFileSync(CLOUD_FILE, 'utf8')); } catch { return null; }
}
function saveCloudConfig(cfg) {
  fs.writeFileSync(CLOUD_FILE, JSON.stringify(cfg, null, 2));
}

async function buildSyncPayload(index) {
  const today = new Date();
  const days = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const ds = d.toLocaleDateString('en-CA');
    const r = buildReport(index, ds);
    if (r.sessionCount === 0) continue; // skip empty days, nothing to sync
    days.push({
      date: ds, sessionCount: r.sessionCount, projectCount: r.projectCount,
      prompts: r.prompts, toolCalls: r.toolCalls, firstTs: r.firstTs, lastTs: r.lastTs,
      projects: r.projects, skills: r.skills,
    });
  }

  const usage = await computeSkillUsage(index);
  const skillUsage = usage.used.map(s => ({ name: s.name, uses: s.uses, lastUsed: s.lastUsed }));

  const sessions = index.slice(0, 100).map(s => ({
    id: s.id, projectName: s.projectName, startTs: s.startTs, endTs: s.endTs,
    userMsgs: s.userMsgs, toolCalls: s.toolCalls,
  }));

  return { days, skillUsage, sessions };
}

async function runSync() {
  const cfg = loadCloudConfig();
  if (!cfg || !cfg.token || !cfg.apiUrl) {
    throw new Error('Not connected. Run: node server.js login <token> --api <url>');
  }
  const index = await getSessionIndex();
  const payload = await buildSyncPayload(index);
  const res = await fetch(`${cfg.apiUrl.replace(/\/$/, '')}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `sync failed: HTTP ${res.status}`);
  cfg.lastSyncedAt = Date.now();
  saveCloudConfig(cfg);
  return body;
}

/* ----------------------------------------------------------------- http utils */

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

/* --------------------------------------------------------------------- server */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    /* ---- API ---- */
    if (p === '/api/overview') {
      const index = await getSessionIndex();
      const today = localDateStr(Date.now());
      return sendJSON(res, 200, buildReport(index, url.searchParams.get('date') || today));
    }
    if (p === '/api/sessions') {
      const index = await getSessionIndex();
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const project = url.searchParams.get('project') || '';
      const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
      let list = index;
      if (project) list = list.filter(s => s.projectName === project);
      if (q) list = list.filter(s => (s.title + ' ' + s.projectName).toLowerCase().includes(q));
      const projectNames = [...new Set(index.map(s => s.projectName))].sort();
      return sendJSON(res, 200, { total: list.length, sessions: list.slice(0, limit), projects: projectNames });
    }
    if (p === '/api/session') {
      const rel = url.searchParams.get('id') || '';
      if (!rel || rel.includes('..')) return sendJSON(res, 400, { error: 'bad id' });
      return sendJSON(res, 200, await readTranscript(rel));
    }
    if (p === '/api/skills') {
      return sendJSON(res, 200, { skills: await listSkills() });
    }
    if (p === '/api/skill-usage') {
      const index = await getSessionIndex();
      return sendJSON(res, 200, await computeSkillUsage(index));
    }
    if (p === '/api/projects') {
      const index = await getSessionIndex();
      const seen = new Map();
      for (const s of index) {
        if (s.project && !seen.has(s.project) && fs.existsSync(s.project)) seen.set(s.project, s.projectName);
      }
      const projects = [...seen.entries()].map(([dir, name]) => ({ dir, name })).sort((a, b) => a.name.localeCompare(b.name));
      return sendJSON(res, 200, { projects });
    }
    if (p === '/api/automations' && req.method === 'GET') {
      return sendJSON(res, 200, { automations: loadAutomations() });
    }
    if (p === '/api/automations' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.name || !body.prompt) return sendJSON(res, 400, { error: 'name and prompt required' });
      const list = loadAutomations();
      list.push({
        id: crypto.randomBytes(4).toString('hex'),
        name: String(body.name).slice(0, 80),
        emoji: String(body.emoji || '⚡').slice(0, 4),
        description: String(body.description || '').slice(0, 200),
        prompt: String(body.prompt).slice(0, 2000),
        cwd: body.cwd ? String(body.cwd) : null,
        mode: ['default', 'acceptEdits', 'bypassPermissions'].includes(body.mode) ? body.mode : 'default',
      });
      saveAutomations(list);
      return sendJSON(res, 200, { automations: list });
    }
    if (p.startsWith('/api/automations/') && req.method === 'DELETE') {
      const id = p.split('/').pop();
      const list = loadAutomations().filter(a => a.id !== id);
      saveAutomations(list);
      return sendJSON(res, 200, { automations: list });
    }
    if (p === '/api/run' && req.method === 'POST') {
      const body = await readBody(req);
      let prompt = String(body.prompt || '').trim();
      const label = String(body.label || prompt).slice(0, 100);
      let cwd = body.cwd ? String(body.cwd) : HOME;
      const mode = ['default', 'acceptEdits', 'bypassPermissions'].includes(body.mode) ? body.mode : 'default';
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return sendJSON(res, 400, { error: 'Folder not found: ' + cwd });
      if (prompt === '__DAILY_REPORT__') {
        const index = await getSessionIndex();
        prompt = narrativePrompt(buildReport(index, localDateStr(Date.now())));
        cwd = HOME;
      }
      if (!prompt) return sendJSON(res, 400, { error: 'prompt required' });
      const rec = startRun({ label, prompt, cwd, mode });
      return sendJSON(res, 200, { run: rec });
    }
    if (p === '/api/runs') {
      const list = [...runs.values()].sort((a, b) => b.startedAt - a.startedAt);
      return sendJSON(res, 200, { runs: list });
    }
    if (/^\/api\/run\/[a-f0-9]+$/.test(p)) {
      const id = p.split('/').pop();
      const rec = runs.get(id);
      if (!rec) return sendJSON(res, 404, { error: 'not found' });
      const offset = Number(url.searchParams.get('offset')) || 0;
      let chunk = '';
      try {
        const fd = fs.openSync(path.join(RUNS_DIR, id + '.log'), 'r');
        const st = fs.fstatSync(fd);
        if (st.size > offset) {
          const buf = Buffer.alloc(Math.min(st.size - offset, 512 * 1024));
          fs.readSync(fd, buf, 0, buf.length, offset);
          chunk = buf.toString('utf8');
        }
        fs.closeSync(fd);
        return sendJSON(res, 200, { run: rec, chunk, nextOffset: offset + Buffer.byteLength(chunk) });
      } catch {
        return sendJSON(res, 200, { run: rec, chunk: '', nextOffset: offset });
      }
    }
    if (/^\/api\/run\/[a-f0-9]+\/stop$/.test(p) && req.method === 'POST') {
      const id = p.split('/')[3];
      const proc = runProcs.get(id);
      const rec = runs.get(id);
      if (proc && rec) { rec.status = 'stopped'; proc.kill('SIGTERM'); }
      return sendJSON(res, 200, { ok: true });
    }
    if (p === '/api/cloud/status') {
      const cfg = loadCloudConfig();
      return sendJSON(res, 200, {
        connected: !!(cfg && cfg.token),
        apiUrl: cfg ? cfg.apiUrl : null,
        lastSyncedAt: cfg ? cfg.lastSyncedAt : null,
      });
    }
    if (p === '/api/cloud/sync' && req.method === 'POST') {
      try {
        const result = await runSync();
        return sendJSON(res, 200, result);
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    }

    /* ---- static ---- */
    let filePath = p === '/' ? '/index.html' : p;
    filePath = path.resolve(PUBLIC_DIR, '.' + filePath);
    if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    try {
      const content = await fsp.readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      return res.end(content);
    } catch {
      res.writeHead(404); return res.end('Not found');
    }
  } catch (e) {
    return sendJSON(res, 500, { error: e.message });
  }
});

/* ------------------------------------------------------------------- CLI */

async function runCli() {
  const [cmd, ...rest] = argv;

  if (cmd === 'login') {
    const token = rest[0];
    const apiFlagIdx = rest.indexOf('--api');
    const apiUrl = apiFlagIdx >= 0 ? rest[apiFlagIdx + 1] : null;
    if (!token || !apiUrl) {
      console.error('Usage: node server.js login <token> --api <https://your-deployment.vercel.app>');
      process.exit(1);
    }
    saveCloudConfig({ token, apiUrl });
    console.log(`Saved. Run "node server.js sync" any time to push your stats to ${apiUrl}.`);
    process.exit(0);
  }

  if (cmd === 'sync') {
    try {
      const result = await runSync();
      console.log(`Synced ${result.synced.days} day(s), ${result.synced.skills} skill(s), ${result.synced.sessions} session(s).`);
      process.exit(0);
    } catch (e) {
      console.error('Sync failed:', e.message);
      process.exit(1);
    }
  }

  return false; // no CLI command matched — fall through to starting the server
}

runCli().then((handled) => {
  if (handled === false) startServer();
});

function startServer() {
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}`;
    console.log(`\n  Claude Deck running at ${url}\n  Reading sessions from ${PROJECTS_DIR}\n  claude binary: ${CLAUDE_BIN}\n`);
    if (OPEN_BROWSER) spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    // warm the session index in the background so first page load is fast
    getSessionIndex().then(ix => console.log(`  Indexed ${ix.length} sessions.\n`)).catch(() => {});
  });
}
