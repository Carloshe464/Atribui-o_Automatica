const FIELDS = {
  enabled: 'checkbox',
  beep: 'checkbox',
  debug: 'checkbox',
  maxChats: 'number',
  idleMinutes: 'number',
  countSource: 'text',
  serveMethod: 'text',
  shortcut: 'text'
};

// Espelha DEFAULTS do content.js. Se divergir, salvar pelo popup reescreveria
// a config com valores diferentes dos que o content script usa.
const DEFAULTS = {
  enabled: true,
  maxChats: 3,
  idleMinutes: 6,
  countSource: 'auto',
  serveMethod: 'auto',
  shortcut: 'Ctrl+Alt+Q',
  beep: true,
  debug: false
};

const $ = (id) => document.getElementById(id);
const msg = (t) => { $('msg').textContent = t; };

async function ask(payload) {
  const tabs = await chrome.tabs.query({ url: ['https://*.zendesk.com/*', 'https://*.zopim.com/*'] });
  for (const tab of tabs) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, payload);
      if (res) return { res, tabCount: tabs.length };
    } catch {
      /* aba carregada antes da extensao — precisa de F5 */
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
  const next = { ...DEFAULTS, ...cfg };
  for (const [key, kind] of Object.entries(FIELDS)) {
    const el = $(key);
    if (!el) continue;
    if (kind === 'checkbox') next[key] = el.checked;
    else if (kind === 'number') next[key] = Math.max(1, Number(el.value) || 1);
    else next[key] = el.value.trim();
  }
  await chrome.storage.local.set({ cfg: next });
  msg('Salvo.');
  setTimeout(() => msg(''), 1800);
  refresh();
}

const n = (v) => (v === null || v === undefined ? '–' : String(v));

async function refresh() {
  const { res: st, tabCount } = await ask({ type: 'zd-status' });
  const gate = $('gate');
  const gateText = $('gate-text');

  if (!st) {
    gateText.textContent = tabCount
      ? 'Aba do Zendesk sem resposta — dê F5 nela.'
      : 'Nenhuma aba do Zendesk aberta.';
    gate.className = 'bad';
    return;
  }

  gateText.textContent = st.gate || 'livre para puxar';
  gate.className = /parada|não sei|nao sei/.test(st.gate || '') ? 'bad' : st.gate ? '' : 'good';

  $('s-mine').textContent = st.mine === null ? '? (não sei)' : `${st.mine} / ${st.maxChats}`;
  $('s-queue').textContent = n(st.queue) + (st.queueFrom ? ` (${st.queueFrom})` : '');
  $('s-sources').textContent = `${n(st.panelCount)} / ${n(st.tabsCount)} / ${n(st.barCount)}`;

  const notas = [];
  if (st.mineFrom) notas.push(`usando: ${st.mineFrom}`);
  if (st.lastServe) notas.push(`último pull ${st.lastServe.ok ? 'ok' : 'SEM EFEITO'}`);
  if (tabCount > 1) notas.push(`${tabCount} abas abertas`);
  $('s-note').textContent = notas.join(' · ');
}

$('save').addEventListener('click', save);

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
setInterval(refresh, 1200);
