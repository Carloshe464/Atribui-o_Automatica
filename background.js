/**
 * Service worker — so existe pra disparar notificacoes do sistema,
 * porque content script nao tem acesso a chrome.notifications.
 */

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'zd-notify') return;

  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: msg.title || 'Zendesk',
    message: msg.message || '',
    priority: 2,
    requireInteraction: false
  });
});

// Primeira instalacao: grava os defaults pra o popup abrir preenchido.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('cfg', (res) => {
    if (res?.cfg) return;
    chrome.storage.local.set({
      cfg: {
        enabled: true,
        maxChats: 3,
        idleMinutes: 6,
        queueFilter: 'Suporte Especializado (NFs)',
        queueMatchMode: 'exact',
        agentName: 'Carlos Lemos',
        allowedStatuses: 'novo',
        beep: true,
        debug: false,
        listItemSelector: '',
        serveSelector: '',
        queueSelector: '',
        statusSelector: ''
      }
    });
  });
});
