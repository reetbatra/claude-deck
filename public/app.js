/* Claude Deck front-end. Vanilla JS, no build step. */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  projects: [],       // [{dir, name}]
  automations: [],
  skills: [],
  watchingRun: null,  // {id, offset}
  narrativeRun: null,
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTime = (ts) => ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
const fmtDate = (ts) => ts ? new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
const fmtDateTime = (ts) => ts ? `${fmtDate(ts)}, ${fmtTime(ts)}` : '';

async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

/* ---------------- modal (replaces window.prompt/confirm) ---------------- */

function openModal({ title, bodyHTML, okLabel = 'Continue', onOk }) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHTML;
  $('#modal-ok').textContent = okLabel;
  $('#modal-backdrop').classList.remove('hidden');
  const close = () => $('#modal-backdrop').classList.add('hidden');
  $('#modal-cancel').onclick = close;
  $('#modal-backdrop').onclick = (e) => { if (e.target.id === 'modal-backdrop') close(); };
  $('#modal-ok').onclick = () => { const r = onOk(); if (r !== false) close(); };
}

function confirmModal({ title, message, okLabel = 'Delete', onOk }) {
  openModal({
    title, bodyHTML: `<p class="modal-warn">${esc(message)}</p>`, okLabel, onOk,
  });
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* ---------------- navigation ---------------- */

function show(view) {
  $$('.view').forEach(v => v.classList.add('hidden'));
  $('#view-' + view).classList.remove('hidden');
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'today') { loadToday(); loadCloudPanel(); }
  if (view === 'automations') { renderAutomations(); refreshRuns(); }
  if (view === 'skills') { renderSkills(); loadUsage(); }
  if (view === 'sessions') loadSessions();
}
$$('.nav-btn').forEach(b => b.onclick = () => show(b.dataset.view));

/* ---------------- Today ---------------- */

async function loadToday() {
  const date = $('#report-date').value || new Date().toLocaleDateString('en-CA');
  const r = await api('/api/overview?date=' + date);
  const isToday = date === new Date().toLocaleDateString('en-CA');
  $('#today-title').textContent = isToday ? 'Today' : new Date(date + 'T12:00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  $('#today-sub').textContent = isToday
    ? new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
    : 'Historical view';

  $('#st-sessions').textContent = r.sessionCount;
  $('#st-projects').textContent = r.projectCount;
  $('#st-prompts').textContent = r.prompts;
  $('#st-tools').textContent = r.toolCalls;
  $('#st-hours').textContent = r.firstTs ? `${fmtTime(r.firstTs)}–${fmtTime(r.lastTs)}` : '—';

  renderActivityChart(r.series);

  $('#today-projects').innerHTML = r.projects.length
    ? r.projects.map(p => `<li><span>${esc(p.name)}</span><span class="count">${p.count} session${p.count > 1 ? 's' : ''}</span></li>`).join('')
    : '<li class="muted">No sessions this day.</li>';

  $('#today-skills').innerHTML = r.skills.length
    ? r.skills.map(s => `<li><span>${esc(s.name)}</span><span class="count">×${s.count}</span></li>`).join('')
    : '<li class="muted">No skills invoked this day.</li>';

  $('#today-sessions').innerHTML = r.sessions.length
    ? r.sessions.map(s => sessionRowHTML({ ...s, startTs: s.startTs })).join('')
    : '<p class="muted">Nothing yet. Sessions appear here as they happen.</p>';
  bindSessionRows('#today-sessions');
}

function renderActivityChart(series) {
  const max = Math.max(1, ...series.map(d => d.count));
  const today = new Date().toLocaleDateString('en-CA');
  $('#activity-chart').innerHTML = series.map((d) => {
    const h = d.count === 0 ? 2 : Math.max(6, Math.round((d.count / max) * 92));
    const label = new Date(d.date + 'T12:00:00').toLocaleDateString([], { day: 'numeric' });
    const isToday = d.date === today;
    return `<div class="bar-col" data-date="${d.date}" data-count="${d.count}">
      <div class="bar ${d.count === 0 ? 'bar-zero' : ''}" style="height:${h}px"></div>
      <div class="bar-label ${isToday ? 'today' : ''}">${isToday ? 'today' : label}</div>
    </div>`;
  }).join('');

  const tip = $('#chart-tooltip');
  $$('#activity-chart .bar-col').forEach(col => {
    col.addEventListener('mouseenter', () => {
      const d = new Date(col.dataset.date + 'T12:00:00');
      tip.textContent = `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} — ${col.dataset.count} session${col.dataset.count === '1' ? '' : 's'}`;
      tip.classList.remove('hidden');
      const cr = col.getBoundingClientRect(), wr = $('.chart-wrap').getBoundingClientRect();
      tip.style.left = (cr.left - wr.left + cr.width / 2) + 'px';
      tip.style.top = '8px';
    });
    col.addEventListener('mouseleave', () => tip.classList.add('hidden'));
  });
}

$('#report-date').onchange = loadToday;

async function loadCloudPanel() {
  const s = await api('/api/cloud/status');
  const el = $('#cloud-panel');
  if (!s.connected) {
    el.innerHTML = `<p class="muted small">Not connected. Sign in to Claude Deck Cloud, generate a token on the Connect page, then run
      <code>node server.js login &lt;token&gt; --api &lt;url&gt;</code> here.</p>`;
    return;
  }
  el.innerHTML = `
    <p class="muted small">Connected to ${esc(s.apiUrl)}${s.lastSyncedAt ? ` — last synced ${fmtDateTime(s.lastSyncedAt)}` : ' — never synced'}.</p>
    <button class="btn" id="btn-cloud-sync" style="margin-top:8px">Sync now</button>
    <span id="cloud-sync-status" class="muted small" style="margin-left:8px"></span>`;
  $('#btn-cloud-sync').onclick = async () => {
    $('#cloud-sync-status').textContent = 'Syncing…';
    try {
      const r = await api('/api/cloud/sync', { method: 'POST' });
      $('#cloud-sync-status').textContent = `Synced ${r.synced.days} day(s), ${r.synced.skills} skill(s), ${r.synced.sessions} session(s).`;
      loadCloudPanel();
    } catch (e) {
      $('#cloud-sync-status').textContent = 'Sync failed: ' + e.message;
    }
  };
}

$('#btn-narrative').onclick = async () => {
  const { run } = await api('/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '__DAILY_REPORT__', label: 'Daily report' }),
  });
  state.narrativeRun = { id: run.id, offset: 0 };
  $('#narrative-card').classList.remove('hidden');
  $('#narrative-out').textContent = '';
  $('#narrative-status').textContent = 'writing…';
  $('#narrative-status').className = 'pill pill-running';
  pollNarrative();
};

async function pollNarrative() {
  if (!state.narrativeRun) return;
  const { id, offset } = state.narrativeRun;
  const r = await api(`/api/run/${id}?offset=${offset}`);
  if (r.chunk) {
    state.narrativeRun.offset = r.nextOffset;
    $('#narrative-out').textContent += r.chunk;
  }
  if (r.run.status === 'running') setTimeout(pollNarrative, 1500);
  else {
    $('#narrative-status').textContent = r.run.status === 'done' ? 'ready' : r.run.status;
    $('#narrative-status').className = 'pill ' + (r.run.status === 'done' ? 'pill-done' : 'pill-failed');
    state.narrativeRun = null;
  }
}

/* ---------------- Automations ---------------- */

function projectOptions(sel, includeHome = true) {
  const opts = [];
  if (includeHome) opts.push(`<option value="">Home folder</option>`);
  for (const p of state.projects) opts.push(`<option value="${esc(p.dir)}">${esc(p.name)}</option>`);
  sel.innerHTML = opts.join('');
}

function renderAutomations() {
  projectOptions($('#af-cwd'));
  $('#automation-grid').innerHTML = state.automations.map(a => `
    <button class="action-card" data-id="${esc(a.id)}">
      <span class="ac-head"><span class="ac-emoji">${esc(a.emoji || '⚡')}</span>${esc(a.name)}</span>
      <span class="ac-desc">${esc(a.description || a.prompt)}</span>
      <span class="ac-run">Run now →</span>
      ${a.id !== 'daily-report' ? `<span class="ac-del" data-del="${esc(a.id)}" title="Delete">✕</span>` : ''}
    </button>`).join('');

  $$('#automation-grid .action-card').forEach(card => {
    card.onclick = (e) => {
      const delId = e.target.dataset && e.target.dataset.del;
      if (delId) { deleteAutomation(delId); e.stopPropagation(); return; }
      runAutomation(card.dataset.id);
    };
  });
}

function deleteAutomation(id) {
  const a = state.automations.find(x => x.id === id);
  confirmModal({
    title: 'Delete automation?',
    message: `"${a ? a.name : id}" will be removed. This can't be undone.`,
    okLabel: 'Delete',
    onOk: async () => {
      const { automations } = await api('/api/automations/' + id, { method: 'DELETE' });
      state.automations = automations;
      renderAutomations();
      toast('Automation deleted.');
    },
  });
}

async function launchRun({ prompt, label, cwd, mode }) {
  const { run } = await api('/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, label, cwd, mode }),
  });
  toast(`Started: ${label}`);
  watchRun(run.id, label);
  refreshRuns();
}

function runAutomation(id) {
  const a = state.automations.find(x => x.id === id);
  if (!a) return;
  if (a.cwd) return launchRun({ prompt: a.prompt, label: a.name, cwd: a.cwd, mode: a.mode });
  openModal({
    title: `Run "${a.name}"`,
    bodyHTML: `<label>Which project? <select id="m-cwd">${state.projects.map(p => `<option value="${esc(p.dir)}">${esc(p.name)}</option>`).join('')}</select></label>`,
    okLabel: 'Run now',
    onOk: () => launchRun({ prompt: a.prompt, label: a.name, cwd: $('#m-cwd').value, mode: a.mode }),
  });
}

$('#btn-add-automation').onclick = () => $('#automation-form').classList.toggle('hidden');
$('#af-cancel').onclick = () => $('#automation-form').classList.add('hidden');
$('#af-save').onclick = async () => {
  const body = {
    name: $('#af-name').value.trim(),
    emoji: $('#af-emoji').value.trim() || '⚡',
    prompt: $('#af-prompt').value.trim(),
    description: $('#af-prompt').value.trim().slice(0, 140),
    cwd: $('#af-cwd').value || null,
    mode: $('#af-mode').value,
  };
  if (!body.name || !body.prompt) { toast('Name and instructions are required.'); return; }
  const { automations } = await api('/api/automations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  state.automations = automations;
  $('#automation-form').classList.add('hidden');
  $('#af-name').value = $('#af-prompt').value = '';
  renderAutomations();
  toast('Automation saved.');
};

/* ---------------- runs ---------------- */

async function refreshRuns() {
  const { runs } = await api('/api/runs');
  const running = runs.filter(r => r.status === 'running').length;
  const badge = $('#runs-badge');
  if (running) {
    badge.classList.remove('hidden');
    badge.innerHTML = `<span class="dot"></span>${running} automation${running > 1 ? 's' : ''} running`;
  } else badge.classList.add('hidden');

  if (!runs.length) return;
  $('#runs-list').innerHTML = runs.map(r => `
    <div class="run-row" data-id="${r.id}" data-label="${esc(r.label)}">
      <span class="pill pill-${r.status}">${r.status}</span>
      <span class="rn">${esc(r.label)}</span>
      <span class="rt">${fmtDateTime(r.startedAt)}${r.endedAt ? ' · ' + Math.round((r.endedAt - r.startedAt) / 1000) + 's' : ''}</span>
    </div>`).join('');
  $$('#runs-list .run-row').forEach(row => row.onclick = () => watchRun(row.dataset.id, row.dataset.label));

  if (running) setTimeout(refreshRuns, 3000);
}

function watchRun(id, label) {
  state.watchingRun = { id, offset: 0 };
  $('#run-output-card').classList.remove('hidden');
  $('#run-output-title').textContent = label;
  $('#run-output').textContent = '';
  pollRun();
}

async function pollRun() {
  if (!state.watchingRun) return;
  const { id, offset } = state.watchingRun;
  const r = await api(`/api/run/${id}?offset=${offset}`);
  if (state.watchingRun.id !== id) return;
  if (r.chunk) {
    state.watchingRun.offset = r.nextOffset;
    const out = $('#run-output');
    out.textContent += r.chunk;
    out.scrollTop = out.scrollHeight;
  }
  $('#run-output-status').textContent = r.run.status;
  $('#run-output-status').className = 'pill pill-' + r.run.status;
  $('#btn-stop-run').classList.toggle('hidden', r.run.status !== 'running');
  if (r.run.status === 'running') setTimeout(pollRun, 1500);
}

$('#btn-stop-run').onclick = async () => {
  if (state.watchingRun) {
    await api(`/api/run/${state.watchingRun.id}/stop`, { method: 'POST' });
    refreshRuns();
  }
};

/* ---------------- Skills ---------------- */

function renderSkills() {
  projectOptions($('#skill-project'));
  const q = ($('#skill-search').value || '').toLowerCase();
  const list = state.skills.filter(s => !q || (s.name + ' ' + s.description).toLowerCase().includes(q));
  const groups = [['personal', 'Your skills'], ['gstack', 'gstack toolkit']];
  let html = '';
  for (const [key, label] of groups) {
    const items = list.filter(s => s.group === key);
    if (!items.length) continue;
    html += `<div class="group-label">${label} (${items.length})</div>`;
    html += items.map(s => `
      <button class="action-card" data-cmd="${esc(s.command)}" data-name="${esc(s.name)}" title="${esc(s.fullDescription)}">
        <span class="ac-head"><span class="ac-emoji">🧩</span>${esc(s.name)}</span>
        <span class="ac-desc">${esc(s.description)}</span>
        <span class="ac-run">Run ${esc(s.command)} →</span>
      </button>`).join('');
  }
  $('#skills-grid').innerHTML = html || '<p class="muted">No skills match.</p>';
  $$('#skills-grid .action-card').forEach(card => {
    card.onclick = () => {
      const cwd = $('#skill-project').value || null;
      openModal({
        title: `Run ${card.dataset.cmd}`,
        bodyHTML: `<label>Anything specific to tell it? (optional)
          <textarea id="m-extra" rows="2" placeholder="Leave blank to just run it as-is"></textarea></label>
          <p class="muted small">Runs in ${cwd ? esc(state.projects.find(p => p.dir === cwd)?.name || cwd) : 'your home folder'}.</p>`,
        okLabel: 'Run now',
        onOk: () => {
          const extra = $('#m-extra').value.trim();
          launchRun({
            prompt: card.dataset.cmd + (extra ? ' ' + extra : ''),
            label: card.dataset.cmd, cwd: cwd || undefined, mode: 'default',
          });
          show('automations');
        },
      });
    };
  });
}
$('#skill-search').oninput = renderSkills;

/* ---------------- Skill usage ---------------- */

async function loadUsage() {
  const u = await api('/api/skill-usage');
  $('#usage-sub').textContent = `across ${u.totalSessions} sessions on this Mac`;
  const top = u.used.slice(0, 8);
  const max = Math.max(1, ...top.map(s => s.uses));
  $('#usage-top').innerHTML = top.length ? top.map(s => `
    <div class="usage-row">
      <span class="u-name">/${esc(s.name)}</span>
      <span class="usage-bar-track"><span class="usage-bar-fill" style="width:${Math.round(s.uses / max * 100)}%"></span></span>
      <span class="u-count">${s.uses}×</span>
    </div>`).join('') : '<p class="muted small">No skill invocations recorded yet.</p>';

  if (u.otherInvoked.length) {
    $('#usage-top').innerHTML += `<p class="muted small" style="margin-top:4px">Also used (plugin/built-in): ${
      u.otherInvoked.map(o => `${esc(o.name)} ×${o.uses}`).join(', ')}</p>`;
  }

  const btn = $('#toggle-unused');
  btn.textContent = `Show ${u.neverUsed.length} skills you've never used ▾`;
  $('#usage-unused').innerHTML = u.neverUsed.map(s => `<span class="unused-chip" title="${esc(s.description)}">${esc(s.name)}</span>`).join('');
  btn.onclick = () => {
    const hidden = $('#usage-unused').classList.toggle('hidden');
    btn.textContent = `${hidden ? 'Show' : 'Hide'} ${u.neverUsed.length} skills you've never used ${hidden ? '▾' : '▴'}`;
  };
}

/* ---------------- Sessions ---------------- */

function sessionRowHTML(s) {
  return `<div class="session-row" data-id="${esc(s.id)}" data-title="${esc(s.title)}">
    <span class="s-time">${fmtDate(s.startTs)} ${fmtTime(s.startTs)}</span>
    <span class="s-project">${esc(s.projectName)}</span>
    <span class="s-title">${esc(s.title)}</span>
    <span class="s-meta">${s.userMsgs} prompt${s.userMsgs === 1 ? '' : 's'} · ${s.toolCalls} actions</span>
  </div>`;
}

function bindSessionRows(sel) {
  $$(sel + ' .session-row').forEach(row => row.onclick = () => openTranscript(row.dataset.id, row.dataset.title));
}

let sessionsTimer = null;
async function loadSessions() {
  const q = $('#session-search').value.trim();
  const project = $('#session-project').value;
  const r = await api(`/api/sessions?limit=200&q=${encodeURIComponent(q)}&project=${encodeURIComponent(project)}`);
  $('#sessions-count').textContent = `${r.total} session${r.total === 1 ? '' : 's'}${project ? ' in ' + project : ''}${q ? ' matching "' + q + '"' : ''}`;
  if ($('#session-project').options.length <= 1) {
    $('#session-project').innerHTML = '<option value="">All projects</option>' +
      r.projects.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    $('#session-project').value = project;
  }
  $('#sessions-table').innerHTML = r.sessions.map(sessionRowHTML).join('') || '<p class="muted">No sessions found.</p>';
  bindSessionRows('#sessions-table');
}
$('#session-search').oninput = () => { clearTimeout(sessionsTimer); sessionsTimer = setTimeout(loadSessions, 250); };
$('#session-project').onchange = loadSessions;

/* ---------------- Transcript ---------------- */

async function openTranscript(id, title) {
  show('sessions'); // ensure nav state
  $$('.view').forEach(v => v.classList.add('hidden'));
  $('#view-transcript').classList.remove('hidden');
  $('#transcript-title').textContent = title;
  $('#transcript-meta').textContent = 'Loading…';
  $('#transcript').innerHTML = '';
  const r = await api('/api/session?id=' + encodeURIComponent(id));
  $('#transcript-meta').textContent =
    `${r.total} messages` +
    (r.truncated ? ' (showing first 800)' : '') +
    (r.skippedSidechain ? ` · ${r.skippedSidechain} background agent steps hidden` : '');
  $('#transcript').innerHTML = r.messages.map(m => {
    if (m.role === 'command') {
      return `<div class="msg msg-command"><div class="msg-body">⌘ Ran ${esc(m.text)}</div></div>`;
    }
    const who = m.role === 'user' ? 'You' : 'Claude';
    const tools = (m.tools && m.tools.length)
      ? `<div class="tool-chips">${m.tools.map(t => `<span class="tool-chip"><b>${esc(t.name)}</b>${t.brief ? ' · ' + esc(t.brief) : ''}</span>`).join('')}</div>`
      : '';
    return `<div class="msg msg-${m.role}">
      <div class="msg-who">${who} · ${fmtTime(m.ts)}</div>
      <div class="msg-body">${esc(m.text)}${tools}</div>
    </div>`;
  }).join('');
}
$('#btn-back').onclick = () => show('sessions');

/* ---------------- boot ---------------- */

(async function boot() {
  $('#report-date').value = new Date().toLocaleDateString('en-CA');
  const [proj, autos, skills] = await Promise.all([
    api('/api/projects'), api('/api/automations'), api('/api/skills'),
  ]);
  state.projects = proj.projects;
  state.automations = autos.automations;
  state.skills = skills.skills;
  loadToday();
  loadCloudPanel();
  refreshRuns();
})();
