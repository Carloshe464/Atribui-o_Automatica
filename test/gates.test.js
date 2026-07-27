/**
 * Testa as 3 travas end-to-end: monta um DOM parecido com a lista de conversas
 * do Agent Workspace, carrega o content.js real e verifica se ele clicou ou nao.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function row({ name, queue, status, badge, pending, extra = '' }) {
  return `
  <div data-test-id="conversation-list-item">
    <span>${name}</span>
    ${queue ? `<span>${queue}</span>` : ''}
    ${status ? `<span>${status}</span>` : ''}
    ${badge ? `<span data-test-id="status-badge-${badge}">•</span>` : ''}
    <span>2 min</span>
    ${extra}
    ${pending ? '<button>Servir</button>' : ''}
  </div>`;
}

async function run({ rows, agentName = 'Carlos Lemos', cfg = {}, mutate = null, waitMs = 1500 }) {
  const dom = new JSDOM(`<!doctype html><body><nav>${rows.join('')}</nav></body>`, {
    url: 'https://acme.zendesk.com/agent/dashboard',
    runScripts: 'outside-only'
  });
  const w = dom.window;

  // jsdom devolve rect zerado; isVisible exige tamanho.
  w.Element.prototype.getBoundingClientRect = () => ({
    width: 200, height: 40, top: 0, left: 0, right: 200, bottom: 40
  });

  const clicks = [];
  w.document.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      const testId = b.getAttribute('data-test-id');
      clicks.push(
        testId === 'toolbar-serve-chat-button'
          ? '<botao-global>'
          : b.closest('[data-test-id]').querySelector('span').textContent.trim()
      );
    });
  });

  // Captura o atalho como se a pagina do Zendesk o escutasse.
  const keys = [];
  w.document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && String(e.key).toLowerCase() === 'q') keys.push('Ctrl+Alt+Q');
  });

  const stored = {
    cfg: {
      enabled: true, maxChats: 3, idleMinutes: 6,
      queueFilter: 'Suporte Especializado (NFs)',
      queueMatchMode: 'exact',
      agentName: 'Carlos Lemos',
      allowedStatuses: 'novo',
      // As regras 1-3 sao testadas no modo que escolhe o chat; o modo cego
      // tem sua propria secao, com a trava de "todos elegiveis".
      serveMethod: 'rowButton',
      shortcut: 'Ctrl+Alt+Q',
      beep: false, debug: false,
      listItemSelector: '', serveSelector: '', queueSelector: '', statusSelector: '',
      ...cfg
    }
  };

  let statusReply = null;
  const listeners = [];
  w.chrome = {
    storage: {
      local: { get: (k, cb) => cb(stored) },
      onChanged: { addListener: () => {} }
    },
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: () => {}
    }
  };
  w.fetch = async (url) => {
    if (!String(url).includes('/api/v2/users/me.json')) throw new Error('404');
    return { ok: true, json: async () => ({ user: { name: agentName, id: 1 } }) };
  };

  w.eval(SRC);
  await new Promise((r) => setTimeout(r, waitMs)); // deixa o fetch resolver + 1 ciclo

  // Simula troca de tela: a lista e desmontada e o ciclo roda de novo.
  if (mutate) {
    mutate(w.document);
    await new Promise((r) => setTimeout(r, 1500));
  }

  listeners[0]?.({ type: 'zd-status' }, null, (res) => { statusReply = res; });
  dom.window.close();
  return { clicks, keys, status: statusReply };
}

const NFS = 'Suporte Especializado (NFs)';
let pass = 0, fail = 0;

function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  ${detail ?? ''}`); }
}

(async () => {
  console.log('\n--- Regra 1: apenas a fila Suporte Especializado (NFs) ---');

  let r = await run({ rows: [row({ name: 'Joana', queue: NFS, status: 'Novo', pending: true })] });
  check('fila correta + status novo => assume', r.clicks.length === 1, JSON.stringify(r.clicks));

  r = await run({ rows: [row({ name: 'Bruno', queue: 'Suporte Geral', status: 'Novo', pending: true })] });
  check('outra fila => bloqueia', r.clicks.length === 0, JSON.stringify(r.clicks));

  r = await run({ rows: [row({ name: 'Ana', queue: 'Suporte Especializado (NFs) VIP', status: 'Novo', pending: true })] });
  check('fila com sufixo (superstring) => bloqueia', r.clicks.length === 0, JSON.stringify(r.clicks));

  r = await run({ rows: [row({ name: 'Caio', queue: null, status: 'Novo', pending: true })] });
  check('sem rotulo de fila => bloqueia (fail-closed)', r.clicks.length === 0, JSON.stringify(r.clicks));

  r = await run({
    rows: [row({ name: 'Duda', queue: null, status: 'Novo', pending: true,
                 extra: `<span>cliente escreveu: Suporte Especializado (NFs) resolve?</span>` })]
  });
  check('nome da fila so no texto do cliente => bloqueia', r.clicks.length === 0, JSON.stringify(r.clicks));

  r = await run({
    rows: [
      row({ name: 'Bruno', queue: 'Suporte Geral', status: 'Novo', pending: true }),
      row({ name: 'Joana', queue: NFS, status: 'Novo', pending: true })
    ]
  });
  check('escolhe o da fila certa ignorando o primeiro', r.clicks[0] === 'Joana', JSON.stringify(r.clicks));

  console.log('\n--- Regra 2: apenas o agente Carlos Lemos ---');

  r = await run({ rows: [row({ name: 'Joana', queue: NFS, status: 'Novo', pending: true })], agentName: 'Marina Souza' });
  check('outro agente logado => extensao inerte', r.clicks.length === 0, JSON.stringify(r.clicks));
  check('  e reporta o motivo', r.status?.agent?.ok === false && /Marina/.test(r.status.agent.why || ''), JSON.stringify(r.status?.agent));

  r = await run({ rows: [row({ name: 'Joana', queue: NFS, status: 'Novo', pending: true })], agentName: 'Carlos Lemos Ferreira' });
  check('nome completo maior contendo o autorizado => assume', r.clicks.length === 1, JSON.stringify(r.clicks));

  console.log('\n--- Regra 3: apenas status Novo ---');

  for (const st of ['Aberto', 'Pendente', 'Resolvido', 'Em espera', 'Aguardando']) {
    r = await run({ rows: [row({ name: 'X', queue: NFS, status: st, pending: true })] });
    check(`status "${st}" => bloqueia`, r.clicks.length === 0, JSON.stringify(r.clicks));
  }

  r = await run({ rows: [row({ name: 'Y', queue: NFS, status: null, pending: true })] });
  check('sem status => bloqueia (fail-closed)', r.clicks.length === 0, JSON.stringify(r.clicks));

  r = await run({ rows: [row({ name: 'Z', queue: NFS, status: 'New', pending: true })] });
  check('status em ingles "New" => assume (alias)', r.clicks.length === 1, JSON.stringify(r.clicks));

  console.log('\n--- Regra 3 via badge (data-test-id="status-badge-*") ---');

  r = await run({ rows: [row({ name: 'B1', queue: NFS, badge: 'new', pending: true })] });
  check('badge "new" sem texto de status => assume', r.clicks.length === 1, JSON.stringify(r.clicks));

  for (const b of ['open', 'pending', 'hold', 'solved', 'closed']) {
    r = await run({ rows: [row({ name: 'B', queue: NFS, badge: b, pending: true })] });
    check(`badge "${b}" => bloqueia`, r.clicks.length === 0, JSON.stringify(r.clicks));
  }

  r = await run({ rows: [row({ name: 'B2', queue: NFS, badge: 'open', status: 'Novo', pending: true })] });
  check('badge "open" prevalece sobre texto "Novo" => bloqueia', r.clicks.length === 0, JSON.stringify(r.clicks));

  console.log('\n--- Modo cego (Ctrl+Alt+Q): so dispara se TODOS forem elegiveis ---');

  const SC = { serveMethod: 'shortcut' };

  r = await run({ cfg: SC, rows: [row({ name: 'A', queue: NFS, status: 'Novo', pending: true })] });
  check('1 pendente elegivel => dispara o atalho', r.keys.length === 1, JSON.stringify(r.keys));

  r = await run({
    cfg: SC,
    rows: [
      row({ name: 'A', queue: NFS, status: 'Novo', pending: true }),
      row({ name: 'B', queue: NFS, status: 'Novo', pending: true })
    ]
  });
  check('2 pendentes, ambos elegiveis => dispara', r.keys.length === 1, JSON.stringify(r.keys));

  r = await run({
    cfg: SC,
    rows: [
      row({ name: 'A', queue: NFS, status: 'Novo', pending: true }),
      row({ name: 'B', queue: 'Suporte Geral', status: 'Novo', pending: true })
    ]
  });
  check('fila mista (outra fila junto) => NAO dispara', r.keys.length === 0, JSON.stringify(r.keys));
  check('  e reporta o motivo', /fila mista/.test(r.status?.blindBlocked || ''), JSON.stringify(r.status?.blindBlocked));

  r = await run({
    cfg: SC,
    rows: [
      row({ name: 'A', queue: NFS, status: 'Novo', pending: true }),
      row({ name: 'B', queue: NFS, status: 'Aberto', pending: true })
    ]
  });
  check('fila mista (um ja aberto) => NAO dispara', r.keys.length === 0, JSON.stringify(r.keys));

  r = await run({ cfg: SC, rows: [row({ name: 'A', queue: NFS, status: 'Novo', pending: false })] });
  check('nenhum pendente => nao dispara', r.keys.length === 0, JSON.stringify(r.keys));

  r = await run({ cfg: SC, rows: [], agentName: 'Carlos Lemos' });
  check('lista nao detectada => nao dispara (fail-closed)', r.keys.length === 0, JSON.stringify(r.keys));

  r = await run({ cfg: SC, rows: [row({ name: 'A', queue: NFS, status: 'Novo', pending: true })], agentName: 'Outro Agente' });
  check('agente errado => nao dispara', r.keys.length === 0, JSON.stringify(r.keys));

  r = await run({ cfg: { ...SC, shortcut: 'Ctrl+Alt+J' }, rows: [row({ name: 'A', queue: NFS, status: 'Novo', pending: true })] });
  check('atalho configuravel: Ctrl+Alt+J nao dispara o listener de Q', r.keys.length === 0, JSON.stringify(r.keys));

  console.log('\n--- Limite de simultaneos ---');

  r = await run({
    rows: [
      row({ name: 'M1', queue: NFS, status: 'Aberto', pending: false }),
      row({ name: 'M2', queue: NFS, status: 'Aberto', pending: false }),
      row({ name: 'M3', queue: NFS, status: 'Aberto', pending: false }),
      row({ name: 'Novo1', queue: NFS, status: 'Novo', pending: true })
    ]
  });
  check('3 chats meus => nao assume o 4o', r.clicks.length === 0, JSON.stringify(r.clicks));
  check('  contagem de "meus" correta', r.status?.mine === 3, JSON.stringify(r.status?.mine));

  r = await run({
    rows: [
      row({ name: 'M1', queue: NFS, status: 'Aberto', pending: false }),
      row({ name: 'M2', queue: NFS, status: 'Aberto', pending: false }),
      row({ name: 'Novo1', queue: NFS, status: 'Novo', pending: true })
    ]
  });
  check('2 chats meus => assume o 3o', r.clicks.length === 1, JSON.stringify(r.clicks));

  console.log('\n--- Timer de silencio sobrevive a troca de tela ---');

  r = await run({ rows: [row({ name: 'Cliente A', queue: NFS, status: 'Aberto', pending: false })] });
  check('conversa minha entra em rastreio', r.status?.tracked === 1, JSON.stringify(r.status?.tracked));

  r = await run({
    rows: [row({ name: 'Cliente A', queue: NFS, status: 'Aberto', pending: false })],
    // desmonta a lista, como o Agent Workspace faz ao navegar
    mutate: (doc) => { doc.querySelector('nav').innerHTML = ''; }
  });
  check('lista desmontada => nao perde o rastreio (carencia)', r.status?.tracked === 1, JSON.stringify(r.status?.tracked));
  check('  e a contagem de "meus" reflete a tela atual', r.status?.mine === 0, JSON.stringify(r.status?.mine));

  console.log(`\n=== ${pass} passaram, ${fail} falharam ===\n`);
  process.exit(fail ? 1 : 0);
})();
