/**
 * Zendesk Auto-Atribuicao — content script
 *
 * Faz tres coisas, so com DOM. Nenhuma chamada de API.
 *
 *   1. Puxa chat novo automaticamente (Ctrl+Alt+Q ou clique em "Conversas"),
 *      em /agent/home, dentro de um chat em atendimento e na tela de conversas.
 *   2. Respeita o limite de chats simultaneos.
 *   3. A atribuicao sai como consequencia: servir atribui pra quem esta logado.
 *
 * Alem disso, alerta quando a conversa fica N minutos sem mensagem nova.
 *
 * A REGRA QUE IMPORTA: sem saber quantos chats sao meus, NAO puxa. Foi a
 * ausencia dessa regra que causou o pull em loop. Se a contagem falhar, o
 * popup diz exatamente por que, em vez de puxar no escuro.
 */
(() => {
  'use strict';

  if (window.__zdAutoAssign) return;
  window.__zdAutoAssign = true;

  const DEFAULTS = {
    enabled: true,
    maxChats: 3,
    idleMinutes: 6,

    // De onde tirar "quantos chats sao meus":
    //   'auto'  - painel de conversas, senao abas do topo, senao contador da barra
    //   'panel' - itens do painel de conversas (exige o painel aberto)
    //   'tabs'  - abas de ticket abertas no topo
    //   'bar'   - numero do botao "Conversas" da barra
    countSource: 'auto',

    //   'auto'     - clica no botao "Conversas"; se estiver inativo, usa o atalho
    //   'shortcut' - so o atalho
    //   'button'   - so o botao
    serveMethod: 'auto',
    shortcut: 'Ctrl+Alt+Q',

    beep: true,
    debug: false
  };

  const POLL_MS = 1200;
  const SERVE_COOLDOWN_MS = 6000;   // espaco minimo entre dois pulls
  const SERVE_VERIFY_MS = 8000;     // tempo pra confirmar que o pull surtiu efeito
  const IDLE_FORGET_MS = 2 * 60 * 1000;

  const SEL = {
    bar: '[data-test-id="toolbar-serve-chat-button"]',
    tab: '[data-test-id="header-tab"]',
    tablist: '[data-test-id="header-tablist"]',
    panelItem: [
      '[data-test-id="conversation-list-item"]',
      '[data-test-id*="conversation-list-item"]',
      '[data-test-id*="chat-list-item"]'
    ]
  };

  const SERVE_WORDS = ['servir', 'serve', 'atender', 'aceitar', 'assumir'];

  let cfg = { ...DEFAULTS };
  let timerId = null;
  let stopped = false;
  let serving = false;
  let attempt = null; // { at, before, verified }
  let lastServe = null;

  const INSTANCE = Math.random().toString(36).slice(2);
  const chats = new Map(); // rastreio do alerta de silencio

  let status = {};

  // ------------------------------------------------------------------ basico

  const DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g');
  const norm = (s) =>
    (s || '').toLowerCase().normalize('NFD').replace(DIACRITICS, '').replace(/\s+/g, ' ').trim();
  const text = (el) => el?.innerText || el?.textContent || '';
  const log = (...a) => cfg.debug && console.log('%c[ZD-Auto]', 'color:#03363d;font-weight:700', ...a);

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  }

  const $$ = (sel) => {
    try {
      return [...document.querySelectorAll(sel)].filter(isVisible);
    } catch {
      return [];
    }
  };

  /**
   * Recarregar a extensao sem F5 deixa o content script antigo vivo: o
   * setInterval continua, mas storage.onChanged nunca mais dispara, entao a
   * config congela e o botao de desligar deixa de ter efeito. Era essa a
   * instancia que puxava sem parar. chrome.runtime.id zera quando isso ocorre.
   */
  function alive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  const store = {
    get: (k) =>
      new Promise((res, rej) => {
        try {
          chrome.storage.local.get(k, (v) =>
            chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(v)
          );
        } catch (e) {
          rej(e);
        }
      }),
    set: (o) =>
      new Promise((res, rej) => {
        try {
          chrome.storage.local.set(o, () =>
            chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res()
          );
        } catch (e) {
          rej(e);
        }
      })
  };

  // --------------------------------------------------------------- leitura

  /** Botao "Conversas" da barra: existe em todas as telas do workspace. */
  function bar() {
    const el = document.querySelector(SEL.bar) ||
      [...document.querySelectorAll('button,[role="button"]')].find((b) => /^conversas\b/.test(norm(text(b))));
    if (!el) return null;
    const m = text(el).match(/\d+/);
    return {
      el,
      count: m ? Number(m[0]) : null,
      disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
      visible: isVisible(el)
    };
  }

  /** Itens do painel de conversas, quando aberto. */
  function panelItems() {
    for (const sel of SEL.panelItem) {
      const found = $$(sel);
      if (found.length) return found;
    }
    return [];
  }

  function serveButtonIn(root) {
    return [...(root || document).querySelectorAll('button,[role="button"]')].find((el) => {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true' || !isVisible(el)) return false;
      const t = norm(text(el) || el.getAttribute('aria-label'));
      return t && t.length <= 22 && SERVE_WORDS.some((w) => t === w || t.startsWith(w + ' '));
    });
  }

  /**
   * Quantos chats sao meus. Retorna null quando nao da pra saber — e null
   * bloqueia o pull. Errar pra menos aqui e o que gera loop.
   */
  function countMine() {
    const items = panelItems();
    const panel = items.length ? items.filter((el) => !serveButtonIn(el)).length : null;
    const tabs = $$(SEL.tab).length;
    const b = bar();
    const barCount = b && Number.isFinite(b.count) ? b.count : null;

    const src = cfg.countSource || 'auto';
    if (src === 'panel') {
      return { value: panel, from: 'painel', why: panel === null ? 'painel de conversas fechado' : '' };
    }
    if (src === 'tabs') return { value: tabs, from: 'abas', why: '' };
    if (src === 'bar') {
      return { value: barCount, from: 'barra', why: barCount === null ? 'botao Conversas nao encontrado' : '' };
    }

    if (panel !== null) return { value: panel, from: 'painel', why: '' };

    // Zero abas e uma contagem valida (nenhum chat aberto), nao ausencia de
    // fonte. Exigir tabs > 0 fazia a extensao travar em "nao sei quantos chats
    // sao meus" justamente quando estava livre pra puxar. Basta a barra de abas
    // existir na tela pra o numero valer.
    if ($$(SEL.tablist).length) return { value: tabs, from: 'abas', why: 'painel fechado' };
    if (tabs > 0) return { value: tabs, from: 'abas', why: 'painel fechado' };
    if (barCount !== null) return { value: barCount, from: 'barra', why: 'sem painel e sem abas' };
    return { value: null, from: '', why: 'nenhuma fonte de contagem disponivel' };
  }

  /** Ha chat esperando pra ser puxado? */
  function queueWaiting() {
    const items = panelItems();
    const pend = items.filter((el) => serveButtonIn(el));
    if (pend.length) return { has: true, count: pend.length, from: 'painel', rows: pend };

    const b = bar();
    if (b && b.count !== null && b.count > 0 && !b.disabled) {
      return { has: true, count: b.count, from: 'barra', rows: [] };
    }
    if (b && b.count !== null) return { has: false, count: b.count, from: 'barra', rows: [] };
    return { has: false, count: null, from: '', rows: [] };
  }

  function onWorkScreen() {
    return location.pathname.startsWith('/agent/');
  }

  // ------------------------------------------------------------------ pull

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
    const up = key.toUpperCase();
    return {
      ...init, key,
      code: /^[a-z]$/.test(key) ? 'Key' + up : up,
      keyCode: up.charCodeAt(0), which: up.charCodeAt(0),
      bubbles: true, cancelable: true, composed: true
    };
  }

  /**
   * Content script roda em mundo isolado mas compartilha o DOM, entao o evento
   * chega nos listeners da pagina. Despacha num alvo so: mandar em varios que
   * borbulham pro document dispararia o atalho duas vezes — dois pulls.
   */
  function fireShortcut() {
    const init = parseShortcut(cfg.shortcut);
    try {
      for (const type of ['keydown', 'keyup']) document.dispatchEvent(new KeyboardEvent(type, init));
      return true;
    } catch (e) {
      console.error('[ZD-Auto] falha no atalho:', e);
      return false;
    }
  }

  function doServe(q) {
    const method = cfg.serveMethod || 'auto';
    const b = bar();
    const canClick = b && b.visible && !b.disabled;

    // Linha com botao "Servir" no painel: e o caminho que escolhe o chat.
    if (q.rows.length) {
      const btn = serveButtonIn(q.rows[0]);
      if (btn) {
        btn.click();
        return 'botao da linha';
      }
    }
    if (method === 'button') return canClick ? (b.el.click(), 'botao Conversas') : null;
    if (method === 'shortcut') return fireShortcut() ? cfg.shortcut : null;
    if (canClick) {
      b.el.click();
      return 'botao Conversas';
    }
    return fireShortcut() ? cfg.shortcut : null;
  }

  // ---------------------------------------------------------- alerta 6 min

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
    } catch {}
  }

  function notify(title, message, sound) {
    try {
      chrome.runtime.sendMessage({ type: 'zd-notify', title, message });
    } catch {}
    if (sound) beep();
  }

  const rowKey = (el) =>
    (text(el).split('\n').map((s) => s.trim()).filter(Boolean)[0] || '').slice(0, 80);
  const fingerprint = (el) => norm(text(el)).replace(/\d+/g, '#');

  function trackIdle(mineRows) {
    const now = Date.now();
    const limit = Math.max(1, Number(cfg.idleMinutes)) * 60000;
    const seen = new Set();

    for (const el of mineRows) {
      const key = rowKey(el);
      if (!key) continue;
      seen.add(key);
      const fp = fingerprint(el);
      const rec = chats.get(key);
      if (!rec) {
        chats.set(key, { fp, since: now, alerted: false, missing: 0 });
      } else if (rec.fp !== fp) {
        Object.assign(rec, { fp, since: now, alerted: false, missing: 0 });
      } else if (!rec.alerted && now - rec.since >= limit) {
        rec.alerted = true;
        notify(`Sem resposta ha ${cfg.idleMinutes} min`, key, true);
      }
    }

    // Trocar de tela desmonta a lista; sem carencia, os timers zeravam.
    for (const [k, rec] of chats) {
      if (seen.has(k)) rec.missing = 0;
      else if (!rec.missing) rec.missing = now;
      else if (now - rec.missing > IDLE_FORGET_MS) chats.delete(k);
    }
  }

  // ----------------------------------------------------------------- ciclo

  function tick() {
    const b = bar();
    const items = panelItems();
    const mineRows = items.filter((el) => !serveButtonIn(el));
    trackIdle(mineRows);

    const mine = countMine();
    const q = queueWaiting();

    // Confirma se o pull anterior surtiu efeito. Sem isso, um clique sem
    // resultado ficava invisivel e a extensao "tentava" pra sempre.
    if (attempt && !attempt.verified && Date.now() - attempt.at > SERVE_VERIFY_MS) {
      const subiu = mine.value !== null && attempt.before !== null && mine.value > attempt.before;
      attempt.verified = true;
      lastServe = { at: attempt.at, method: attempt.method, ok: subiu };
      log('pull verificado:', lastServe);
    }

    const gate = (reason) => {
      status.gate = reason;
      return null;
    };

    status = {
      enabled: cfg.enabled,
      mine: mine.value,
      mineFrom: mine.from,
      mineWhy: mine.why,
      maxChats: Number(cfg.maxChats),
      panelCount: items.length ? mineRows.length : null,
      tabsCount: $$(SEL.tab).length,
      barCount: b && Number.isFinite(b.count) ? b.count : null,
      barDisabled: b ? b.disabled : null,
      queue: q.count,
      queueFrom: q.from,
      tracked: chats.size,
      path: location.pathname,
      lastServe,
      gate: ''
    };

    // ------------------------------------------------------- portao do pull
    if (stopped) return gate('instancia parada — recarregue a pagina (F5)');
    if (!alive()) {
      selfDestruct('contexto invalidado');
      return gate('instancia parada — recarregue a pagina (F5)');
    }
    if (!cfg.enabled) return gate('desligado');
    if (!onWorkScreen()) return gate(`fora do workspace (${location.pathname})`);

    if (mine.value === null) return gate(`nao sei quantos chats sao meus — ${mine.why}`);
    if (mine.value >= Number(cfg.maxChats)) {
      return gate(`limite atingido: ${mine.value}/${cfg.maxChats}`);
    }

    if (attempt && !attempt.verified) return gate('confirmando o pull anterior');
    if (Date.now() - (attempt?.at || 0) < SERVE_COOLDOWN_MS) return gate('aguardando (cooldown)');
    if (!q.has) return gate('nenhum chat esperando');

    if (serving) return gate('puxando…');
    serving = true;

    (async () => {
      try {
        // Config relida do disco: o cache em memoria pode estar congelado, e
        // era assim que o botao de desligar deixava de ser respeitado.
        const fresh = { ...DEFAULTS, ...((await store.get('cfg'))?.cfg || {}) };
        if (!fresh.enabled) return gate('desligado');
        if (mine.value >= Number(fresh.maxChats)) {
          return gate(`limite atingido: ${mine.value}/${fresh.maxChats}`);
        }

        // Uma aba por vez: varias abas do Zendesk puxavam em paralelo.
        const lock = (await store.get('serveLock'))?.serveLock;
        if (lock && Date.now() - lock.ts < SERVE_COOLDOWN_MS) return gate('outra aba esta puxando');
        await store.set({ serveLock: { id: INSTANCE, ts: Date.now() } });

        const method = doServe(q);
        if (!method) return gate('nao ha como puxar nesta tela');

        attempt = { at: Date.now(), before: mine.value, method, verified: false };
        status.gate = '';
        log('puxou via', method, '| meus antes:', mine.value);
        notify('Chat assumido', `via ${method}`, false);
      } catch (e) {
        selfDestruct(`falha ao ler a config: ${e.message}`);
      } finally {
        serving = false;
      }
    })();
  }

  // ----------------------------------------------------------- diagnostico

  function diagnose() {
    const b = bar();
    const items = panelItems();
    const ids = new Map();
    document.querySelectorAll('[data-test-id]').forEach((el) => {
      if (!isVisible(el)) return;
      const k = el.getAttribute('data-test-id');
      ids.set(k, (ids.get(k) || 0) + 1);
    });

    return [
      '=== Zendesk Auto-Atribuicao — diagnostico (sem API) ===',
      `url: ${location.href}`,
      `trava: ${cfg.enabled ? 'LIGADA' : 'DESLIGADA'} | limite: ${cfg.maxChats}`,
      `situacao: ${status.gate || '(livre pra puxar)'}`,
      '',
      '--- contagem de "meus chats" ---',
      `  em uso: ${status.mine ?? '?'} (fonte: ${status.mineFrom || '-'}${status.mineWhy ? ' — ' + status.mineWhy : ''})`,
      `  painel de conversas: ${items.length ? status.panelCount : '(fechado)'}`,
      `  abas de ticket no topo: ${status.tabsCount}`,
      `  contador da barra: ${status.barCount ?? '(nao achei)'} ${b?.disabled ? '(inativo)' : ''}`,
      '',
      '--- fila ---',
      `  esperando: ${status.queue ?? '?'} (fonte: ${status.queueFrom || '-'})`,
      `  ultimo pull: ${lastServe ? `${lastServe.method} — ${lastServe.ok ? 'surtiu efeito' : 'SEM EFEITO'}` : '(nenhum)'}`,
      '',
      '--- data-test-id visiveis (top 30) ---',
      ...[...ids.entries()].sort((a, c) => c[1] - a[1]).slice(0, 30).map(([k, v]) => `  ${v}x  ${k}`),
      '',
      '--- textos de botoes visiveis ---',
      ...[...new Set(
        [...document.querySelectorAll('button,[role="button"]')]
          .filter(isVisible)
          .map((el) => (text(el) || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
          .filter((t) => t && t.length <= 30)
      )].slice(0, 50).map((t) => `  "${t}"`)
    ].join('\n');
  }

  window.__zdDiag = diagnose;

  // -------------------------------------------------------------- arranque

  function selfDestruct(motivo) {
    if (timerId) clearInterval(timerId);
    timerId = null;
    stopped = true;
    console.warn(`[ZD-Auto] instancia parada: ${motivo}. Recarregue a pagina (F5).`);
  }

  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    if (msg?.type === 'zd-status') {
      send({ ...status, cfg });
      return true;
    }
    if (msg?.type === 'zd-diag') {
      send({ report: diagnose() });
      return true;
    }
    return false;
  });

  function loop() {
    if (stopped) return;
    if (!alive()) return selfDestruct('contexto da extensao invalidado');
    try {
      tick();
    } catch (e) {
      console.error('[ZD-Auto] erro no ciclo:', e);
    }
  }

  chrome.storage.local.get('cfg', (res) => {
    cfg = { ...DEFAULTS, ...(res?.cfg || {}) };
    log('config carregada', cfg);
    timerId = setInterval(loop, POLL_MS);
    loop();
  });

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !ch.cfg) return;
    cfg = { ...DEFAULTS, ...(ch.cfg.newValue || {}) };
    chats.clear();
    log('config atualizada', cfg);
  });
})();
