# Comentários

**Estado:** parcialmente implementado. Parte da [arquitetura de bundles](../bundles.md); `GROUNDING.md` continua sendo o contrato da implementação atual. Já existem: o bundle `comments` (`bundles/features/comments`) com `comments/v1` (`add`, `list`, `resolve`), os eventos `comments.added/v1` e `comments.resolved/v1` no log da Thread e a validação das quatro formas de âncora; `list` e `resolve` dobram esses eventos a partir do log (`runtime.threads/v1.threadEvents`), sem estado no processo, no escopo da chamada (a Thread, ou todas as Threads do Project quando a chamada só nomeia o Project); a pilha do compositor (`chat.composer/v1`), a nota confirmada no próprio canvas do papercraft antes de entrar na pilha, o envio da pilha fora do compositor (`chat.send/v1`, `Cmd/Ctrl+Enter`), o flush depois do aceite do prompt — que devolve à pilha o item cuja gravação falhou —, o prompt em envelope XML (`<comments>` e `<message>`) que leva os comentários da pilha acima das palavras do usuário, o `commentId` escolhido por quem comenta e as respostas (`inReplyTo`), a tool `comment_reply` com que o agente responde e resolve, e as threads de comentário com estado (`done`, `await`, `open`) que o `chat` projeta; e os consumidores papercraft (alvo `artifact`) e conversa (alvo `message`, âncora `range`). As decisões em aberto abaixo continuam em aberto, exceto as marcadas como decididas.

## Resumo

Um comentário é uma **anotação ancorada** num **alvo**: qualquer coisa endereçável do app — uma revisão de [artefato](./artifacts.md), uma mensagem da conversa, um arquivo e uma linha, a saída de um terminal, um elemento de um preview. O usuário aponta o ponto, escreve o que quer diferente, e o agente lê isso como instrução.

Este documento é o **spec do conceito**, e não de quem o usa: o [papercraft](./papercraft/README.md) é o primeiro consumidor (comentário num elemento do preview), a conversa é o segundo (comentário numa mensagem do agente), e qualquer funcionalidade futura que precise de comentários em qualquer coisa implementa por aqui. O que o dono do alvo fornece é o **significado da âncora** e o desenho do pino; o que o registro fornece é a identidade, o evento durável, a leitura e o rascunho.

Quatro regras dão forma ao resto do documento:

- **Um comentário sempre tem âncora.** Sem âncora não é comentário — é mensagem, e a mensagem já existe: é o prompt.
- **O comentário é durável e reconstruível.** Ele vira um evento do log, e o replay o reconstrói como reconstrói qualquer node.
- **O comentário abre uma thread.** O agente responde ao comentário — dizendo o que mudou ou perguntando o que não entendeu — e a thread termina resolvida; a resposta é outro comentário, ligado ao primeiro, e não uma mensagem solta.
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

O carimbo de origem é a forma mais forte, e o [papercraft](./papercraft/README.md#âncoras-que-o-agente-entende) é o exemplo completo: quando o preview vem de um componente do Project, o carimbo aponta para o **código real** — e é isso que faz o comentário valer como instrução de edição, e não como descrição.

A âncora é resolvida contra a **estrutura derivada** do alvo, não contra uma posição de pixel: um clique em espaço vazio ainda encontra o elemento mais próximo, e o hit-test continua correto sob pan e zoom. Quem resolve é o dono do alvo; o registro nunca olha para dentro da âncora.

**A âncora envelhece.** Ela nomeia uma revisão; quando a revisão seguinte muda a linha carimbada, o comentário antigo continua apontando para o que ele viu, e é o agente que reconcilia ("a linha 42 de antes"). O que fazer nesse caso é decisão em aberto (item 1).

## O contrato `comments/v1`

Serviço de host fornecido pelo bundle `comments`, cardinalidade `one` como os demais. Os métodos que uma janela chama declaram `desktopScope` com `['projectId', 'threadId', 'promptId']` e `expose: 'desktop'`, como `resources/v1` e `screen.views/v1`.

| Método    | O que faz                                                                                                                        |
| --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `add`     | Grava `comments.added/v1` com o alvo, a âncora e o texto, e devolve a identidade do comentário; aceita `commentId` e `inReplyTo` |
| `list`    | Devolve os comentários de um alvo (ou de um `kind`), na ordem do log                                                             |
| `resolve` | Marca um comentário como atendido, gravando `comments.resolved/v1`                                                               |

`add` aceita um `commentId` escolhido por quem chama (`/^[A-Za-z0-9_-]{1,128}$/`), idempotente por Thread: gravar de novo o mesmo id devolve o comentário que já existe. É assim que o id que o prompt nomeia ao agente (`comment-<uuid>`, o id do item da pilha) é o id do evento. `inReplyTo` aponta para outro comentário **da mesma Thread** e é normalizado para a **raiz**: a thread é plana, e toda resposta aponta para o primeiro comentário. Uma raiz que não existe na Thread recusa a chamada.

O bundle também registra a tool `comment_reply` (ordem 1800, sempre disponível, sem skill), e por isso passa a exigir `tools/v1`. A entrada é `{ comment_id, text, resolve? }`; a tool procura o comentário na Thread da chamada, normaliza para a raiz e grava a resposta com `author: "agent"`, o alvo da raiz e `inReplyTo` apontando para ela. Com `resolve`, grava também `comments.resolved/v1` na raiz. A saída é `{ commentId, inReplyTo, resolved }`.

Eventos, declarados em `contracts/` com `defineEvent` e registrados com `events/v1` na ativação, no sumidouro que o `runtime` já registra (`scopeKeys` `['projectId', 'threadId', 'promptId']` no stream `runtime.thread.events/{threadId}`, `bundles/runtime/runtime/src/contracts/events.ts:28-32`):

| Evento                 | Payload (resumo)                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `comments.added/v1`    | `commentId`, `target` (`kind`, `id`, `revision?`, `anchor`), `text`, `author?`, `inReplyTo?` |
| `comments.resolved/v1` | `commentId`, `resolved`                                                                      |

Um comentário é **imutável**: editar um comentário enviado é um evento novo (decisão em aberto, item 4).

## Dois registros, um dono

O comentário tem um só gesto — o envio — e dois registros, porque o log durável e o histórico do provider são contratos separados ([eventos e nodes](./events-and-nodes.md)):

1. **O evento** `comments.added/v1` — durável, replayável, desenhado como pino no alvo e presente no transcript, com o prompt. É a memória do comentário.
2. **O prompt** — o único canal que acorda o agente, enviado por `runtime.threads/v1.prompt({ id, prompt })`, o mesmo caminho do compositor da conversa (`bundles/desktop/chat/src/client/api/threads-api.ts:32`), num envelope XML ([abaixo](#o-prompt-o-envelope-xml)).

Os dois nascem do mesmo envio. Um comentário que nunca chega a ser enviado **não vira evento**: enquanto é rascunho, ele não está no log.

O dono é um só, e é o do alvo: ele desenha o elemento na pilha, resolve a âncora e registra o `flush` que transforma o rascunho em evento. O `chat` não sabe o que é um comentário — ele sabe o que é um **item da pilha do compositor**.

## O rascunho e a pilha do compositor

O texto do prompt e a pilha de comentários são **um só estado**, e ele vive no processo principal, num serviço de host — `chat.composer/v1` —, com uma parte `desktop` do `chat` provendo, no mesmo desenho do `history`.

- **Chaveado por `(projectId, threadId)`**, e toda janela lê e assina: `read({ threadId })` para o retrato e `watch(threadId, listener)` para os deltas, no formato de `runtime.threads/v1.watchThread` — retrato primeiro, depois os itens ao vivo, com `StreamListener<T>`.
- **Sobrevive à navegação** e é o mesmo em qualquer janela: hoje o rascunho vive só no `threadChatsStore` da janela que o escreveu (`bundles/desktop/chat/src/client/stores/thread-chats.ts`), então uma segunda janela abre a conversa vazia.
- **O item da pilha é genérico**: `{ id, kind, elementTag, data, author, note }`. O `chat` resolve o `elementTag` como resolve um bloco de conversa, e o `flush()` que o dono registra para o seu `kind` é o que o envio chama. O `id` do item é `comment-<uuid>` e vira o `commentId` do evento (`addItem` aceita um `id` opcional, e o item devolvido à pilha o mantém); a convenção de `data` é `{ target, pin?, inReplyTo?, refs?: { title?, source? } }`. É assim que dois consumidores diferentes — o preview do papercraft e uma mensagem da conversa — usam a mesma pilha, com o mesmo elemento e o mesmo gesto.

O flush roda **depois** que o host aceita o prompt: um envio recusado devolve as palavras ao editor e a pilha fica onde está. Ele grava `commentId` e `inReplyTo` **na ordem da pilha**, e uma resposta espera enquanto a raiz dela ainda é rascunho (a raiz é gravada antes, ou a resposta volta para a pilha). Os eventos entram no log na ordem em que foram gravados, e o bloco nasce ancorado pelo `sequence` logo abaixo do turno do usuário.

## Onde o comentário aparece

| Lugar                       | O que mostra                                                                                                                 | Quem desenha   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------- |
| A pilha acima do prompt     | Uma linha por comentário (`chat-comment-line`), com avatar, `↩` nas respostas, autor, a nota editável, a âncora e o `[pino]` | O `chat`       |
| O turno do usuário          | As mesmas linhas, acima do texto que o usuário escreveu; clicar abre a thread no preview mais recente                        | O `chat`       |
| A resposta do agente        | Blocos de resposta no ponto do turno do agente em que a `comment_reply` aconteceu, agrupados                                 | O `chat`       |
| O alvo                      | O pino com o estado da thread, ou o contorno no ponto ancorado; o controle de comentar mostra a contagem                     | O dono do alvo |
| A linha do código, num diff | O indicador de comentário na linha, como o Antigravity faz                                                                   | O dono do alvo |

O dono do alvo decide **onde a nota se escreve**. Num alvo de canvas, como o preview do [papercraft](./papercraft/README.md#o-node-da-conversa), é no próprio alvo, como no Figma: o clique abre um campo ao lado do pino, e só **confirmar** a nota (`Enter` ou ↑) acrescenta a linha à pilha, já com ela — um campo vazio que perde o foco, ou cancelado com `Esc`, nunca toca a pilha. Num alvo de texto, como a mensagem do agente, o clique vira uma linha na pilha e a nota se escreve ali. Nos dois casos a linha confirmada é um **rascunho**: editar ou remover na pilha muda o alvo, e vice-versa, porque é um só item; e o comentário e o pedido do usuário viajam juntos no mesmo envio.

O envio é o do compositor. Fora dele, o alvo envia a pilha com `Cmd/Ctrl+Enter` (e a janela do canvas, que não tem prompt, com o botão `Enviar ao agente`) pelo serviço de cliente `chat.send/v1`: o mesmo caminho do botão de enviar — as linhas da pilha com as âncoras no prompt, o flush só depois do aceite e os itens cuja gravação falhou de volta na pilha —, sem as palavras do editor.

A linha da pilha é do `chat` para **todo** `kind`, e a nota se edita **na própria linha**, sem popover nem botões: o campo é um `contenteditable` ao lado do avatar, e o teclado é o da pilha — ↑/↓ andam entre as notas e o prompt, `Enter` vai para a próxima, `Esc` volta ao prompt, `Cmd/Ctrl+Backspace` apaga a linha (assim como `Backspace`/`Delete` numa nota vazia) e `Cmd/Ctrl+Enter` envia. Os eventos da pilha ficam isolados do Lexical, que não os vê como edição do prompt.

### Threads, estados e respostas do agente

O `chat` projeta `comments.added/v1` e `comments.resolved/v1` (as duas reivindicadas pela projeção embutida dele) em **threads**: a raiz, as respostas na ordem do log e o estado, que é derivado:

| Estado  | Quando                                                               |
| ------- | -------------------------------------------------------------------- |
| `done`  | A raiz foi resolvida (`comments.resolved/v1`)                        |
| `await` | A última mensagem da thread é do agente: a resposta espera o usuário |
| `open`  | O usuário falou por último, ou ninguém respondeu ainda               |

As respostas do agente aparecem no ponto do turno do agente em que aconteceram, como linhas recolhíveis no estilo das tools (`Replied to [n]` com o trecho do comentário e, no fim, o **pino do comentário** — a gota do canvas (`desktop/ui/comment-pin`, em três tamanhos; a linha usa o pequeno), numerada, na cor do estado: aberta, aguardando ou resolvida). A linha vem fechada quando a thread está resolvida e aberta nos outros estados, e a escolha do leitor prevalece. A linha de uma `comment_reply` bem-sucedida na lista de tools fica escondida, porque a linha de resposta já a mostra. Clicar no pino **não** salta para o canvas: abre um popover com a thread (as mensagens, com avatar e autor) e, no cabeçalho dele, o botão que leva ao comentário no canvas. No turno do usuário, a linha do comentário não desenha o estado (ele só é lido para leitores de tela); clicar na linha leva ao preview mais recente do alvo, com a thread aberta.

As linhas de comentário do turno do usuário e o botão do cabeçalho do popover do pino — o que leva ao comentário no canvas — disparam o evento DOM `doric:comment-thread-open` (borbulha, `composed`, `detail: { commentId, target }`, com o id da **raiz** e o alvo sem `revision`, que quer dizer a revisão mais recente), que o dono do alvo escuta para abrir a thread no próprio alvo: só o node do papercraft da revisão mais recente abre o popover do pino. Os blocos externos da conversa levam `data-chat-block-id`. A janela do canvas é outro documento e não recebe o evento DOM do `chat`: abrir o pino a partir da conversa é uma limitação conhecida dela.

### O prompt: o envelope XML

O texto que o agente lê é montado pelo `chat` em **todo** envio (o do editor e o de `chat.send/v1`):

```xml
<comments>
<target kind="artifact" id="art_123" revision="2" title="Checkout" source="src/Checkout.tsx">
<comment id="comment-…" pin="1" anchor="src/Checkout.tsx:14" element="h2">aumenta o respiro</comment>
<comment id="comment-…" in-reply-to="comment-…" pin="1" anchor="src/Checkout.tsx:14">e o botão também</comment>
</target>
</comments>
<message>
palavras do usuário
</message>
```

Cada parte vazia é omitida (só comentários, ou só palavras, já é um prompt inteiro; um prompt só de palavras continua sendo texto simples). Um comentário leva `id`, `in-reply-to` (nas respostas), `pin` e a âncora em atributos — `anchor` com `arquivo:linha`, seletor ou posição, mais `element`, `near` (o elemento mais próximo de um ponto) ou `quote` (o trecho de um intervalo) —, e a nota como corpo. Os valores de atributo são escapados e, nos corpos, as tags de fechamento dos elementos do envelope são neutralizadas (`<\/message>`), para que o texto do usuário não encerre a estrutura. O `runtime` (`bundles/runtime/direct`) embrulha o prompt inteiro em `<user-request>`, então o `chat` nunca escreve esse elemento; o prompt de sistema explica o envelope e manda o agente responder cada comentário com `comment_reply`.

**A leitura de volta é uma regra só.** O log guarda esse texto, então todo lugar do `chat` que mostra um prompt guardado como "as palavras do usuário" lê o corpo de `<message>`: o turno do usuário, as linhas e a edição da fila, o turno pendente e os marcadores do trilho. Editar um prompt da fila preserva o bloco de comentários (`withPromptMessage` troca só o corpo de `<message>`), e um prompt em texto simples, como o das conversas antigas, é lido como está.

## Comentário não autoriza

Um comentário **orienta**, e nada mais:

- Comentar pede uma mudança e alimenta a próxima revisão do alvo. O agente responde publicando uma revisão nova — o que é a conversa funcionando — e **responde ao comentário** com `comment_reply`, resolvendo-o quando atendeu.
- O agente **não espera** um comentário para agir: no Doric ele segue direto, e o comentário corrige o rumo ([a política de revisão](./artifacts.md#a-política-de-revisão)). Um comentário chegado depois da implementação vale como pedido de ajuste, não como veto.
- Não existe "aprovar comentário": o modelo não tem estado de aprovação. Quando um Project opta por revisar antes ([política `request`](./artifacts.md#a-política-de-revisão)), a aprovação é do artefato, e continua sendo outro gesto e outro evento.

## Quem usa hoje

| Consumidor                           | Alvo                               | Âncora                                                |
| ------------------------------------ | ---------------------------------- | ----------------------------------------------------- |
| [Papercraft](./papercraft/README.md) | A revisão de um artefato `preview` | O elemento carimbado, um seletor ou uma posição livre |
| A conversa                           | Uma mensagem do agente             | Um intervalo no texto da mensagem                     |

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
2. **Comentário durante um prompt em andamento.** A fila de `runtime.threads/v1` aceita; falta decidir se a pilha enfileira ou espera (decisão 7 do [papercraft](./papercraft/README.md#decisões-em-aberto)).
3. **Comentário sem prompt.** Hoje o comentário só vira evento no flush do envio; falta decidir se um comentário pode ser gravado sozinho, sem acordar o agente.
4. **Editar e apagar.** Editar um rascunho é livre; o que fazer com um comentário já enviado — outro evento, um evento de remoção, ou imutável.
5. **Decidido: `resolve`.** "Atendido" é um estado da **thread** (da raiz), marcado por `comments/v1.resolve` — o usuário, pelo popover do pino, ou o agente, com `resolve` na `comment_reply` — e projetado como `done`; reabrir é outro `resolve` com `resolved: false`. Continua em aberto se o estado também vale por alvo.
6. **Quem é o autor.** O comentário guarda o autor (`agent` nas respostas da tool; o avatar da pilha usa o jdenticon do nome); falta decidir como isso se relaciona com o usuário do Project.
7. **Notificação e retomada.** Se um comentário pendente aparece fora da conversa, como o `notifications` faz com o fim de um prompt.
8. **Alvo sem Thread.** Um comentário num alvo que não pertence a uma conversa (um arquivo do Project, uma revisão antiga) precisa de outro escopo que `projectId`/`threadId`/`promptId`.
9. **Persistência do rascunho além do processo.** Se a pilha sobrevive ao fechamento do app, num registro de cache como o do `history`, e se o texto do editor sincroniza a cada tecla ou em lotes curtos (decisão 14 do [papercraft](./papercraft/README.md#decisões-em-aberto)).
10. **Uma pilha, várias janelas.** Falta decidir o que uma janela faz quando o prompt é enviado em outra: a pilha se esvazia para todas e o editor das demais se limpa (decisão 15 do [papercraft](./papercraft/README.md#decisões-em-aberto)).

## Referências

- [Reviewing artifacts](https://antigravity.google/docs/cli/artifacts) (Antigravity CLI): o comentário por linha, o indicador na linha e o envio do feedback de volta à conversa.
- [Implementation plan](https://antigravity.google/docs/implementation-plan) (Antigravity): comentar o plano para redirecionar o agente antes de ele editar.
- [Artifacts](https://antigravity.google/docs/artifacts) (Antigravity): a colaboração assíncrona e a revisão em marcos.
- [Artefatos](./artifacts.md): o alvo com revisões, a política de revisão e a decisão de seguir direto.
- [Papercraft](./papercraft/README.md): o primeiro consumidor — a âncora carimbada, o pino e a pilha.
- [Eventos e nodes](./events-and-nodes.md): o log durável, os projetores e os nodes de conversa.
- [O bundle chat](./chat.md): `chat.views/v1`, os renderizadores e o serviço de compositor.
- [Direct](../../../bundles/runtime/direct/README.md): o envelope de entrada (`<user-request>` e os demais) em que o prompt chega ao modelo.
- [Armazenamento genérico e histórico](./storage.md): o cache local por bundle, o precedente do `history`.
- [Contextos e capacidades](./contexts.md): o `call` com `scope`, que é o que amarra o comentário ao Project, à Thread e ao prompt.
