# Papercraft

**Estado:** parcialmente implementado. Parte da [arquitetura de bundles](../../bundles.md); `GROUNDING.md` continua sendo o contrato da implementação atual. Já existem: o bundle `papercraft` (`bundles/features/papercraft`) com o tipo `preview`, `papercraft.previews/v1`, a tool `papercraft_preview` (que revisa com `artifact_id` e devolve os comentários pendentes e o estado de revisão) e a skill; no desktop, o corpo `papercraft-preview` dentro da moldura do [registro de artefatos](../artifacts.md) (com `header: 'body'`), o node quadrado com cabeçalho overlay, o fluxo de comentário do Figma (campo no pino, rascunho na pilha, `Cmd/Ctrl+Enter` envia por `chat.send/v1`), os pinos de rascunhos e de comentários enviados — com o estado da thread (rascunho, aberto, esperando resposta, resolvido) —, o popover da thread (mensagens, campo de resposta, resolver e reabrir), as linhas da pilha desenhadas pelo `chat-comment-line` do `chat`, as respostas do agente pela tool `comment_reply` do [registro de comentários](../comments.md), e a janela, que acompanha a Thread ao vivo. Diferenças em relação ao texto abaixo: a rota da janela é `/papercraft/:projectId/:threadId/:artifactId`; sob `request` a tool não bloqueia — devolve `review.pending` e a skill manda o agente esperar a autorização antes de escrever código; sem o compositor do chat o gesto de comentar fica desabilitado, sem gravação direta no log; o ajuste ao canvas nunca passa de 100%; e a janela do canvas, que é outro documento, não recebe o evento DOM `doric:comment-thread-open` do `chat` (abrir o pino a partir de um bloco de resposta da conversa só funciona no node). O caminho B existe para a fonte `component`: o esbuild empacota dentro do sandbox do Project quando a imagem o instala em `/opt/doric/bundler` na versão do host (o host copia o runner `dist/sandbox/runner.mjs` para `.doric/papercraft/` e lê o resultado de volta, `src/host/sandbox.ts`), e senão o host empacota lendo o Project por `files/v1` (`src/host/compile.ts`), deixando externos só o que a janela compartilha pelo import map (o React e o ReactDOM com que o `mount` renderiza e os especificadores do Base UI que o mapa serve; `lucide-react`, fora do import map, vem embutido do host no `index.js`, e `radix-ui` é pacote do Project como qualquer outro), gera o `index.css` com Tailwind e publica `index.html` (fallback), `index.js` e `index.css`; um erro de compilação falha a chamada antes de publicar. Providers, props e CSS vêm do Project: um harness versionado (`.storybook/preview.*` ou `.papercraft/preview.*`) e stories CSF — as do Project ou uma story de rascunho em `.doric/artifacts/drafts/` —, e os overlays portalados ficam dentro do shadow root — os de `desktop/ui` automaticamente, os de terceiros pelo `context.papercraft.portalContainer` (ver [Harness, stories e portais](#harness-stories-e-portais)). Quem busca os bytes para o cache é a janela (`artifacts/v1.read` → `artifacts.cache/v1.ensure`), não o `desktopMain`. Ainda não existem: o caminho B para a fonte `html`, a chave de cache com `PLATFORM_VERSION`, a fonte `site` e o caminho C, e a escrita de volta (`artifacts.applied/v1`).

## Resumo

Papercraft deixa o agente **mostrar** uma mudança visual em vez de descrevê-la. O agente entrega **código de verdade** — um HTML, um componente do Project ou o caminho de um arquivo — e o preview aparece como um node da conversa, num canvas que o usuário arrasta, dá zoom e usa normalmente. Cada preview é uma **proposta** e uma **janela**: o Doric é YOLO por padrão, então o agente publica o preview e **segue direto**, implementando a mudança — a espera por autorização só existe quando o Project pede revisão ([artefatos](../artifacts.md#a-política-de-revisão)).

O preview é um **artefato** ([artefatos](../artifacts.md)): o registro que dá identidade, revisões, âncoras e comentários aos entregáveis do agente. O papercraft é o primeiro **tipo** (`kind`) desse registro — o `preview` —, e o que este documento chama de artefato do preview é a instância dele.

Três decisões do usuário moldam este desenho, e a versão anterior deste documento as contrariava:

- **Nada de iframe.** O artefato é montado no próprio app, numa raiz React própria dentro de um shadow root — no node e na janela de rota, porque o módulo é servido pelo host na origem do app. A página do host com `partition` própria fica para o que não é app (`site`, conteúdo de terceiros). Em nenhum caso há documento embutido em documento.
- **O artefato é código, não JSON.** O agente escreve HTML, um componente ou aponta um caminho. Ele não descreve a interface num schema.
- **A estrutura derivada é opcional e derivada.** Quando o canvas precisa de dados para interagir, ele os **deriva** do DOM que renderizou — como o _scene graph_ do Glide — em vez de pedir que o agente os autorisse.

O repositório de referência é [`SrivarsanK/Glide`](https://github.com/SrivarsanK/Glide): um editor visual local que mostra o app rodando num canvas, deixa selecionar, arrastar e redimensionar elementos e **escreve de volta no código-fonte** por codemods de AST, com registry de componentes para agentes, sync bidirecional e buffer de edições em staging. A seção [Herança do Glide](#herança-do-glide) mapeia cada peça dele para o que o Doric já tem.

## Herança do Glide

| Peça do Glide                                                      | No Doric                                                                                                |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Canvas com seleção, arrastar, redimensionar, zoom e pan            | Elemento do bundle `papercraft`, hospedado no node do chat por um `DecoratorNode`                       |
| _In-memory scene graph_ com bounds em cache, hit-testing sob zoom  | Derivado no client a partir do DOM montado, no elemento do canvas; nada disso vira payload de evento    |
| `glideSourceStamping`: elementos carimbados com arquivo e linha    | O build do preview carimba o mesmo `data-*`; é o que dá âncora exata ao comentário                      |
| `glide-components.json`: registry que o agente lê por nome         | Índice de componentes do Project, lido pelo agente antes de escolher o que previewar                    |
| Edições visuais → AST codemod → arquivo-fonte                      | Implementação de verdade, pelo agente, no código do Project — o preview mostra o que ela faz            |
| _Staged edits buffer_ antes de gravar                              | O evento `artifacts.revised/v1` e a revisão nova: a cópia de trabalho é o staging                       |
| `glide-positions.json` durante o arrasto, para não reiniciar o HMR | Estado de arrasto local no canvas; nada disso entra no log durável                                      |
| File watcher → sync bidirecional sem recarregar                    | `files.refresh/v1` e os eventos que o preview já produz; a atualização vira revisão, não mutação oculta |
| Proxy HTTP + WebSocket na porta 7777                               | Relay residente na origem que o host já expõe, como `screen-relay`/`ports`                              |
| Skills (`glide`, `glide-component-segregator`, `glide-setup`)      | Skill `papercraft-preview`, com o juízo de quando previewar e o fluxo de publicar e revisar             |
| UI do canvas num iframe (proxy do app)                             | **Não copiar:** o preview é montado no app ou aberto como página em janela própria                      |

## O artefato: código do Project, referenciado pelo evento

O agente escreve **arquivos** com as ferramentas que já tem (`write`, `edit`) ou pela tool do papercraft. O evento durável carrega só a referência: identificador, revisão, caminho e título. O log tem limites de append e de documento (`maxAppendBytes`/`maxDocumentBytes`, cobertos por `packages/storage/src/conformance/limits.ts`) e payload com schema fechado — HTML não pertence ali.

As três origens do preview (o campo `source` do payload):

| Origem      | O que o agente fornece                                    | Como o preview carrega                                       |
| ----------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| `html`      | Um HTML autocontido, com CSS (e JS, quando interativo)    | O documento é embrulhado num módulo e montado; ver caminho B |
| `component` | O caminho de um componente do Project, ou um novo arquivo | O host compila o componente; o node monta o módulo           |
| `site`      | Um caminho de servidor do Project (dev server, build)     | A janela do canvas aponta para o host; ver caminho C         |

O diretório do artefato, no registro central ([artefatos](../artifacts.md#onde-vive)), no root do workspace do Project:

```
/workspace/.doric/artifacts/<artifactId>/
  index.html         # o payload do tipo `preview`, origem `html` ou `component`
  artifact.json      # manifesto pequeno: tipo, título, revisão, âncoras, entradas
```

O diretório fica no workspace do Project — que as Threads compartilham —, e o registro o alcança pelo lease, como o `files` faz. Ele nasce ignorado pelo Git, e versionar um artefato é escolha do usuário, porque o entregável que se versiona é o diff do código de verdade, e não uma conversão de formato. O evento durável carrega as entradas da revisão (`path` + `sha256`), nunca os bytes: o diretório é a cópia de trabalho, e a verdade durável é o log.

**Sobre "converter em outra estrutura".** O preview não converte o componente em JSON. O que existe é uma estrutura **derivada em tempo de render**, do mesmo tipo que o Glide mantém: uma árvore de nós com bounds, tag, classes e a origem carimbada, que serve para hit-testing sob zoom, seleção, camadas e para ancorar um comentário a um ponto do artefato. Essa estrutura é cache local do canvas, descartável, reconstruída a cada render — não é contrato, não é payload de evento e não exige nada do agente.

## Como o preview chega à tela (sem iframe)

Os fatos da plataforma que restringem a resposta:

- A shell de cada janela é servida por `doric://app`, com o import map e o tema injetados por requisição (`app/desktop/doric/src/platform/protocol/shell.ts:31-52`); o handler serve `/platform/`, `/bundles/` e `/schemas/` do disco e devolve a shell para qualquer outro path (`app/desktop/doric/src/platform/protocol/handler.ts:1-3,15-31`).
- A CSP empacotada é `default-src 'none'`, `script-src 'self' '<hash do import map>'`, `style-src 'self' 'unsafe-inline'`, `connect-src 'none'`, `frame-ancestors 'none'` (`app/desktop/doric/src/platform/protocol/csp.ts:10-24`). Ou seja: estilo inline é permitido, script dinâmico não é, e nada é enquadrado.
- A shell **nunca abre HTTP ou Socket.IO**: o preload expõe só `window.doric.desktop`, e toda chamada ao host ou ao desktop é uma chamada de contrato roteada pelo dispatcher do main (`app/desktop/doric-renderer/AGENTS.md:28-33`). O conteúdo do preview chega ao node por contrato, não por `fetch`.
- O app fornece React, ReactDOM, Lexical, Base UI, `zod`, o registro shadcn (`desktop/ui`) e `bundle/contracts` por import map (o `lucide-react` não: o build do artefato o embute), e o `desktop/ui/theme.css` emite uma vez o preflight, os tokens e as classes dos componentes; cada bundle compila só os utilitários das próprias classes (`docs/architecture/bundles/platform-packages.md`).
- O build da plataforma já usa esbuild e o compilador do Tailwind (`app/desktop/doric-platform/build.mjs:16-17,484-492`), então compilar um artefato no host não introduz dependência nova no workspace.

Com isso, três caminhos, em ordem de custo:

**Caminho A — render no host, montagem no app (o fallback).** O host compila o artefato (esbuild, com os especificadores do import map como externos) e o renderiza: HTML autocontido passa como está; componente vira markup por `react-dom/server`. O host também roda um passo de Tailwind sobre as fontes do artefato, para que as classes dele existam num CSS que o node injeta inline no shadow root — o que a CSP já permite. O node recebe markup e CSS por chamada de contrato, monta num shadow root com estilo isolado do app, e o canvas (pan, zoom, seleção, comentários) é o chrome do bundle. Scripts do artefato **não** rodam no node por esse caminho: a CSP não autoriza script dinâmico, e é essa restrição que mantém o node barato.

**Caminho B — módulo vivo no node (decidido).** Para o artefato reagir no node, o módulo compilado precisa ser servido pela **origem do app**: `script-src 'self'` não deixa importar script de `blob:` nem de outra origem, e `doric://app` é a origem que a CSP já autoriza. B não inventa uma máquina nova; ele reaproveita a que já distribui bundles:

| Peça que B reutiliza                                                                | Onde ela vive hoje                                                                                                          |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Cache verificado por SHA-256, com staging no mesmo volume e rename atômico          | `ArtifactCache`, `app/desktop/doric/src/platform/catalog/artifacts.ts:1-5,45-70`                                            |
| Bytes por hash, com o host relendo o arquivo e conferindo o SHA-256 antes de servir | `doric.catalog/v1.artifact({ sha256 })` → `{ sha256, base64 }`, `packages/bundle/src/contracts/platform.ts:406-415,586-593` |
| Rota que serve um diretório verificado sob a origem do app, com guarda de caminho   | `route` e `insideRoot` em `handler.ts:70-125`, hoje para `/bundles/<id>@<version>/…`                                        |
| Import de módulo por URL dentro da janela                                           | `ImportPart`, `packages/desktop/src/client/activate.ts:46-49`                                                               |
| Lista de especificadores que ficam externos (React, Base UI, `desktop/ui/*`, `zod`) | `clientExternals`, `packages/bundle/src/build/externals.ts`                                                                 |

O fluxo é: o host compila o artefato com esbuild usando os mesmos externals, gera o CSS e calcula o SHA-256 de cada arquivo; o evento durável leva apenas `{ path, sha256 }` da revisão; o `desktopMain` busca cada hash pelo `artifacts/v1.read`, verifica e grava em `userData/artifacts/<artifactId>@<revision>/` com a mesma máquina de staging e rename; o handler ganha o prefixo `/artifacts/` e serve essa pasta; e o elemento do node — código confiável do bundle — faz `import('doric://app/artifacts/<artifactId>@<revision>/index.js')` e monta o export numa raiz React dentro do shadow root, com error boundary e descarte no unmount. Especificadores bare resolvem pelo import map da janela, então o preview usa a **mesma** instância de React e os mesmos componentes do app.

```
userData/artifacts/<artifactId>@<revision>/
  index.js           # o módulo ESM, verificado por hash
  index.css          # o Tailwind do artefato, compilado junto
```

O que B custa, além da superfície de plataforma (a rota, o fetch, o serve e seus testes): o módulo roda no **mesmo realm** da shell, então alcança o DOM do app e a ponte `window.doric`. O main valida cada chamada contra o catálogo da janela, os schemas e o `desktopScope`, então não é IPC arbitrário — mas é mais poder do que a janela isolada de C concede. As saídas são aceitar (é código do Project que o usuário está revisando), publicar só depois da autorização (e perder o preview vivo antes dela) ou restringir por allowlist; a decisão tomada é **aceitar** — o preview é a mudança que o usuário está revisando, e ele roda sob a CSP e os escopos que o app já impõe a qualquer código. Duas obrigações técnicas acompanham B: a chave do cache precisa incluir o `PLATFORM_VERSION` (um preview compilado contra `desktop/ui@1.0.0` não vale numa plataforma 2.0.0, como `engines.doric` já resolve para bundles) e o markup estático de A continua sendo o fallback quando o módulo não carrega. O build do preview é agnóstico ao Project: a janela compartilha só o React e o ReactDOM com que o `mount` renderiza; o host provisiona só o `radix-ui` e o `lucide-react` (cuja estrutura de arquivos custaria leituras demais do sandbox) e, na folha, o Tailwind e um tema genérico; todo o resto é código do Project, lido dos arquivos e do `node_modules` dele e embutido — e nada é especial ao Doric: quando o Project é o próprio Doric, o `desktop/ui`, o `bundle/contracts`, o zod e o Lexical dele são código do Project, então um componente editado ou criado aparece como o Project o tem. Os pacotes são resolvidos pelo `customConditions` do tsconfig mais próximo, que leva um pacote do workspace ao fonte. Nenhum import é recusado pelo que ele nomeia: o módulo já roda no realm da janela, onde a fronteira são as checagens do main sobre cada chamada da ponte e a CSP; só falha o que não roda numa janela ou, quando o host empacota por `files/v1`, passa do orçamento de leituras, nomeando o import.

**Caminho C — a janela de visualização (página do host).** Onde o conteúdo **não é app**: a janela carrega uma página do host, com `partition` própria e sem preload, exatamente como o bundle `screen` abre a tela de um Project (`bundles/features/screen/src/desktop/windows.ts`). O `papercraft-relay`, residente, serve a página a partir do artefato e monta a camada de comentários; o token é a capability, como em `screen-relay` (`bundles/features/screen-relay/src/host/relay.ts:1-24`).

Com B decidido, C **não é o caminho da v1**: a janela do canvas é uma **janela de rota do app** (abaixo), que reusa os mesmos módulos, serviços e import map. C fica para o `site` (dev server do Project) e para conteúdo de terceiros — o caso em que a partição própria e o token como capability são o ponto; depende de `ports` existir.

Decidido: **B no node e a janela de rota no canvas**. O usuário vê e comenta o preview na conversa desde o primeiro dia, e a janela é a mesma superfície em tela cheia.

## O canvas

O canvas é chrome do próprio bundle, renderizado no node e (em tela cheia) na janela:

- **viewport**: pan e zoom com transform; o hit-test usa a árvore derivada com bounds em cache, não `document.elementFromPoint`, porque um canvas com transform quebra o teste direto de posição — a lição do Glide.
- **seleção e camadas**: selecionar o elemento sob o ponteiro, ver a árvore, esconder e focalizar.
- **arrastar e reposicionar**: mover elementos e o próprio canvas; nada disso é durável enquanto o usuário não comentar.
- **pinos de comentário**: ancorados ao nó selecionado e à sua origem carimbada.

O que é local e o que é durável:

| Estado                               | Onde vive                         | Por quê                                                 |
| ------------------------------------ | --------------------------------- | ------------------------------------------------------- |
| Pan, zoom, tamanho da janela         | View local, por node e por janela | Replay não deve devolver o usuário a uma posição antiga |
| Seleção, camadas escondidas, arrasto | View local                        | É exploração, não decisão                               |
| Árvore derivada (scene graph)        | Cache do canvas, reconstruído     | Derivada do DOM montado; descartável por definição      |
| Comentários e suas âncoras           | Durable, no evento do comentário  | É o que o agente lê e o que o transcript mostra         |
| Revisões                             | Durable                           | É o registro do que foi proposto e do que veio          |

## A UI no node e na janela

As duas casas do preview — o node da conversa e a janela do canvas — compartilham o mesmo código de UI e o mesmo estado durável. O chrome é **mínimo** nas duas: a tela é o preview, e os controles são um cabeçalho que flutua sobre o canvas.

### Uma superfície, duas molduras

O que desenha o preview vive em `bundles/features/papercraft/src/client/surface/`:

- `preview-container.tsx` — o container do preview: o canvas que rola por trás do cabeçalho overlay (`preview-header.tsx`) e o fluxo do comentário.
- `preview-surface.tsx` — o componente que hospeda o artefato: cria um shadow root (`attachShadow({ mode: 'open' })`), injeta o `index.css` da revisão por `<link rel="stylesheet">` (a CSP permite `'self'` e `'unsafe-inline'`), copia as variáveis de tema do app para o host do shadow (`resolvedVariables`, `packages/desktop/src/tokens/css.ts:33`) e faz `import('doric://app/artifacts/<artifactId>@<revision>/index.js')`.
- `scene-graph.ts` — a árvore derivada: percorre o DOM dentro do shadow root, casa o carimbo `data-*` com as âncoras e guarda os bounds em cache. É o que permite hit-test com pan/zoom sem `document.elementFromPoint`, e é o que resolve o elemento sob um clique em espaço vazio.
- `pins-layer.tsx` — os pinos em gota (com o avatar do autor e o estado da thread) e o campo do comentário, em light DOM, por cima do shadow root; `comment-field.tsx` é o campo inline, `thread-popover.tsx` o popover da thread de um pino que já tem o primeiro comentário, e `thread-log.ts`/`threads-view.ts` agrupam os comentários do log em threads (um `watchThread` compartilhado por Thread e janela, com `comments/v1.list` de reserva).
- A linha da pilha **não** é do papercraft: o cartão de comentário próprio foi removido, e a pilha usa o `chat-comment-line` do `chat`, o mesmo elemento no turno do usuário.
- `command-toolbar.tsx` — a barra de comandos da janela: os quatro grupos de controles, os divisores e o armado da ferramenta ([abaixo](#a-barra-de-comandos)).
- `tree-panel.tsx` — a árvore da janela, sobre a mesma `scene-graph`.
- `domain/preview-state.ts` — o redutor puro dos eventos `artifacts.*` para um `PreviewState`, o mesmo usado pelo projetor do chat e pela janela.

A moldura do node usa `chrome: 'node'`; a da janela, `chrome: 'canvas'`.

### O node da conversa

O node é um **quadrado**: ocupa a largura do bloco da conversa e tem a mesma altura — não se redimensiona. Ele é o corpo da moldura do [registro de artefatos](../artifacts.md), e o tipo `preview` declara `header: 'body'`: a moldura não desenha a barra dela (título, tipo, revisão, `Comentar`) e mantém abaixo do corpo só o que é do registro — `Autorizar`, sob `request` e numa revisão aberta. Não há lista de revisões: a conversa, com as respostas do agente, é o histórico.

O **cabeçalho é overlay**, no node e na janela: uma faixa transparente, por cima do canvas, que ocupa o container inteiro desde o topo e rola por trás dela. À esquerda, o nome do arquivo (ou o título) e a revisão em tom apagado (`rev 2`); à direita, só botões de ícone com tooltip e `aria-label` — `abrir` (`ExternalLink`, só no node), que abre a janela naquele preview, e `Comentar` (balão), pressionado (`aria-pressed`) enquanto o modo comentário está ligado, com um contador pequeno dos comentários pendentes e dos rascunhos. O chrome do canvas usa Noto Sans no peso 400, e não a fonte monoespaçada da conversa em volta.

Cada revisão **abre centralizada**: quando o conteúdo é medido pela primeira vez, a vista enquadra o elemento — não a página em volta dele (o `body` e os containers da largura da página, como um `main` que centraliza um card) —, reduzindo para caber e nunca ampliando. Pan e zoom depois disso são do leitor. A medida é do que aparece: cada elemento conta só pela parte que os ancestrais que cortam o overflow deixam visível (o que rolou para fora de uma área de rolagem não conta), e um elemento sem área — como os wrappers `display: contents` do próprio módulo, que o navegador mede no canto da janela — não delimita o conteúdo nem responde ao ponteiro.

O preview de um **componente abraça o conteúdo**: o host tem a largura do que a story renderiza, até a largura do canvas, como o layout `centered` do Storybook — e um fundo que o harness pinta vira uma moldura em volta do componente, em vez de uma faixa da largura da janela. A story ou o harness que precisa da largura toda declara o `parameters.layout` do Storybook: `padded` ou `fullscreen` montam o preview na largura do canvas (o padding do Storybook não é reproduzido, porque o canvas já cerca o preview). Um preview `html` é uma página e fica na largura do canvas.

No rodapé do node, centralizado e flutuando sobre o canvas, ficam os controles de vista: diminuir o zoom, a leitura do zoom (o clique volta a 100%), aumentar o zoom e `Centralizar`, que enquadra o elemento de novo. A janela tem a barra de comandos própria e não mostra esse rodapé.

```text
╭──────────────────────────────────────────────────────────╮
│ Checkout.tsx  rev 1                              ⧉  💬 2 │
│                                                          │
│         Checkout                                         │
│         ────────────────────                             │
│                                                          │
│         Subtotal             R$ 128,00                   │
│         Frete                R$  12,00                   │
│                                                          │
│         ┌──────────────────────┐                         │
│         │     Pagar agora      │                         │
│         └──────────────────────┘                         │
│                                                          │
╰──────────────────────────────────────────────────────────╯
```

**O fluxo do comentário é o do Figma.**

1. O botão `Comentar` — ou a tecla `C`, com o canvas em foco — liga e desliga o _modo comentário_; o ponteiro vira um **balão de comentário**, que continua balão sobre qualquer elemento do artefato, qualquer que seja o cursor que ele declare. `Esc` fecha o campo aberto e, sem campo aberto, sai do modo.
2. Sob o ponteiro, o elemento que vai receber o comentário ganha um contorno **tracejado** com um leve tom da cor primária — distinto do contorno sólido da seleção. Em espaço vazio não há contorno: o comentário é uma posição livre, ancorada ao elemento mais próximo. Segurar `Alt` força a posição livre mesmo sobre um elemento.
3. O clique põe no ponto um **pino em gota** (redondo, exceto o canto inferior esquerdo, que toca o ponto; na cor primária) e, à direita dele (à esquerda, quando o canvas não tem espaço — nunca por cima do pino), o **campo do comentário**, num popover com a mesma superfície do popover da thread (fundo, borda, raio e sombra de popover do tema): o campo (`Adicionar comentário`, em Noto Sans) com o botão de enviar **fora** dele, mas dentro do popover (↑, 28px, neutro e desabilitado enquanto vazio, primário com texto), já em foco. Enquanto o campo — ou uma thread — está aberto, o rótulo `elemento · arquivo:linha` do ponteiro some, para não cobrir o campo nem o pino. Vazio, é uma linha com o ↑ ao lado; escrito o primeiro caractere, a nota fica em cima e o ↑ embaixo, à direita. Pino e campo ficam numa camada acima do conteúdo transformado — não escalam, seguem o pan e o zoom e ficam dentro do canvas.
4. `Enter` ou ↑ **confirmam**: só aí o comentário entra na pilha acima do prompt como rascunho ([abaixo](#comentários-acima-do-prompt-rascunho-no-host)). `Shift+Enter` quebra a linha; `Esc` cancela; clicar fora descarta um campo vazio e confirma um campo escrito. O modo continua ligado: o próximo clique começa outro comentário.
5. Cada rascunho confirmado é um pino: a gota em relevo com o **avatar do autor** dentro — o mesmo identicon do nome que a conversa desenha (`ReaderAvatar`) — e o número no rótulo acessível. Clicar no pino reabre o mesmo campo, preenchido, para editar a nota ou remover o rascunho — e é o mesmo rascunho da pilha: editar na pilha muda o canvas, e vice-versa. Um comentário já enviado também é um pino, e o pino que já guarda o primeiro comentário abre o **popover da thread** ([abaixo](#threads-no-canvas)).
6. Num elemento, o pino guarda onde o clique caiu dentro da caixa dele (frações, a chave extra `offset` da âncora), então acompanha o layout e o zoom, e guarda também o ponto do conteúdo clicado (`x`, `y`, chaves que toda forma aceita); uma posição livre guarda as coordenadas do conteúdo. Guarda ainda a identidade do elemento além do seletor: um trecho do texto (`text`, espaços colapsados) e `index`, a ordem dele entre os elementos do mesmo seletor (os carimbados do mesmo arquivo, quando carimbado). Numa revisão seguinte o agente pode ter editado o arquivo e mudado todas as linhas, então o pino só volta a um elemento do **mesmo seletor**: o `path:line` exato quando é o único ali; senão, entre os elementos do seletor carimbados do arquivo (ou todos os do seletor), o de texto igual, depois o do `index` gravado, o único, o que está sob o ponto `x`/`y` gravado (ou o mais perto dele) e, por fim, o de linha mais próxima; sem nenhum, o ponto gravado. Nunca um elemento de outro seletor. A âncora que o agente lê não muda de sentido: as formas `source`, `selector` e `point` e o carimbo `data-papercraft-source` são os mesmos.

**Rascunho até o envio.** Os comentários confirmados continuam rascunhos na pilha até um prompt ser enviado — o flush de sempre os grava como `comments.added/v1` e acorda o agente. `Cmd/Ctrl+Enter`, com o canvas ou o campo em foco, **envia agora**: o prompt sai com a pilha (pode sair só com ela), pelo mesmo caminho do botão de enviar do chat — os comentários da pilha no envelope `<comments>` do prompt ([comentários](../comments.md#o-prompt-o-envelope-xml)), o texto do rascunho que o host guarda, o flush depois do aceite e os itens cuja gravação falhou de volta na pilha. A janela, que não tem prompt, ganha no cabeçalho o botão `Enviar ao agente (n)` enquanto há rascunhos. O envio é o serviço de cliente `chat.send/v1` (`send({ projectId, threadId })`) que o `chat` provê em cada janela — ele inclui o texto de rascunho que o host guarda e o limpa depois do aceite: o `chat.composer/v1` roda no processo principal, que não chama os contratos do host.

```text
╭──────────────────────────────────────────────────────────╮
│ Checkout.tsx  rev 1                              ⧉  💬 1 │
│                                                          │
│         Checkout                                         │
│         ────────────────────                             │
│         ┌──────────────────────┐                         │
│         ┆     Pagar agora   ●  ┆ ╭───────────────────╮   │
│         └──────────────────────┘ │ mais respiro…  (↑)│   │
│                                  ╰───────────────────╯   │
│             (1)                                          │
│                                                          │
╰──────────────────────────────────────────────────────────╯
```

**Pan com o espaço.** O node é quadrado e nem todo artefato cabe nele: segurando a barra de espaço o ponteiro vira `grab`/`grabbing` e o arrasto move o canvas, como no Figma; soltar a barra devolve o ponteiro ao modo anterior, sem perder o comentário em ar. O mesmo gesto vale no canvas da janela. Como o node vive dentro do editor da conversa, o espaço só é do canvas enquanto o ponteiro está sobre ele — o canvas toma o foco no ponteiro, e a barra de espaço continua sendo de quem está escrevendo o prompt.

Quando o módulo não carrega, o canvas não fica vazio: o aviso é uma linha discreta e o markup estático de A aparece no lugar (decisão 10).

```text
╭──────────────────────────────────────────────────────────╮
│ Checkout.tsx                                   [ abrir ] │
│                                                          │
│ o preview não carregou · mostrando o markup de A         │
│                                                          │
│         Checkout                                         │
│         ────────────────────                             │
│                                                          │
│         Subtotal             R$ 128,00                   │
│         Frete                R$  12,00                   │
│                                                          │
│         ┌──────────────────────┐                         │
│         │     Pagar agora      │                         │
│         └──────────────────────┘                         │
│                                                          │
│                                                      (o) │
│                                                          │
╰──────────────────────────────────────────────────────────╯
```

### Comentários acima do prompt, rascunho no host

O comentário tem um só lugar de escrita, e ele é a **pilha acima do prompt do usuário**: um elemento por comentário, **linha única**, um em cima do outro entre o último turno e o bloco do prompt — o mesmo padrão das linhas da fila de mensagens (`thread-queue.tsx:95-105`), que traz o autor e o texto truncado na mesma linha. Cada linha é o `chat-comment-line` do `chat`: o **avatar** de quem comentou — o jdenticon do nome, o mesmo `ReaderAvatar` da fila e da linha de autor do turno (`bundles/desktop/chat/src/client/components/molecules/prompt-author.tsx`) —, o `↩` quando é uma resposta, o **autor**, a **nota** (um `contenteditable`, editada ali mesmo) e, no fim, o **arquivo e a linha** (ou a posição, no comentário de espaço vazio) com o `[pino]`.

```text
╭──────────────────────────────────────────────────────────────────────────────╮
│                                                                              │
│   (js) jao.scheuermann  aumenta o respiro do botão e…    [1] Checkout.tsx:42 │
│   (js) jao.scheuermann  falta espaço aqui           [2] espaço em (412, 180) │
│                                                                              │
│  Adiciona o espaçamento entre os itens do carrinho                           │
│                                                                              │
│                                                                      Cmd + ↵ │
╰──────────────────────────────────────────────────────────────────────────────╯
```

A nota se escreve no canvas, no campo ao lado do pino; confirmá-la (`Enter` ou ↑) acrescenta uma linha à pilha, com a nota. Nada toca a pilha enquanto a nota é escrita, e nada entra no log enquanto é rascunho. Depois disso a nota se edita **na própria linha**, sem popover nem botões, com o teclado da pilha: ↑/↓ andam entre as notas e o prompt, `Enter` vai à próxima, `Esc` volta ao prompt, `Cmd/Ctrl+Backspace` (ou `Backspace`/`Delete` numa nota vazia) apaga a linha e `Cmd/Ctrl+Enter` envia.

O item da pilha guarda `{ target, pin, point, refs: { title, source }, inReplyTo? }`; o `id` dele é o `comment-<uuid>` que vira o `commentId` do evento. O flush grava `commentId` e `inReplyTo` na ordem da pilha — uma resposta espera enquanto a raiz é rascunho — e ainda lê os rascunhos no formato antigo.

O envio é o **flush**: ao mandar o prompt, cada elemento vira um evento `comments.added/v1` ([comentários](../comments.md)) e a pilha se esvazia. O envio passa a contar também os elementos da pilha: hoje o botão só habilita com palavras no editor, e um comentário sozinho já é algo a mandar.

No turno do usuário, os comentários aparecem **com o prompt**: as mesmas linhas, com o mesmo avatar, acima do texto que o usuário escreveu. Clicar numa linha leva ao preview mais recente do artefato, com a thread aberta.

```text
╭──────────────────────────────────────────────────────────────────────────────╮
│   (js) jao.scheuermann  aumenta o respiro do botão e…    [1] Checkout.tsx:42 │
│   (js) jao.scheuermann  falta espaço aqui           [2] espaço em (412, 180) │
│                                                                              │
│  Adiciona o espaçamento entre os itens do carrinho                           │
│                                                                              │
│                                                                         Você │
╰──────────────────────────────────────────────────────────────────────────────╯
```

Depois do flush, o que resta é o log. A linha do turno nasce do evento, pelo projetor, e não do estado do compositor — é o que faz replay e rewind reconstruírem os comentários como tudo o mais. E é o **mesmo elemento** nos dois lugares: o `chat-comment-line` o desenha com dois provedores, a pilha (ainda não durável) e o bloco do projetor (durável).

**O rascunho mora no host.** O texto do prompt e a pilha de comentários são **um só estado**, e ele vive no processo principal, num serviço novo — `chat.composer/v1` —, com uma parte `desktop` do `chat` provendo (o mesmo desenho de `history`, que serve `history.snapshots/v1` a partir de `src/desktop`). O estado é chaveado por `(projectId, threadId)`, e toda janela o lê e o assina: `read({ threadId })` para o retrato e `watch(threadId, listener)` para os deltas, no formato do `runtime.threads/v1.watchThread` — retrato primeiro, depois os itens ao vivo, com `StreamListener<T>`. Assim o rascunho **sobrevive à navegação** (trocar de conversa, trocar de rota, abrir o canvas) e **é o mesmo em qualquer janela do front-end**: hoje ele vive só no `threadChatsStore` da janela que o escreveu (`stores/thread-chats.ts`), então uma segunda janela abre a conversa vazia.

**Como a pilha é costurada.** O canvas é do `papercraft`; o compositor é do `chat`. O estado é do host, mas quem **desenha** o elemento e quem **grava** o evento são do bundle dono do tipo: o item guarda `{ id, kind, elementTag, data, author, note }` e o `chat` resolve o `elementTag` como resolve um bloco de conversa (`chat.views/v1.registerRenderer`); o `flush()` que o dono registra para o seu `kind` é o que o envio chama, e é ele que grava o evento pelo `artifacts/v1`, sem que o `chat` saiba o que é um comentário. Um segundo uso — comentar a resposta do agente, fora desta entrega — é outro `kind` na mesma pilha, com o mesmo elemento e o mesmo `flush`.

O flush roda **depois** que o host aceita o prompt (`send(text)` devolve o aceite) — também no envio do canvas (`Cmd/Ctrl+Enter`, `chat.send/v1`), que é o mesmo caminho sem as palavras do editor: um envio recusado devolve as palavras ao editor (`$restore`, `send-prompt.tsx`) e a pilha fica onde está. Os eventos entram no log na ordem em que foram gravados, e o bloco nasce ancorado pelo `sequence` logo abaixo do turno do usuário (`insert-thread-turn-nodes.tsx`).

### Threads no canvas

Os comentários do log são agrupados em **threads** (a raiz e as respostas dela, [comentários](../comments.md#threads-estados-e-respostas-do-agente)), e o pino mostra o estado da thread pela **cor** (o desenho do pino é um componente compartilhado com a conversa, `desktop/ui/comment-pin`, em três tamanhos — o canvas usa o médio):

| Estado   | Pino                                    |
| -------- | --------------------------------------- |
| Rascunho | Tracejado                               |
| `open`   | Primário                                |
| `await`  | Laranja (o agente respondeu por último) |
| `done`   | Verde                                   |

As threads **atravessam as revisões**: o canvas mostra todas as threads do artefato (e os rascunhos dele) na revisão que está na tela — a mais nova, por padrão —, cada uma com o mesmo número em qualquer revisão. O pino se recoloca pela âncora na revisão da tela; quando o elemento não existe mais nela, o pino vai para o ponto que a âncora guardou e, sem ponto guardado (comentários antigos), fica **destacado**, empilhado na borda esquerda do conteúdo — continua contado e abre a thread. Um comentário novo é escrito contra a revisão da tela; uma resposta, contra o alvo da raiz (a revisão em que ela foi escrita), e resolver vale em qualquer revisão.

Um controle mostra ou esconde as threads resolvidas. Passar o ponteiro sobre um elemento mostra o contorno tracejado com o rótulo `elemento · arquivo:linha` em qualquer modo, com o frame em foco ou não: com a ferramenta de comentar armada, no elemento que vai receber o comentário; fora dela, no elemento sob o ponteiro. Nada é contornado enquanto o canvas faz pan, e o contorno some quando o ponteiro sai do canvas. **Abrir um pino que já guarda o primeiro comentário** mostra o popover da thread: o cabeçalho (`N Componente:linha`), o menu `⋯`, resolver ou reabrir (nas raízes já enviadas) e fechar; as mensagens, com avatar, nome e hora; e o campo de resposta. Uma resposta vai para a **pilha** com `inReplyTo` e sai no próximo envio, como qualquer rascunho (que continua editável e removível); resolver chama `comments/v1.resolve` na raiz, sob o `promptId` da própria raiz. O node escuta o evento DOM `doric:comment-thread-open` (`detail: { commentId, target }`) que o `chat` dispara dos blocos de resposta e dos marcadores, e abre a thread do pino correspondente: com `target.revision`, só o node daquela revisão responde; sem ela — a mais nova —, só o node da revisão mais nova do artefato (que ele pergunta ao registro). A janela do canvas não recebe esse evento.

### A janela do canvas

A janela é a mesma superfície em tela cheia, com o mesmo chrome mínimo:

- **cabeçalho overlay** — o semáforo do macOS à esquerda e o nome do arquivo ao lado. A janela abre com `appearance.titleBar: 'integrated'` (o default do contrato), que no macOS usa `titleBarStyle: 'hidden'` com `trafficLightPosition` e reserva a área segura à esquerda (`app/desktop/doric/src/platform/windows/appearance.ts:26-56`); o cabeçalho é o `ChromeBar` do app (`packages/desktop/src/chrome-bar.tsx`), a faixa arrastável de `--doric-titlebar-height` com `ps-(--doric-safe-left)`, que mantém o semáforo clicável e o resto da barra arrastável. O canvas flui por trás dele, como no node.
- **árvore à esquerda** — a estrutura derivada do artefato renderizado (a mesma `scene-graph`), com o nó selecionado destacado; clicar seleciona, e a seleção acende o elemento no canvas.
- **barra de comandos** — uma barra flutuante, centrada na borda inferior do canvas, com os controles da janela agrupados: ferramenta, seleção, viewport e proposta. É o único chrome de ação da janela: o comentário entra pelo mesmo gesto do node (elemento ou posição livre) e cai na mesma pilha, e o resto são comandos do bundle. O desenho está em [A barra de comandos](#a-barra-de-comandos).
- **sem rodapé** — nada abaixo do canvas.

```text
╭──────────────────────────────────────────────────────────────────────────────╮
│ (o)(o)(o)  Checkout.tsx                                                      │
│                                                                              │
│ ╭ estrutura ───╮                                                             │
│ │ Page         │    Checkout                                                 │
│ │  main        │    ──────────────────────                                   │
│ │   section    │                                                             │
│ │    h1        │    Subtotal                                       R$ 128,00 │
│ │    > button  │    Frete                                          R$  12,00 │
│ │    ul        │                                                             │
│ ╰──────────────╯      ┌────────────────────────┐                             │
│                       │      Pagar agora       │  [1]                        │
│                       └────────────────────────┘                             │
│                                                                              │
│                           [2]                                                │
│                                                                              │
│                                                                              │
│      ╭────────────────────────────────────────────────────────────────────╮  │
│      │  ▸  ⊙ ¹  ✋   │   ⌖  ◎   │  −  100%  +  ⤢  │  rev 1/1               │  │
│      ╰────────────────────────────────────────────────────────────────────╯  │
╰──────────────────────────────────────────────────────────────────────────────╯
```

A janela é uma **rota do app**, o mesmo tipo da janela de ajustes:

- o bundle registra `/papercraft/:artifactId` com `navigation/v1`, cujo elemento é `<papercraft-canvas>`;
- o desktop part registra o comando `papercraft.open-canvas/v1` (no molde de `core.open-settings/v1`, `bundles/foundation/core/src/desktop/commands.ts:22-39`) e chama `windows/v1.open({ key: <artifactId>, path: '/papercraft/<artifactId>', appearance })`; o core prefixa a chave com o id do bundle (`bundles/foundation/core/src/desktop/windows.ts:44-52`), então a janela é estável por preview e um segundo clique foca a existente;
- `/papercraft/…` não é arquivo: o handler devolve a shell (`handler.ts:130`), o `<core-outlet>` renderiza a rota do bundle (`bundles/foundation/core/src/client/elements/outlet.ts:135`) e a janela tem o preload, o import map e os serviços de qualquer outra.

**Por que não uma partição aqui.** A janela com `partition` própria é a janela `view` do `windows/v1`: página do host, sem preload nem contratos (`packages/bundle/src/contracts/basic/windows.ts:53-83`). Com B decidido, o artefato já roda na origem do app; uma `view` obrigaria o chrome do canvas a morar numa página servida pelo host, com runtime de UI próprio e um transporte via relay — o caminho C inteiro — para voltar a falar com o host. A partição continua fazendo sentido para `site` e conteúdo de terceiros.

#### A barra de comandos

O trail de texto livre (`/ comentar · isolar · autorizar`) obrigava o usuário a adivinhar: não dizia o que estava **armado**, o que estava **disponível naquele momento**, nem o que cada verbo fazia com a seleção. Os mesmos verbos viram uma **barra de comandos** — controles explícitos e agrupados, no desenho de barra inferior que os editores de canvas usam.

A barra é **overlay**, como o cabeçalho: flutua sobre o canvas, centrada na borda inferior, com uma margem do container, cantos arredondados, borda, fundo translúcido com blur e sombra — o canvas continua rolando por trás dela e continua sem rodapé. Ela é montada com os componentes do registro (`desktop/ui/<componente>`, `docs/architecture/bundles/platform-packages.md:19`), não com CSS próprio: `ToggleGroup`/`Toggle` para a ferramenta armada, `Button size="icon-sm" variant="ghost"` para os demais, `Tooltip` com um `<kbd>` no conteúdo para o rótulo e o atalho (`packages/desktop/src/components/tooltip.tsx:44`), `Badge` para a contagem de pinos, um `Separator` vertical mais curto que a barra entre os grupos — o `ToolbarDivider` do compositor de mensagens (`bundles/desktop/chat/src/client/components/molecules/toolbar-divider.tsx`) — e ícones `lucide`, a biblioteca do registro (`packages/desktop/components.json`).

**Quatro grupos, três divisores.** Da esquerda para a direita: a ferramenta armada, o que se faz com a seleção, o viewport e a proposta.

| Grupo      | Controle                                                | Comando                         | Atalho            | Habilitado quando                                                        |
| ---------- | ------------------------------------------------------- | ------------------------------- | ----------------- | ------------------------------------------------------------------------ |
| Ferramenta | Selecionar (`MousePointer2`)                            | `papercraft.select/v1`          | `V`               | sempre; é o armado de entrada                                            |
|            | Comentar (`MessageSquarePlus`, com a contagem de pinos) | `papercraft.comment/v1`         | `C`               | sempre                                                                   |
|            | Mão (`Hand`)                                            | `papercraft.pan/v1`             | `H`               | sempre                                                                   |
| Seleção    | Isolar (`Focus`, alternável)                            | `papercraft.isolate/v1`         | `I`               | há um nó selecionado                                                     |
|            | Mostrar tudo (`Eye`)                                    | `papercraft.show-all/v1`        | `Shift+I`         | há camada escondida ou isolada                                           |
| Viewport   | Menos zoom (`ZoomOut`)                                  | `papercraft.zoom-out/v1`        | `CmdOrCtrl+-`     | sempre                                                                   |
|            | Zoom atual (`100%`, leitura)                            | `papercraft.zoom-reset/v1`      | `CmdOrCtrl+0`     | sempre; o clique volta a 100%                                            |
|            | Mais zoom (`ZoomIn`)                                    | `papercraft.zoom-in/v1`         | `CmdOrCtrl+=`     | sempre                                                                   |
|            | Ajustar (`Maximize`)                                    | `papercraft.zoom-fit/v1`        | `Shift+1`         | sempre                                                                   |
| Proposta   | Revisão (`rev 1/1`, leitura)                            | `papercraft.select-revision/v1` | —                 | há mais de uma revisão; abre um `DropdownMenu`                           |
|            | Autorizar (`Check`, primário, com rótulo)               | `papercraft.approve/v1`         | `CmdOrCtrl+Enter` | **só sob a política `request`**, e a revisão na tela não está autorizada |

Regras que a barra segue:

- **A ferramenta armada é um grupo de rádio, não três botões.** Selecionar, Comentar e Mão são o `ToggleGroup`: só uma por vez, e "Comentar" arma o mesmo gesto do botão do node — o ponteiro vira balão, o elemento sob ele ganha contorno e o clique cai na pilha do compositor. O controle carrega a **contagem de pinos**, como o botão do node.
- **Nada de estado novo.** Cada controle lê um campo do `PreviewState` — o mesmo redutor do projetor do chat e da janela — e despacha por `commands/v1.execute`, o caminho que o painel de Changes do `git` usa. A ferramenta armada, o pan, o zoom, a seleção e o isolamento são **view local**, como o resto do canvas ([acima](#o-canvas)); o que a barra grava no log é só o que já era durável: o comentário (no flush do envio) e, sob `request`, a autorização.
- **Desabilitado, não escondido.** Um controle que aparece e desaparece move o alvo do ponteiro debaixo do usuário; os controles ficam no lugar e mudam de estado. As duas exceções são **leituras**: a revisão só existe com mais de uma revisão, e o botão de autorização vira a leitura `Autorizado` — sem ação — quando a revisão já foi aprovada.
- **Um rótulo, uma vez.** `Autorizar` — quando a política o pede — é o único controle com texto além do ícone, porque é a ação que libera a escrita no código do Project; os demais se explicam pelo ícone e pelo tooltip, que mostra o nome e o atalho.
- **Isolar é o verbo que o trail deixava solto e agora tem lugar.** Ele esconde os irmãos do nó selecionado e mantém a cadeia dele visível — a leitura de perto que a árvore sugere; `Mostrar tudo` desfaz o isolamento e as camadas escondidas à mão.
- **Atalhos sem modificador são só desta janela.** O cliente registra cada atalho com `menus/v1.addKeybinding` (dono = bundle, como em [menus nativos e atalhos](../menus-and-keybindings.md)), apontando para o id do comando. `V`, `C`, `H` e `I` são teclas soltas e não colidem com nada: **a janela do canvas não tem campo de texto** — a nota do comentário se escreve na pilha acima do prompt, na conversa — e o core entrega a cada janela a tabela já filtrada para ela (`packages/desktop/src/client/keybindings.ts:1-3`).
- **A barra é da janela; o node fica com o cabeçalho.** O node (`chrome: 'node'`) desenha só os botões de ícone do cabeçalho overlay, porque a largura da conversa não comporta quatro grupos; a janela (`chrome: 'canvas'`) desenha o mesmo cabeçalho e a barra inteira. É o `chrome` que decide quais grupos existem, e não uma segunda superfície.

Com o chrome mínimo, o node mostra a revisão com que foi criado e a janela abre na mais nova; a leitura `rev 1/1` da barra é o único lugar da tela onde a revisão aparece, e é ela que troca a revisão na tela quando há mais de uma ([decisões em aberto](#decisões-em-aberto)).

### Estados lado a lado (proposta)

**Estado:** proposta, ainda não implementada. Mockup: [estados lado a lado](./mockups/states.html).

O preview passa a ter **frames**: um frame por story de um arquivo de stories, cada um com o nome em cima, todos no mesmo canvas, com o mesmo pan, zoom e pinos.

- **O frame é a página de hoje, repetida.** O mesmo `mount`, o mesmo bundle e o mesmo CSS, com uma raiz React e um container de portal por frame, a margem de 8px da superfície e o fundo do próprio tema. A compilação continua sendo uma só.
- **O tema é mais uma dimensão.** `Claro`, `Escuro` ou `Claro e escuro`; o último põe cada story duas vezes, lado a lado. O `mount` já recebe o `theme`.
- **Layout.** `Grade`, em duas colunas, ou `Linha`, todos numa fileira, sobre a grade de pontos, com 48px entre colunas e 72px entre linhas. O nome do frame fica acima dele, em 11px e `muted-foreground`, e passa a `primary` no hover e no frame em foco.
- **Zoom num frame.** Clicar no nome do frame, no canvas ou na estrutura, enquadra o frame e o destaca com o contorno primário. `Ajustar` volta a mostrar todos, descontando a área do painel de estrutura.

Na janela:

- **A estrutura vira um painel flutuante**, no padrão da barra de comandos: borda de 1px, `rounded-xl`, `p-1`, fundo `background/80` com blur e `shadow-md`, a 12px da esquerda e logo abaixo do cabeçalho. A altura acompanha o conteúdo e rola quando chega ao fim do canvas. Não tem rótulo visível; "estrutura" fica só no `aria-label`.
- **Os frames ficam no primeiro nível.** Cada frame é um grupo: a seta de recolher, o ícone de frame, o nome em sans 12.5px médio e, quando há comentários abertos nele, um contador. Os elementos ficam embaixo, recuados, em mono 11.5px com a tag em destaque. Um divisor de 1px separa um estado do outro.
- **Linhas de 26px**, com hover suave. O olho só aparece no hover ou no foco, e fica fixo num frame ou elemento escondido. Esconder um frame tira ele do canvas; os comentários dele continuam na thread.
- **Um controle novo na barra de comandos:** o menu `N estados`, depois do grupo de viewport e antes de `rev n/m`, no mesmo padrão de dropdown. Ele escolhe os estados visíveis, o tema e o layout.

No node, o quadrado, o cabeçalho e o rodapé de zoom são os de hoje. O cabeçalho ganha `· N estados`, e o node abre ajustado à grade inteira, no tema claro.

Nos dados:

- A tool aceita `entry` como lista de stories e `themes` (`light`, `dark`). Um `entry` com uma string continua sendo um frame só.
- A âncora ganha `frame`, o nome da story. O mesmo `arquivo:linha` existe em todos os frames, então o frame faz parte da identidade do pino, e a busca das [âncoras](#âncoras-que-o-agente-entende) roda dentro do frame da âncora.
- No chat, a linha do comentário leva o nome do frame antes do local: `Empty · div · CheckoutCard.tsx:58 [1]`.
- O artefato é modelado como uma lista de frames, para que o passo seguinte, frames de arquivos diferentes, não mude o canvas nem os comentários. Esse passo traz o `id` estável do frame entre revisões, um shadow root por frame HTML, para o CSS de um não vazar no outro, e o CSS como união das fontes.

### De onde vêm os dados

| O que                                                   | Node                                                                      | Janela                                                                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Revisão e comentários                                   | projetor do chat sobre o log, direto no `block.data`                      | `artifacts/v1.read({ artifactId })` e `runtime.threads/v1.watchThread(threadId, 0)` filtrado por `artifacts.*` e `comments.*`, com o mesmo redutor |
| Seleção, ferramenta armada, pan/zoom, isolamento, pinos | estado local do elemento                                                  | estado local da janela                                                                                                                             |
| Comentário                                              | card na pilha de `chat.composer/v1`; o flush grava `artifacts/v1.comment` | o mesmo, pelo controle `Comentar` da barra                                                                                                         |
| Autorizar (só sob `request`)                            | —                                                                         | botão `Autorizar` da barra                                                                                                                         |

A janela precisa do `threadId` para assinar o log; o `read` responde o registro (thread, revisão, âncoras) e o resto vem do stream. O rascunho e a pilha não passam pelo log: são estado do compositor, no host, e cada janela os assina pelo `chat.composer/v1`. Em ambos os casos o estado do preview é reconstruído dos eventos duráveis; nada de UI vira estado de aplicação fora do log.

### O que o build entrega

O módulo compilado (`index.js`) tem um contrato pequeno, e a assinatura não depende de React:

```ts
export interface PapercraftModule {
  /** Monta o preview no root e devolve o unmount. */
  mount(
    root: HTMLElement,
    context: { theme: 'light' | 'dark' },
  ): void | (() => void);
}
```

- `html` — o build embrulha o documento no `mount` (o CSS vira `index.css`).
- `component` — o build embrulha o componente num `mount` que cria a raiz com o `createRoot` do import map: a mesma instância de React do app.
- O módulo é ESM com os especificadores do import map externos, então `react`, `react-dom/client` e o `@base-ui/react` que o mapa serve resolvem pelo mapa da janela — e é por isso que o preview compartilha tema e componentes com o app.

### Harness, stories e portais

O preview roda numa raiz React própria, então nenhum provider do app chega até ele. O que o componente precisa vem do **Project**, em arquivos versionados no formato do Storybook:

- **Harness.** O mais próximo subindo a partir do arquivo previewado (pulando `.doric/` e `node_modules/`): `.storybook/preview.{tsx,ts,jsx,js}`, senão `.papercraft/preview.{tsx,ts,jsx,js}`. Subconjunto suportado: o `default` `{ decorators, parameters, args }` e/ou os exports nomeados. Imports só de tipo de `@storybook/*` somem no build; `@storybook/addon-themes` tem um substituto embutido; os outros imports passam pela resolução do Project, e um harness que não compila fica de fora com um aviso — o preview compila sem ele.
- **Stories CSF.** Um `*.stories.*` (ou um `default` com cara de meta CSF) monta uma story: `entry`, senão a primeira na ordem do fonte. Renderiza `story.render(args, context)`, senão `meta.render`, senão `<meta.component {...args} />`, com `args = { ...preview.args, ...meta.args, ...story.args }`; decorators na ordem do Storybook (story → meta → harness, o primeiro mais interno). `context` traz `args`, `parameters`, `globals.theme`, `viewMode: 'story'` e `papercraft.portalContainer`. Actions não são sintetizadas. Um componente comum também recebe os decorators do harness.
- **CSS.** A base da folha é um tema genérico — as variáveis, o preflight e os utilitários do Tailwind, com um conjunto neutro de tokens do shadcn em claro e escuro —, que não é de aplicação nenhuma, nem do Doric; o surface não copia o tema do app para o preview, e só o modo claro ou escuro do leitor chega ao `mount`. O CSS que o harness importa é o global do Project e substitui o tema genérico: compilado com Tailwind v4, lido por `files/v1` (`tailwindcss` vem do host), com as regras `:root` valendo também em `:host` e no wrapper de tema do módulo. O CSS que os componentes importam é anexado. Tailwind v3 (`@tailwind`) ou uma folha que não compila cai no tema genérico, com aviso; `@plugin`/`@config` em JS são ignorados com aviso.
- **Portais.** O `mount` cria um container de portal ao lado da raiz React, dentro do shadow root, e o entrega em `context.papercraft.portalContainer`; o conteúdo da superfície é o bloco de contenção (`contain: layout`) dos overlays `fixed`. O preview não supõe nada dos componentes do Project: nem o Base UI nem o Radix têm default global de container, então o harness ou a story passa `context.papercraft.portalContainer` ao `Portal` (`container`) ou ao provider que os componentes do Project leem. Os harnesses do Doric entregam o container ao `PortalContainerProvider` de `desktop/ui`, e os overlays de `desktop/ui` (Dialog, Sheet, AlertDialog, Popover, Tooltip, Select, DropdownMenu, ContextMenu, Combobox) caem nele.

## Âncoras que o agente entende

Um comentário solto ("esse botão está errado") obriga o agente a adivinhar a que elemento o usuário se refere. O carimbo de origem resolve isso, e é a peça mais barata de copiar do Glide: o build do preview anota cada elemento com o arquivo e a linha de onde ele veio, e a âncora do comentário guarda esse par mais o seletor.

```xml
<comments>
<target kind="artifact" id="checkout-1" revision="3" title="Checkout" source="src/components/Checkout.tsx">
<comment id="comment-…" pin="1" anchor="src/components/Checkout.tsx:42" element="button">o botão primário some no tema escuro</comment>
<comment id="comment-…" pin="2" anchor="src/components/Checkout.tsx:57" element="div">aqui deveria ter 8px de respiro</comment>
</target>
</comments>
```

Quando o preview é `html` novo, o carimbo aponta para o próprio arquivo do payload; quando é `component`, aponta para o código real do Project — o que faz o comentário valer como instrução de edição, e não como descrição. É esse bloco que o `chat` monta a partir das linhas da pilha ([comentários](../comments.md#o-prompt-o-envelope-xml)): a nota de cada linha vira um `<comment>` com a sua âncora, agrupado pelo `<target>` (a revisão que o usuário viu).

## Comentários: dois registros, um dono

O pedido diz que todos os comentários são atribuídos ao contexto da conversa e que o agente age sobre eles. Na arquitetura atual isso são dois registros, porque o log durável e o histórico do provider são contratos separados — e os dois nascem do mesmo gesto, o envio:

1. **O evento** `comments.added/v1` ([comentários](../comments.md)) — durável, replayável, desenhado como pino no canvas e presente no transcript (com o prompt, acima do texto que o usuário escreveu, quando ele o enviou). É a memória do comentário.
2. **O prompt** — o único canal que acorda o agente, enviado por `runtime.threads/v1.prompt({ id, prompt })`, o mesmo caminho do compositor da conversa (`bundles/desktop/chat/src/client/api/threads-api.ts:32`), num envelope XML (`<comments>` e `<message>`), exceção estreita às regras de prompt do repositório: o conteúdo de dentro continua texto legível.

O comentário é rascunho na pilha acima do prompt e o envio faz o **flush**: grava o evento e manda o prompt com os comentários e as âncoras (ver [Comentários acima do prompt, rascunho no host](#comentários-acima-do-prompt-rascunho-no-host)). Um comentário que nunca chega a ser enviado não vira evento — o rascunho é do host, não do log.

O controle `Comentar` do cabeçalho e o da barra da janela são, portanto, um **compositor de prompt com contexto espacial**: o comentário é confirmado no canvas, entra na pilha acima do input do usuário como rascunho e sai com o próximo envio — ou já, com `Cmd/Ctrl+Enter`.

## Implementação e escrita de volta

O Doric é **YOLO por padrão**: o preview **não** é um portão. O agente publica o preview e implementa a mudança no código do Project com as ferramentas normais, no mesmo turno ou no seguinte — o preview é a janela que o usuário olha, e o comentário é o que corrige o rumo ([artefatos](../artifacts.md#a-política-de-revisão)).

O que o preview garante é **não escrever às cegas**: a tool só escreve dentro do diretório do artefato, e a guarda de caminho é a do próprio sandbox, que recusa qualquer path que resolva fora do root do workspace (`GROUNDING.md:606-609`). A implementação de verdade é outra ação, sobre outros arquivos, que o preview mostra.

Sob a política `request` — escolha do Project, não o padrão — a espera existe, e tem um lugar em cada casa: no node é um pedido na conversa (o bloco não tem botão) e na janela é o botão `Autorizar` da barra (`papercraft.approve/v1`), despachado por `commands/v1.execute`, o mesmo caminho que o painel de Changes do `git` usa; a aprovação grava `artifacts.approved/v1` ([artefatos](../artifacts.md)) e manda o prompt que libera a implementação, com o escopo autorizado. Se um dia fizer sentido um botão no próprio bloco do node, o renderer acrescenta ações por `chat.hooks/v1.onBeforeRenderBlockHook` e o `IntentDispatcher` as converte em comandos.

A escrita de volta pelo host — o codemod do Glide — continua sendo um passo **opcional**, e herda as duas lições dele: edições em **staging** antes de gravar e **resolução de conflito por propriedade**. Aqui o staging já existe por construção (a cópia de trabalho em `.doric/` é separada do código do Project) e o conflito por propriedade é o que o log de eventos dá de graça, com um evento por ajuste. Hoje a implementação é o agente editando os arquivos com as ferramentas normais, e é isso que o preview mostra.

## O bundle `papercraft`

`bundles/features/papercraft` e `bundles/features/artifacts` ([artefatos](../artifacts.md)), na lista `enabled` de `app/backend/doric-host/composition.json`, mais `papercraft-relay` em `resident` se o caminho C for usado.

### Eventos duráveis

Declarados em `contracts/` com `defineEvent` e registrados com `events/v1` na ativação; o sumidouro do `runtime` já usa `scopeKeys` `['projectId', 'threadId', 'promptId']` no stream `runtime.thread.events/{threadId}` (`bundles/runtime/runtime/src/contracts/events.ts:28-32`). Os eventos são os do [registro de artefatos](../artifacts.md#ciclo-de-vida-e-eventos), com `kind: 'preview'`; o `source` diz de onde o payload veio.

| Evento                  | Payload (resumo)                                                                 |
| ----------------------- | -------------------------------------------------------------------------------- |
| `artifacts.created/v1`  | `artifactId`, `revision`, `kind`, `title`, `targets`, `path`, `source`, `entry?` |
| `artifacts.revised/v1`  | `artifactId`, `revision`, `changeNote`                                           |
| `artifacts.approved/v1` | `artifactId`, `revision`, `scope` — só sob a política `request`                  |
| `artifacts.applied/v1`  | `artifactId`, `revision`, `files`                                                |

O comentário não é um evento do artefato: ele é `comments.added/v1` ([comentários](../comments.md)), com a revisão como alvo. O comentário só entra no log no flush do envio (e a resposta do agente, quando a `comment_reply` roda); enquanto é rascunho, ele vive na pilha do compositor — estado do host, não do log.

### Tool do agente

Uma tool de host registrada em `ToolsV1` com posição global explícita, como as demais (`bundles/features/files/src/host/index.ts`). O tipo possui a sua tool ([artefatos](../artifacts.md#a-tool-do-agente)). Ela aceita **código e caminhos**, nunca uma descrição estrutural da interface:

```ts
// papercraft, host/tools/preview.ts — pseudocódigo da API proposta
export const previewTool = defineTool({
  name: 'papercraft_preview',
  description:
    'Publishes a visual preview of a change as a node of the conversation, from real code: an HTML file, a component file in the Project, or the path of an existing component. It writes only inside the artifact directory and never implements the change.',
  input: z
    .object({
      artifact_id: z.string().optional(), // ausente: cria; presente: nova revisão
      title: z.string(),
      source: z.enum(['html', 'component', 'site']),
      path: z.string(), // o arquivo do payload, ou o entry do componente
      files: z
        .array(z.object({ path: z.string(), content: z.string() }).strict())
        .optional(), // o que o agente escreve agora, quando escreve ele mesmo
      notes: z.string().optional(),
    })
    .strict(),
  output: previewStateSchema, // artifactId, revision, path, comments
  execute: async (input, call, services) => {
    // 1. escreve os arquivos em `/workspace/.doric/artifacts/<artifactId>/`, com guarda de caminho
    // 2. materializa o tipo pelo serviço do host (esbuild + markup + CSS)
    // 3. events/v1.append(artifactsCreatedEvent | artifactsRevisedEvent, payload, call)
    // 4. devolve o estado resolvido do preview para o modelo
  },
});
```

A saída da tool é o **estado do preview**, não a confirmação da escrita: o modelo precisa saber a revisão atual e os comentários pendentes com a âncora. A tool também lê os comentários do log no escopo da chamada, para que a rodada de ajustes não dependa de o usuário repetir o texto no prompt: ela devolve as **raízes não resolvidas** de cada thread, cada uma com as `replies` (as respostas, em ordem; a última pode ser a resposta do usuário a uma pergunta do agente).

### Skill do agente

Quem ensina **quando** propor um preview e **por que** ele existe não é o corpo da tool: uma tool é um contrato, e o juízo de quando usá-la é uma skill — a mesma divisão que o `web` faz entre a ferramenta e `web-research`. Ela vive em `bundles/features/papercraft/src/skills/papercraft-preview/SKILL.md` e é descoberta como as demais (`packages/bundle/src/loader/skills.ts`):

```yaml
---
name: papercraft-preview
description: 'Publishes a visual change as a live preview node of the conversation, built from real code, instead of describing it. Use when the change is easier to judge by looking than by reading a diff, and the user should see it, comment on it and steer it.'
allowed-tools:
  - papercraft_preview
  - comment_reply
  - write
  - edit
order: 3400
---
```

O corpo responde as três perguntas que a assinatura da tool não responde:

- **por que**: mudança visual se julga olhando, não lendo um diff; o preview é mais barato de mudar que uma implementação; e é o que deixa o usuário **ver o que está sendo feito**, em vez de descobrir depois;
- **quando usar**: mudança que é visual, usuário que ainda não decidiu, pedido explícito de ver/mock/protótipo, ou ajuste de um preview que já existe — que é **revisão** do mesmo preview, e não um preview novo;
- **quando não usar**: mudança que não é visual, inspeção do app rodando, e artefato que precisaria de código que o agente não pode escrever — dizer o que falta em vez de previewar outra coisa.

O procedimento fixa as decisões que o agente erraria sozinho: escolher a origem do preview pelo que a mudança toca (`component` para código real, porque o carimbo faz o comentário valer como instrução de edição; `html` para ideia nova; `site` só quando o servidor é o ponto), escrever o payload dentro do diretório do artefato, ler o estado que a tool devolve (revisão e comentários pendentes com a âncora), **implementar a mudança** com as ferramentas normais — o preview não é portão, o Doric segue direto — tratar cada comentário como o pedido da revisão seguinte e **respondê-lo com `comment_reply`** — dizendo o que mudou ou perguntando o que não entendeu — com `resolve` quando está atendido. Só sob a política `request` do Project o agente espera o `artifacts.approved/v1`.

`allowed-tools` lista as quatro ferramentas que o procedimento nomeia: a tool do bundle, a `comment_reply` do `comments` e os dois utilitários de escrita do `files`. O registro as resolve contra o catálogo visto pela geração (`D10-6`), então um Project sem o `files` recusa a skill com `unavailable_tool`, em vez de falhar no meio do fluxo. `order: 3400` é a próxima faixa livre depois das skills do `threads` (3300), no mesmo esquema de faixas de 100 de `files` (100–1300) e `git` (2100–2600).

### Serviço de host

O registro, as revisões e a autorização são do serviço `artifacts/v1` ([artefatos](../artifacts.md#o-contrato-artifactsv1)); os comentários são do `comments/v1` ([comentários](../comments.md)); e o que é do tipo `preview` fica em `papercraft.previews/v1`: `build({ path })` compila e carimba o payload e devolve `{ path, sha256 }` de cada entrada (o que o evento durável referencia) — é a materialização que o registro chama —; `read({ artifactId, revision })` devolve o markup+CSS de fallback de A e o que o canvas precisa do preview. Serviços chamados por uma janela declaram `desktopScope` com `['projectId', 'threadId', 'promptId']` e métodos com `expose: 'desktop'`, como `resources/v1` e `screen.views/v1`. O registro lê e escreve o `.doric/` pelo lease, como o `files` faz; sem lease ele responde estado, como `files/v1`.

### Node de conversa

A parte `client` registra, com `whenAvailable(ChatViewsV1, …)` como faz o `threads` (`bundles/features/threads/src/client/index.ts:23-27`): um projetor que produz um bloco por revisão (`papercraft.preview/v1`, o `blockType` do tipo — [artefatos](../artifacts.md#o-node)) e um renderizador `papercraft-preview`. O elemento recebe o bloco pela propriedade `block` e o chat lhe entrega cada versão mais nova (`chat-block-node.tsx:83-87`); ele monta o módulo da revisão no shadow root (acima, [A UI no node e na janela](#a-ui-no-node-e-na-janela)) e desenha o chrome do canvas.

### Janela de canvas

Decidido: a janela é uma **rota do app** (`/papercraft/:artifactId`), aberta e focada por `windows/v1` com chave estável por preview (prefixada pelo core com o `bundleId`); a superfície é a mesma do node, em tela cheia, com o cabeçalho overlay (semáforo do macOS + nome do arquivo), a árvore à esquerda e a barra de comandos no centro inferior — sem rodapé. O detalhe está em [A UI no node e na janela](#a-ui-no-node-e-na-janela). A janela `view` do host, com `partition` própria, fica para o `site` e conteúdo de terceiros.

## Fluxo do usuário, passo a passo

| Passo | O usuário faz               | O que acontece                                                                                                                     |
| ----- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1     | "corrige o componente X"    | Prompt comum. Nada de papercraft ainda.                                                                                            |
| 2     | —                           | O agente lê o índice de componentes, escreve o payload e chama `papercraft_preview`; o evento entra no log e o node aparece.       |
| 3     | —                           | O agente implementa a mudança no código do Project — o preview **não** é portão.                                                   |
| 4     | Pede ajustes X, Y e Z       | No node ou na janela: cada comentário vira uma linha na pilha acima do prompt; o envio faz o flush (evento + prompt).              |
| 5     | —                           | Nova revisão: o mesmo `artifact_id`, um evento novo, **um node novo**. O node antigo permanece, com seus comentários.              |
| 5b    | —                           | O agente responde cada comentário com `comment_reply` (e resolve o atendido); o pino muda de estado e a resposta aparece no turno. |
| 6     | Autoriza (só sob `request`) | `papercraft.approve/v1` → `artifacts.approved/v1` + prompt, e o agente implementa.                                                 |

O passo 5 é o requisito mais forte do pedido: um bloco por revisão faz o preview antigo continuar na conversa e aberto para comentários, sem nenhum estado extra, porque o replay reconstrói todos os blocos do log em ordem de sequência.

## Replay e rewind

Os projetores de `chat.views/v1` são puros e rodam do estado inicial sobre a lista inteira de eventos, no replay e no rewind (`bundles/desktop/chat/src/client/domain/external-blocks.ts:41-98`). Consequências:

- o canvas de um node é reconstruído dos eventos, nunca de estado local guardado;
- um rewind para antes de um preview remove o node, porque o evento sai do log;
- efeitos que não devem se repetir (compilar, carimbar, subir um servidor) vivem no host, e o replay não os reexecuta;
- a árvore derivada do canvas é recalculada a cada render, e nada dela é persistido.

## Decisões em aberto

1. **Decidido: B no node.** O artefato compila para módulo ESM, é servido pela origem do app (`/artifacts/…`) e o node importa e monta; A fica como fallback estático. A confiança é a do resto do app: código do Project revisado pelo usuário, rodando sob a CSP e os `desktopScope`.
2. **Decidido: o empacotamento roda no sandbox, o Tailwind no host.** O esbuild vem da imagem do sandbox (`.sandbox.Dockerfile`, na versão do host) e o runner vem do host, então a resolução é a mesma dos dois lados; ler cada arquivo por `files/v1` custava idas ao sandbox por arquivo e impunha um orçamento de 1.500 leituras e o limite de 256 KB por arquivo. Sem o esbuild na imagem, o host empacota como antes.
3. **Preview `site` com dev server.** Depende de `ports` existir (`docs/architecture/bundles/port-forwarding.md`).
4. **Decidido: o diretório é `/workspace/.doric/artifacts/<artifactId>/` e nasce ignorado pelo Git** ([artefatos](../artifacts.md#decisões-em-aberto)). O preview é um artefato do tipo `preview`, e a visibilidade passou a ser do registro: versionar um artefato é escolha do usuário.
5. **Relação com a escrita de volta.** O codemod no host (modelo do Glide) ou o próprio agente editando os arquivos. A segunda opção já funciona hoje.
6. **Carimbo de origem em componentes de terceiros.** O que fazer quando a linha carimbada muda entre revisões.
7. **Comentário com prompt em andamento.** A fila de `runtime.threads/v1` aceita; falta decidir se a pilha enfileira ou espera.
8. **Sob `request`, a semântica da aprovação.** O que conta como aprovação e se uma revisão autorizada pode ser substituída depois. O padrão do Doric é não precisar disso (decisão 3 do [artefatos](../artifacts.md#decisões-em-aberto)).
9. **Posição da tool** no catálogo global do modelo, que hoje vai de 100 a 900 (`D10-5`); a skill `papercraft-preview` já está em `3400`, a próxima faixa livre depois das skills do `threads`.
10. **Chave do cache e fallback do preview.** Incluir o `PLATFORM_VERSION` na chave, e decidir se o markup de A continua sendo o fallback obrigatório de toda revisão com script.
11. **Decidido: a janela é uma rota do app.** `windows/v1` abre `/papercraft/:artifactId` (path window, sem `partition`), em vez da janela `view` com página do host; essa fica reservada ao `site` e a conteúdo de terceiros (caminho C).
12. **Decidido: quando existe autorização, ela mora na barra da janela.** O pedido na conversa continua existindo — o node não tem botão — e a janela ganha o botão `Autorizar` da barra ([acima](#a-barra-de-comandos)), que vira a leitura `Autorizado` quando a revisão já foi aprovada. Só aparece sob a política `request`, e continuam em aberto a semântica dela (decisão 8) e se ela também cabe no popover do comentário.
13. **Decidido: a revisão tem leitura na barra.** O node mostra a revisão com que foi criado e a janela abre na mais nova; a leitura `rev 1/2` da barra ([acima](#a-barra-de-comandos)) troca a revisão na tela quando há mais de uma.
14. **Onde o rascunho mora.** O rascunho (texto do prompt e pilha de comentários) fica no host, em `chat.composer/v1`, para sobreviver à navegação e valer para todas as janelas; falta decidir se ele passa do processo — um registro no cache, como o `history` faz, para sobreviver ao fechamento do app — e se o texto do editor sincroniza a cada tecla ou em lote curtos.
15. **Um canal para todas as janelas.** Hoje o rascunho vive no `threadChatsStore` da janela que o escreveu; o serviço de host passa a ser o dono, e falta decidir o que uma janela faz quando o prompt é enviado em outra (a pilha se esvazia para todas, e o editor das demais se limpa).
16. **O registro de artefatos.** O preview passa a ser um tipo do registro ([artefatos](../artifacts.md)); ficam em aberto, lá, a forma do `artifactId`, a política de revisão e o que acontece quando o alvo do carimbo muda entre revisões.
17. **Decidido: o preview não é portão.** O Doric é YOLO por padrão: o agente publica e segue direto, o comentário corrige o rumo e a autorização é exceção, por política do Project ([artefatos](../artifacts.md#a-política-de-revisão)). A decisão 8 vira, então, uma pergunta sobre o caso `request`.
18. **Decidido: a resolução.** Um comentário se resolve por thread: o usuário, no popover do pino, ou o agente, com `resolve` na `comment_reply`; o pino mostra o estado (`done`, `await`, `open`) e as threads resolvidas podem ser escondidas. Fecha o item 5 das decisões em aberto de [comentários](../comments.md#decisões-em-aberto).
19. **Limitação conhecida: a janela do canvas e o evento de abertura.** O `doric:comment-thread-open` é um evento DOM do `chat`; a janela do canvas é outro documento e não o recebe, então só o node abre a thread a partir da conversa.
20. **Estados lado a lado.** A proposta está desenhada ([acima](#estados-lado-a-lado-proposta)). Falta decidir quais stories entram quando a tool não lista nenhuma, o limite de frames por preview e o que acontece com um frame que some numa revisão.

## Composição e partes

- `host` — a tool `papercraft_preview`, o tipo `preview` do registro (`artifact.kind/v1`) e `papercraft.previews/v1`; `requires` `tools/v1`, `events/v1`, `files/v1`, `runtime.threads/v1`, `artifacts/v1` e `comments/v1` — o registro e os comentários são de outros bundles, e o papercraft só contribui o tipo.
- `client` — projetor, renderizador, a rota `/papercraft/:artifactId` e os dois elementos (`<papercraft-preview>`, `<papercraft-canvas>`) sobre a superfície compartilhada; `requires` `ui/v1`, `navigation/v1`, `commands/v1`, `menus/v1`, `hooks/v1` e os contratos de host `papercraft.previews/v1` — é por ele que os comandos da barra leem o preview —, `artifacts/v1` e `comments/v1` — é por eles que leem a revisão e gravam o comentário —, e consulta `chat.views/v1`, `chat.hooks/v1` e o serviço de host proposto `chat.composer/v1` por `whenAvailable`.
- `desktop` — registra `papercraft.open-canvas/v1` e abre ou foca a janela da rota por `doric.windows/v1`, com a chave prefixada pelo core.
- `papercraft-relay` (residente) — só quando o caminho C existir (`site`, terceiros): serve `/papercraft/<token>/` na origem do host, espelhando `screen-relay`.
- `skills/papercraft-preview/` — a skill `papercraft-preview` ([acima](#skill-do-agente)), que é o juízo de quando propor um preview e o fluxo de publicar, implementar e revisar, no molde do `web` com `web-research` (`bundles/features/web/src/skills/web-research/SKILL.md`).

## Etapas de entrega

O registro de artefatos ([artefatos](../artifacts.md#etapas-de-entrega)) é pré-requisito da etapa 1; as etapas abaixo são as do papercraft.

1. **Preview vivo com eventos.** Tool e a skill `papercraft-preview` que ensina quando usá-la, o tipo `preview` no registro, build/render no host, a rota `/artifacts/` no handler, o projetor, o renderizador e o node montando o módulo no shadow root (caminho B, com o markup de A como fallback).
2. **Canvas.** Pan, zoom, seleção, árvore derivada e camadas, tudo local.
3. **Comentários ancorados.** Carimbo de origem, pinos, a pilha de cards acima do prompt e o flush do envio, com o rascunho no serviço de host do `chat`.
4. **Janela de canvas.** A rota `/papercraft/:artifactId`, o comando `papercraft.open-canvas/v1`, a janela por `windows/v1` com o cabeçalho overlay (semáforo + nome do arquivo), a árvore à esquerda e a barra de comandos no centro inferior, com os quatro grupos e os atalhos de `menus/v1`; um segundo clique foca a janela já aberta para o preview.
5. **Política `request`.** O pedido na conversa, o botão `Autorizar` da barra e `artifacts.approved/v1`, como exceção opt-in de um Project.
6. **Revisões acumuladas.** Ajustes de `artifacts.revised/v1`, com o node antigo preservado, como o fluxo pede.
7. **Escrita de volta pelo host.** O codemod opcional (modelo do Glide); hoje a implementação é do agente, e o preview já a mostra. O `site` e o conteúdo de terceiros ganham a janela `view` (caminho C) quando `ports` existir.
8. **Frames.** Estados lado a lado de um arquivo de stories, com o tema como dimensão, a estrutura flutuante com os frames no primeiro nível, o menu `N estados` na barra e a chave `frame` na âncora; depois, frames de arquivos diferentes.

## Mockups

Páginas HTML estáticas, para abrir direto no navegador. Elas registram as decisões de desenho; o código continua sendo a fonte do comportamento.

- [Comentários e threads](./mockups/comments.html): o pino com estados, o label de hover, o popover da thread e a pilha acima do prompt. O campo do primeiro comentário aparece sem superfície, como foi desenhado; no código ele voltou a ter a superfície do popover.
- [Respostas no chat](./mockups/replies.html): as opções de layout das respostas do agente. A escolhida é a C, a linha de tool recolhida, e o turno do usuário não mostra mais o chip de estado.
- [Estados lado a lado](./mockups/states.html): a proposta de frames, na janela e no node ([acima](#estados-lado-a-lado-proposta)).

## Referências

- [Glide](https://github.com/SrivarsanK/Glide): canvas, scene graph, carimbo de origem, staging e escrita de volta.
- Barra inferior de ferramentas de editores de canvas (Figma, Paper): a referência de desenho da barra de comandos — ícones agrupados, as leituras no meio e a ação primária à direita.
- [Artefatos](../artifacts.md): o registro que dá identidade, revisões, âncoras e estado de revisão aos entregáveis do agente, e o tipo `preview`.
- [Comentários](../comments.md): o spec do conceito — o alvo, a âncora, os dois registros e o rascunho no host.
- [Eventos e nodes](../events-and-nodes.md): por que o log durável não é o histórico do provider.
- [O bundle chat](../chat.md): projetores, renderizadores e o exemplo completo do `git`.
- [UI composta por bundles](../ui-composition.md) e [React dentro de Web Components](../react-web-components.md): como um elemento de node é definido e hospedado.
- [Pacotes compartilhados e tokens do tema](../platform-packages.md): import map, tema e a regra do Tailwind.
- [Protocolo `doric://`](../doric-protocol.md): a origem única, a shell por requisição e a CSP.
- [Janelas abertas pelo core](../windows.md): `windows/v1`, paths e partições.
- [Port forwarding](../port-forwarding.md): o precedente `screen`/`screen-relay` de servir conteúdo do sandbox numa janela.
