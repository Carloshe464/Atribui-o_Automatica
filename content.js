/**
 * Zendesk Auto-Atribuicao — content script
 *
 * OBJETIVO: enquanto a trava estiver habilitada, puxar chat novo da fila
 * automaticamente ate o limite de simultaneos. Servir atribui o chat para quem
 * esta logado na aba — nao existe caminho para atribuir a outra pessoa —, entao
 * "atribuir pro analista logado" e consequencia direta de puxar.
 *
 * REGRA CENTRAL: fail-closed. Toda condicao precisa ser positivamente
 * confirmada. Qualquer duvida => nao puxa. Puxar demais e muito pior do que
 * deixar de puxar: vira loop de atribuicao.
 *
 * O QUE DECIDE UM PULL — todas obrigatorias, em ordem:
 *   1. contexto da extensao vivo    <- instancia orfa se autodestroi
 *   2. cfg.enabled                  <- reconfirmado NO DISCO antes de agir
 *   3. agente autorizado
 *   4. meus chats < cfg.maxChats    <- sem contagem confiavel, NAO puxa
 *   5. numa tela do workspace (/agent/*)
 *   6. existe chat esperando na fila
 *   7. fila e status conferem       <- cfg.strictQueueGate, ligada por padrao
 *   8. disjuntor: teto de pulls na janela movel, independente do DOM
 *   9. lock entre abas: so uma instancia puxa por vez
 *
 * As tres ultimas existem porque as anteriores dependem de ler o DOM, e o DOM
 * do Agent Workspace muda a cada tela. O disjuntor e a rede final: mesmo que
 * toda a deteccao erre junto, ele limita o estrago a maxChats por janela.
 *
 * Todo bloqueio guarda o motivo em status.gateReason, exibido no popup.
 */
(() => {
  'use strict';

  if (window.__zdAutoAssign) return;
  window.__zdAutoAssign = true;

  const CFG_VERSION = 3;

  const DEFAULTS = {
    cfgVersion: CFG_VERSION,

    enabled: true,
    maxChats: 3,
    idleMinutes: 6,

    // --- contagem de "meus chats" (o limite depende dela)
    //   'auto' - lista do DOM quando confiavel, senao a API
    //   'dom'  - so a lista do DOM
    //   'api'  - so a busca da API (independe da tela aberta)
    //   'bar'  - o numero do botao "Conversas" da barra superior
    // Nao existe modo "sem limite": sem contagem confiavel, nao puxa.
    mineSource: 'auto',
    mineApiQuery: 'type:ticket assignee:{me} status<solved',

    // Telas onde pode puxar. Vazio = qualquer /agent/.
    allowedPaths: '',

    // Views (filas) de onde pode puxar, por id do path /agent/filters/<id>.
    // A view E a fila: garantia mais forte que casar texto na linha.
    allowedViewIds: '21225438247447',

    // --- como puxar
    //   'auto'         - clica no botao da barra; se nao der, dispara o atalho
    //   'globalButton' - so o botao da barra (toolbar-serve-chat-button)
    //   'shortcut'     - so o atalho (Ctrl+Alt+Q)
    //   'rowButton'    - clica no "Servir" da linha (exige a lista no DOM)
    serveMethod: 'auto',
    shortcut: 'Ctrl+Alt+Q',

    // --- trava de fila/status antes de puxar (ligada: so a fila NFs, so Novo)
    strictQueueGate: true,
    queueFilter: 'Suporte Especializado (NFs)',
    queueMatchMode: 'exact', // 'exact' | 'contains'
    allowedStatuses: 'novo',

    // --- agente autorizado. Vazio = qualquer analista logado (nao recomendado).
    agentName: 'Carlos Lemos',

    // --- disjuntor: teto de pulls numa janela movel, independente do DOM
    breakerMinutes: 10,

    autoOpenPanel: false,
    beep: true,
    debug: false,

    // overrides opcionais, preenchidos depois do diagnostico
    listItemSelector: '',
    serveSelector: '',
    queueSelector: '',
    statusSelector: ''
  };

  const SERVE_WORDS = ['servir', 'serve', 'atender', 'aceitar', 'assumir'];

  const KNOWN_STATUSES = [
    'novo', 'new',
    'aberto', 'open',
    'pendente', 'pending',
    'em espera', 'on-hold', 'em pausa',
    'resolvido', 'solved',
    'fechado', 'closed',
    'aguardando', 'waiting'
  ];

  // O Agent Workspace codifica o status no proprio data-test-id do badge
  // (data-test-id="status-badge-open") — mais confiavel que ler texto traduzido.
  const STATUS_BADGE_MAP = {
    new: 'novo',
    open: 'aberto',
    pending: 'pendente',
    hold: 'em espera',
    'on-hold': 'em espera',
    solved: 'resolvido',
    closed: 'fechado'
  };

  const STATUS_ALIASES = {
    new: 'novo',
    open: 'aberto',
    pending: 'pendente',
    'on-hold': 'em espera',
    'em pausa': 'em espera',
    solved: 'resolvido',
    closed: 'fechado',
    waiting: 'aguardando'
  };

  /**
   * trusted = e de fato a lista de conversas, entao "linha sem botao Servir"
   * pode ser contada como chat meu. Seletores frouxos (abas, itens de nav)
   * casavam com dezenas de elementos de UI e o contador ia a 76/3, o que
   * estourava o limite e travava o pull. Eles ficaram fora de proposito;
   * o diagnostico ainda mostra quantos elementos cada um pegaria.
   */
  const LIST_CANDIDATES = [
    { sel: '[data-test-id="conversation-list-item"]', trusted: true },
    { sel: '[data-test-id*="conversation-list-item"]', trusted: true },
    { sel: '[data-test-id*="chat-list-item"]', trusted: true },
    { sel: '[data-test-id*="omni-log-item"]', trusted: false },
    { sel: '[data-test-id*="conversation"] [role="listitem"]', trusted: false }
  ];

  // Seletores que NAO entram na deteccao, mas aparecem no diagnostico.
  const LIST_REJECTED = [
    '[data-garden-id="tabs.tab"]',
    '[role="tablist"] [role="tab"]',
    'nav [role="listitem"]',
    '[data-test-id="generic-table-row"]'
  ];

  // Uma lista de conversas nao tem 76 itens. Acima disso o seletor casou com
  // outra coisa — descarta, em vez de produzir um numero absurdo.
  const MAX_PLAUSIBLE_ROWS = 30;

  const POLL_MS = 1200;
  const SERVE_COOLDOWN_MS = 5000;
  const SERVE_FAIL_COOLDOWN_MS = 12000; // cresce por falha consecutiva
  const SERVE_VERIFY_MS = 7000;         // janela pra confirmar que o pull pegou
  const AGENT_RECHECK_MS = 5 * 60 * 1000;
  const API_MINE_MS = 15000;

  // Carencia antes de esquecer uma conversa que sumiu da lista. Trocar de tela
  // desmonta a lista inteira; sem isso, os timers de silencio zeravam a cada
  // navegacao. 2 min e menor que o alerta de 6, entao nao mascara nada.
  const IDLE_FORGET_MS = 2 * 60 * 1000;

  // O DOM tambem some ao navegar. Em modo 'auto', a ultima contagem confiavel
  // vale por esse tempo, pra nao bloquear o pull durante a troca de tela.
  const DOM_MINE_TTL_MS = 45000;

  const PANEL_OPEN_TRIES = 3;
  const PANEL_OPEN_COOLDOWN_MS = 8000;

  let cfg = { ...DEFAULTS };
  let timerId = null;
  let panelTries = 0;
  let lastPanelTryAt = 0;
  let stopped = false;
  let serving = false;

  // Identidade desta aba, pro lock entre abas. Varias abas do Zendesk abertas
  // significavam varias instancias puxando em paralelo, cada uma com seu
  // proprio cooldown em memoria.
  const INSTANCE_ID = Math.random().toString(36).slice(2) + '-' + Date.now();

  let listInfo = { selector: '', trusted: false, count: 0, rejected: '' };
  let lastDomMine = { value: null, at: 0 };
  let apiMine = { count: null, at: 0, error: '', pending: false };

  /** ultima tentativa de pull, pra verificar se realmente pegou */
  let serveAttempt = null; // { at, method, queueBefore, mineBefore, verified }
  let lastServe = null;    // { at, method, ok, note }
  let serveFails = 0;
  let autoPreferShortcut = false; // vira true quando o botao da barra falha

  /** key -> { fp, since, alerted, missingSince } */
  const chats = new Map();

  /** { name, id, source, ok } | null enquanto nao resolvido */
  let agent = null;
  let agentCheckedAt = 0;
  let agentPending = false;

  let status = {
    ok: false,
    mine: null,
    mineSourceUsed: '',
    mineWhy: '',
    domMine: null,
    apiMine: null,
    pending: 0,
    eligible: 0,
    queueWaiting: null,
    queueFrom: '',
    blocked: [],
    gateReason: '',
    agent: null,
    listSelectorUsed: '',
    listTrusted: false,
    lastAction: '',
    lastActionAt: 0,
    lastServe: null,
    serveFails: 0
  };

  // ---------------------------------------------------------------- utilitarios

  const DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g');

  const norm = (s) =>
    (s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(DIACRITICS, '')
      .replace(/\s+/g, ' ')
      .trim();

  const log = (...a) => {
    if (cfg.debug) console.log('%c[ZD-Auto]', 'color:#03363d;font-weight:700', ...a);
  };

  /**
   * innerText respeita renderizacao (da quebras de linha reais), mas nem sempre
   * esta disponivel. Sem o fallback, uma linha com innerText vazio era ignorada
   * silenciosamente pelo rastreio de silencio.
   */
  const text = (el) => el?.innerText || el?.textContent || '';

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  }

  function setAction(msg) {
    status.lastAction = msg;
    status.lastActionAt = Date.now();
    log(msg);
  }

  /** Elementos-folha: onde o Zendesk costuma colocar badges de fila e status. */
  function leaves(root) {
    return [...root.querySelectorAll('*')].filter((el) => el.children.length === 0);
  }

  /** Textos "rotulados" da linha: folhas + aria-label/title/data-status. */
  function labelTexts(root) {
    const out = [];
    for (const el of leaves(root)) {
      const t = norm(el.textContent);
      if (t) out.push(t);
    }
    for (const el of [root, ...root.querySelectorAll('[aria-label],[title],[data-status]')]) {
      for (const attr of ['aria-label', 'title', 'data-status']) {
        const v = norm(el.getAttribute?.(attr));
        if (v) out.push(v);
      }
    }
    return out;
  }

  // ------------------------------------------------------- identidade do agente

  async function resolveAgent() {
    // 1) API do Support. GET com cookie de sessao — nao exige CSRF token.
    try {
      const r = await fetch('/api/v2/users/me.json', {
        credentials: 'include',
        headers: { Accept: 'application/json' }
      });
      if (r.ok) {
        const j = await r.json();
        const name = j?.user?.name;
        if (name) return { name, id: j.user.id, email: j.user.email, source: 'api' };
      }
    } catch {
      /* fora do dominio Support (ex.: zopim.com) — cai no DOM */
    }

    // 2) Fallback no DOM: menu de perfil / avatar.
    const sels = [
      '[data-test-id*="user-profile"] [data-test-id*="name"]',
      '[data-test-id*="current-user"]',
      '[data-test-id*="avatar"][aria-label]',
      'header [aria-label*="perfil" i]',
      'header [aria-label*="profile" i]'
    ];
    for (const sel of sels) {
      let el;
      try {
        el = document.querySelector(sel);
      } catch {
        continue;
      }
      const t = (el?.getAttribute('aria-label') || el?.textContent || '').trim();
      if (t && t.length < 60) return { name: t, source: 'dom' };
    }

    return null;
  }

  function agentGate() {
    const now = Date.now();
    if (!agentPending && (!agent || now - agentCheckedAt > AGENT_RECHECK_MS)) {
      agentPending = true;
      resolveAgent()
        .then((res) => {
          agentCheckedAt = Date.now();
          const wanted = norm(cfg.agentName);
          if (!res) {
            // Sem nome exigido nao ha o que conferir: servir atribui pra quem
            // esta logado de qualquer forma. Com nome exigido, bloqueia.
            agent = wanted
              ? { name: null, source: null, ok: false, why: 'nao foi possivel identificar o usuario logado' }
              : { name: null, source: null, ok: true, why: '' };
            return;
          }
          const ok = !wanted || norm(res.name).includes(wanted);
          agent = {
            ...res,
            ok,
            why: ok ? '' : `logado como "${res.name}", esperado "${cfg.agentName}"`
          };
          log('agente resolvido', agent);
        })
        .catch(() => {
          agentCheckedAt = Date.now();
          agent = norm(cfg.agentName)
            ? { name: null, source: null, ok: false, why: 'erro ao consultar a identidade' }
            : { name: null, source: null, ok: true, why: '' };
        })
        .finally(() => {
          agentPending = false;
        });
    }
    return agent;
  }

  // ------------------------------------------------------------- fila (rotulos)

  /**
   * Confirma que a linha pertence a fila alvo.
   * Retorna { ok, detected }. Usado pela trava opcional strictQueueGate e pelo
   * modo rowButton — nos modos cegos nao existe linha pra ler.
   */
  function checkQueue(row) {
    const target = norm(cfg.queueFilter);
    if (!target) return { ok: false, detected: null };

    if (cfg.queueSelector) {
      let el;
      try {
        el = row.querySelector(cfg.queueSelector);
      } catch {
        return { ok: false, detected: null };
      }
      const v = norm(el?.textContent);
      return { ok: !!v && v === target, detected: v || null };
    }

    // Padrao: algum rotulo da linha e EXATAMENTE o nome da fila.
    // Exato importa: "Suporte Especializado (NFs) VIP" nao pode passar por substring.
    const labels = labelTexts(row);
    if (labels.includes(target)) return { ok: true, detected: cfg.queueFilter };

    if (cfg.queueMatchMode === 'contains' && norm(text(row)).includes(target)) {
      return { ok: true, detected: cfg.queueFilter };
    }

    return { ok: false, detected: null };
  }

  // ----------------------------------------------------------- status (rotulos)

  /** Le o status do badge, quando existir: data-test-id="status-badge-open". */
  function statusFromBadge(row) {
    const el = row.matches?.('[data-test-id^="status-badge-"]')
      ? row
      : row.querySelector('[data-test-id^="status-badge-"]');
    if (!el) return null;
    const raw = norm(el.getAttribute('data-test-id').slice('status-badge-'.length));
    return STATUS_BADGE_MAP[raw] || null;
  }

  /** Retorna o status canonico identificado, ou null se nao deu pra identificar. */
  function detectStatus(row) {
    if (cfg.statusSelector) {
      let el;
      try {
        el = row.querySelector(cfg.statusSelector);
      } catch {
        return null;
      }
      const t = norm(el?.textContent);
      if (!t) return null;
      return STATUS_ALIASES[t] || (KNOWN_STATUSES.includes(t) ? t : null);
    }

    const badge = statusFromBadge(row);
    if (badge) return badge;

    for (const t of labelTexts(row)) {
      if (KNOWN_STATUSES.includes(t)) return STATUS_ALIASES[t] || t;
    }
    return null;
  }

  function allowedStatusList() {
    return String(cfg.allowedStatuses || 'novo')
      .split(',')
      .map((s) => norm(s))
      .filter(Boolean);
  }

  // ------------------------------------------------------------ deteccao de DOM

  function serveButtonsIn(root) {
    const scope = root || document;
    if (cfg.serveSelector) {
      try {
        return [...scope.querySelectorAll(cfg.serveSelector)].filter(isVisible);
      } catch {
        return [];
      }
    }
    const nodes = scope.querySelectorAll('button, [role="button"], a[role="button"]');
    return [...nodes].filter((el) => {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      if (!isVisible(el)) return false;
      const t = norm(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
      if (!t || t.length > 22) return false;
      return SERVE_WORDS.some((w) => t === w || t.startsWith(w + ' '));
    });
  }

  function findRows() {
    const cands = cfg.listItemSelector
      ? [{ sel: cfg.listItemSelector, trusted: true }]
      : LIST_CANDIDATES;

    let rejected = '';
    for (const c of cands) {
      let found;
      try {
        found = [...document.querySelectorAll(c.sel)].filter(isVisible);
      } catch {
        continue;
      }
      if (!found.length) continue;
      if (found.length > MAX_PLAUSIBLE_ROWS) {
        rejected = `${c.sel} casou com ${found.length} elementos (> ${MAX_PLAUSIBLE_ROWS}) — descartado`;
        continue;
      }
      listInfo = { selector: c.sel, trusted: c.trusted, count: found.length, rejected };
      return found;
    }
    listInfo = { selector: '', trusted: false, count: 0, rejected };
    return [];
  }

  /**
   * O data-test-id "toolbar-serve-chat-button" e o botao de chat da barra
   * superior ("Conversas"/"Atender"), com o contador da fila embutido no texto
   * e desabilitado quando esta zerado. E o unico indicador que existe em TODAS
   * as telas — a lista de conversas some ao navegar, a barra nao. E clicar nele
   * e o caminho mais confiavel pra puxar: clique real, nao evento sintetico.
   */
  function readConversationsButton() {
    const el =
      document.querySelector('[data-test-id="toolbar-serve-chat-button"]') ||
      [...document.querySelectorAll('button, [role="button"]')].find((b) =>
        /^(conversas|atender|servir chat|serve chat)\b/.test(norm(text(b)))
      );
    if (!el) return null;
    const m = text(el).match(/\d+/);
    return {
      el,
      count: m ? Number(m[0]) : null,
      disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
      visible: isVisible(el)
    };
  }

  function rowKey(row) {
    const label = text(row)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)[0];
    return (
      (label || '').slice(0, 80) ||
      row.getAttribute('data-conversation-id') ||
      row.id ||
      ''
    );
  }

  const fingerprint = (row) => norm(text(row)).replace(/\d+/g, '#');

  /**
   * Telas onde puxar e permitido. O Agent Workspace e uma SPA: a barra superior
   * (com o botao Conversas) existe em todas elas, entao nao ha motivo pra exigir
   * o painel aberto — basta estar no workspace.
   */
  function onAllowedScreen() {
    const path = location.pathname;
    const extra = String(cfg.allowedPaths || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (extra.length) return extra.some((p) => path.startsWith(p));
    return path.startsWith('/agent/');
  }

  // ------------------------------------------- fila pela tabela da view (/agent/filters)

  /**
   * Na pratica a fila e a TABELA DE VIEW, nao o painel de conversas: cada chat
   * aparece como um ticket "Conversa com X" com status e responsavel legiveis.
   *
   *   status-badge-new + assignee "-"  => disponivel pra puxar
   *   assignee == meu nome             => ja e meu
   *
   * E a fila e a PROPRIA VIEW: todo ticket da tabela pertence a ela por
   * definicao. Conferir o id da view no path e uma garantia mais forte do que
   * casar texto — os custom fields de categoria vem vazios nessas linhas.
   */
  const VIEW_ROW_SEL = '[data-test-id="generic-table-row"]';
  const UNASSIGNED = ['', '-', '—', '–'];

  function currentViewId() {
    const m = location.pathname.match(/\/agent\/filters\/(\d+)/);
    return m ? m[1] : null;
  }

  function viewAllowed() {
    const id = currentViewId();
    if (!id) return false;
    const allow = String(cfg.allowedViewIds || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return allow.length ? allow.includes(id) : true;
  }

  function viewRowInfo(row) {
    const cell = (id) => row.querySelector(`[data-test-id="${id}"]`);
    const assignee = text(cell('ticket-table-cells-assignee')).trim();
    const idTxt = text(cell('generic-table-cells-id')).replace(/\D/g, '');
    return {
      row,
      id: idTxt || null,
      subject: text(cell('ticket-table-cells-subject')).trim(),
      assignee,
      unassigned: UNASSIGNED.includes(assignee),
      status: detectStatus(row)
    };
  }

  function scanView() {
    const rows = [...document.querySelectorAll(VIEW_ROW_SEL)].filter(isVisible);
    if (!rows.length) return { on: false, rows: [], mine: null, avail: [] };

    const infos = rows.map(viewRowInfo);
    const me = norm(cfg.agentName || agent?.name || '');
    const allowed = allowedStatusList();

    return {
      on: true,
      viewId: currentViewId(),
      allowed: viewAllowed(),
      rows: infos,
      // So conta se souber o nome — senao "0 meus" liberaria o limite.
      mine: me ? infos.filter((i) => norm(i.assignee) === me).length : null,
      avail: infos.filter((i) => i.unassigned && allowed.includes(i.status))
    };
  }

  // ------------------------------------------------- contagem de "meus chats"

  /** Busca na API quantos chats ativos estao atribuidos a mim. Estrangulada. */
  function refreshApiMine() {
    if (cfg.mineSource !== 'auto' && cfg.mineSource !== 'api') return;
    if (!agent?.id) return;
    if (apiMine.pending || Date.now() - apiMine.at < API_MINE_MS) return;

    const query = String(cfg.mineApiQuery || DEFAULTS.mineApiQuery).replace(/\{me\}/g, agent.id);
    apiMine.pending = true;
    fetch(`/api/v2/search/count.json?query=${encodeURIComponent(query)}`, {
      credentials: 'include',
      headers: { Accept: 'application/json' }
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => {
        apiMine.at = Date.now();
        apiMine.error = '';
        apiMine.count = typeof j?.count === 'number' ? j.count : null;
      })
      .catch((e) => {
        apiMine.at = Date.now();
        apiMine.error = e.message;
        apiMine.count = null;
      })
      .finally(() => {
        apiMine.pending = false;
      });
  }

  /**
   * Quantos chats sao meus agora. Devolve { value, source, why }; value null
   * significa "nao sei" — e nesse caso o pull nao acontece, porque estourar o
   * limite e pior do que perder um chat.
   */
  function resolveMine(domMineRows, conv, view) {
    let src = cfg.mineSource || 'auto';
    if (src === 'off') src = 'auto';

    if (src === 'view') {
      return view?.mine === null || view?.mine === undefined
        ? { value: null, source: 'view', why: 'tabela da view fora da tela ou agente sem nome' }
        : { value: view.mine, source: 'view', why: '' };
    }

    // Contador do botao "Conversas" da barra: e o unico numero de chat presente
    // em TODAS as telas do workspace, entao nao some ao navegar.
    const barVal = conv && Number.isFinite(conv.count) ? conv.count : null;
    if (src === 'bar') {
      return barVal === null
        ? { value: null, source: 'bar', why: 'botao Conversas nao encontrado' }
        : { value: barVal, source: 'bar', why: '' };
    }

    // 'off' foi removido: era ele que permitia puxar sem limite nenhum.
    // Config antiga com esse valor cai no comportamento seguro ('auto').
    const domOk = listInfo.trusted && listInfo.selector;
    if (domOk) {
      lastDomMine = { value: domMineRows.length, at: Date.now() };
    }

    if (src === 'dom') {
      if (domOk) return { value: domMineRows.length, source: 'dom', why: '' };
      if (Date.now() - lastDomMine.at < DOM_MINE_TTL_MS && lastDomMine.value !== null) {
        return { value: lastDomMine.value, source: 'dom (cache)', why: 'lista fora da tela' };
      }
      return { value: null, source: 'dom', why: 'lista de conversas nao detectada' };
    }

    if (src === 'api') {
      if (apiMine.count !== null) return { value: apiMine.count, source: 'api', why: '' };
      return { value: null, source: 'api', why: apiMine.error || 'aguardando a API' };
    }

    // auto: lista na tela > API > cache do DOM > barra
    if (domOk) return { value: domMineRows.length, source: 'dom', why: '' };
    if (apiMine.count !== null) return { value: apiMine.count, source: 'api', why: 'lista fora da tela' };
    if (barVal !== null) return { value: barVal, source: 'bar', why: 'sem lista e sem API' };
    if (Date.now() - lastDomMine.at < DOM_MINE_TTL_MS && lastDomMine.value !== null) {
      return { value: lastDomMine.value, source: 'dom (cache)', why: 'lista fora da tela' };
    }
    return { value: null, source: 'auto', why: apiMine.error || 'sem lista no DOM e sem contagem da API' };
  }

  // ------------------------------------------------------- disparo do atalho

  /** "Ctrl+Alt+Q" -> init de KeyboardEvent. So trata teclas de letra. */
  function parseShortcut(str) {
    const parts = String(str || 'Ctrl+Alt+Q').split('+').map((s) => norm(s));
    const init = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
    let key = 'q';
    for (const p of parts) {
      if (p === 'ctrl' || p === 'control') init.ctrlKey = true;
      else if (p === 'alt') init.altKey = true;
      else if (p === 'shift') init.shiftKey = true;
      else if (p === 'meta' || p === 'cmd' || p === 'win') init.metaKey = true;
      else if (p) key = p;
    }
    const upper = key.toUpperCase();
    return {
      ...init,
      key,
      code: /^[a-z]$/.test(key) ? 'Key' + upper : upper,
      keyCode: upper.charCodeAt(0),
      which: upper.charCodeAt(0),
      bubbles: true,
      cancelable: true,
      composed: true
    };
  }

  /**
   * O content script roda em mundo isolado, mas compartilha o DOM — entao um
   * evento despachado aqui chega nos listeners da pagina. O evento vai com
   * isTrusted=false; atalhos de aplicacao tratados em JS respondem normalmente,
   * atalhos nativos do navegador nao (nao e o caso aqui).
   *
   * Despacha em UM alvo so (document, onde ficam os handlers globais). Mandar
   * em varios alvos que borbulham pro document dispararia o handler duas vezes
   * — e dois pulls seguidos.
   */
  function fireShortcut() {
    const init = parseShortcut(cfg.shortcut);
    for (const type of ['keydown', 'keyup']) {
      try {
        document.dispatchEvent(new KeyboardEvent(type, init));
      } catch (e) {
        console.error('[ZD-Auto] falha ao disparar o atalho:', e);
        return false;
      }
    }
    return true;
  }

  // ------------------------------------------------------------------- alertas

  function beep() {
    if (!cfg.beep) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.5);
      setTimeout(() => ctx.close().catch(() => {}), 800);
    } catch {
      /* autoplay bloqueado — a notificacao do sistema cobre */
    }
  }

  function notify(title, message, withSound) {
    try {
      chrome.runtime.sendMessage({ type: 'zd-notify', title, message });
    } catch {
      /* contexto invalidado apos reload da extensao */
    }
    if (withSound) beep();
  }

  // -------------------------------------------------- travas duras de seguranca

  const store = {
    get: (keys) =>
      new Promise((res, rej) => {
        try {
          chrome.storage.local.get(keys, (v) => (chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(v)));
        } catch (e) {
          rej(e);
        }
      }),
    set: (obj) =>
      new Promise((res, rej) => {
        try {
          chrome.storage.local.set(obj, () => (chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res()));
        } catch (e) {
          rej(e);
        }
      })
  };

  /**
   * Config lida do disco AGORA, nao do cache em memoria. O cache pode estar
   * congelado (contexto morto) — e foi assim que o botao de desligar deixou de
   * ser respeitado. Se a leitura falhar, nao puxa.
   */
  async function freshCfg() {
    const res = await store.get('cfg');
    return { ...DEFAULTS, ...(res?.cfg || {}) };
  }

  /**
   * Disjuntor: teto absoluto de pulls numa janela movel, guardado no storage
   * (portanto compartilhado entre abas) e independente de qualquer leitura de
   * DOM. Se toda a deteccao falhar junto, isto ainda segura o loop.
   */
  async function breakerOk(c) {
    const now = Date.now();
    const windowMs = Math.max(1, Number(c.breakerMinutes || 10)) * 60000;
    const limit = Math.max(1, Number(c.maxChats || 3));

    const res = await store.get('recentServes');
    const recent = (res?.recentServes || []).filter((t) => now - t < windowMs);

    if (recent.length !== (res?.recentServes || []).length) {
      await store.set({ recentServes: recent });
    }
    status.breakerCount = recent.length;
    status.breakerLimit = limit;

    if (recent.length >= limit) {
      status.breaker = `disjuntor: ${recent.length} pull(s) em ${c.breakerMinutes || 10} min (teto ${limit})`;
      return false;
    }
    status.breaker = '';
    return true;
  }

  async function recordServe() {
    const res = await store.get('recentServes');
    const recent = res?.recentServes || [];
    recent.push(Date.now());
    await store.set({ recentServes: recent });
  }

  /**
   * Lock entre abas. Sem ele, N abas do Zendesk = N instancias puxando ao
   * mesmo tempo, cada uma achando que respeitou o proprio cooldown.
   */
  async function claimLock(cooldown) {
    const now = Date.now();
    const res = await store.get('serveLock');
    const lock = res?.serveLock;
    if (lock && now - lock.ts < cooldown) return false;

    await store.set({ serveLock: { id: INSTANCE_ID, ts: now } });
    await new Promise((r) => setTimeout(r, 80)); // janela pra outra aba escrever
    const check = await store.get('serveLock');
    return check?.serveLock?.id === INSTANCE_ID;
  }

  // ------------------------------------------------------------------- decisao

  /** Avalia uma linha pendente contra fila e status. */
  function evaluate(row) {
    const q = checkQueue(row);
    if (!q.ok) {
      return {
        ok: false,
        reason: q.detected ? `outra fila ("${q.detected}")` : 'fila nao confirmada'
      };
    }

    const st = detectStatus(row);
    if (st === null) return { ok: false, reason: 'status nao identificado' };
    if (!allowedStatusList().includes(st)) return { ok: false, reason: `status "${st}"` };

    return { ok: true, reason: 'ok' };
  }

  function trackIdle(mine) {
    const now = Date.now();
    const limitMs = Math.max(1, Number(cfg.idleMinutes)) * 60000;
    const seen = new Set();

    for (const row of mine) {
      const key = rowKey(row);
      if (!key) continue;
      seen.add(key);

      const fp = fingerprint(row);
      const rec = chats.get(key);

      if (!rec) {
        chats.set(key, { fp, since: now, alerted: false });
        continue;
      }
      if (rec.fp !== fp) {
        rec.fp = fp;
        rec.since = now;
        rec.alerted = false;
        continue;
      }
      if (!rec.alerted && now - rec.since >= limitMs) {
        rec.alerted = true;
        notify(`Sem resposta ha ${cfg.idleMinutes} min`, key, true);
        setAction(`Alerta de silencio: ${key}`);
      }
    }

    // Nao apaga na hora: trocar de tela desmonta a lista, e apagar aqui zerava
    // todos os timers de silencio. So esquece depois de sumir por IDLE_FORGET_MS.
    for (const [k, rec] of chats) {
      if (seen.has(k)) {
        rec.missingSince = 0;
      } else if (!rec.missingSince) {
        rec.missingSince = now;
      } else if (now - rec.missingSince > IDLE_FORGET_MS) {
        chats.delete(k);
      }
    }
  }

  /** Tem chat esperando? Botao da barra primeiro; senao, linha com "Servir". */
  function queueWaiting(conv, pendingRows, view) {
    // A tabela da view vem primeiro: ela lista os chats de verdade, com status
    // e responsavel. O contador da barra marca 0 mesmo havendo chat novo na
    // fila (ele conta sessao de chat ao vivo, nao ticket) — era ele que
    // bloqueava com "nenhum chat esperando".
    if (view && view.on) {
      return { has: view.avail.length > 0, count: view.avail.length, from: 'view' };
    }
    if (conv && conv.visible && !conv.disabled && conv.count !== null && conv.count > 0) {
      return { has: true, count: conv.count, from: 'barra' };
    }
    if (pendingRows.length) {
      return { has: true, count: pendingRows.length, from: 'lista' };
    }
    if (conv && conv.count !== null) {
      return { has: false, count: conv.count, from: 'barra' };
    }
    return { has: false, count: null, from: pendingRows.length ? 'lista' : '' };
  }

  /**
   * Confere se o pull anterior realmente pegou: ou a fila diminuiu, ou o numero
   * de chats meus subiu. Sem isso, um clique que nao surte efeito ficava
   * invisivel — a extensao "tentava" pra sempre e o popup dizia que assumiu.
   */
  function verifyServe(queueNow, mineNow) {
    if (!serveAttempt || serveAttempt.verified) return;
    if (Date.now() - serveAttempt.at < SERVE_VERIFY_MS) return;

    const { queueBefore, mineBefore, method } = serveAttempt;
    const queueDropped = queueBefore !== null && queueNow !== null && queueNow < queueBefore;
    const mineGrew = mineBefore !== null && mineNow !== null && mineNow > mineBefore;
    const inconclusive =
      (queueBefore === null || queueNow === null) && (mineBefore === null || mineNow === null);

    serveAttempt.verified = true;

    if (queueDropped || mineGrew) {
      serveFails = 0;
      lastServe = { at: serveAttempt.at, method, ok: true, note: queueDropped ? 'fila diminuiu' : 'meus chats subiram' };
      return;
    }
    if (inconclusive) {
      lastServe = { at: serveAttempt.at, method, ok: null, note: 'sem numeros pra confirmar' };
      return;
    }

    serveFails++;
    lastServe = { at: serveAttempt.at, method, ok: false, note: `sem efeito (${serveFails}x)` };
    // No modo auto, alterna o caminho: se o botao nao resolveu, tenta o atalho.
    if ((cfg.serveMethod || 'auto') === 'auto') autoPreferShortcut = !autoPreferShortcut;
    setAction(`Tentativa por ${method} sem efeito — proxima via ${nextAutoMethod()}`);
  }

  function nextAutoMethod() {
    return autoPreferShortcut ? cfg.shortcut : 'botao da barra';
  }

  function cooldownMs() {
    return serveFails ? Math.min(60000, SERVE_FAIL_COOLDOWN_MS * serveFails) : SERVE_COOLDOWN_MS;
  }

  /** Executa o pull. Retorna { ok, method } | null se nao havia como. */
  function doServe(conv, eligibleRows, pendingRows) {
    const method = cfg.serveMethod || 'auto';

    if (method === 'rowButton') {
      const target = eligibleRows[0] || (cfg.strictQueueGate ? null : pendingRows[0]);
      if (!target) return null;
      const btn = serveButtonsIn(target.row || target)[0];
      if (!btn) return null;
      btn.click();
      return { ok: true, method: 'botao da linha', label: target.key || rowKey(target.row || target) };
    }

    const buttonUsable = conv && conv.visible && !conv.disabled;

    if (method === 'globalButton') {
      if (!buttonUsable) return null;
      conv.el.click();
      return { ok: true, method: 'botao da barra' };
    }

    if (method === 'shortcut') {
      if (!fireShortcut()) return null;
      return { ok: true, method: cfg.shortcut };
    }

    // auto: botao real primeiro (mais confiavel); atalho quando o botao nao
    // existe nessa tela, ou quando o botao ja falhou na tentativa anterior.
    if (buttonUsable && !autoPreferShortcut) {
      conv.el.click();
      return { ok: true, method: 'botao da barra' };
    }
    if (fireShortcut()) return { ok: true, method: cfg.shortcut };
    if (buttonUsable) {
      conv.el.click();
      return { ok: true, method: 'botao da barra' };
    }
    return null;
  }

  function tick() {
    const ag = agentGate();
    refreshApiMine();

    const conv = readConversationsButton();
    const rows = findRows();

    // Sem painel aberto nao existe lista no DOM. O pull nao depende mais dela,
    // mas a contagem por DOM e o alerta de silencio dependem.
    if (cfg.autoOpenPanel && conv && conv.count > 0 && !conv.disabled && !rows.length) {
      if (panelTries < PANEL_OPEN_TRIES && Date.now() - lastPanelTryAt > PANEL_OPEN_COOLDOWN_MS) {
        lastPanelTryAt = Date.now();
        panelTries++;
        conv.el.click();
        setAction(`Abrindo painel Conversas (tentativa ${panelTries})`);
      }
    } else if (rows.length) {
      panelTries = 0;
    }

    const pending = [];
    const mineRows = [];
    for (const row of rows) {
      if (serveButtonsIn(row).length) pending.push(row);
      else mineRows.push(row);
    }

    // O alerta de silencio roda mesmo com a atribuicao desligada — mas so com
    // lista confiavel, pra nao rastrear elementos de UI quaisquer.
    if (listInfo.trusted) trackIdle(mineRows);

    const verdicts = pending.map((row) => ({ row, key: rowKey(row), ...evaluate(row) }));
    const eligible = verdicts.filter((v) => v.ok);

    const view = scanView();
    const mine = resolveMine(mineRows, conv, view);
    const q = queueWaiting(conv, pending, view);

    verifyServe(conv ? conv.count : null, mine.value);

    const setGate = (reason) => {
      status.gateReason = reason;
    };

    status = {
      ...status,
      ok: !!(listInfo.selector || conv),
      mine: mine.value,
      mineSourceUsed: mine.source,
      mineWhy: mine.why,
      domMine: listInfo.trusted ? mineRows.length : null,
      apiMine: apiMine.count,
      apiMineError: apiMine.error,
      barMine: conv && Number.isFinite(conv.count) ? conv.count : null,
      viewOn: view.on,
      viewId: view.viewId || null,
      viewAllowed: view.on ? view.allowed : null,
      viewMine: view.mine,
      viewAvail: view.on ? view.avail.map((i) => `#${i.id} ${i.subject}`).slice(0, 5) : [],
      apiQueryUsed: String(cfg.mineApiQuery || '').replace(/\{me\}/g, agent?.id ?? '{me}'),
      screenOk: onAllowedScreen(),
      path: location.pathname,
      pending: pending.length,
      eligible: eligible.length,
      queueWaiting: q.count,
      queueHas: q.has,
      queueFrom: q.from,
      convFound: !!conv,
      convDisabled: conv ? conv.disabled : null,
      panelOpen: rows.length > 0,
      tracked: chats.size,
      blocked: verdicts.filter((v) => !v.ok).slice(0, 5).map((v) => ({ key: v.key, reason: v.reason })),
      agent: ag ? { name: ag.name, ok: ag.ok, source: ag.source, why: ag.why } : null,
      listSelectorUsed: listInfo.selector,
      listTrusted: listInfo.trusted,
      listRejected: listInfo.rejected,
      lastServe,
      serveFails
    };

    // ----------------------------------------------------------- portao final
    if (stopped) return setGate('instancia parada — recarregue a pagina (F5)');
    if (!contextAlive()) {
      selfDestruct('contexto invalidado');
      return setGate('instancia parada — recarregue a pagina (F5)');
    }
    if (!cfg.enabled) return setGate('trava desligada — nao puxa');
    if (!ag) return setGate('verificando a identidade do analista');
    if (!ag.ok) return setGate(`agente nao autorizado: ${ag.why}`);

    // O limite e inegociavel: sem contagem confiavel, nao puxa. A opcao "off"
    // foi removida — era ela que permitia puxar sem limite nenhum.
    if (mine.value === null) return setGate(`nao sei quantos chats sao meus (${mine.why})`);
    if (mine.value >= Number(cfg.maxChats)) {
      return setGate(`limite atingido: ${mine.value}/${cfg.maxChats}`);
    }

    // Precisa estar numa tela do Agent Workspace (/agent/home, /agent/tickets/N,
    // /agent/filters/N, chat aberto...). Exigir a LISTA de conversas no DOM era
    // errado: ela so existe com o painel aberto, entao bloqueava todas as telas.
    if (!onAllowedScreen()) {
      return setGate(`fora das telas de atendimento (${location.pathname})`);
    }

    if (serveAttempt && !serveAttempt.verified) {
      return setGate('confirmando o pull anterior');
    }
    if (Date.now() - (serveAttempt?.at || 0) < cooldownMs()) {
      return setGate('em espera (cooldown)');
    }

    if (!q.has) {
      return setGate(
        conv || pending.length
          ? 'nenhum chat esperando na fila'
          : 'nao achei o botao de chat da barra nem lista de conversas'
      );
    }

    // Trava opcional: so puxa se a fila/status derem pra ler e baterem. Nos
    // modos cegos isso exige que TODOS os pendentes sejam elegiveis, porque a
    // acao serve "o proximo" sem escolher qual.
    // Fila pela view: o id do path identifica a fila sem ambiguidade, e os
    // candidatos ja vem filtrados por "sem responsavel + status permitido".
    if (view.on) {
      if (cfg.strictQueueGate && !view.allowed) {
        return setGate(`view ${view.viewId} nao esta na lista de filas permitidas`);
      }
      if (!view.avail.length) return setGate('nenhum chat novo sem responsavel na fila');
    }

    if (cfg.strictQueueGate && !view.on && (cfg.serveMethod || 'auto') !== 'rowButton') {
      if (!pending.length) {
        return setGate('trava de fila ligada, mas a lista nao mostra os pendentes');
      }
      if (eligible.length !== pending.length) {
        return setGate(
          `trava de fila: ${pending.length - eligible.length} de ${pending.length} pendente(s) fora da regra`
        );
      }
    }
    if (cfg.strictQueueGate && (cfg.serveMethod || 'auto') === 'rowButton' && !eligible.length) {
      return setGate('trava de fila: nenhum pendente elegivel');
    }

    // A partir daqui e assincrono: reconfirma tudo no disco antes de agir.
    if (serving) return setGate('confirmando…');
    serving = true;
    setGate('confirmando…');

    (async () => {
      try {
        // 1. Config do disco. Se o botao foi desligado, para aqui — mesmo que
        //    o cache em memoria ainda diga o contrario.
        const c = await freshCfg();
        if (!c.enabled) return setGate('trava desligada — nao puxa');
        if (mine.value >= Number(c.maxChats)) {
          return setGate(`limite atingido: ${mine.value}/${c.maxChats}`);
        }

        // 2. Disjuntor: teto absoluto, independente de qualquer leitura de tela.
        if (!(await breakerOk(c))) return setGate(status.breaker);

        // 3. Lock entre abas: so uma instancia puxa por vez.
        if (!(await claimLock(cooldownMs()))) {
          return setGate('outra aba esta puxando');
        }

        const res = doServe(conv, eligible, pending);
        if (!res) {
          return setGate('nao ha caminho pra puxar nesta tela (sem botao, sem linha)');
        }

        await recordServe();
        serveAttempt = {
          at: Date.now(),
          method: res.method,
          queueBefore: conv ? conv.count : null,
          mineBefore: mine.value,
          verified: false
        };
        setGate('');
      } catch (e) {
        // Leitura de storage falhando = contexto morto. Nao puxa.
        selfDestruct(`falha ao ler a config: ${e.message}`);
        setGate('instancia parada — recarregue a pagina (F5)');
      } finally {
        serving = false;
      }
    })();
    return;
    const label = res.label ? `: ${res.label}` : '';
    setAction(`Puxado via ${res.method}${label}`);
    notify('Chat assumido', `Puxado via ${res.method}${label}`, false);
  }

  function loop() {
    try {
      tick();
    } catch (e) {
      console.error('[ZD-Auto] erro no ciclo:', e);
    }
  }

  // --------------------------------------------------------------- diagnostico

  /** Panorama da tela: onde estamos e quais controles de chat existem. */
  function probeEnvironment() {
    const conv = readConversationsButton();
    const path = location.pathname;
    return [
      `tela: ${path.includes('/filters/') ? 'views/tickets' : path.includes('chat') ? 'chat' : path}`,
      `botao de chat da barra: ${
        conv
          ? `PRESENTE | texto=${JSON.stringify(text(conv.el).replace(/\s+/g, ' ').trim())}` +
            ` | contador=${conv.count} | disabled=${conv.disabled} | visivel=${conv.visible}`
          : 'AUSENTE (sem ele, so o atalho ou a linha da lista servem pra puxar)'
      }`,
      `linhas de tabela de tickets (generic-table-row): ${document.querySelectorAll('[data-test-id="generic-table-row"]').length}`,
      `metodo em uso: ${cfg.serveMethod} | proxima via: ${nextAutoMethod()} | falhas seguidas: ${serveFails}`,
      `ultimo pull: ${
        lastServe
          ? `${lastServe.method} — ${lastServe.ok === true ? 'CONFIRMADO' : lastServe.ok === false ? 'SEM EFEITO' : 'INCONCLUSIVO'} (${lastServe.note})`
          : '(nenhum)'
      }`,
      `motivo atual: ${status.gateReason || '(nenhum — livre pra puxar)'}`
    ];
  }

  /**
   * Despeja as celulas da tabela de views. Serve pra descobrir QUAL custom field
   * carrega a fila/categoria — os data-test-id vem numerados, sem nome legivel.
   */
  function dumpTableRows(limit = 3) {
    const rows = [...document.querySelectorAll('[data-test-id="generic-table-row"]')]
      .filter(isVisible)
      .slice(0, limit);
    return rows.map((r, i) => {
      const badge = r.querySelector('[data-test-id^="status-badge-"]');
      const cells = [...r.querySelectorAll('[data-test-id]')]
        .filter((c) => /cells-/.test(c.getAttribute('data-test-id')))
        .map(
          (c) =>
            `        ${c.getAttribute('data-test-id')}: ` +
            JSON.stringify((c.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 70))
        );
      return [
        `  [${i}] status-badge: ${badge ? badge.getAttribute('data-test-id').replace('status-badge-', '') : '(nenhum)'}` +
          ` => interpretado como: ${detectStatus(r) ?? '(nao identificado)'}`,
        ...cells
      ].join('\n');
    });
  }

  /**
   * Sonda a API de busca. Objetivo: achar a consulta que conta os chats ativos
   * do analista sem depender do DOM. Compare os numeros com a realidade da tela
   * e cole a vencedora em "Consulta da API" no popup.
   */
  async function probeApi() {
    if (!agent?.id) return ['  (id do agente nao resolvido — sem sondagem)'];

    const queries = [
      String(cfg.mineApiQuery || DEFAULTS.mineApiQuery).replace(/\{me\}/g, agent.id),
      `type:ticket assignee:${agent.id} status<solved`,
      `type:ticket assignee:${agent.id} status:new`,
      `type:ticket assignee:${agent.id} status:open`,
      `type:ticket assignee:${agent.id} status:pending`,
      `type:ticket assignee:${agent.id} status:open via:chat`,
      `type:ticket status:new group:"${cfg.queueFilter}"`
    ];

    const out = [];
    for (const q of [...new Set(queries)]) {
      try {
        const r = await fetch(`/api/v2/search/count.json?query=${encodeURIComponent(q)}`, {
          credentials: 'include',
          headers: { Accept: 'application/json' }
        });
        const j = await r.json().catch(() => ({}));
        out.push(`  HTTP ${r.status}  count=${j?.count ?? '?'}  ${q}`);
      } catch (e) {
        out.push(`  ERRO ${e.message}  ${q}`);
      }
    }
    return out;
  }

  /** Lista os grupos: se a fila for um group do Zendesk, da pra filtrar por API. */
  async function probeGroups() {
    try {
      const r = await fetch('/api/v2/groups.json?per_page=100', {
        credentials: 'include',
        headers: { Accept: 'application/json' }
      });
      if (!r.ok) return [`  HTTP ${r.status} ao listar grupos`];
      const j = await r.json();
      const groups = j?.groups || [];
      const hits = groups.filter((g) => /especializ|nfs/i.test(g.name));
      return [
        `  total de grupos: ${groups.length}`,
        ...(hits.length
          ? hits.map((g) => `  MATCH id=${g.id} nome=${JSON.stringify(g.name)}`)
          : ['  nenhum grupo casa com /especializ|nfs/i']),
        '  primeiros 15 nomes:',
        ...groups.slice(0, 15).map((g) => `    ${g.id}  ${JSON.stringify(g.name)}`)
      ];
    } catch (e) {
      return [`  ERRO ${e.message}`];
    }
  }

  function countSel(sel) {
    try {
      return [...document.querySelectorAll(sel)].filter(isVisible).length;
    } catch {
      return 0;
    }
  }

  async function diagnose() {
    const testIds = new Map();
    document.querySelectorAll('[data-test-id]').forEach((el) => {
      if (!isVisible(el)) return;
      const id = el.getAttribute('data-test-id');
      testIds.set(id, (testIds.get(id) || 0) + 1);
    });

    const buttons = [...document.querySelectorAll('button, [role="button"]')]
      .filter(isVisible)
      .map((el) => (el.innerText || el.getAttribute('aria-label') || '').trim())
      .filter((t) => t && t.length <= 30);

    const candidates = [
      ...LIST_CANDIDATES.map(
        (c) => `${String(countSel(c.sel)).padStart(3)}  ${c.trusted ? '[conta como meus]' : '[so informativo]'}  ${c.sel}`
      ),
      ...LIST_REJECTED.map((sel) => `${String(countSel(sel)).padStart(3)}  [FORA da deteccao]  ${sel}`)
    ];

    const rows = findRows().slice(0, 8).map((r, i) => {
      const pend = serveButtonsIn(r).length > 0;
      const v = pend ? evaluate(r) : { ok: false, reason: 'ja e meu' };
      const q = checkQueue(r);
      return [
        `  [${i}] ${pend ? 'PENDENTE' : 'MEU     '} | veredito: ${v.ok ? 'ELEGIVEL' : v.reason}`,
        `       fila detectada:   ${q.detected ?? '(nenhuma)'}`,
        `       status detectado: ${detectStatus(r) ?? '(nenhum)'}`,
        `       folhas: ${JSON.stringify(labelTexts(r).slice(0, 14))}`
      ].join('\n');
    });

    return [
      '=== Zendesk Auto-Atribuicao — diagnostico ===',
      `url: ${location.href}`,
      `trava: ${cfg.enabled ? 'HABILITADA (puxa automatico)' : 'DESLIGADA (nao puxa)'}`,
      `agente: ${agent ? `${agent.name ?? '(nome nao lido)'} (${agent.source}) ok=${agent.ok}` : '(nao resolvido)'}` +
        ` | exigido: ${cfg.agentName ? JSON.stringify(cfg.agentName) : '(qualquer analista logado)'}`,
      `limite: ${status.mine ?? '?'} / ${cfg.maxChats}  (fonte: ${status.mineSourceUsed}${status.mineWhy ? ' — ' + status.mineWhy : ''})`,
      `  meus por DOM: ${status.domMine ?? '(indisponivel)'} | meus por API: ${apiMine.count ?? '(indisponivel)'}${apiMine.error ? ' erro=' + apiMine.error : ''}`,
      `  consulta da API: ${String(cfg.mineApiQuery).replace(/\{me\}/g, agent?.id ?? '{me}')}`,
      `fila esperando: ${status.queueWaiting ?? '?'} (fonte: ${status.queueFrom || 'nenhuma'})`,
      `trava de fila/status: ${cfg.strictQueueGate ? `LIGADA — so "${cfg.queueFilter}" / ${allowedStatusList().join(', ')}` : 'desligada (puxa o proximo da fila sem checar antes)'}`,
      `seletor de lista em uso: ${listInfo.selector || '(NENHUM CASOU)'}${listInfo.trusted ? '' : ' [nao confiavel pra contar]'}`,
      listInfo.rejected ? `descartado: ${listInfo.rejected}` : '',
      '',
      '--- panorama do ambiente ---',
      ...probeEnvironment().map((l) => '  ' + l),
      '',
      '--- API: contagens (achar a consulta que reflete os chats ativos) ---',
      ...(await probeApi()),
      '',
      '--- API: grupos (a fila e um group do Zendesk?) ---',
      ...(await probeGroups()),
      '',
      '--- celulas da tabela de views (achar o campo da fila) ---',
      ...(dumpTableRows().length ? dumpTableRows() : ['  (nenhuma linha de tabela)']),
      '',
      '--- candidatos de lista (elementos visiveis) ---',
      ...candidates,
      '',
      '--- linhas detectadas ---',
      ...(rows.length ? rows : ['  (nenhuma)']),
      '',
      '--- data-test-id visiveis (top 40) ---',
      ...[...testIds.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 40)
        .map(([k, v]) => `  ${v}x  ${k}`),
      '',
      '--- textos de botoes visiveis (unicos) ---',
      ...[...new Set(buttons)].slice(0, 60).map((t) => `  "${t}"`)
    ]
      .filter((l) => l !== '')
      .join('\n');
  }

  window.__zdDiag = diagnose;

  // ----------------------------------------------------------------- mensagens

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'zd-status') {
      sendResponse({ ...status, enabled: cfg.enabled, cfg });
      return true;
    }
    if (msg?.type === 'zd-diag') {
      diagnose()
        .then((report) => sendResponse({ report }))
        .catch((e) => sendResponse({ report: `falha no diagnostico: ${e.message}` }));
      return true; // resposta assincrona
    }
    return false;
  });

  // ------------------------------------------------------------------- arranque

  /**
   * Ao recarregar a extensao sem dar F5 na aba, o content script ANTIGO continua
   * vivo: o setInterval segue rodando, mas chrome.storage.onChanged nunca mais
   * dispara. Resultado: uma instancia orfa puxando chat com a config congelada
   * em enabled:true, imune ao botao do popup. Era essa a causa de "nao respeita
   * o botao de atribuir". Sintoma no console: chrome-extension://invalid/.
   *
   * chrome.runtime.id fica undefined quando o contexto morre.
   */
  function contextAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function selfDestruct(motivo) {
    if (timerId) clearInterval(timerId);
    timerId = null;
    stopped = true;
    console.warn(`[ZD-Auto] instancia parada: ${motivo}. Recarregue a pagina (F5).`);
  }

  function start() {
    if (timerId) clearInterval(timerId);
    timerId = setInterval(() => {
      if (stopped) return;
      if (!contextAlive()) return selfDestruct('contexto da extensao invalidado');
      loop();
    }, POLL_MS);
    loop();
  }

  chrome.storage.local.get('cfg', (res) => {
    cfg = { ...DEFAULTS, ...(res?.cfg || {}) };
    log('config carregada', cfg);
    start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.cfg) return;
    cfg = { ...DEFAULTS, ...(changes.cfg.newValue || {}) };
    chats.clear();
    agent = null;          // reavalia a identidade se o nome do agente mudou
    agentCheckedAt = 0;
    apiMine = { count: null, at: 0, error: '', pending: false };
    serveFails = 0;
    autoPreferShortcut = false;
    log('config atualizada', cfg);
  });
})();
