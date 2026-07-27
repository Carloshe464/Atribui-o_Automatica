const FIELDS = {
  enabled: 'checkbox',
  strictQueueGate: 'checkbox',
  autoOpenPanel: 'checkbox',
  beep: 'checkbox',
  debug: 'checkbox',
  maxChats: 'number',
  breakerMinutes: 'number',
  idleMinutes: 'number',
  queueFilter: 'text',
  queueMatchMode: 'text',
  allowedStatuses: 'text',
  agentName: 'text',
  serveMethod: 'text',
  shortcut: 'text',
  mineSource: 'text',
  mineApiQuery: 'text',
  allowedPaths: 'text',
  listItemSelector: 'text',
  serveSelector: 'text',
  queueSelector: 'text',
  statusSelector: 'text'
};

// Precisa espelhar DEFAULTS do content.js — se divergir, salvar pelo popup
// reescreveria a config com valores mais frouxos do que os do content script.
const DEFAULTS = {
  cfgVersion: 3,
  enabled: true,
  maxChats: 3,
  idleMinutes: 6,
  mineSource: 'auto',
  mineApiQuery: 'type:ticket assignee:{me} status<solved',
  allowedPaths: '',
  serveMethod: 'auto',
  shortcut: 'Ctrl+Alt+Q',
  strictQueueGate: true,
  queueFilter: 'Suporte Especializado (NFs)',
  queueMatchMode: 'exact',
  allowedStatuses: 'novo',
  agentName: 'Carlos Lemos',
  breakerMinutes: 10,
  autoOpenPanel: false,
  beep: true,
  debug: false,
  listItemSelector: '',
  serveSelector: '',
  queueSelector: '',
  statusSelector: ''
};

const $ = (id) => document.getElementById(id);
const msg = (t) => { $('msg').textContent = t; };

async function zendeskTabs() {
  return chrome.tabs.query({ url: ['https://*.zendesk.com/*', 'https://*.zopim.com/*'] });
}

async function ask(payload) {
  const tabs = await zendeskTabs();
  for (const tab of tabs) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, payload);
      if (res) return { res, tabCount: tabs.length };
    } catch {
      /* aba sem content script injetado (precisa de F5) */
    }
  }
  return { res: null, tabCount: tabs.length };
}

async function loadConfig() {
  const { cfg = {} } = await chrome.storage.local.get('cfg');
  const merged = { ...DEFAULTS, ...cfg };
  for (const [key, kind] of Object.entries(FIELDS)) {
    const el = $(key);
    if (!el) continue;
    if (kind === 'checkbox') el.checked = !!merged[key];
    else el.value = merged[key] ?? '';
  }
}

async function save() {
  const { cfg = {} } = await chrome.storage.local.get('cfg');
  const next = { ...DEFAULTS, ...cfg, cfgVersion: DEFAULTS.cfgVersion };
  for (const [key, kind] of Object.entries(FIELDS)) {
    const el = $(key);
    if (!el) continue;
    if (kind === 'checkbox') next[key] = el.checked;
    else if (kind === 'number') next[key] = Math.max(1, Number(el.value) || 1);
    else next[key] = el.value.trim();
  }
  if (next.strictQueueGate && !next.queueFilter) {
    msg('Com a trava de fila ligada, a fila não pode ficar vazia.');
    return;
  }
  await chrome.storage.local.set({ cfg: next });
  msg('Salvo.');
  setTimeout(() => msg(''), 1800);
  refresh();
}

async function refresh() {
  const { res: st, tabCount } = await ask({ type: 'zd-status' });
  const gate = $('gate-text');
  const box = $('status');

  if (!st) {
    gate.textContent = tabCount
      ? 'Aba do Zendesk encontrada, mas sem resposta — dê F5 nela.'
      : 'Nenhuma aba do Zendesk aberta.';
    box.className = 'card bad';
    return;
  }

  const cfg = { ...DEFAULTS, ...(st.cfg || {}) };

  gate.textContent = st.gateReason || 'livre para puxar';
  const parado = /parada|invalidado/.test(st.gateReason || '');
  box.className = 'card' + (parado ? ' bad' : st.gateReason ? '' : ' good');

  $('s-mine').textContent =
    st.mine === null || st.mine === undefined ? '? (não sei)' : `${st.mine} / ${cfg.maxChats}`;
  $('s-queue').textContent = st.queueWaiting ?? (st.pending || 0);
  $('s-breaker').textContent =
    st.breakerCount === undefined ? '–' : `${st.breakerCount} / ${st.breakerLimit ?? cfg.maxChats}`;
  $('s-agent').textContent = st.agent
    ? (st.agent.ok ? `${st.agent.name} ✓` : '✕ não autorizado')
    : 'verificando…';

  // As tres leituras lado a lado: comparar com a tela mostra na hora qual
  // fonte esta certa, sem precisar de diagnostico.
  const n = (v) => (v === null || v === undefined ? '–' : String(v));
  $('s-sources').textContent =
    `${n(st.domMine)} / ${n(st.apiMine)}${st.apiMineError ? '!' : ''} / ${n(st.barMine)}`;

  const partes = [];
  if (st.mineSourceUsed) partes.push(`usando: ${st.mineSourceUsed}${st.mineWhy ? ` (${st.mineWhy})` : ''}`);
  if (st.apiMineError) partes.push(`API: ${st.apiMineError}`);
  if (!st.screenOk) partes.push(`tela: ${st.path}`);
  if (tabCount > 1) partes.push(`${tabCount} abas abertas`);
  $('s-src').textContent = partes.join(' · ');

  const blocked = $('blocked');
  blocked.innerHTML = '';
  for (const b of st.blocked || []) {
    const li = document.createElement('li');
    li.textContent = `${b.key || '(sem nome)'} — ${b.reason}`;
    blocked.appendChild(li);
  }
}

$('save').addEventListener('click', save);

$('reset-breaker').addEventListener('click', async () => {
  await chrome.storage.local.set({ recentServes: [], serveLock: null });
  msg('Disjuntor zerado.');
  setTimeout(() => msg(''), 1800);
  refresh();
});

$('diag').addEventListener('click', async () => {
  const { res } = await ask({ type: 'zd-diag' });
  if (!res?.report) {
    msg('Não consegui falar com a aba do Zendesk.');
    return;
  }
  await navigator.clipboard.writeText(res.report);
  console.log(res.report);
  msg('Diagnóstico copiado.');
});

loadConfig().then(refresh);
setInterval(refresh, 1500);
