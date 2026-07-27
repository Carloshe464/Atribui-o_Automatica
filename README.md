# Zendesk Auto-Atribuição

Extensão MV3 para Edge. Faz três coisas, **só com DOM — nenhuma chamada de API**:

1. **Puxa chat novo automaticamente** em `/agent/home`, dentro de um chat em
   atendimento e na tela de conversas — via `Ctrl+Alt+Q` ou clique em "Conversas".
2. **Respeita o limite** de chats simultâneos.
3. **A atribuição sai como consequência**: servir atribui para quem está logado
   na aba. Não existe caminho para atribuir a outra pessoa.

Além disso, alerta quando a conversa fica N minutos sem mensagem nova (padrão 6).

## Instalar

1. `edge://extensions` → **Modo de desenvolvedor**
2. **Carregar sem pacote** → selecione esta pasta
3. **F5 em todas as abas do Zendesk** — content script não entra em aba já carregada

## A regra que importa

**Sem saber quantos chats são seus, não puxa.** Foi a ausência dessa regra que
causou o pull em loop. Se a contagem falhar, o popup diz exatamente por quê, em
vez de puxar no escuro.

A contagem tenta três fontes, nesta ordem:

| Fonte | O que lê | Disponível |
|---|---|---|
| `painel` | itens do painel de conversas sem botão "Servir" | só com o painel aberto |
| `abas` | abas de ticket abertas no topo (`header-tab`) | todas as telas |
| `barra` | número do botão "Conversas" | todas as telas |

O popup mostra as três lado a lado (`painel / abas / barra`). **Compare com a
tela**: a que bater com a realidade é a certa — fixe ela em *Contar meus chats por*.

## Outras travas

- **Instância órfã.** Recarregar a extensão sem F5 deixa o content script antigo
  rodando com a config congelada, imune ao botão de desligar. Era ela que puxava
  sem parar. Um watchdog detecta e para a instância.
- **Config relida do disco** antes de cada pull — o cache em memória pode estar
  velho.
- **Uma aba por vez.** Várias abas do Zendesk puxavam em paralelo.
- **Confirma o pull anterior** antes de tentar de novo. Sem isso, um clique sem
  efeito ficava invisível e a extensão tentava para sempre.

Não há mais disjuntor (teto de pulls por janela). Isso significa que **o limite é
a única coisa segurando o pull** — se a fonte de contagem estiver errada, não há
rede embaixo. Por isso a contagem falha fechada.

## Testes

```bash
npm install jsdom && node test/gates.test.js
```

30 casos. O que mais importa: **fila que nunca acaba**. Cada pull abre uma aba
(como no Zendesk real), a contagem sobe, e o teste confirma que ele para exatamente
no limite — 3 pulls com limite 3, 5 com limite 5. Era esse o cenário do loop.

Também: pull nas quatro telas, limite por cada uma das três fontes, sem fonte de
contagem, pull duplicado, lock entre abas, desligar em voo e instância órfã.

O ritmo é de ~1 pull a cada 8 segundos — ele espera confirmar o anterior antes de
tentar de novo. Isso sozinho já impede a enxurrada.

## Limitações

- Só funciona com a aba do Zendesk aberta.
- `Ctrl+Alt+Q` e o botão "Conversas" servem **o próximo da fila** — não dá para
  escolher qual chat. Só o botão "Servir" de uma linha do painel escolhe. Se
  chats de outras filas chegam para você, a extensão não tem como filtrar.
- O alerta é de **silêncio na conversa** (nenhuma mensagem nova por N min), não
  especificamente "a última mensagem foi sua".
