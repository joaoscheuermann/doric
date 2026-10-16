# Comentários — proposta

**Estado:** proposta. Parte da [arquitetura de bundles](../bundles.md); nada aqui descreve comportamento já implementado, e `GROUNDING.md` continua sendo o contrato da implementação atual. Os caminhos citados como evidência existem hoje no repositório.

## Resumo

Um comentário é uma **anotação ancorada** num **alvo**: qualquer coisa endereçável do app — uma revisão de [artefato](./artifacts.md), uma mensagem da conversa, um arquivo e uma linha, a saída de um terminal, um elemento de um preview. O usuário aponta o ponto, escreve o que quer diferente, e o agente lê isso como instrução.

Este documento é o **spec do conceito**, e não de quem o usa: o [papercraft](./papercraft.md) é o primeiro consumidor (comentário num elemento do preview), a conversa é o segundo (comentário numa mensagem do agente), e qualquer funcionalidade futura que precise de comentários em qualquer coisa implementa por aqui. O que o dono do alvo fornece é o **significado da âncora** e o desenho do pino; o que o registro fornece é a identidade, o evento durável, a leitura e o rascunho.

Três regras dão forma ao resto do documento:

- **Um comentário sempre tem âncora.** Sem âncora não é comentário — é mensagem, e a mensagem já existe: é o prompt.
- **O comentário é durável e reconstruível.** Ele vira um evento do log, e o replay o reconstrói como reconstrói qualquer node.
- **Um comentário nunca autoriza.** Ele orienta; a decisão de agir é do agente, e o Doric é [YOLO por padrão](./artifacts.md#a-política-de-revisão): o agente segue direto e o comentário corrige o rumo.

## O alvo

O comentário não sabe o que comenta. Ele carrega uma **referência de alvo**, e o dono do alvo é quem a interpreta:

| Campo       | O que é                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------- |
| `kind`      | O tipo do alvo, declarado pelo bundle dono: `artifact`, `message`, `file`, `terminal`, …    |
| `id`        | A identidade do alvo dentro do tipo                                                         |
| `revision?` | A revisão do alvo, quando ele tem revisões (uma revisão de artefato, uma versão de arquivo) |
| `anchor`    | Onde no alvo o comentário se ancora (abaixo)                                                |

O registro **não interpreta** o alvo: ele guarda, valida o schema e transmite. Quem sabe que `revision` significa algo e que a âncora aponta para um elemento é o bundle dono do `kind` — o mesmo desenho que faz o `chat` hospedar um bloco sem conhecer o tipo dele.

Um alvo que existe fora de uma Thread (um arquivo do Project, por exemplo) continua sendo alvo: o comentário é gravado no escopo da chamada, como qualquer evento durável.

## A âncora

Um comentário solto ("esse botão está errado") obriga o agente a adivinhar a que o usuário se refere. A âncora resolve isso, e tem quatro formas:

| Forma      | O que guarda                                                 | Onde nasce                                          |
| ---------- | ------------------------------------------------------------ | --------------------------------------------------- |
| `source`   | O par arquivo e linha, como `src/components/Checkout.tsx:42` | O carimbo de origem que o alvo aplica no build      |
| `selector` | Um seletor do alvo, quando o carimbo não é o ponto           | A estrutura derivada que o dono mantém              |
| `point`    | Uma posição no alvo, com o elemento mais próximo             | Um clique em espaço vazio                           |
| `range`    | Um intervalo no texto do alvo                                | Uma seleção de texto numa mensagem ou num documento |

O carimbo de origem é a forma mais forte, e o [papercraft](./papercraft.md#âncoras-que-o-agente-entende) é o exemplo completo: quando o preview vem de um componente do Project, o carimbo aponta para o **código real** — e é isso que faz o comentário valer como instrução de edição, e não como descrição.

A âncora é resolvida contra a **estrutura derivada** do alvo, não contra uma posição de pixel: um clique em espaço vazio ainda encontra o elemento mais próximo, e o hit-test continua correto sob pan e zoom. Quem resolve é o dono do alvo; o registro nunca olha para dentro da âncora.

**A âncora envelhece.** Ela nomeia uma revisão; quando a revisão seguinte muda a linha carimbada, o comentário antigo continua apontando para o que ele viu, e é o agente que reconcilia ("a linha 42 de antes"). O que fazer nesse caso é decisão em aberto (item 1).

## O contrato `comments/v1`

Serviço de host fornecido pelo bundle `comments`, cardinalidade `one` como os demais. Os métodos que uma janela chama declaram `desktopScope` com `['projectId', 'threadId', 'promptId']` e `expose: 'desktop'`, como `resources/v1` e `screen.views/v1`.

| Método    | O que faz                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------- |
| `add`     | Grava `comments.added/v1` com o alvo, a âncora e o texto, e devolve a identidade do comentário |
| `list`    | Devolve os comentários de um alvo (ou de um `kind`), na ordem do log                           |
| `resolve` | Marca um comentário como atendido, gravando `comments.resolved/v1`                             |

Eventos, declarados em `contracts/` com `defineEvent` e registrados com `events/v1` na ativação, no sumidouro que o `runtime` já registra (`scopeKeys` `['projectId', 'threadId', 'promptId']` no stream `runtime.thread.events/{threadId}`, `bundles/runtime/runtime/src/contracts/events.ts:28-32`):

| Evento                 | Payload (resumo)                                                    |
| ---------------------- | ------------------------------------------------------------------- |
| `comments.added/v1`    | `commentId`, `target` (`kind`, `id`, `revision?`, `anchor`), `text` |
| `comments.resolved/v1` | `commentId`, `resolved`                                             |

Um comentário é **imutável**: editar um comentário enviado é um evento novo (decisão em aberto, item 4).

## Dois registros, um dono

O comentário tem um só gesto — o envio — e dois registros, porque o log durável e o histórico do provider são contratos separados ([eventos e nodes](./events-and-nodes.md)):

1. **O evento** `comments.added/v1` — durável, replayável, desenhado como pino no alvo e presente no transcript, com o prompt. É a memória do comentário.
2. **O prompt** — o único canal que acorda o agente, enviado por `runtime.threads/v1.prompt({ id, prompt })`, o mesmo caminho do compositor da conversa (`bundles/desktop/chat/src/client/api/threads-api.ts:32`), com texto legível em Markdown.

Os dois nascem do mesmo envio. Um comentário que nunca chega a ser enviado **não vira evento**: enquanto é rascunho, ele não está no log.

O dono é um só, e é o do alvo: ele desenha o elemento na pilha, resolve a âncora e registra o `flush` que transforma o rascunho em evento. O `chat` não sabe o que é um comentário — ele sabe o que é um **item da pilha do compositor**.

## O rascunho e a pilha do compositor

O texto do prompt e a pilha de comentários são **um só estado**, e ele vive no processo principal, num serviço de host — `chat.composer/v1` —, com uma parte `desktop` do `chat` provendo, no mesmo desenho do `history`.

- **Chaveado por `(projectId, threadId)`**, e toda janela lê e assina: `read({ threadId })` para o retrato e `watch(threadId, listener)` para os deltas, no formato de `runtime.threads/v1.watchThread` — retrato primeiro, depois os itens ao vivo, com `StreamListener<T>`.
- **Sobrevive à navegação** e é o mesmo em qualquer janela: hoje o rascunho vive só no `threadChatsStore` da janela que o escreveu (`bundles/desktop/chat/src/client/stores/thread-chats.ts`), então uma segunda janela abre a conversa vazia.
- **O item da pilha é genérico**: `{ id, kind, elementTag, data, author, note }`. O `chat` resolve o `elementTag` como resolve um bloco de conversa, e o `flush()` que o dono registra para o seu `kind` é o que o envio chama. É assim que dois consumidores diferentes — o preview do papercraft e uma mensagem da conversa — usam a mesma pilha, com o mesmo elemento e o mesmo gesto.

O flush roda **depois** que o host aceita o prompt: um envio recusado devolve as palavras ao editor e a pilha fica onde está. Os eventos entram no log na ordem em que foram gravados, e o bloco nasce ancorado pelo `sequence` logo abaixo do turno do usuário.

## Onde o comentário aparece

| Lugar                       | O que mostra                                                                                        | Quem desenha   |
| --------------------------- | --------------------------------------------------------------------------------------------------- | -------------- |
| A pilha acima do prompt     | Uma linha por comentário, com avatar, autor, a nota truncada e a âncora com o número do pino        | O `chat`       |
| O turno do usuário          | As mesmas linhas, acima do texto que o usuário escreveu — o mesmo elemento, agora vindo do projetor | O `chat`       |
| O alvo                      | O pino, o contorno ou o indicador no ponto ancorado; o controle de comentar mostra a contagem       | O dono do alvo |
| A linha do código, num diff | O indicador de comentário na linha, como o Antigravity faz                                          | O dono do alvo |

O comentário **não abre popover sobre o alvo**. O clique vira uma linha na pilha, e a nota se escreve ali: o alvo fica livre, a escrita acontece no mesmo lugar de sempre — o compositor —, e o comentário e o pedido do usuário viajam juntos no mesmo envio.

A linha é **linha única** e truncada com elipses; abrir a linha mostra o texto inteiro e é ali que a nota se edita (`Popover` + `Details`, o desenho que a fila de mensagens já usa).

## Comentário não autoriza

Um comentário **orienta**, e nada mais:

- Comentar pede uma mudança e alimenta a próxima revisão do alvo. O agente responde publicando uma revisão nova — o que é a conversa funcionando.
- O agente **não espera** um comentário para agir: no Doric ele segue direto, e o comentário corrige o rumo ([a política de revisão](./artifacts.md#a-política-de-revisão)). Um comentário chegado depois da implementação vale como pedido de ajuste, não como veto.
- Não existe "aprovar comentário": o modelo não tem estado de aprovação. Quando um Project opta por revisar antes ([política `request`](./artifacts.md#a-política-de-revisão)), a aprovação é do artefato, e continua sendo outro gesto e outro evento.

## Quem usa hoje

| Consumidor                    | Alvo                               | Âncora                                                |
| ----------------------------- | ---------------------------------- | ----------------------------------------------------- |
| [Papercraft](./papercraft.md) | A revisão de um artefato `preview` | O elemento carimbado, um seletor ou uma posição livre |
| A conversa                    | Uma mensagem do agente             | Um intervalo no texto da mensagem                     |

O papercraft é o consumidor com desenho completo (a âncora carimbada, o pino, o botão com a contagem, a pilha). O segundo uso — comentar a resposta do agente — é outro `kind` na mesma pilha, com o mesmo elemento e o mesmo `flush`, e existe para provar que o conceito não é do papercraft.

## Antigravity como referência

| No Antigravity                                                | No Doric                                                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Comentário por linha, com indicador na linha comentada        | Âncora `source` com arquivo e linha, e o indicador na linha                   |
| Feedback enviado de volta à conversa ao fechar o visualizador | O flush do envio: o evento durável e o prompt juntos                          |
| Comentário no plano, antes de o agente editar                 | Comentário em qualquer alvo, com o agente seguindo direto e corrigindo o rumo |
| Comentário como mecanismo de co-steering                      | O mesmo, e é o único papel do comentário: ele nunca autoriza                  |

O que **não** se copia: o comentário preso a uma superfície só. Aqui o comentário é durável e ancorado, então ele aparece no alvo, no transcript e em qualquer janela — e serve tanto para o agente quanto para quem lê a conversa depois.

## Decisões em aberto

1. **Âncora obsoleta.** O que o alvo faz quando a revisão seguinte muda o ponto: manter a âncora antiga (e deixar o agente reconciliar), remapear pela estrutura derivada, ou marcar o comentário como órfão na tela.
2. **Comentário durante um prompt em andamento.** A fila de `runtime.threads/v1` aceita; falta decidir se a pilha enfileira ou espera (decisão 7 do [papercraft](./papercraft.md#decisões-em-aberto)).
3. **Comentário sem prompt.** Hoje o comentário só vira evento no flush do envio; falta decidir se um comentário pode ser gravado sozinho, sem acordar o agente.
4. **Editar e apagar.** Editar um rascunho é livre; o que fazer com um comentário já enviado — outro evento, um evento de remoção, ou imutável.
5. **`resolve`.** O que "atendido" significa, quem marca e se o estado é por comentário ou por alvo.
6. **Quem é o autor.** Se o comentário guarda o autor (o avatar da pilha usa o jdenticon do nome), e como isso se relaciona com o usuário do Project.
7. **Notificação e retomada.** Se um comentário pendente aparece fora da conversa, como o `notifications` faz com o fim de um prompt.
8. **Alvo sem Thread.** Um comentário num alvo que não pertence a uma conversa (um arquivo do Project, uma revisão antiga) precisa de outro escopo que `projectId`/`threadId`/`promptId`.
9. **Persistência do rascunho além do processo.** Se a pilha sobrevive ao fechamento do app, num registro de cache como o do `history`, e se o texto do editor sincroniza a cada tecla ou em lotes curtos (decisão 14 do [papercraft](./papercraft.md#decisões-em-aberto)).
10. **Uma pilha, várias janelas.** Falta decidir o que uma janela faz quando o prompt é enviado em outra: a pilha se esvazia para todas e o editor das demais se limpa (decisão 15 do [papercraft](./papercraft.md#decisões-em-aberto)).

## Referências

- [Reviewing artifacts](https://antigravity.google/docs/cli/artifacts) (Antigravity CLI): o comentário por linha, o indicador na linha e o envio do feedback de volta à conversa.
- [Implementation plan](https://antigravity.google/docs/implementation-plan) (Antigravity): comentar o plano para redirecionar o agente antes de ele editar.
- [Artifacts](https://antigravity.google/docs/artifacts) (Antigravity): a colaboração assíncrona e a revisão em marcos.
- [Artefatos](./artifacts.md): o alvo com revisões, a política de revisão e a decisão de seguir direto.
- [Papercraft](./papercraft.md): o primeiro consumidor — a âncora carimbada, o pino e a pilha.
- [Eventos e nodes](./events-and-nodes.md): o log durável, os projetores e os nodes de conversa.
- [O bundle chat](./chat.md): `chat.views/v1`, os renderizadores e o serviço de compositor.
- [Armazenamento genérico e histórico](./storage.md): o cache local por bundle, o precedente do `history`.
- [Contextos e capacidades](./contexts.md): o `call` com `scope`, que é o que amarra o comentário ao Project, à Thread e ao prompt.
