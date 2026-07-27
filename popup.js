const FIELDS = {
  enabled: 'checkbox',
  autoOpenPanel: 'checkbox',
  beep: 'checkbox',
  debug: 'checkbox',
  maxChats: 'number',
  idleMinutes: 'number',
  queueFilter: 'text',
  queueMatchMode: 'text',
  agentName: 'text',
  allowedStatuses: 'text',
  serveMethod: 'text',
  shortcut: 'text',
  listItemSelector: 'text',
  serveSelector: 'text',
  queueSelector: 'text',
  statusSelector: 'text'
};

const DEFAULTS = {
  enabled: true,
  maxChats: 3,
  idleMinutes: 6,
  queueFilter: 'Suporte Especializado (NFs)',
  queueMatchMode: 'exact',
  agentName: 'Carlos Lemos',
  allowedStatuses: 'novo',
  serveMethod: 'shortcut',
  shortcut: 'Ctrl+Alt+Q',
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

function mark(id, state) {
  const el = $(id + '-mark');
  el.className = 'mark ' + (state === true ? 'yes' : state === false ? 'no' : 'wait');
  el.textContent = state === true ? '✓' : state === false ? '✕' : '•';
}

async function zendeskTab() {
  const tabs = await chrome.tabs.query({
    url: ['https://*.zendesk.com/*', 'https://*.zopim.com/*']
  });
  return tabs[0] || null;
}

async function ask(payload) {
  const tab = await zendeskTab();
  if (!tab) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, payload);
  } catch {
    return null; // content script ainda nao injetado — a aba precisa de F5
  }
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
  const next = { ...DEFAULTS, ...cfg };
  for (const [key, kind] of Object.entries(FIELDS)) {
    const el = $(key);
    if (!el) continue;
    if (kind === 'checkbox') next[key] = el.checked;
    else if (kind === 'number') next[key] = Number(el.value) || 1;
    else next[key] = el.value.trim();
  }
  if (!next.queueFilter) {
    msg('A fila não pode ficar vazia — sem ela nada é assumido.');
    return;
  }
  if (!next.agentName) {
    msg('O agente autorizado não pode ficar vazio.');
    return;
  }
  await chrome.storage.local.set({ cfg: next });
  msg('Salvo.');
  setTimeout(() => msg(''), 1800);
  refresh();
}

async function refresh() {
  const st = await ask({ type: 'zd-status' });
  const box = $('status');
  const note = $('s-note');
  const blocked = $('blocked');

  if (!st) {
    box.className = 'card bad';
    note.textContent = 'Abra o Zendesk e dê F5 na aba.';
    ['g1', 'g2', 'g3'].forEach((g) => mark(g, null));
    blocked.innerHTML = '';
    return;
  }

  const cfg = { ...DEFAULTS, ...(st.cfg || {}) };

  // --- portao 1: fila
  const anyQueueOk = st.eligible > 0 || (st.pending === 0);
  $('g1').textContent = `só "${cfg.queueFilter}"` + (cfg.queueMatchMode === 'contains' ? ' (modo contém)' : '');
  mark('g1', st.pending === 0 ? null : st.eligible > 0);

  // --- portao 2: agente
  if (!st.agent) {
    $('g2').textContent = 'verificando…';
    mark('g2', null);
  } else if (st.agent.ok) {
    $('g2').textContent = `${st.agent.name} ✓ (${st.agent.source})`;
    mark('g2', true);
  } else {
    $('g2').textContent = st.agent.why || 'não autorizado — extensão inerte';
    mark('g2', false);
  }

  // --- portao 3: status
  $('g3').textContent = `só ${cfg.allowedStatuses}`;
  mark('g3', st.pending === 0 ? null : st.eligible > 0);

  $('s-conv').textContent =
    st.convCount === null || st.convCount === undefined
      ? 'botão não achado'
      : `${st.convCount}${st.convCount > 0 && !st.panelOpen ? ' (painel fechado)' : ''}`;
  $('s-mine').textContent = `${st.mine} / ${cfg.maxChats}`;
  $('s-pending').textContent = st.pending;
  $('s-eligible').textContent = st.eligible;

  if (!st.ok) {
    box.className = 'card bad';
    note.textContent = 'Lista de conversas não detectada — use o diagnóstico.';
  } else if (st.agent && !st.agent.ok) {
    box.className = 'card bad';
    note.textContent = 'Bloqueado: agente logado não é o autorizado.';
  } else {
    box.className = 'card';
    note.textContent = st.lastAction
      ? `${st.lastAction} · ${new Date(st.lastActionAt).toLocaleTimeString('pt-BR')}`
      : `Monitorando (${st.listSelectorUsed})`;
  }

  const blind = $('s-blind');
  if (st.blindBlocked) {
    blind.style.display = 'block';
    blind.textContent = `Não disparou — ${st.blindBlocked}`;
  } else {
    blind.style.display = 'none';
  }

  blocked.innerHTML = '';
  for (const b of st.blocked || []) {
    const li = document.createElement('li');
    li.textContent = `${b.key || '(sem nome)'} — ${b.reason}`;
    blocked.appendChild(li);
  }
}

function syncMethodUI() {
  const m = $('serveMethod').value;
  $('shortcut-wrap').style.display = m === 'shortcut' ? 'block' : 'none';
  $('blind-note').style.display = m === 'rowButton' ? 'none' : 'block';
}

$('serveMethod').addEventListener('change', syncMethodUI);
$('save').addEventListener('click', save);

$('diag').addEventListener('click', async () => {
  const res = await ask({ type: 'zd-diag' });
  if (!res?.report) {
    msg('Não consegui falar com a aba do Zendesk.');
    return;
  }
  await navigator.clipboard.writeText(res.report);
  console.log(res.report);
  msg('Diagnóstico copiado.');
});

loadConfig().then(() => { syncMethodUI(); refresh(); });
setInterval(refresh, 1500);
