/**
 * Zendesk Auto-Atribuicao — content script
 *
 * REGRA CENTRAL: fail-closed. Um chat so e assumido se as TRES condicoes forem
 * positivamente confirmadas no DOM. Qualquer duvida => nao clica.
 *
 *   1. FILA    — a linha precisa exibir exatamente "Suporte Especializado (NFs)".
 *                Fila nao confirmada = bloqueado, sempre. Sem excecao, sem modo permissivo.
 *   2. AGENTE  — o usuario logado precisa ser Carlos Lemos. Verificado em
 *                /api/v2/users/me.json (cookie de sessao, GET nao precisa de CSRF),
 *                com fallback no DOM. Nao confirmou => a extensao inteira fica inerte.
 *   3. STATUS  — a linha precisa exibir status "Novo". "Aberto", "Pendente" etc.
 *                sao bloqueados; status nao identificado tambem e bloqueado.
 *
 * Cada bloqueio guarda o motivo, exibido no popup — e assim que se ajusta os seletores.
 */
(() => {
  'use strict';

  if (window.__zdAutoAssign) return;
  window.__zdAutoAssign = true;

  const DEFAULTS = {
    enabled: true,
    maxChats: 3,
    idleMinutes: 6,

    // --- regra 1: fila
    queueFilter: 'Suporte Especializado (NFs)',
    queueMatchMode: 'exact', // 'exact' = um elemento da linha tem esse texto exato
                             // 'contains' = basta aparecer no texto da linha (mais frouxo)

    // --- regra 2: agente
    agentName: 'Carlos Lemos',

    // --- regra 3: status
    allowedStatuses: 'novo',

    // como assumir:
    //   'shortcut'     - dispara Ctrl+Alt+Q (serve o proximo da fila) [cego]
    //   'globalButton' - clica em toolbar-serve-chat-button           [cego]
    //   'rowButton'    - clica no botao "Servir" da linha             [escolhe o chat]
    serveMethod: 'shortcut',
    shortcut: 'Ctrl+Alt+Q',

    beep: true,
    debug: false,

    // overrides opcionais, preenchidos depois do diagnostico
    listItemSelector: '',
    serveSelector: '',
    queueSelector: '',
    statusSelector: ''
  };

  const SERVE_WORDS = ['servir', 'serve', 'atender', 'aceitar', 'assumir'];

  // Status conhecidos. Se o texto da linha bate com um destes, ele foi IDENTIFICADO —
  // e ai a decisao e so comparar com a lista de permitidos.
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
  // (data-test-id="status-badge-open"). Isso e MUITO mais confiavel que ler
  // texto, entao e a primeira tentativa em detectStatus().
  const STATUS_BADGE_MAP = {
    new: 'novo',
    open: 'aberto',
    pending: 'pendente',
    hold: 'em espera',
    'on-hold': 'em espera',
    solved: 'resolvido',
    closed: 'fechado'
  };

  // "novo" e "new" sao equivalentes; idem para os outros pares.
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

  const LIST_CANDIDATES = [
    '[data-test-id="conversation-list-item"]',
    '[data-test-id*="conversation-list-item"]',
    '[data-test-id*="chat-list-item"]',
    '[data-test-id*="omni-log-item"]',
    '[data-test-id*="conversation"] [role="listitem"]',
    '[data-garden-id="tabs.tab"]',
    '[role="tablist"] [role="tab"]',
    'nav [role="listitem"]'
  ];

  const POLL_MS = 1200;
  const SERVE_COOLDOWN_MS = 4000;
  const AGENT_RECHECK_MS = 5 * 60 * 1000;

  let cfg = { ...DEFAULTS };
  let lastServeAt = 0;
  let listSelectorUsed = '';
  let timerId = null;

  /** key -> { fp, since, alerted } */
  const chats = new Map();

  /** { name, id, source, ok } | null enquanto nao resolvido */
  let agent = null;
  let agentCheckedAt = 0;
  let agentPending = false;

  let status = {
    ok: false,
    mine: 0,
    pending: 0,
    eligible: 0,
    blocked: [],
    blindBlocked: '',
    agent: null,
    listSelectorUsed: '',
    lastAction: '',
    lastActionAt: 0
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

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  }

  function setAction(text) {
    status.lastAction = text;
    status.lastActionAt = Date.now();
    log(text);
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

  // ----------------------------------------------- regra 2: identidade do agente

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
          if (!res) {
            agent = { name: null, source: null, ok: false, why: 'nao foi possivel identificar o usuario logado' };
            return;
          }
          const ok = norm(res.name).includes(norm(cfg.agentName));
          agent = {
            ...res,
            ok,
            why: ok ? '' : `logado como "${res.name}", esperado "${cfg.agentName}"`
          };
          log('agente resolvido', agent);
        })
        .catch(() => {
          agentCheckedAt = Date.now();
          agent = { name: null, source: null, ok: false, why: 'erro ao consultar a identidade' };
        })
        .finally(() => {
          agentPending = false;
        });
    }
    return agent;
  }

  // -------------------------------------------------------- regra 1: fila exata

  /**
   * Confirma que a linha pertence a fila alvo.
   * Retorna { ok, detected } — ok=false sempre bloqueia, sem modo permissivo.
   */
  function checkQueue(row) {
    const target = norm(cfg.queueFilter);
    if (!target) return { ok: false, detected: null };

    // Override explicito: le o elemento da fila e compara exatamente.
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

    if (cfg.queueMatchMode === 'contains' && norm(row.innerText).includes(target)) {
      return { ok: true, detected: cfg.queueFilter };
    }

    return { ok: false, detected: null };
  }

  // ------------------------------------------------------ regra 3: status "novo"

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
    const sels = cfg.listItemSelector ? [cfg.listItemSelector] : LIST_CANDIDATES;
    for (const sel of sels) {
      let found;
      try {
        found = [...document.querySelectorAll(sel)].filter(isVisible);
      } catch {
        continue;
      }
      if (found.length) {
        listSelectorUsed = sel;
        return found;
      }
    }
    listSelectorUsed = '';
    return [];
  }

  function rowKey(row) {
    const label = (row.innerText || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)[0];
    return label || row.getAttribute('data-conversation-id') || row.id || '';
  }

  const fingerprint = (row) => norm(row.innerText).replace(/\d+/g, '#');

  // ------------------------------------------------------ disparo do atalho

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
   */
  function fireShortcut() {
    const init = parseShortcut(cfg.shortcut);
    const target =
      document.activeElement && document.activeElement !== document.body
        ? document.activeElement
        : document;
    for (const type of ['keydown', 'keypress', 'keyup']) {
      try {
        target.dispatchEvent(new KeyboardEvent(type, init));
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

  // ------------------------------------------------------------------- decisao

  /** Avalia uma linha pendente contra as regras 1 e 3. */
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

    for (const k of [...chats.keys()]) if (!seen.has(k)) chats.delete(k);
  }

  function tick() {
    const ag = agentGate();

    // Sempre varre: o popup mostra o status e o alerta de silencio roda
    // mesmo com a atribuicao automatica desligada.
    const rows = findRows();
    const pending = [];
    const mine = [];
    for (const row of rows) {
      if (serveButtonsIn(row).length) pending.push(row);
      else mine.push(row);
    }

    // O alerta de silencio roda mesmo com a atribuicao desligada.
    trackIdle(mine);

    const verdicts = pending.map((row) => ({ row, key: rowKey(row), ...evaluate(row) }));
    const eligible = verdicts.filter((v) => v.ok);

    status = {
      ...status,
      ok: rows.length > 0,
      mine: mine.length,
      pending: pending.length,
      eligible: eligible.length,
      blocked: verdicts.filter((v) => !v.ok).slice(0, 5).map((v) => ({ key: v.key, reason: v.reason })),
      agent: ag ? { name: ag.name, ok: ag.ok, source: ag.source, why: ag.why } : null,
      listSelectorUsed
    };

    // --- portao final: tudo precisa estar confirmado
    if (!cfg.enabled) return;
    if (!ag) return;                                  // identidade ainda nao resolvida
    if (!ag.ok) return;                               // regra 2 reprovada => inerte
    if (mine.length >= Number(cfg.maxChats)) return;  // limite
    if (Date.now() - lastServeAt < SERVE_COOLDOWN_MS) return;
    if (!eligible.length) return;

    const method = cfg.serveMethod || 'shortcut';

    // Modo com escolha: clica no botao da propria linha ja aprovada.
    if (method === 'rowButton') {
      const target = eligible[0];
      const btn = serveButtonsIn(target.row)[0];
      if (!btn) return;
      lastServeAt = Date.now();
      const label = target.key || 'chat da fila';
      btn.click();
      setAction(`Assumido: ${label}`);
      notify('Chat assumido', `${label} — ${cfg.queueFilter}`, false);
      return;
    }

    // Modos cegos (atalho e botao global): a acao serve "o proximo da fila",
    // sem escolher qual. So e seguro se TODOS os pendentes forem elegiveis —
    // com um unico fora da regra, o proximo poderia ser justamente ele.
    if (eligible.length !== pending.length) {
      status.blindBlocked =
        `fila mista: ${pending.length - eligible.length} de ${pending.length} pendente(s) fora da regra`;
      return;
    }
    status.blindBlocked = '';

    if (method === 'globalButton') {
      const gb = document.querySelector('[data-test-id="toolbar-serve-chat-button"]');
      if (!gb || !isVisible(gb) || gb.disabled || gb.getAttribute('aria-disabled') === 'true') return;
      lastServeAt = Date.now();
      gb.click();
      setAction('Assumido pelo botao global');
    } else {
      lastServeAt = Date.now();
      if (!fireShortcut()) return;
      setAction(`Assumido via ${cfg.shortcut}`);
    }

    notify('Chat assumido', `${pending.length} elegivel(is) — ${cfg.queueFilter}`, false);
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
    const serveBtn = document.querySelector('[data-test-id="toolbar-serve-chat-button"]');
    const convBtn = [...document.querySelectorAll('button, [role="button"]')].find((b) =>
      /^conversas\b/.test(norm(b.innerText))
    );
    const path = location.pathname;
    return [
      `tela: ${path.includes('/filters/') ? 'views/tickets' : path.includes('chat') ? 'chat' : path}`,
      `botao global "Servir chat": ${
        serveBtn
          ? `PRESENTE | texto=${JSON.stringify((serveBtn.innerText || serveBtn.getAttribute('aria-label') || '').trim())}` +
            ` | disabled=${serveBtn.disabled || serveBtn.getAttribute('aria-disabled') === 'true'}` +
            ` | visivel=${isVisible(serveBtn)}`
          : 'ausente'
      }`,
      `painel Conversas: ${convBtn ? JSON.stringify(convBtn.innerText.replace(/\s+/g, ' ').trim()) : '(botao nao encontrado)'}`,
      `linhas de tabela de tickets (generic-table-row): ${document.querySelectorAll('[data-test-id="generic-table-row"]').length}`
    ];
  }

  /**
   * Despeja as celulas da tabela de views. Serve pra descobrir QUAL custom field
   * carrega a fila/categoria — os data-test-id vem numerados, sem nome legivel.
   * Essa tabela NAO entra em LIST_CANDIDATES de proposito: linhas de ticket nao
   * tem botao "Servir" e seriam contadas como chats meus, travando o limite.
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

  function diagnose() {
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

    const candidates = LIST_CANDIDATES.map((sel) => {
      let n = 0;
      try {
        n = [...document.querySelectorAll(sel)].filter(isVisible).length;
      } catch {}
      return `${String(n).padStart(3)}  ${sel}`;
    });

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
      `agente: ${agent ? `${agent.name} (${agent.source}) ok=${agent.ok}` : '(nao resolvido)'}`,
      `fila alvo: "${cfg.queueFilter}" | modo: ${cfg.queueMatchMode}`,
      `metodo: ${cfg.serveMethod} ${cfg.serveMethod === 'shortcut' ? `(${cfg.shortcut})` : ''}` +
        `${cfg.serveMethod !== 'rowButton' ? ' [cego: exige TODOS os pendentes elegiveis]' : ''}`,
      `status permitidos: ${allowedStatusList().join(', ')}`,
      `seletor de lista em uso: ${listSelectorUsed || '(NENHUM CASOU)'}`,
      `meus: ${status.mine} | pendentes: ${status.pending} | elegiveis: ${status.eligible}`,
      '',
      '--- panorama do ambiente ---',
      ...probeEnvironment().map((l) => '  ' + l),
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
    ].join('\n');
  }

  window.__zdDiag = diagnose;

  // ----------------------------------------------------------------- mensagens

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'zd-status') {
      sendResponse({ ...status, enabled: cfg.enabled, cfg });
      return true;
    }
    if (msg?.type === 'zd-diag') {
      sendResponse({ report: diagnose() });
      return true;
    }
    return false;
  });

  // ------------------------------------------------------------------- arranque

  function start() {
    if (timerId) clearInterval(timerId);
    timerId = setInterval(loop, POLL_MS);
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
    log('config atualizada', cfg);
  });
})();
