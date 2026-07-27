# Zendesk Auto-Atribuição (NFs)

Extensão MV3 para Edge. Assume chats da fila **Suporte Especializado (NFs)** automaticamente
até um limite configurável, e alerta quando o cliente fica N minutos sem responder.

## As três travas

A lógica é **fail-closed**: um chat só é assumido se as três condições forem *positivamente
confirmadas* no DOM. Qualquer incerteza — rótulo ausente, status ilegível, identidade não
resolvida — resulta em não fazer nada. Silêncio é o comportamento correto quando há dúvida.

| # | Trava | Como é garantida | Se não confirmar |
|---|---|---|---|
| 1 | **Só a fila NFs** | Um rótulo da linha precisa ser **exatamente** `Suporte Especializado (NFs)` (comparação sem acento/caixa, em elementos-folha) | Bloqueia. Sempre — não existe modo permissivo para essa regra |
| 2 | **Só o Carlos Lemos** | `GET /api/v2/users/me.json` com cookie de sessão; fallback no DOM | A extensão inteira fica inerte |
| 3 | **Só status Novo** | Lê `data-test-id="status-badge-<status>"` quando existir; senão cai no texto do rótulo | Bloqueia, inclusive quando o status não é identificado |

O badge tem prioridade sobre o texto: o Agent Workspace codifica o status no próprio
`data-test-id` (`status-badge-open`, `status-badge-new`), o que é bem mais confiável do que
ler texto traduzido. Confirmado no ambiente `beteltecnologia.zendesk.com`.

Sobre a trava 2, vale ser explícito: clicar em "Servir" atribui o chat para **quem está
logado na aba** — não existe forma de atribuir para outra pessoa por esse caminho. Então a
garantia real é verificar a identidade antes de tocar em qualquer coisa. Se outra pessoa
logar nesse perfil do Edge, a extensão não clica em nada e o popup mostra o motivo.

Por que **exata** e não "contém" na fila: `contains` deixaria passar `Suporte Especializado
(NFs) VIP` e também uma linha em que o próprio cliente digitou o nome da fila na mensagem.
Os dois casos estão cobertos por teste.

## Como assumir: três modos

| Modo | Ação | Escolhe o chat? |
|---|---|---|
| `shortcut` (padrão) | Dispara `Ctrl+Alt+Q` | Não — serve o próximo da fila |
| `globalButton` | Clica em `toolbar-serve-chat-button` | Não — idem |
| `rowButton` | Clica no "Servir" da própria linha | Sim |

Os dois primeiros são **cegos**: servem o próximo da fila sem escolher qual. Isso
tornaria as travas 1 e 3 inúteis — descobrir a fila depois do clique é justamente
"tocar em atendimento que não deveria".

A saída é uma trava adicional: **em modo cego, só dispara se todos os pendentes forem
elegíveis.** Aí não importa qual venha, qualquer um respeita as regras. Com um único
pendente fora da regra, não dispara — o próximo poderia ser exatamente ele. É
conservador (perde oportunidade em fila mista) e nunca viola as regras.

O atalho é despachado como `KeyboardEvent` no DOM compartilhado. O evento vai com
`isTrusted=false`, o que atende atalhos de aplicação tratados em JS — que é o caso do
Zendesk — mas não atalhos nativos do navegador.

## Instalar

1. `edge://extensions` → **Modo de desenvolvedor**
2. **Carregar sem pacote** → selecione a pasta `zendesk-auto-assign`
3. **Dê F5 na aba do Zendesk** — content script não entra em abas já carregadas

## O popup

Mostra os três portões (`✓` confirmado, `✕` bloqueado, `•` indeterminado), os contadores
`meus / pendentes / elegíveis`, e — o mais útil no dia a dia — a **lista de motivos** de cada
chat pendente que foi recusado:

```
Bruno Alves — outra fila ("Suporte Geral")
Ana Costa   — status "aberto"
Caio Melo   — fila nao confirmada
```

É por essa lista que se percebe na hora se um seletor precisa de ajuste.

## Se nada for assumido

Ordem de investigação:

1. **"Lista de conversas não detectada"** → nenhum seletor candidato casou
2. **Pendentes = 0 com chat na fila** → o botão tem outro texto (ajuste `SERVE_WORDS` no topo de `content.js`)
3. **Elegíveis = 0** → leia os motivos; quase sempre é rótulo de fila ou de status em um lugar que a heurística não alcança

Em **Ajuste fino → Copiar diagnóstico**, com um chat pendente na tela. O relatório traz, por
linha, a fila detectada, o status detectado e a lista de textos-folha — com isso dá para
preencher `Seletor do rótulo da fila` e `Seletor do rótulo de status` e travar a detecção.

## Testes

Cobrem as três travas end-to-end, com DOM simulado (19 casos):

```bash
npm install jsdom && node test/gates.test.js
```

Inclui os casos de contorno que importam: fila superstring, nome da fila aparecendo só na
mensagem do cliente, status ausente, agente errado logado, e o limite de simultâneos.

## Limitações conhecidas

- Só funciona com a aba do Zendesk aberta.
- O alerta é de **silêncio na conversa** (nenhuma mensagem nova por N min), não
  especificamente "a última mensagem foi sua". Cobre o caso real, mas dispara também se
  ninguém falar nada. Dá para refinar com um seletor de autor depois do diagnóstico.
- A detecção de fila e status depende de esses rótulos estarem visíveis na linha da lista.
  Se o Zendesk só mostrar a fila dentro da conversa aberta, a trava 1 bloqueia tudo — nesse
  caso o diagnóstico mostra `fila nao confirmada` em todas as linhas e o caminho é usar
  `Seletor do rótulo da fila`.
- Atribuições ficam no log de auditoria do Zendesk, visível para admins.
