/**
 * Testes end-to-end sem API: monta um DOM parecido com o Agent Workspace,
 * carrega o content.js real e verifica se ele puxou ou nao.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

/** Item do painel de conversas. Com botao "Servir" = esperando na fila. */
const conv = ({ name, waiting = false }) => `
  <div data-test-id="conversation-list-item">
    <span>${name}</span><span>2 min</span>
    ${waiting ? '<button>Servir</button>' : ''}
  </div>`;

/** Aba de ticket aberta no topo. */
const tab = (title) => `<div data-test-id="header-tab"><span>${title}</span></div>`;

async function run({
  panel = [],           // itens do painel de conversas
  tabs = [],            // abas de ticket no topo
  bar = null,           // numero do botao "Conversas" (null = botao ausente)
  barDisabled = false,
  url = 'https://acme.zendesk.com/agent/home',
  cfg = {},
  waitMs = 1600,
  // Simula o Zendesk de verdade: cada pull abre mais uma aba de chat, entao a
  // contagem sobe. E assim que o limite tem chance de segurar o loop.
  tabGrowsOnPull = false,
  killContext = false,
  disableMidFlight = false,
  seed = {}
}) {
  const barHtml =
    bar === null
      ? ''
      : `<button data-test-id="toolbar-serve-chat-button"${barDisabled ? ' disabled' : ''}>Conversas\n${bar}</button>`;

  const dom = new JSDOM(
    `<!doctype html><body>${barHtml}` +
      `<header data-test-id="header-tablist">${tabs.map(tab).join('')}</header>` +
      `<nav>${panel.join('')}</nav></body>`,
    { url, runScripts: 'outside-only' }
  );
  const w = dom.window;

  // jsdom devolve rect zerado; isVisible exige tamanho.
  w.Element.prototype.getBoundingClientRect = () => ({
    width: 200, height: 40, top: 0, left: 0, right: 200, bottom: 40
  });

  const clicks = [];
  w.document.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () =>
      clicks.push(
        b.getAttribute('data-test-id') === 'toolbar-serve-chat-button'
          ? '<botao-conversas>'
          : b.closest('[data-test-id]')?.querySelector('span')?.textContent.trim() || '?'
      )
    );
  });

  const keys = [];
  w.document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && String(e.key).toLowerCase() === 'q') keys.push('Ctrl+Alt+Q');
  });

  if (tabGrowsOnPull) {
    const grow = () => {
      const h = w.document.querySelector('header');
      const el = w.document.createElement('div');
      el.setAttribute('data-test-id', 'header-tab');
      el.innerHTML = `<span>Chat ${h.children.length + 1}</span>`;
      h.appendChild(el);
    };
    w.document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.altKey && String(e.key).toLowerCase() === 'q') grow();
    });
    w.document.querySelectorAll('button').forEach((b) => b.addEventListener('click', grow));
  }

  const stored = {
    cfg: {
      enabled: true, maxChats: 3, idleMinutes: 6,
      countSource: 'auto', serveMethod: 'auto', shortcut: 'Ctrl+Alt+Q',
      beep: false, debug: false,
      ...cfg
    },
    ...seed
  };

  const pick = (k) => {
    if (k === null || k === undefined) return { ...stored };
    const out = {};
    for (const key of Array.isArray(k) ? k : [k]) if (key in stored) out[key] = stored[key];
    return out;
  };

  let reply = null;
  const listeners = [];
  w.chrome = {
    runtime: {
      id: 'test-id',
      lastError: undefined,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: () => {}
    },
    storage: {
      local: {
        get: (k, cb) => cb(pick(k)),
        set: (o, cb) => { Object.assign(stored, o); if (cb) cb(); }
      },
      onChanged: { addListener: () => {} }
    }
  };

  w.eval(SRC);

  // O primeiro ciclo roda em t=0 e pode puxar legitimamente. O que importa
  // nestes cenarios e se ele continua puxando DEPOIS da mudanca.
  let pullsAtChange = null;
  if (killContext || disableMidFlight) {
    await new Promise((r) => setTimeout(r, 400));
    pullsAtChange = clicks.length + keys.length;
    if (disableMidFlight) stored.cfg = { ...stored.cfg, enabled: false };
    if (killContext) w.chrome.runtime.id = undefined;
  }

  await new Promise((r) => setTimeout(r, waitMs));
  listeners[0]?.({ type: 'zd-status' }, null, (res) => { reply = res; });
  dom.window.close();

  const total = clicks.length + keys.length;
  return {
    clicks, keys, status: reply, stored,
    pullsAfterChange: pullsAtChange === null ? total : total - pullsAtChange
  };
}

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail ?? ''}`); }
};
const pulled = (r) => r.keys.length + r.clicks.length > 0;

(async () => {
  console.log('\n--- 1. Puxa chat automaticamente ---');

  let r = await run({ panel: [conv({ name: 'Novo', waiting: true })] });
  check('chat esperando no painel => puxa', pulled(r), JSON.stringify(r.status?.gate));

  r = await run({ panel: [], bar: 2, barDisabled: false });
  check('sem painel, barra com 2 => puxa pelo botao', r.clicks.includes('<botao-conversas>'), JSON.stringify(r.clicks));

  // Linha do painel tem prioridade: e o unico caminho que escolhe QUAL chat.
  r = await run({ panel: [conv({ name: 'Novo', waiting: true })], bar: 1, barDisabled: true });
  check('linha do painel => clica nela, nao no atalho', r.clicks[0] === 'Novo' && r.keys.length === 0, JSON.stringify({ k: r.keys, c: r.clicks }));

  r = await run({ panel: [], bar: 2, cfg: { serveMethod: 'shortcut' } });
  check('metodo atalho => dispara Ctrl+Alt+Q', r.keys.length === 1 && r.clicks.length === 0, JSON.stringify({ k: r.keys, c: r.clicks }));

  r = await run({ panel: [], bar: 0, barDisabled: true });
  check('nada esperando => nao puxa', !pulled(r), JSON.stringify(r.status?.gate));

  console.log('\n--- Telas onde deve funcionar ---');

  for (const p of ['/agent/home', '/agent/tickets/1044082', '/agent/filters/21225438247447', '/agent/dashboard']) {
    r = await run({ panel: [conv({ name: 'Novo', waiting: true })], url: `https://acme.zendesk.com${p}` });
    check(`${p} => puxa`, pulled(r), JSON.stringify(r.status?.gate));
  }

  r = await run({ panel: [conv({ name: 'Novo', waiting: true })], url: 'https://acme.zendesk.com/hc/pt-br/artigo' });
  check('fora de /agent/ => nao puxa', !pulled(r), JSON.stringify(r.clicks));

  console.log('\n--- 2. Respeita o limite ---');

  r = await run({
    panel: [conv({ name: 'A' }), conv({ name: 'B' }), conv({ name: 'C' }), conv({ name: 'Novo', waiting: true })],
    cfg: { maxChats: 3 }
  });
  check('3 no painel, limite 3 => nao puxa', !pulled(r), JSON.stringify(r.status?.gate));
  check('  e reporta o limite', /limite atingido: 3\/3/.test(r.status?.gate || ''), JSON.stringify(r.status?.gate));

  r = await run({
    panel: [conv({ name: 'A' }), conv({ name: 'B' }), conv({ name: 'Novo', waiting: true })],
    cfg: { maxChats: 3 }
  });
  check('2 no painel, limite 3 => puxa', pulled(r), JSON.stringify(r.status?.gate));

  r = await run({ panel: [], tabs: ['Chat 1', 'Chat 2', 'Chat 3'], bar: 1, cfg: { maxChats: 3, countSource: 'tabs' } });
  check('3 abas, limite 3 => nao puxa', !pulled(r), JSON.stringify(r.status?.gate));

  r = await run({ panel: [], bar: 4, cfg: { maxChats: 4, countSource: 'bar' } });
  check('barra=4, limite 4 => nao puxa', !pulled(r), JSON.stringify(r.status?.gate));

  r = await run({ panel: [], tabs: [], bar: null, cfg: { countSource: 'bar' } });
  check('sem fonte de contagem => nao puxa (fail-closed)', !pulled(r), JSON.stringify(r.status?.gate));
  check('  e diz que nao sabe', /nao sei quantos/.test(r.status?.gate || ''), JSON.stringify(r.status?.gate));

  console.log('\n--- Nao puxar duas vezes ---');

  r = await run({ panel: [conv({ name: 'Novo', waiting: true })], waitMs: 4500 });
  check('varios ciclos com 1 na fila => 1 pull so', r.keys.length + r.clicks.length === 1, JSON.stringify({ k: r.keys, c: r.clicks }));

  r = await run({
    panel: [conv({ name: 'Novo', waiting: true })],
    seed: { serveLock: { id: 'outra-aba', ts: Date.now() } }
  });
  check('outra aba puxando => nao puxa junto', !pulled(r), JSON.stringify(r.status?.gate));

  console.log('\n--- O cenario do loop: fila que nunca acaba ---');

  // Era exatamente isto que acontecia: fila sempre com chat, e a extensao
  // puxando ciclo apos ciclo. Aqui cada pull abre uma aba, entao a contagem
  // sobe e o limite tem chance de segurar.
  r = await run({
    panel: [], bar: 9, tabGrowsOnPull: true, waitMs: 30000,
    cfg: { maxChats: 3, countSource: 'auto' }
  });
  const total = r.keys.length + r.clicks.length;
  check(`fila infinita, limite 3 => para em 3 (puxou ${total})`, total === 3, JSON.stringify({ k: r.keys.length, c: r.clicks.length }));
  check('  e o motivo e o limite', /limite atingido: 3\/3/.test(r.status?.gate || ''), JSON.stringify(r.status?.gate));

  // ~8s por pull (espera confirmar o anterior antes de tentar de novo), entao
  // 5 pulls precisam de ~45s de janela.
  r = await run({
    panel: [], bar: 9, tabGrowsOnPull: true, waitMs: 50000,
    cfg: { maxChats: 5, countSource: 'auto' }
  });
  check('mesmo cenario com limite 5 => para em 5', r.keys.length + r.clicks.length === 5, JSON.stringify({ k: r.keys.length, c: r.clicks.length }));

  console.log('\n--- Contagem disponivel mesmo com zero abas ---');

  r = await run({ panel: [], tabs: [], bar: 2 });
  check('zero abas => conta 0, nao "nao sei"', r.status?.mine === 0, JSON.stringify({ m: r.status?.mine, g: r.status?.gate }));
  check('  e puxa', pulled(r), JSON.stringify(r.status?.gate));

  console.log('\n--- Trava e instancia orfa ---');

  r = await run({ panel: [conv({ name: 'Novo', waiting: true })], cfg: { enabled: false } });
  check('desligado => nao puxa', !pulled(r), JSON.stringify(r.clicks));

  // Fila sempre cheia: sem trava, ele puxaria a cada ciclo indefinidamente.
  const filaInfinita = [
    conv({ name: 'N1', waiting: true }),
    conv({ name: 'N2', waiting: true }),
    conv({ name: 'N3', waiting: true })
  ];

  r = await run({ panel: filaInfinita, cfg: { maxChats: 99 }, disableMidFlight: true, waitMs: 9000 });
  check('desligado em voo (cache diz ligado) => para de puxar', r.pullsAfterChange === 0, `${r.pullsAfterChange} pulls depois`);

  r = await run({ panel: filaInfinita, cfg: { maxChats: 99 }, killContext: true, waitMs: 9000 });
  check('extensao recarregada sem F5 => instancia orfa para', r.pullsAfterChange === 0, `${r.pullsAfterChange} pulls depois`);

  console.log('\n--- 3. Contagem e fila reportadas ---');

  r = await run({ panel: [conv({ name: 'A' }), conv({ name: 'Novo', waiting: true })], tabs: ['T1'], bar: 5 });
  check('painel tem prioridade sobre abas e barra', r.status?.mine === 1 && r.status?.mineFrom === 'painel', JSON.stringify(r.status));
  check('  conta a fila separada dos meus', r.status?.queue === 1, JSON.stringify(r.status?.queue));

  r = await run({ panel: [], tabs: ['T1', 'T2'], bar: 9 });
  check('sem painel => usa abas', r.status?.mine === 2 && r.status?.mineFrom === 'abas', JSON.stringify(r.status));

  console.log(`\n=== ${pass} passaram, ${fail} falharam ===\n`);
  process.exit(fail ? 1 : 0);
})();
