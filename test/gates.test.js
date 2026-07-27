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

async function run({
  rows, agentName = 'Carlos Lemos', cfg = {}, mutate = null, waitMs = 1500,
  url = 'https://acme.zendesk.com/agent/dashboard',
  bar = null,           // contador do botao "Conversas" da barra superior
  barDisabled = false,  // como no ambiente real: fica desabilitado em 0
  seed = {},            // estado inicial do chrome.storage (disjuntor, lock)
  killContext = false,  // simula extensao recarregada sem F5
  disableMidFlight = false // desliga a trava no disco depois de carregada
}) {
  const barHtml =
    bar === null
      ? ''
      : `<button data-test-id="toolbar-serve-chat-button"${barDisabled ? ' disabled' : ''}>Conversas\n${bar}</button>`;

  const dom = new JSDOM(`<!doctype html><body>${barHtml}<nav>${rows.join('')}</nav></body>`, {
    url,
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
      strictQueueGate: true,
      mineSource: 'dom',
      breakerMinutes: 10,
      beep: false, debug: false,
      listItemSelector: '', serveSelector: '', queueSelector: '', statusSelector: '',
      ...cfg
    },
    ...seed
  };

  let statusReply = null;
  const listeners = [];
  // Storage real em memoria: o disjuntor e o lock entre abas dependem de
  // get/set funcionando de verdade, nao de um stub que ignora escrita.
  const pick = (keys) => {
    if (keys === null || keys === undefined) return { ...stored };
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const k of list) if (k in stored) out[k] = stored[k];
    return out;
  };

  w.chrome = {
    runtime: {
      id: 'test-extension-id', // contextAlive() checa isto
      lastError: undefined,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: () => {}
    },
    storage: {
      local: {
        get: (keys, cb) => cb(pick(keys)),
        set: (obj, cb) => { Object.assign(stored, obj); if (cb) cb(); }
      },
      onChanged: { addListener: () => {} }
    }
  };

  // Permite ao teste inspecionar/derrubar o storage compartilhado.
  w.__stored = stored;
  w.fetch = async (url) => {
    if (!String(url).includes('/api/v2/users/me.json')) throw new Error('404');
    return { ok: true, json: async () => ({ user: { name: agentName, id: 1 } }) };
  };

  w.eval(SRC);

  // Deixa a config carregar, entao muda o mundo por baixo da instancia.
  if (killContext || disableMidFlight) {
    await new Promise((r) => setTimeout(r, 200));
    // Cache em memoria segue com enabled:true; so o disco muda.
    if (disableMidFlight) stored.cfg = { ...stored.cfg, enabled: false };
    if (killContext) w.chrome.runtime.id = undefined;
  }

  await new Promise((r) => setTimeout(r, waitMs)); // deixa o fetch resolver + 1 ciclo

  // Simula troca de tela: a lista e desmontada e o ciclo roda de novo.
  if (mutate) {
    mutate(w.document);
    await new Promise((r) => setTimeout(r, 1500));
  }

  listeners[0]?.({ type: 'zd-status' }, null, (res) => { statusReply = res; });
  dom.window.close();
  return { clicks, keys, status: statusReply, stored };
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
  check('  e reporta o motivo', /trava de fila/.test(r.status?.gateReason || ''), JSON.stringify(r.status?.gateReason));

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
  // Importante: a contagem NAO pode cair a zero quando a lista some, senao
  // navegar entre telas liberaria o limite e o pull viraria loop.
  check('  contagem sobrevive via cache (nao zera e libera o limite)', r.status?.mine === 1, JSON.stringify(r.status?.mine));
  check('  e a fonte indica que veio do cache', /cache/.test(r.status?.mineSourceUsed || ''), JSON.stringify(r.status?.mineSourceUsed));

  console.log('\n--- Travas anti-loop ---');

  const elegivel = () => [row({ name: 'Novo1', queue: NFS, status: 'Novo', pending: true })];

  r = await run({ rows: elegivel(), cfg: { enabled: false } });
  check('trava desligada => nao puxa', r.clicks.length === 0, JSON.stringify(r.clicks));

  // Disjuntor: ja houve maxChats pulls dentro da janela.
  r = await run({
    rows: elegivel(),
    seed: { recentServes: [Date.now(), Date.now(), Date.now()] }
  });
  check('disjuntor cheio (3 pulls na janela) => nao puxa', r.clicks.length === 0, JSON.stringify(r.clicks));
  check('  e reporta o disjuntor', /disjuntor/.test(r.status?.gateReason || ''), JSON.stringify(r.status?.gateReason));

  // Pulls antigos, fora da janela de 10 min, nao devem contar.
  r = await run({
    rows: elegivel(),
    seed: { recentServes: [Date.now() - 20 * 60000, Date.now() - 15 * 60000, Date.now() - 11 * 60000] }
  });
  check('disjuntor com pulls fora da janela => puxa normal', r.clicks.length === 1, JSON.stringify(r.clicks));

  // Lock de outra aba ainda quente.
  r = await run({
    rows: elegivel(),
    seed: { serveLock: { id: 'outra-aba', ts: Date.now() } }
  });
  check('lock de outra aba => nao puxa', r.clicks.length === 0, JSON.stringify(r.clicks));

  // Contexto invalidado: o setInterval orfao nao pode continuar puxando.
  r = await run({ rows: elegivel(), killContext: true });
  check('contexto invalidado => nao puxa', r.clicks.length === 0, JSON.stringify(r.clicks));

  // Desligar DEPOIS de carregado: o cache em memoria diz enabled:true, mas a
  // releitura do disco tem que vencer. Era exatamente a falha relatada.
  r = await run({
    rows: elegivel(),
    disableMidFlight: true
  });
  check('desligado em voo (cache diz ligado) => nao puxa', r.clicks.length === 0, JSON.stringify(r.clicks));

  // O disjuntor precisa registrar o pull, senao nao segura nada.
  r = await run({ rows: elegivel() });
  check('pull bem-sucedido registra no disjuntor', (r.stored?.recentServes || []).length === 1, JSON.stringify(r.stored?.recentServes));

  console.log('\n--- Telas onde pode puxar ---');

  for (const p of ['/agent/home', '/agent/tickets/1043700', '/agent/filters/21225438247447', '/agent/dashboard']) {
    r = await run({ rows: elegivel(), url: `https://acme.zendesk.com${p}` });
    check(`${p} => puxa`, r.clicks.length === 1, JSON.stringify(r.status?.gateReason));
  }

  r = await run({ rows: elegivel(), url: 'https://acme.zendesk.com/hc/pt-br/articles/123' });
  check('fora de /agent/ => nao puxa', r.clicks.length === 0, JSON.stringify(r.clicks));

  r = await run({
    rows: elegivel(),
    url: 'https://acme.zendesk.com/agent/filters/99',
    cfg: { allowedPaths: '/agent/home' }
  });
  check('telas restritas por config => respeita a lista', r.clicks.length === 0, JSON.stringify(r.clicks));

  console.log('\n--- Contagem pelo contador da barra ---');

  r = await run({ rows: elegivel(), bar: 0, cfg: { mineSource: 'bar' } });
  check('barra=0 => puxa', r.clicks.length === 1, JSON.stringify(r.status?.gateReason));

  r = await run({ rows: elegivel(), bar: 3, cfg: { mineSource: 'bar' } });
  check('barra=3 com limite 3 => nao puxa', r.clicks.length === 0, JSON.stringify(r.clicks));
  check('  e reporta o limite', /limite atingido: 3\/3/.test(r.status?.gateReason || ''), JSON.stringify(r.status?.gateReason));

  r = await run({ rows: elegivel(), bar: null, cfg: { mineSource: 'bar' } });
  check('sem botao da barra => nao puxa (fail-closed)', r.clicks.length === 0, JSON.stringify(r.status?.gateReason));

  r = await run({ rows: elegivel(), bar: 2, cfg: { mineSource: 'bar' } });
  check('barra reportada no status', r.status?.barMine === 2, JSON.stringify(r.status?.barMine));

  console.log('\n--- Fila pela tabela da view (estrutura real do diagnostico) ---');

  // Reproduz exatamente as linhas capturadas em beteltecnologia.zendesk.com
  const vrow = ({ id, subject, badge, assignee }) => `
    <div data-test-id="generic-table-row">
      <span data-test-id="status-badge-${badge}">•</span>
      <span data-test-id="ticket-table-cells-custom-status">${badge === 'new' ? 'Novo' : 'Aberto'}</span>
      <span data-test-id="generic-table-cells-id">#${id}</span>
      <span data-test-id="ticket-table-cells-subject">${subject}</span>
      <span data-test-id="ticket-table-cells-assignee">${assignee}</span>
      <span data-test-id="ticket-table-cells-custom-field-360032624354"></span>
    </div>`;

  const VIEW_URL = 'https://acme.zendesk.com/agent/filters/21225438247447';
  const realView = [
    vrow({ id: 1044095, subject: 'Conversa com Vanderlei', badge: 'new', assignee: '-' }),
    vrow({ id: 1044082, subject: 'Conversa com NAYANE', badge: 'open', assignee: 'Carlos Lemos' }),
    vrow({ id: 1044085, subject: 'Conversa com SILVIO', badge: 'open', assignee: 'João Pedro Vianey' })
  ];

  const vcfg = { mineSource: 'view', serveMethod: 'rowButton', allowedViewIds: '21225438247447' };

  r = await run({ rows: realView, url: VIEW_URL, cfg: vcfg, bar: 0 });
  check('conta 1 chat meu pelo responsavel', r.status?.viewMine === 1, JSON.stringify(r.status?.viewMine));
  check('ve 1 disponivel (novo + sem responsavel)', r.status?.queueWaiting === 1, JSON.stringify(r.status?.queueWaiting));
  check('  e identifica qual', /1044095/.test(JSON.stringify(r.status?.viewAvail)), JSON.stringify(r.status?.viewAvail));
  check('barra=0 nao bloqueia mais a fila', !/nenhum chat esperando/.test(r.status?.gateReason || ''), JSON.stringify(r.status?.gateReason));

  // Ticket de outro analista nao pode ser contado nem puxado.
  r = await run({
    rows: [vrow({ id: 1, subject: 'Conversa com X', badge: 'open', assignee: 'João Pedro Vianey' })],
    url: VIEW_URL, cfg: vcfg, bar: 0
  });
  check('ticket de outro analista => nao conta como meu', r.status?.viewMine === 0, JSON.stringify(r.status?.viewMine));
  check('  nem como disponivel', r.status?.queueWaiting === 0, JSON.stringify(r.status?.queueWaiting));

  // Aberto e sem responsavel: nao e "novo", nao pode ser tocado.
  r = await run({
    rows: [vrow({ id: 2, subject: 'Conversa com Y', badge: 'open', assignee: '-' })],
    url: VIEW_URL, cfg: vcfg, bar: 0
  });
  check('aberto sem responsavel => nao disponivel (so novo)', r.status?.queueWaiting === 0, JSON.stringify(r.status?.queueWaiting));

  // View fora da lista permitida.
  r = await run({
    rows: realView, url: 'https://acme.zendesk.com/agent/filters/999', cfg: vcfg, bar: 0
  });
  check('view nao permitida => bloqueia', /nao esta na lista de filas permitidas/.test(r.status?.gateReason || ''), JSON.stringify(r.status?.gateReason));

  // Limite pela contagem da view.
  r = await run({
    rows: [
      vrow({ id: 1, subject: 'A', badge: 'open', assignee: 'Carlos Lemos' }),
      vrow({ id: 2, subject: 'B', badge: 'open', assignee: 'Carlos Lemos' }),
      vrow({ id: 3, subject: 'C', badge: 'open', assignee: 'Carlos Lemos' }),
      vrow({ id: 4, subject: 'D', badge: 'new', assignee: '-' })
    ],
    url: VIEW_URL, cfg: { ...vcfg, maxChats: 3 }, bar: 0
  });
  check('3 meus na view com limite 3 => bloqueia', /limite atingido: 3\/3/.test(r.status?.gateReason || ''), JSON.stringify(r.status?.gateReason));

  console.log('\n--- Puxar: cenario real (view com chat novo, barra em 0/desabilitada) ---');

  const autoCfg = { mineSource: 'view', serveMethod: 'auto', allowedViewIds: '21225438247447' };

  r = await run({ rows: realView, url: VIEW_URL, cfg: autoCfg, bar: 0, barDisabled: true });
  check('barra desabilitada => cai no atalho Ctrl+Alt+Q', r.keys.length === 1, JSON.stringify({ keys: r.keys, gate: r.status?.gateReason }));
  check('  e nao clica no botao desabilitado', r.clicks.length === 0, JSON.stringify(r.clicks));
  check('  registra o pull no disjuntor', (r.stored?.recentServes || []).length === 1, JSON.stringify(r.stored?.recentServes));

  // Botao habilitado: prefere o clique real, sem disparar o atalho junto.
  r = await run({ rows: realView, url: VIEW_URL, cfg: autoCfg, bar: 2, barDisabled: false });
  check('barra habilitada => clica no botao', r.clicks.includes('<botao-global>'), JSON.stringify(r.clicks));
  check('  e nao dispara o atalho junto (pull duplo)', r.keys.length === 0, JSON.stringify(r.keys));

  // Nada disponivel na view: nao pode disparar nada, mesmo com barra habilitada.
  r = await run({
    rows: [vrow({ id: 9, subject: 'Conversa com Z', badge: 'open', assignee: 'Carlos Lemos' })],
    url: VIEW_URL, cfg: autoCfg, bar: 4, barDisabled: false
  });
  check('view sem chat novo => nao puxa mesmo com barra > 0', r.keys.length === 0 && r.clicks.length === 0, JSON.stringify({ keys: r.keys, clicks: r.clicks }));

  // Limite estourado nao pode ser burlado pelo atalho.
  r = await run({
    rows: [
      vrow({ id: 1, subject: 'A', badge: 'open', assignee: 'Carlos Lemos' }),
      vrow({ id: 2, subject: 'B', badge: 'open', assignee: 'Carlos Lemos' }),
      vrow({ id: 3, subject: 'C', badge: 'new', assignee: '-' })
    ],
    url: VIEW_URL, cfg: { ...autoCfg, maxChats: 2 }, bar: 0, barDisabled: true
  });
  check('limite atingido => atalho nao dispara', r.keys.length === 0, JSON.stringify({ keys: r.keys, gate: r.status?.gateReason }));

  console.log(`\n=== ${pass} passaram, ${fail} falharam ===\n`);
  process.exit(fail ? 1 : 0);
})();
