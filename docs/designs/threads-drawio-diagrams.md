# Spec: diagramas draw.io nas Threads e o modal de canvas

- Ticket: [DORIC-88](https://linear.app/doric/issue/DORIC-88) — "[FEATURE] Threads: draw.io support for diagrams".
- Status: approved, versão 16 (2026-10-29). Todas as fases concluídas: a fase 0, menos a nova medida de memória em macOS e Windows ([Fase 0](#fase-0--origem-do-editor-e-provas)), e as fases 1a, 1b, 2, 3 e 4.
- Áreas tocadas: o app desktop (`app/desktop/doric`), os pacotes `packages/desktop` e `packages/bundle`, os bundles `artifacts` e `papercraft`, o bundle novo `drawio` e a composição do host (`app/backend/doric-host`).
- Brief: none. O conceito, aceito pelo usuário na versão 3, foi substituído por esta spec na versão 4; ver [Revisões](#revisões).
- Feature docs: [threads-drawio-diagrams](../features/threads-drawio-diagrams.md) (fases 0 a 4). Docs de arquitetura tocados: [Papercraft](../architecture/bundles/papercraft/README.md), [Artefatos](../architecture/bundles/artifacts.md), [Comentários](../architecture/bundles/comments.md).
- Reviews: none. Os relatórios chegaram pela conversa; a coluna Reviews de [Revisões](#revisões) os nomeia.

Todo caminho é escrito a partir da raiz do repositório e nomeia o arquivo como ele está antes desta mudança; caminhos de outros repositórios são links para o GitHub. As referências de linha foram conferidas no commit `b036232f`; as do bundle `drawio` (`bundles/features/drawio/`) e das mudanças das fases 0 a 4 foram conferidas de novo no fim da fase 4.

## Problema

1. O agente não entrega diagramas revisáveis: o registro recusou o tipo `diagram` (`docs/architecture/bundles/artifacts.md:137`), e o código não tem renderizador de diagrama (nenhuma ocorrência de `mermaid` em `bundles/`, `packages/` ou `app/`).
2. O usuário não consegue comentar uma parte de um diagrama, nem editá-lo no Doric.
3. O canvas ampliado do Papercraft abre numa janela do sistema operacional separada (`bundles/features/papercraft/src/desktop/commands.ts:30-43`), sem o prompt da conversa e sem o evento que abre a thread de um comentário (limitação 19, `docs/architecture/bundles/papercraft/README.md:588`).

## Glossário

Runtime de bundles:

- **Partes de um bundle**: `host` roda no backend (`app/backend/doric-host`), junto do sandbox do Project; `desktopMain` roda num utility process do app desktop, sem DOM e sem `webContents` (`bundles/features/papercraft/src/desktop/snapshot.ts:8-14`); `client` roda em cada janela. Cada `activate(ctx)` recebe só `services` (`docs/architecture/bundles.md:22`).
- **Geração `desktopMain`**: o processo da parte `desktopMain`; trocar o código dela reinicia o processo, e o IPC dos bundles passa por um dispatcher único (`docs/architecture/bundles.md:27`).
- **Plataforma desktop**: o app Electron `app/desktop/doric`, com o processo principal (main). S1, S2 e as seções "Plataforma: …" falam dela; o bundle `core` (`bundles/foundation/core`) é outra coisa.
- **Contrato de plataforma**: um contrato `doric.*`, fornecido pela plataforma, versionado com ela e fora de `requires`; a compatibilidade com ele só passa por `engines.doric` (`docs/architecture/bundles/versioning.md:29`).
- **Ponte, `expose: 'desktop'` e `desktopScope`**: a ponte leva as chamadas de uma janela aos serviços; só os métodos com `expose: 'desktop'` são alcançáveis dela (`docs/architecture/bundles/services-and-channels.md:366`), e `desktopScope` lista as chaves de escopo que a ponte preenche nessas chamadas (`docs/architecture/bundles/artifacts.md:105`).
- **Cópia estrutural**: o bundle copia os tipos e o `ref` de um contrato de outro bundle em vez de importar o pacote dele (`docs/architecture/bundles/implementation-decisions.md:869`, `:893`).
- **Import map**: o mapa de módulos da janela; todo subpath exportado de `desktop/ui` entra nele uma vez (`app/desktop/doric-platform/build.mjs:173-198`).
- **Origem `doric://app` e CSP do shell**: shell, pacotes e assets de bundles vêm de `doric://app`, com CSP gerada pelo main (`docs/architecture/bundles.md:28`). O `frame-src` do shell lista os documentos que uma janela pode pôr num iframe; hoje só `doric://app/frame/` (`app/desktop/doric/src/platform/protocol/csp.ts:11`).
- **Composição**: a escolha dos bundles habilitados e dos provedores (`docs/architecture/bundles/composition-and-distribution.md:7`).

Threads e artefatos:

- **Project** e **Thread**: o projeto do usuário (com um sandbox e o workspace dele) e uma conversa com o agente dentro dele. Ver [chat](../architecture/bundles/chat.md).
- **Pasta atual da Thread**: o diretório de trabalho da Thread, de `runtime.workspace/v1.cwd()` (`bundles/features/files/src/host/sandbox.ts:54`); `write` e `edit` resolvem caminhos relativos contra ela (`bundles/features/files/src/host/tools/write.ts:57`, `:172-173`).
- **Raiz do Project**: `sandbox.root` do sandbox que o lease entrega (`packages/sandbox/src/lib/types/sandbox.ts:163`).
- **Node**: um bloco da conversa renderizado por um elemento de um bundle, reconstruído dos eventos do log da Thread. Ver [eventos e nodes](../architecture/bundles/events-and-nodes.md).
- **Artefato**, **tipo** e **revisão**: o entregável do agente com identidade estável, o `kind` que diz como ele é validado e mostrado, e cada versão imutável dele. Ver [artefatos](../architecture/bundles/artifacts.md).
- **Moldura do registro**: o elemento do bundle `artifacts` que envolve o corpo de cada revisão e cria o elemento do tipo (`bodyTag`) com `ui/v1.create(bodyTag, { block })` (`bundles/features/artifacts/src/contracts/index.ts:360-367`). Sob a política `request`, ela mostra o botão **Autorizar**, que aprova a revisão (`bundles/features/artifacts/src/client/elements.ts:506-507`).
- **Política `proceed` e `request`**: a política de revisão do Project (`docs/architecture/bundles/artifacts.md:155-166`).
- **Lease**: a posse do sandbox do Project pelo host. `runtime.lease/v1.withLease(task)` roda `task` no sandbox atual sem adquirir um, e responde `pending`, `unavailable`, `expired` ou `missing` quando não há (`bundles/runtime/runtime/src/contracts/lease.ts:140`). `artifacts/v1.read` também passa por ele (`bundles/features/artifacts/src/host/store.ts:201-212`), mas responde `undefined` sem lease, igual a um artefato ausente (`bundles/features/artifacts/src/host/artifacts.ts:387-398`, `:630`).
- **Arquivo guardado de uma revisão**: `<raiz do Project>/.doric/artifacts/<artifactId>/<revision>/diagram.drawio`, onde o registro grava os bytes de cada revisão e nunca os reescreve (`bundles/features/artifacts/src/host/store.ts:1-13`). Só o registro o lê e escreve; o agente recebe uma cópia por `checkout` ([Revisões e base](#revisões-e-base)).
- **Rascunho do agente**: o `.drawio` que o agente escreve, ou que um `checkout` cria, e passa à tool em `path`; por padrão em `.doric/artifacts/drafts/`, como o Papercraft faz (`bundles/features/papercraft/src/skills/papercraft-preview/SKILL.md:37`).
- **Pilha, flush e envelope `<comments>`**: o comentário confirmado fica como rascunho numa pilha acima do prompt (`chat.composer/v1`); no envio, o flush do dono do tipo do item grava cada um como `comments.added/v1`, e o agente os lê no bloco `<comments>` do prompt (`docs/architecture/bundles/comments.md:84-143`). Para uma âncora `selector`, o envelope mostra `anchor` (o `selector`) e `element` (o rótulo); para uma âncora `point`, só `anchor="point x,y"` e `near` (`bundles/desktop/chat/src/client/domain/prompt-envelope.ts:95-108`), sem lugar para a página. Por isso o diagrama usa `selector` também para pontos livres ([Âncora](#âncora)).
- **Comentário atendido**: um comentário que o agente marcou como resolvido (`comments.resolved/v1`) depois de publicar a revisão que faz o que ele pede.

Canvas:

- **Frame de bundle**: um módulo `src/client/frames/<nome>.ts` de um bundle, montado no documento `doric://app/frame/index.html`, num `<iframe sandbox="allow-scripts">` de origem opaca (`docs/architecture/bundles/papercraft/isolamento.md:11`, `:29-40`).
- **Frames vivos**: no máximo 3 frames de preview do Papercraft vivos por janela; uma superfície montada com chave `undefined` fica viva fora dessa conta (`bundles/features/papercraft/src/client/surface/live-frames.ts:28`, `:158-170`). O diagrama não usa frames vivos (S5).
- **Layout de uma revisão**: o tamanho do SVG de uma página e a caixa de cada célula nele, medidos uma vez no frame de medida e guardados com o SVG ([`drawio.svg/v1`](#serviço-drawiosvgv1-desktopmain)).
- **Scene graph**: a árvore dos elementos do preview que o frame do Papercraft mede e manda ao app, com as caixas de cada um (`bundles/features/papercraft/src/client/surface/scene-graph.ts`).
- **Porta**: uma interface que o bundle dono implementa para um módulo genérico de `desktop/ui/canvas`: `CanvasHitTester` (o que há sob o ponteiro) e `CommentStore` (a pilha do seu tipo de comentário), definidas em [`desktop/ui/canvas`](#desktopuicanvas).
- **`chrome` e `host`**: `chrome: 'node' | 'canvas'` é a prop da superfície do Papercraft que diz onde ela está montada; `CanvasHeader` troca a dele por `host: 'node' | 'modal'`, porque o cabeçalho deixa de conhecer a janela do canvas.
- **Revisar** e **Editar**: os dois modos do modal do diagrama: o SVG com pinos e comentários, e o editor draw.io.
- **Tema do app**: `light` ou `dark`, lido de `document.documentElement.classList.contains('dark')`, como o Papercraft faz (`bundles/features/papercraft/src/client/surface/preview-surface.tsx:86-89`).
- **Base UI**: `@base-ui/react`, a biblioteca de componentes React sem estilo; `packages/desktop/src/components/` tem os wrappers dela (`packages/desktop/src/components/dialog.tsx:2`).

draw.io:

- **`mxfile`**: a raiz de um arquivo `.drawio`; cada filho `<diagram>` é uma **página**, com `id` e `name`.
- **`mxGraphModel`**: o modelo de uma página; dentro do elemento `<root>` dele estão as **células** (`mxCell`), formas (`vertex="1"`) ou conectores (`edge="1"`, com `source` e `target`), cada uma com `id` único na página. Uma célula com dados extras vem embrulhada em `<object>` ou `<UserObject>`, que levam o `id` e o `label`.
- **XML comprimido**: o conteúdo de um `<diagram>` gravado como texto base64 de deflate cru de `encodeURIComponent(xml)`.
- **Embed mode**: o editor num iframe, falando com a página por `postMessage`, com mensagens JSON (`proto=json`). Eventos usados: `init`, `load`, `autosave`, `export`, `shortcut`; `exit` e `openLink` são ignorados. Ações usadas: `load`, `export` e, nos testes, `merge`, que mescla um XML ao diagrama aberto como se o usuário o tivesse desenhado.
- **`.drawio.svg`**: SVG com o diagrama dentro (exportação `xmlsvg`); qualquer visualizador mostra a imagem, e o draw.io o abre de novo.

## Decisões do usuário

| Id  | Decisão                                                                                                                                                                                                                                | Origem                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| D1  | O agente cria os diagramas por uma tool parecida com `papercraft_preview`; o usuário revisa e comenta.                                                                                                                                 | conceito                                  |
| D2  | O usuário edita no editor draw.io dentro do modal expandido; cada salvar cria uma revisão nova.                                                                                                                                        | conceito                                  |
| D3  | O draw.io é self-hosted, com a biblioteca de <https://www.drawio.com/react/?framework=other>.                                                                                                                                          | conceito                                  |
| D4  | Entram: revisões numeradas, comentários ancorados em células, estado de revisão e aprovação, e exportar/salvar como `.drawio` ou SVG no Project.                                                                                       | conceito                                  |
| D5  | Diagramas e Papercraft passam a abrir no modal; a janela separada do canvas do Papercraft deixa de existir.                                                                                                                            | conceito                                  |
| D6  | As [fases](#fases-e-critérios-de-aceitação) 0–4: 0 e 1a correm em paralelo, e 1b remove a janela do Papercraft.                                                                                                                        | conceito                                  |
| D7  | O editor é servido por `protocol.handle` do Electron num host `https:` fixo. Plano B: cliente próprio do protocolo sob um esquema próprio.                                                                                             | questão do conceito sobre servir o editor |
| D8  | Bundle novo, com tipo de artefato, tool e skill próprios, reusando o canvas do Papercraft.                                                                                                                                             | questão do conceito sobre o bundle        |
| D9  | A aprovação de diagramas fica para depois da v1.                                                                                                                                                                                       | questão do conceito sobre a aprovação     |
| D10 | A exportação grava os dois formatos, `.drawio` e `.drawio.svg`.                                                                                                                                                                        | questão do conceito sobre a exportação    |
| D11 | A edição não salva fica só na memória do modal, e fechar pede confirmação; não há rascunho nem recuperação na v1.                                                                                                                      | Q12                                       |
| D12 | Links do diagrama não abrem, e o painel de bibliotecas de formas do editor fica fechado na v1.                                                                                                                                         | Q12                                       |
| D13 | A revisão não tem campo de autor; a revisão do usuário é identificada pela nota `Editado pelo usuário`. Um node por salvar, sem agrupar.                                                                                               | Q7                                        |
| D14 | O teto de memória da fase 0 é 300 MB para o processo do iframe do editor. Substituída por D23.                                                                                                                                         | fase 0                                    |
| D15 | Salvar sobre uma revisão do agente mais nova que a base grava a revisão do usuário; o modal mostra a faixa durante a edição; o agente sabe na saída seguinte da tool, por um aviso tirado das revisões do registro, sem fila guardada. | Q13                                       |
| D16 | O webapp vai inteiro, menos `WEB-INF/`, `META-INF/` e `templates/`.                                                                                                                                                                    | Q14                                       |
| D17 | O modal cobre a janela inteira, menos 12 px de margem.                                                                                                                                                                                 | Q8                                        |
| D18 | O node mostra a página 1, com `pág 1/N`; o modal troca de página pela barra.                                                                                                                                                           | Q9                                        |
| D19 | O draw.io é conferido a cada minor do Doric; uma correção de segurança do draw.io entra no release seguinte do Doric.                                                                                                                  | Q4                                        |
| D20 | `papercraft.open-canvas/v1` sai sem substituto, e o Papercraft vai a 2.0.0; `papercraft.send/v1` e o botão `Enviar ao agente (n)` ficam.                                                                                               | Q10                                       |
| D21 | Diagramas saem da política `request` por uma lista de tipos isentos na política de revisão (`exemptKinds`, padrão `['diagram']`).                                                                                                      | Q11                                       |
| D22 | Para desenhar a página N, o renderizador carrega um `mxfile` só com o `<diagram>` dessa página e o exporta.                                                                                                                            | A3, fase 0                                |
| D23 | O teto de memória é 400 MB para os dois editores juntos (renderizador e modal), no lugar dos 300 MB de D14. A fase 0 mediu 296,5 MB no Linux; a medida se repete em macOS e Windows antes do release.                                  | fase 0                                    |
| D24 | No node, um comentário ancorado em outra página da revisão é um pino solto; no modal, os pinos das páginas fora da tela são soltos.                                                                                                    | fase 2, Q1                                |
| D25 | "Célula alterada" é o contorno tracejado de `ChangedCells`, do `drawio`, com o título "A célula mudou desde o comentário"; `desktop/ui/canvas` não muda.                                                                               | fase 2, Q2                                |
| D26 | A limpeza do SVG mantém um `foreignObject` só de texto e remove o que tem mídia, controle de formulário, `link` ou `meta`.                                                                                                             | fase 2, Q3                                |
| D27 | O cache de SVG guarda um ponteiro para a primeira página de cada revisão; o node acha a página 1 pelo cache, sem ler a revisão.                                                                                                        | fase 2, Q7                                |

## Objetivos

1. Tool `drawio_diagram` que cria e revisa diagramas e devolve o estado com os comentários pendentes (D1).
2. Tipo de artefato `diagram`, um node por revisão, comentários ancorados em células (D4).
3. Editor draw.io no modal; cada salvar é uma revisão com a nota `Editado pelo usuário` (D2).
4. Exportação para o Project em `.drawio` e `.drawio.svg` (D10).
5. Tudo offline: nenhuma requisição sai da máquina (D3).
6. Modal de canvas para diagrama e preview; a janela do Papercraft sai (D5).

## Não-objetivos

- Aprovação de diagramas (D9). O tipo `diagram` está na lista de tipos isentos da política de revisão ([Registro de artefatos 1.1.0](#registro-de-artefatos-110)).
- Rascunho que sobrevive ao fechamento do app (D11) e links que abrem (D12).
- O painel de bibliotecas de formas do editor (D12). As formas de qualquer biblioteca que um diagrama já usa são desenhadas, porque o webapp vai inteiro ([Plataforma: o webapp vendorizado](#plataforma-o-webapp-vendorizado)).
- Entrada em Mermaid, PlantUML ou CSV; edição em tempo real entre usuário e agente; mescla automática de revisões concorrentes; integrações de nuvem do draw.io; abrir um `.drawio` qualquer do Project sem o agente; exportação feita pelo agente; o canvas num segundo monitor.

## Desenho

O agente publica diagramas draw.io como artefatos da conversa, por uma tool do bundle novo `drawio`. Cada revisão vira um node com o SVG do diagrama, onde o usuário comenta células. Um modal de canvas, que cobre a janela, substitui a janela separada do Papercraft e hospeda também o editor draw.io, onde cada salvar grava uma revisão. O editor roda offline: o webapp do draw.io vai empacotado com o app e é servido pelo processo principal numa origem `https:` fixa, interceptada por `protocol.handle`. O SVG de cada revisão é desenhado na janela por um iframe oculto do mesmo editor, guiado pela `DrawioClient` da `@drawio/react`, medido uma vez num frame de origem opaca e guardado, com as caixas das células, num cache do bundle; o node o mostra num `<img>`. A lógica de canvas que não depende da forma da âncora sai do Papercraft para `packages/desktop`, de onde os dois bundles a usam.

### Decisões de desenho

| Id  | Decisão                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Motivo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | A origem do editor, `https://drawio.doric.invalid`, é da plataforma desktop, fixa no código, com um contrato de plataforma próprio, `doric.drawio/v1`. Não há contrato genérico para um bundle registrar uma origem.                                                                                                                                                                                                                                      | Nenhuma costura deixa um bundle registrar handler de protocolo ou origem: o desktopMain só recebe serviços (`bundles/features/papercraft/src/desktop/index.ts:25`) e roda num utility process sem `webContents` (`bundles/features/papercraft/src/desktop/snapshot.ts:8-14`). Um contrato genérico deixaria qualquer bundle pôr uma origem no `frame-src` do shell, e o CSP do shell passaria a depender da geração. Há um consumidor só.                                                                                                                                                                                                                                           |
| S2  | O webapp do draw.io vai **empacotado com o app** como asset de plataforma (`assets/drawio/`), não pelo catálogo de bundles.                                                                                                                                                                                                                                                                                                                               | O catálogo baixa e confere por SHA-256 cada arquivo de `client/**` de um bundle (`packages/bundle/src/contracts/platform.ts:333-346`); `src/main/webapp` tem 3.092 arquivos e 104 MB na tag `v32.6.1` (árvore de [jgraph/drawio](https://github.com/jgraph/drawio/tree/v32.6.1/src/main/webapp)). E quem serve a origem já é a plataforma (S1).                                                                                                                                                                                                                                                                                                                                     |
| S3  | A lógica de canvas que não depende da forma da âncora sai de `bundles/features/papercraft/src/client/` para `packages/desktop/src/canvas/`, exportada como `desktop/ui/canvas`: as peças visuais, gestos, enquadramento, threads, log de comentários, fluxo de comentário e abertura de thread. O acoplamento ao scene graph é cortado por portas; o scene graph, a resolução de âncoras do preview e o foco do frame ficam no Papercraft.                | Um bundle só alcança `*/contracts` e `desktop/ui/*` de outro (`packages/bundle/src/build/externals.ts:10-25`); `desktop/ui/comment-pin` já é o precedente (`packages/desktop/package.json:50-54`); o build da plataforma põe no import map todo subpath exportado de `desktop/ui` (`app/desktop/doric-platform/build.mjs:173-198`). Copiar a lógica duplicaria cerca de 1.800 linhas.                                                                                                                                                                                                                                                                                               |
| S4  | O SVG de uma revisão é **derivado**: desenhado no client do `drawio` por um iframe oculto do editor, um por janela, com uma ação `export` da `DrawioClient` que já leva o XML, e guardado pelo desktopMain do `drawio` no diretório de cache do bundle. A revisão só tem o `.drawio`.                                                                                                                                                                     | O host não renderiza draw.io. A ação `export` aceita `xml` e o carrega antes de exportar ([protocol.ts#L277-L287](https://github.com/jgraph/drawio-react/blob/main/src/protocol.ts#L277-L287)), com prazo por pedido (`requestTimeout`); um segundo cliente do protocolo na plataforma fica sem medida que o justifique, e a fase 0 mede. O cache por bundle já existe (`doric.cache/v1.directory`, `packages/bundle/src/contracts/platform.ts:722-725`); `artifacts.cache/v1` não serve ([Alternativas](#alternativas-consideradas)).                                                                                                                                              |
| S5  | O node e o modo **Revisar** mostram o SVG num `<img>` com URI `data:`, e os pinos sobre as caixas das células. As caixas são medidas uma vez por revisão, página e tema, num frame de bundle de origem opaca (o documento de frame do Papercraft, `doric://app/frame/index.html?entry=…`), e guardadas com o SVG em `drawio.svg/v1`. O app faz o hit-test sobre essas caixas.                                                                             | Num `<img>`, o navegador não executa script nem carrega recurso externo do SVG, e o shell aceita `img-src 'self' data:` (`app/desktop/doric/src/platform/protocol/csp.ts:19`). Medir pede o SVG num DOM, e o frame de bundle é onde ele não executa script (`app/desktop/doric/src/platform/protocol/csp.ts:47-58`); a plataforma aceita frames de qualquer bundle (`app/desktop/doric/src/platform/protocol/frame.ts:85-90`). O Papercraft limita frames vivos porque cada um avalia o próprio React (`bundles/features/papercraft/src/client/surface/live-frames.ts:4-5`); o diagrama não precisa de frame para ser mostrado, e um caminho de exibição só serve o node e o modal. |
| S6  | A âncora de uma célula é `form: 'selector'` com `selector = "page/<pageId>/cell/<cellId>"`.                                                                                                                                                                                                                                                                                                                                                               | O envelope `<comments>` mostra ao agente só `selector` e `label` de uma âncora `selector` (`bundles/desktop/chat/src/client/domain/prompt-envelope.ts:95-102`); assim o agente vê a página sem mudar o `chat`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| S7  | O host nunca escreve num arquivo que existe. O agente revisa a partir do próprio rascunho, com `path` e `base_revision`; quando precisa do conteúdo de uma revisão (a do usuário, por exemplo), pede um `checkout`, que grava a revisão num arquivo novo. A tool recusa quando há revisão mais nova que `base_revision` e lista as revisões novas, com as do usuário reconhecidas pela nota `Editado pelo usuário` ([Revisões e base](#revisões-e-base)). | O registro já guarda cada revisão num diretório próprio, nunca reescrito (`bundles/features/artifacts/src/host/store.ts:1-13`, `docs/architecture/bundles/artifacts.md:3`), e `artifacts/v1.revisions` devolve a nota de cada revisão (`bundles/features/artifacts/src/contracts/index.ts:132-133`, `:253-262`). Sem arquivo de trabalho, não há estado nem fila de avisos para manter. `.doric/` inteiro é ignorado pelo Git (`bundles/features/artifacts/src/host/store.ts:41-46`).                                                                                                                                                                                               |
| S8  | O registro de artefatos ganha, numa minor, uma lista de tipos isentos na política de revisão (`artifacts.review-policy/v1`), com `diagram` no valor padrão; um tipo isento corre sob `proceed` em qualquer Project. A revisão não ganha autor (D13). É D21.                                                                                                                                                                                               | A moldura desenha `Autorizar` para todo tipo sob `request` (`bundles/features/artifacts/src/client/elements.ts:506-507`); sem isenção, D9 não se cumpre. Sob `proceed`, `approve` devolve o registro sem gravar (`bundles/features/artifacts/src/host/artifacts.ts:747-754`), a espera de `awaitApproval` libera (`:467-468`) e `apply` não recusa (`:935-938`): a isenção reusa esses caminhos. O bloco que o corpo recebe já traz `changeNote` (`bundles/features/artifacts/src/client/elements.ts:194-196`), que o node do diagrama mostra no rodapé.                                                                                                                            |
| S9  | No modal, os atalhos sem modificador (`V`, `C`, `H`, `I`, `E`) e os de zoom são tratados pelo `keydown` do próprio modal, que os ignora com o foco em `input`, `textarea` ou `[contenteditable]`.                                                                                                                                                                                                                                                         | O listener de teclas da janela intercepta, na fase de captura, todo atalho da tabela de `menus/v1`, sem exceção para campos de texto (`packages/desktop/src/client/keybindings.ts:129-141`); o Papercraft só registra letras porque a janela do canvas não tem campo de texto (`bundles/features/papercraft/src/client/index.ts:75-77`). `when.focus` existe (`app/desktop/doric/src/platform/menus/native-menus.ts:49-55`, `menus/v1.setContext`, `packages/bundle/src/contracts/basic/menus.ts:24`), mas vale para a janela inteira, e o modal tem um campo de comentário.                                                                                                        |
| S10 | As fases 0 e 1a sobem a plataforma uma minor cada, até 1.2.0; `drawio` e o Papercraft 2.0.0 declaram `engines.doric: "^1.2.0"` ([Plataforma: versão](#plataforma-versão)).                                                                                                                                                                                                                                                                                | Os dois dependem de `desktop/ui/canvas`, `doric.drawio/v1` e `assets/drawio`, que só a plataforma nova tem; a compatibilidade com a plataforma só passa por `engines.doric` (`docs/architecture/bundles/versioning.md:29`, `:64`), e hoje a versão é `1.0.0` (`packages/bundle/src/runtime/version.ts:2`).                                                                                                                                                                                                                                                                                                                                                                          |

### Arquitetura

```text
app/desktop/doric (processo principal; plataforma 1.2.0, S10)
  ├─ assets/drawio/                 webapp vendorizado (S2)
  ├─ origem https://drawio.doric.invalid  protocol.handle('https') (S1)
  └─ CSP do shell + guarda de navegação aceitam a origem
packages/bundle                     contrato de plataforma doric.drawio/v1 (describe)
packages/desktop                    desktop/ui/canvas (S3): viewport, cabeçalho, rodapé,
                                    pinos, campo e popover, barra, modal, gestos,
                                    enquadramento, threads, log e fluxo de comentário
bundles/features/artifacts 1.1.0    tipos isentos na política de revisão (S8)
bundles/features/papercraft 2.0.0   usa desktop/ui/canvas; modal no lugar da janela; engines ^1.2.0
bundles/features/drawio 1.2.0       engines ^1.2.0; host: tipo, tool, serviço drawio.diagrams/v1
                                    desktopMain: drawio.svg/v1 (cache), flush dos comentários
                                    client: <drawio-diagram>, modal, editor,
                                    renderizador oculto (S4), frame de medida (S5)
```

### Plataforma: `doric.drawio/v1`

Em `packages/bundle/src/contracts/platform.ts`, ao lado de `doric.windows/v1` (`:1016-1034`), o tipo, o schema e o `ref`:

```ts
/** A origem fixa do editor draw.io (S1); a única fonte desse valor. */
export const DRAWIO_ORIGIN = 'https://drawio.doric.invalid';

export interface DrawioDescription {
  /** Se a origem responde: o webapp existe e o handler foi registrado. */
  readonly available: boolean;
  /** A versão do webapp vendorizado, de `assets/drawio/manifest.json`. */
  readonly version?: string;
  /** Por que não está disponível. */
  readonly reason?: 'missing-assets' | 'handler-failed';
}

export const drawioDescriptionSchema: z.ZodType<DrawioDescription> = z
  .object({
    available: z.boolean(),
    version: z.string().optional(),
    reason: z.enum(['missing-assets', 'handler-failed']).optional(),
  })
  .strict();

export interface DoricDrawio {
  describe(call?: CallArg): Promise<DrawioDescription>;
}

export const DoricDrawioV1 = ref<DoricDrawio>('doric.drawio/v1');
```

E a entrada nova de `platformContracts`, um `Object.freeze` (`:959-1145`):

```ts
export const platformContracts = Object.freeze({
  // … as entradas de hoje …
  'doric.drawio/v1': {
    environments: ['desktopMain'],
    methods: { describe: { input: noInput, output: drawioDescriptionSchema } },
  },
} satisfies Record<string, PlatformContractSpec>);
```

O documento do editor é sempre `${DRAWIO_ORIGIN}/index.html`; nenhuma outra constante guarda essa URL. O processo principal fornece o contrato: `'doric.drawio/v1'` entra em `KERNEL_CONTRACTS` (`app/desktop/doric/src/platform/generation/process.ts:40-48`), e `provideBroker` (`app/desktop/doric/src/platform/generation/broker.ts:73`) registra o provedor com a dependência nova, obrigatória, `BrokerDeps.drawio: { describe(): DrawioDescription }` (`broker.ts:37-55`). Os testes que chamam `provideBroker` passam um `drawio` falso (`app/desktop/doric/tests/generation.test.ts:86`, `app/desktop/doric/tests/menus.test.ts:274`, `:340`, `app/desktop/doric/tests/window-capture.test.ts:217`), e o teste dos métodos de plataforma ganha `'doric.drawio/v1': { describe: 'crosses' }` (`packages/bundle/tests/values.test.ts:195-248`). O client do `drawio` lê o estado por `drawio.svg/v1.status`, que repassa `describe`.

### Plataforma: a origem do editor

Módulos novos em `app/desktop/doric/src/platform/drawio/`:

- `origin.ts` (`app/desktop/doric/src/platform/drawio/origin.ts`) exporta:
  - `DRAWIO_HOST`, tirado de `DRAWIO_ORIGIN` (`new URL(DRAWIO_ORIGIN).host`, `:16`), e `isDrawioOriginUrl(url)` (protocolo `https:` e host igual, `:19`);
  - `DrawioOriginDeps` (`:29-36`): `root` (`Resources.drawioRoot`; os arquivos vêm de `<root>/webapp/`), `passThrough(request)` (a passagem para outros hosts) e `readFile?` (padrão: `readFile` de `node:fs/promises`);
  - `HandlerRegistry` (`:38-43`), a parte de `protocol` que o módulo usa (`handle(scheme, handler)`), para os testes passarem um falso;
  - `respondDrawio(request, deps)` (`:74`), a resposta a uma requisição, descrita abaixo; ela reusa `segmentsOf` de `app/desktop/doric/src/platform/protocol/handler.ts:59`, que a fase 0 passou a exportar, e `insideRoot`;
  - `registerDrawioOrigin(protocol, deps)` (`:120-125`), que chama `protocol.handle('https', (request) => respondDrawio(request, deps))` na sessão padrão, a mesma onde `registerDoricProtocol` registra `doric` (`app/desktop/doric/src/platform/protocol/handler.ts:400-411`), e deixa passar a exceção de `handle`;
  - `startDrawioOrigin(protocol, deps)` (`:131`), que registra e depois descreve: uma exceção ao registrar responde `{ available: false, reason: 'handler-failed' }`; senão, `describeDrawio(deps.root)`. Nunca rejeita.

  `respondDrawio`:
  - para uma URL cujo host não é `DRAWIO_HOST`, devolve `net.fetch(request, { bypassCustomProtocolHandlers: true })`: nada muda para outros hosts, exceto o código de uma falha. O Electron troca toda rejeição do handler por `net::ERR_UNEXPECTED` (medido na fase 0), então uma requisição de passagem que falha chega a quem pediu com esse código, não com o original (por exemplo `net::ERR_NAME_NOT_RESOLVED`);
  - aceita só `GET` e `HEAD` (outros métodos: 405);
  - o caminho vem de `assets/drawio/webapp/`, resolvido com `insideRoot` (`app/desktop/doric/src/platform/protocol/handler.ts:195-206`); fora da raiz ou ausente: 404;
  - o tipo vem de `app/desktop/doric/src/platform/protocol/mime.ts`, que ganha `'.xml': 'application/xml'`: o webapp sem as três pastas tem 4 arquivos `.xml`, e as outras extensões dele (`html`, `js`, `css`, `ico`, `png`, `gif`, `svg`, `json`, `txt`, `map`, `ttf`) já estão na tabela; `.md` e os 4 arquivos sem extensão saem como `application/octet-stream`, que o editor não carrega;
  - toda resposta HTML leva o cabeçalho `Content-Security-Policy` do editor (abaixo); toda resposta leva `X-Content-Type-Options: nosniff` e `Cache-Control: no-cache`.

- `assets.ts` (`app/desktop/doric/src/platform/drawio/assets.ts`) exporta `DrawioManifest` (`{ version, files }`, `:14-17`) e `describeDrawio(root)` (`:40`), que lê `<root>/manifest.json`: um manifesto válido com `version` não vazia responde `{ available: true, version }`; ausente, ilegível ou malformado, `{ available: false, reason: 'missing-assets' }`. Nunca rejeita e não confere os hashes.
- `index.ts` reexporta os dois módulos.

`drawioRoot` não fica em `drawio/`: é um campo de `Resources`, em `protocol/resources.ts`.

`Resources` (`app/desktop/doric/src/platform/protocol/resources.ts:6-15`) ganha `drawioRoot`, e `resourcesFor` (`:22-27`) o preenche com `join(mainDir, 'assets', 'drawio')`. `app.ts` chama `startDrawioOrigin` logo depois de `registerDoricProtocol` (`app/desktop/doric/src/platform/app.ts:517-524`), e o resultado é o que `describe` responde; uma exceção ao registrar vira `{ available: false, reason: 'handler-failed' }`, e o app segue.

**CSP das respostas HTML da origem do editor**:

```text
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self';
worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'self';
form-action 'none'; frame-ancestors doric://app 'self'
```

A fase 0 só pode acrescentar `'unsafe-inline'` e `'unsafe-eval'` a `script-src`, e só se o registro de violações mostrar que o editor precisa. O registro de violações é o do teste e2e da fase 0: ele liga o domínio `Audits` do CDP pelo `webContents.debugger` da janela, com `Target.setAutoAttach({ autoAttach: true, flatten: true })` para alcançar o iframe de outra origem, e guarda cada `Audits.issueAdded` de código `ContentSecurityPolicyIssue` com a diretiva violada. Qualquer outra fonte necessária é falha da [A2](#a2-o-editor-roda-sob-o-csp-do-editor). A política final fica numa constante `drawioCsp` em `app/desktop/doric/src/platform/protocol/csp.ts`.

Resultado da fase 0: o registro teve dois `ContentSecurityPolicyIssue` de `script-src` do tipo `kEvalViolation`, e o editor funcionou mesmo assim (A1–A4 passaram com eles). `'unsafe-eval'` não entrou, e `drawioCsp` é a política acima, sem mudança.

**CSP do shell**: `FRAME_SRC` (`app/desktop/doric/src/platform/protocol/csp.ts:11`) passa a `frame-src doric://app/frame/ https://drawio.doric.invalid/`, usado pela política empacotada (`:13-26`) e pela de desenvolvimento (`:36-40`). Nada mais muda no CSP do shell.

**Guarda de navegação**: em `installNavigationGuard` (`app/desktop/doric/src/platform/windows/navigation-guard.ts:36-49`), o `will-frame-navigate` passa a aceitar subframes cuja URL é o documento do frame **ou** `isDrawioOriginUrl(url)`; o resto continua cancelado, e `setWindowOpenHandler` continua negando.

**Plano B (D7)**: se a fase 0 mostrar que interceptar `https:` não funciona (a biblioteca recusa, o Chromium resolve o host, ou o handler afeta outra requisição), a plataforma registra o esquema privilegiado `doric-drawio` (`standard`, `secure`, `supportFetchAPI`, `corsEnabled`) ao lado de `doric` (`app/desktop/doric/src/platform/protocol/privileges.ts:8-19`) e serve o mesmo conteúdo em `doric-drawio://editor`; `DRAWIO_ORIGIN` passa a esse valor; e o client do `drawio` troca a `DrawioClient` da biblioteca por um cliente próprio do protocolo (`src/client/protocol-client.ts`), usado pelo editor e pelo renderizador, que usa só `import type` da `@drawio/react` e confere a origem da mesma forma. Nenhum outro contrato desta spec muda.

### Plataforma: o webapp vendorizado

- Projeto Nx novo `drawio-webapp`, em `app/desktop/drawio-webapp/`, com `project.json` e dois alvos: `build`, `node app/desktop/drawio-webapp/vendor.mjs --out dist/app/desktop/doric/assets/drawio`, com cache por `vendor.mjs` e `drawio.lock.json`; e `test`, `node --test app/desktop/drawio-webapp/tests/*.test.mjs`, que roda `tests/vendor.test.mjs`.
- `tar` (`^7.5.22`) é uma devDependency direta da raiz (`package.json:59`, e `package-lock.json`), usada por `vendor.mjs` para extrair o arquivo.
- `app/desktop/drawio-webapp/drawio.lock.json`: `{ "version": "32.6.1", "url": "https://github.com/jgraph/drawio/archive/refs/tags/v32.6.1.tar.gz", "sha256": "d3aa45e4ad3588d5c25805685f34a30946c3c7586cb6a54e5d62f5d2a4b0a49f", "exclude": ["WEB-INF/", "META-INF/", "templates/"] }`, com o `sha256` que a fase 0 gravou. O webapp vai inteiro (D16), menos as duas pastas do servidor Java (27 arquivos, 4,6 MB) e `templates/` (312 arquivos, 4,9 MB), que o embed mode desta spec não abre: ficam 2.753 arquivos, 103 MB sem compressão (medido na fase 0). As bibliotecas de formas carregadas sob demanda (`shapes/`, 49 arquivos; `stencils/`; `img/lib/`, 1.910 arquivos) precisam estar lá para que um diagrama que as usa seja desenhado, e cortar o resto por uma lista de inclusão exigiria provar, a cada versão, tudo o que o editor carrega.
- `vendor.mjs`: usa `node_modules/.cache/drawio/<sha256>.tar.gz` se existir; senão baixa `url`. Confere o SHA-256 e falha se diferir. Extrai `src/main/webapp/`, menos os caminhos de `exclude`, para `<out>/webapp/`, copia `LICENSE` do repositório do draw.io para `<out>/`, e `NOTICE` só quando o arquivo tem um (o da tag `v32.6.1` não tem; um `NOTICE` antigo em `<out>/` é apagado) e grava `<out>/manifest.json` com `version` e o SHA-256 de cada arquivo.
- O alvo `build` de `doric-app` (`app/desktop/doric/project.json`) depende de `drawio-webapp:build`.
- Dono: a plataforma desktop. Atualizar o draw.io é trocar `version`, `url` e `sha256` no lock e passar os testes da fase 0. A cada minor do Doric, o dono confere o release do draw.io e atualiza o lock; uma correção de segurança do draw.io entra no release seguinte do Doric (D19).

### Registro de artefatos 1.1.0

Em `bundles/features/artifacts/src/contracts/index.ts`:

- O schema de `artifactReviewPolicy` (`:836-846`) ganha `exemptKinds: z.array(z.string().min(1)).default(['diagram'])`, e `defaultArtifactReviewPolicy` (`:851-854`) ganha `exemptKinds: ['diagram']`. Um valor gravado antes da mudança lê com o padrão.
- `reviewPolicyOf(settings, projectId, kind?)` (`:857-862`): com `kind` em `settings.exemptKinds`, responde `'proceed'`; senão, como hoje.
- `ArtifactReviewPolicyValue` (`:221-223`) ganha `readonly exemptKinds?: readonly string[]`, e `artifactPolicySchema` (`:549-552`, um `looseObject`) o declara opcional. `artifactPolicyInputSchema` (`:555-558`) não muda: `setPolicy` continua escrevendo só `policy`.

Comportamento:

- `policyOf` (`bundles/features/artifacts/src/host/artifacts.ts:378-385`) recebe o `kind` do artefato, e a espera de `awaitApproval` (`:467-468`), `approve` (`:747-754`) e `apply` (`:935-938`) o passam. Um diagrama corre sob `proceed`: `approve` devolve o registro sem gravar aprovação, `awaitApproval` libera na hora e `apply` não recusa.
- `policy()` (`:853-859`) devolve também `exemptKinds`, a lista em vigor.
- A moldura (`bundles/features/artifacts/src/client/elements.ts:506-507`) calcula `authorizable = policy?.policy === 'request' && !(policy.exemptKinds ?? []).includes(data.kind) && !approved`.
- A lista vale para todos os Projects, e a v1 não tem UI para editá-la: ela muda por `settings/v1` no espaço `artifacts.review-policy/v1`.

Versões: `artifacts/v1@1.1.0` (`policy` com `exemptKinds`) e `artifacts.review-policy/v1@1.1.0` (o campo novo, com padrão); `artifact.kind/v1` e `artifacts.revised/v1` não mudam; o bundle passa a `1.1.0` (`docs/architecture/bundles/versioning.md:53`). A revisão não ganha autor (S8).

### Plataforma: versão

- As fases 0 e 1a sobem `PLATFORM_VERSION` (`packages/bundle/src/runtime/version.ts:2`) uma minor cada, na ordem em que entram: a fase 0 por `doric.drawio/v1`, a origem e `assets/drawio`; a fase 1a por `desktop/ui/canvas`. Com as duas, a plataforma está em 1.2.0.
- Cada subida troca a versão também nos quatro caminhos fixos que a carregam: `app/desktop/doric/src/splash-page/index.html:7`, `app/desktop/doric-renderer/src/shell.html:11`, `app/desktop/doric/project.json:51` (`splash@<versão>`) e `app/desktop/doric-renderer/webpack.config.js:11` (`shellPath = '/platform/shell@<versão>/'`).
- A fase 0 entrou primeiro (plataforma 1.1.0) e fez os testes lerem `PLATFORM_VERSION` em vez de `1.0.0`: `app/desktop/doric/tests/{protocol,splash}.test.ts`, `app/desktop/doric-platform/tests/import-map.test.mjs`, `app/desktop/doric-e2e/tests/{privileges,windows-protocol}.test.ts` e `app/desktop/doric-e2e/tests/support/harness.ts`. A fase 1a só troca `PLATFORM_VERSION` para 1.2.0 e os quatro caminhos fixos.
- O Papercraft da fase 1a vai a 1.3.0 (hoje `1.2.0`, `bundles/features/papercraft/manifest.json:4`) e declara `engines.doric: "^<a versão que a fase 1a criou>"`. O Papercraft 2.0.0 e o `drawio` declaram `engines.doric: "^1.2.0"`.
- Num desktop mais velho, as partes client desses bundles ficam em quarentena com motivo, em vez de ativar e falhar (`docs/architecture/bundles/versioning.md:64`).

### `desktop/ui/canvas`

Novo subpath em `packages/desktop/package.json`, no molde de `./ui/comment-pin` (`:50-54`): `./ui/canvas` → `src/canvas/index.ts`. Como todo subpath de `desktop/ui`, ele entra no import map uma vez por janela (`app/desktop/doric-platform/build.mjs:173-198`): os dois bundles usam a mesma instância do módulo. O log compartilhado é estado desse módulo, por Thread, e não por `Services`: cada bundle tem os seus `Services` (`packages/desktop/src/client/activate.ts:256-257`, `packages/bundle/src/runtime/services.ts:341-343`), e a chave por `Services` de hoje (`bundles/features/papercraft/src/client/surface/thread-log.ts:47`, `:172-175`) abriria uma assinatura por bundle.

Peças visuais, movidas sem mudar o comportamento:

| Export                                                                      | Origem (`bundles/features/papercraft/src/client/`)                                                                                                                                                                                       |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Viewport`, `zoomAt`, `toContent`, `fitViewport` e o resto de `viewport.ts` | `surface/viewport.ts`                                                                                                                                                                                                                    |
| `CanvasHeader`                                                              | `surface/preview-header.tsx`, com a prop nova `host: 'node' \| 'modal' \| 'window'` no lugar de `chrome`; `'window'` mantém a faixa de barra de título (`:114-118`) enquanto a janela existe, e a fase 1b o tira                         |
| `CanvasFooter`                                                              | `surface/node-footer.tsx`                                                                                                                                                                                                                |
| `CommentField`                                                              | `surface/comment-field.tsx`                                                                                                                                                                                                              |
| `PinsLayer`, `CommentPin`, `surfacePoint`, `OVERLAY_ATTRIBUTE`              | `surface/pins-layer.tsx`                                                                                                                                                                                                                 |
| `ThreadPopover`, `ThreadMessage`                                            | `surface/thread-popover.tsx`                                                                                                                                                                                                             |
| `Avatar`, `authorName`                                                      | `surface/avatar.tsx`                                                                                                                                                                                                                     |
| `CanvasToolbar`, `ToolbarGroup`, `ToolbarButton`, `ToolbarSeparator`        | a casca visual de `surface/command-toolbar.tsx` (grupos, divisores, botão com tooltip), sem os ids de comando                                                                                                                            |
| `CommentOverlay`                                                            | `surface/comment-overlay.tsx`, genérico na âncora `A` no lugar do import de `CommentAnchor` (`:8`), e com as props novas `titleOf(anchor)` e `textOf(anchor, revision)` no lugar dos imports de `anchorTitleOf` e `anchorTextOf` (`:17`) |
| `appTheme`, `useAppTheme`, `CanvasTheme`                                    | `surface/preview-surface.tsx:86-120`, movidos; `PreviewTheme` do Papercraft passa a ser `CanvasTheme`                                                                                                                                    |
| `CanvasModal`                                                               | novo, abaixo                                                                                                                                                                                                                             |

Lógica que não depende da forma da âncora, movida e tornada genérica no tipo da âncora `A`. O corte do acoplamento ao scene graph está em `bundles/features/papercraft/src/client/surface/gestures.ts:32-34`, `:37-47`, `:55` e `:57`, `bundles/features/papercraft/src/client/surface/fit.ts:18-19` e `:33`, e nos imports de contratos do Papercraft em `bundles/features/papercraft/src/client/surface/threads-view.ts:14-23`, `bundles/features/papercraft/src/client/surface/comment-flow.ts:17-36` e `bundles/features/papercraft/src/client/surface/thread-open.ts:13-20`:

| Módulo novo em `src/canvas/` | Origem                                                                                                                                 | Corte                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `geometry.ts`                | `ContentPoint` de `surface/pin-geometry.ts:37-40`; `ContentBounds` novo                                                                | —                                                                                                                                                                                                                                                                                                                                                     |
| `gestures.ts`                | `surface/gestures.ts` inteiro, menos as perguntas ao scene graph (`:168-248`) e a montagem da âncora (`:293-312`)                      | os imports de `CommentAnchor`, `PreviewTool`, `anchorOf`, `pointAnchorOf` e `FrameMessage` (`:32-34`) saem; `scene` e `hidden` saem de `GestureInput`; entra `hits: CanvasHitTester<A> \| undefined`; `tool` passa a `CanvasTool`; `chrome: 'node' \| 'canvas'` fica (`:52`). `FramePointer` e `FrameWheel` viram `ReportedPointer` e `ReportedWheel` |
| `fit.ts`                     | `surface/fit.ts` inteiro                                                                                                               | `scene` sai de `FitInput`; entra `content: ContentBounds \| undefined`, o que o dono quer enquadrar                                                                                                                                                                                                                                                   |
| `threads.ts`                 | `domain/preview-state.ts:271-447`: o comentário, `AGENT_AUTHOR`, `commentsOfEvents`, `ThreadState`, `threadStateOf`, `threadsOf`       | `PreviewComment` e `PreviewThread` viram `CanvasComment<A>` e `CanvasThread<A>`; `PreviewLogEvent` (`:22-28`) vira `CanvasLogEvent`                                                                                                                                                                                                                   |
| `threads-view.ts`            | `surface/threads-view.ts:26-212` (`draftRootsOf`, `openCountOf`, `nextPinOf`, `DETACHED_STEP`, `pinsOf`, `ThreadView`, `threadViewOf`) | `PreviewDraft` (`bundles/features/papercraft/src/client/comment.ts:128-138`) vira `CanvasDraft<A>`; o alvo vira `CanvasCommentTarget<A>`                                                                                                                                                                                                              |
| `thread-log.ts`              | `surface/thread-log.ts` inteiro                                                                                                        | o `RuntimeThreadsV1` sai; quem assina passa a fonte (`ThreadWatchSource`). O log guarda os `comments.*` e os `artifacts.revised/v1`; além de `watchThreadComments`, exporta `watchArtifactRevisions`, que entrega os `artifacts.revised/v1` de um artefato                                                                                            |
| `comment-flow.ts`            | `surface/comment-flow.ts` inteiro                                                                                                      | `services` e `scope` saem de `CommentFlowInput`; entram `store: CommentStore<D>` e `threadId`. `targetOf` de `bundles/features/papercraft/src/client/anchor.ts:135-144` vira `artifactTargetOf`                                                                                                                                                       |
| `thread-open.ts`             | `surface/thread-open.ts` inteiro                                                                                                       | `services` e `scope` saem; entram `latestRevision()` e `eventName`; `chrome` fica em `ThreadOpenInput` (`:23`)                                                                                                                                                                                                                                        |

As portas:

```ts
export interface ContentBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type CanvasTool = 'select' | 'comment' | 'pan';

/** O ponteiro como o dono o lê: o ponto de conteúdo e o que um frame relatou. */
export interface CanvasPointerAt {
  readonly content: ContentPoint;
  /** O alvo que o frame resolveu, quando um frame relata o ponteiro. */
  readonly nodeId?: string;
  readonly pseudo?: string;
}

/** O que há sob o ponteiro e a âncora de um comentário, segundo o dono. */
export interface CanvasHitTester<A> {
  /**
   * O id do alvo sob o ponteiro. `select`: o alvo, senão o mais perto;
   * `point`: só um alvo sob o ponteiro, nunca o fundo.
   */
  targetAt(
    pointer: CanvasPointerAt,
    mode: 'select' | 'point',
  ): string | undefined;
  /** A âncora de um comentário no alvo `targetId`; sem ele, um ponto livre. */
  anchorAt(pointer: CanvasPointerAt, targetId: string | undefined): A;
}

export interface ThreadWatchSource {
  watchThread(
    input: { readonly threadId: string; readonly afterSequence: number },
    listener: StreamListener<ThreadWatchItem>,
  ): Disposable;
}

/** A pilha do dono do tipo de comentário, para o fluxo de comentário. */
export interface CommentStore<D> {
  begin(data: D, note: string): Promise<CommentOutcome>;
  edit(itemId: string, note: string): Promise<void>;
  remove(itemId: string): Promise<void>;
  send(): Promise<'accepted' | 'empty' | 'refused' | 'unavailable'>;
  resolve(input: {
    readonly commentId: string;
    readonly promptId: string | undefined;
    readonly resolved: boolean;
  }): Promise<'done' | 'unavailable'>;
  /** O evento DOM de envio do chat, `doric:prompt-send`. */
  readonly promptSendEvent: string;
}
```

- O `Alt` que força ponto livre (`bundles/features/papercraft/src/client/surface/gestures.ts:236-240`) fica no módulo genérico: com `Alt`, `anchorAt` recebe `targetId` ausente.
- `ReportedPointer` e `ReportedWheel` são as formas `kind: 'pointer'` e `kind: 'wheel'` de `bundles/features/papercraft/src/client/frame-protocol.ts:208-228`, sem `kind`, como interfaces; o schema zod continua no Papercraft. Um dono cujo frame não relata ponteiro não as usa.
- O log compartilhado fica num `Map` do módulo `src/canvas/thread-log.ts`, com a chave `${projectId}\u0000${threadId}`. Cada assinante passa a sua fonte e a sua conexão (`ThreadWatchSource` e `DoricConnectionV1` dos seus `Services`); o primeiro assinante de uma Thread abre o `watchThread`; uma nova assinatura depois de um stream perdido usa a fonte do assinante mais recente ainda inscrito; o último a sair fecha o stream.
- O filtro do log (`COMMENT_EVENT`, `bundles/features/papercraft/src/client/surface/thread-log.ts:31`) passa a aceitar também o tipo `artifacts.revised/v1`. `watchThreadComments(source, connection, scope, listener)` entrega os `comments.*`; `watchArtifactRevisions(source, connection, scope, artifactId, listener)` chama `listener(revision)` para cada `artifacts.revised/v1` cujo `artifactId` é o dado, os do replay e os seguintes, com repetições; o modal do diagrama o usa ([O modal do diagrama](#o-modal-do-diagrama)). A superfície do Papercraft mantém a sua assinatura de hoje (`bundles/features/papercraft/src/client/surface/preview-data.ts:432-455`).
- `ThreadLogEvent` e `ThreadWatchItem` são interfaces de `src/canvas/thread-log.ts` com as formas de `bundles/features/papercraft/src/contracts/index.ts:489-503`; `packages/desktop` não ganha `ref` de contrato de bundle (hoje não tem nenhum: busca por `ref<` em `packages/desktop/src` sem resultado). `StreamListener`, `Disposable` e `DoricConnectionV1` vêm de `bundle/contracts`, que `packages/desktop` já importa (`packages/desktop/src/client/bridge.ts:11`).
- `CommentOutcome` é o de `bundles/features/papercraft/src/client/comment.ts:187-189`.

Fica no Papercraft: o scene graph (`surface/scene.ts`, `surface/scene-graph.ts`), a resolução das âncoras do preview (`surface/pin-geometry.ts` menos `ContentPoint`), um módulo novo `surface/scene-hit.ts` com `sceneHitTester(scene, hidden): CanvasHitTester<CommentAnchor>` (o código de `bundles/features/papercraft/src/client/surface/gestures.ts:168-248` e `:293-312`), `anchorTitleOf` e `anchorTextOf` (`surface/threads-view.ts:214-281`), o foco do frame (`surface/frame-focus.ts`, que lê `InputCapture` do protocolo do preview), os frames vivos e `comment.ts`, que passa a exportar `papercraftCommentStore(services, scope): CommentStore<PreviewItemData>` com as funções de `:198-302`. O `drawio` escreve só o que é dele: o hit-test por caixas, a âncora e a re-ancoragem, e um `CommentStore` do seu tipo de comentário.

`jdenticon` (`^3.3.0`, hoje dependência do Papercraft) entra nas dependências de `packages/desktop`, e `package-lock.json` muda junto.

As classes Tailwind de `src/canvas/` chegam a toda janela pelo tema da plataforma: `packages/desktop/src/styles/theme.css` lê `../components`, `../chrome-bar.tsx` e `../canvas` (`:15-17`) e importa `./canvas.css` (`:13`). `packages/desktop/src/styles/canvas.css` tem as regras de componente do canvas, que saem de `bundles/features/papercraft/src/client/styles.css`: o pino pendente, o ativo e o solto, a sombra da thread e do campo de comentário, os chips de estado e o controle de resolvida. São regras de componente, e não utilities, porque uma utility de mesmo nome sai na folha de cada bundle, e a folha carregada depois venceria (`packages/desktop/src/styles/canvas.css:1-7`). O Papercraft continua lendo `packages/desktop/src` inteiro (`bundles/features/papercraft/src/client/styles.css:13`); o `drawio` lê só os próprios arquivos ([Estrutura](#estrutura)).

O teste de `packages/desktop` roda só `tests/*.test.js`, `tests/client/*.test.js` e `tests/reads/*.test.js` (`packages/desktop/project.json:34`); a fase 1a acrescenta `packages/desktop/dist-tests/tests/canvas/*.test.js` ao comando.

`CanvasModal`:

```ts
export type CanvasModalCloseReason = 'escape' | 'backdrop' | 'close-button';

export interface CanvasModalProps {
  readonly open: boolean;
  /** Título acessível do diálogo (o título do artefato). */
  readonly title: string;
  /**
   * Pedido de fechar. O dono decide: fecha (`open = false`) ou não (por
   * exemplo, para pedir confirmação de uma edição não salva).
   */
  readonly onCloseRequest: (reason: CanvasModalCloseReason) => void;
  /** Teclas tratadas pelo dono; só chegam com o foco dentro do modal. */
  readonly onKeyDown?: (event: KeyboardEvent) => void;
  readonly children: ReactNode;
}
```

- Feito sobre `@base-ui/react/dialog` com o portal de `usePortalContainer` (`packages/desktop/src/components/dialog.tsx:17-26`), com fundo escurecido; o painel cobre a janela menos 12 px de margem (D17).
- O fechamento por `Esc`, clique no fundo ou o botão fechar do cabeçalho vira `onCloseRequest(reason)`; o modal nunca fecha sozinho. Um `Esc` que um descendente já tomou (`defaultPrevented`) não vira pedido (`packages/desktop/src/canvas/modal.tsx:77-79`).
- O foco vai para a raiz do conteúdo ao abrir e volta ao botão que abriu ao fechar.
- `onKeyDown` não recebe eventos cujo alvo é `input`, `textarea` ou `[contenteditable]`.

### Bundle `drawio`

#### Estrutura

```text
bundles/features/drawio/
  manifest.json  package.json  project.json  README.md
  tsconfig.json  tsconfig.parts.json  tsconfig.client.json
  tsconfig.spec.json  tsconfig.client-spec.json
  src/contracts/index.ts       constantes, schemas, drawio.diagrams/v1, drawio.svg/v1,
                               cópias estruturais de artifacts, comments, runtime.lease;
                               reexporta ./chat.js
  src/contracts/chat.ts        cópia estrutural de chat.composer/v1 e chat.send/v1
  src/host/index.ts            activate: tipo, tool, serviço
  src/host/kind.ts             a declaração do tipo `diagram`
  src/host/xml.ts              validação e normalização (função pura)
  src/host/diagrams.ts         drawio.diagrams/v1
  src/host/tools/drawio-diagram.ts
  src/desktop/index.ts         activate: drawio.svg/v1 e o flush
  src/desktop/svg-cache.ts     drawio.svg/v1: o cache de SVG
  src/desktop/comment-flush.ts
  src/client/index.ts          activate: <drawio-diagram>, composer
  src/client/styles.css        Tailwind: utilities, @reference desktop/ui/tailwind.css,
                               só @source './' (as classes de desktop/ui/canvas vêm do tema)
  src/client/elements.tsx      <drawio-diagram>
  src/client/diagram-node.tsx  o node: useDiagramData, DiagramCanvas e o estado do modal
  src/client/diagram-data.ts   useDiagramData: cache, leitura, modelo, xml, revisions,
                               threads e rascunhos
  src/client/drawing.ts        drawPage (desenha, mede e guarda uma página), sha256Hex e
                               DiagramDrawing.createEditorClient
  src/client/model.ts          leitura do XML no client: páginas, células, rótulos
  src/client/anchor.ts         âncora, re-ancoragem e o CanvasHitTester das células
  src/client/comment.ts        o CommentStore do tipo drawio-diagram
  src/client/renderer.ts       o renderizador oculto (S4)
  src/client/single-page.ts    singlePageOf e RenderError, sem imports
  src/client/measure.ts        o frame de medida e a fila dele (S5)
  src/client/diagram-view.tsx  DiagramCanvas (node e Revisar): o <img>, os pinos, ChangedCells
  src/client/diagram-modal.tsx modal, máquina de estados, `ExportDialog` e `defaultExportPath`
  src/client/editor-frame.tsx  iframe do editor + DrawioClient (fase 3)
  src/client/frame-protocol.ts mensagens do frame de medida (zod)
  src/client/frame-constants.ts os valores do protocolo que o frame usa, sem zod
  src/client/frames/diagram.ts entrada do frame de medida
  src/client/frames/diagram/runtime.ts  runtime do frame: limpeza e medida
  src/skills/drawio-diagram/SKILL.md
  tests/…
```

`package.json`: `"name": "drawio"`, `"exports"` só `./package.json` e `./contracts` (molde de `bundles/features/papercraft/package.json:6-13`); dependências `bundle`, `desktop`, `tool`, `react`, `react-dom`, `lucide-react`, `zod`, `tslib`, `"@drawio/react": "0.1.0"`, `"@xmldom/xmldom": "0.8.15"`, `"tailwindcss": "4.3.3"` e `"@tailwindcss/oxide": "4.3.3"` (versões exatas; as duas últimas como no Papercraft, `bundles/features/papercraft/package.json:16`, `:25`, porque o build compila `src/client/styles.css`, `packages/bundle/src/build/parts.ts:306`, `:424`); dev `happy-dom`. `project.json`: o projeto `bundle-drawio`, com `build`, `typecheck` e `test` iguais aos do Papercraft (`bundles/features/papercraft/project.json:34-46`), sem o passo do `sandbox`. Os testes seguem os globs dele: host e desktopMain em `tests/*.test.ts` (o `tsconfig.spec.json` inclui `src/host/**`, `src/desktop/**`, `src/contracts/**`, `tests/*.ts` e `tests/support/**`), client em `tests/client/*.test.ts(x)`, com os auxiliares em `tests/client/support/` (o `tsconfig.client-spec.json` inclui `tests/client/**`).

`build` e `typecheck` passam por três `tsconfig`: `tsconfig.json` (host e contratos; exclui `src/client/**` e `src/desktop/**`), `tsconfig.parts.json` (`src/desktop/**`) e `tsconfig.client.json` (`src/client/**` e `src/contracts/**`); o `build` termina com `packages/bundle/dist/build/cli.js build` (`bundles/features/drawio/project.json:13-16`). O builder troca todo import relativo que cai em `src/contracts/**` pelo externo `drawio/contracts` (`packages/bundle/src/build/parts.ts:118-119`, `:168-175`), que é `src/contracts/index.ts`; por isso `index.ts` reexporta `./chat.js` (`bundles/features/drawio/src/contracts/index.ts:30`), e sem o reexporte o build falha nos imports de `../contracts/chat.js` do client e do desktopMain. O frame de medida é a exceção: ele empacota as fontes de contrato que importa (`parts.ts:168-169`), e por isso `frames/diagram/runtime.ts` importa valores só de `frame-constants.ts`, e dos contratos e de `frame-protocol.ts` só tipos; o `client/frames/diagram.js` construído não leva zod (`bundles/features/drawio/src/client/frames/diagram/runtime.ts:1-15`).

#### Manifesto

O manifesto da fase 4, como está em `bundles/features/drawio/manifest.json:1-21`: a fase 3 subiu `version` e `drawio.diagrams/v1` a 1.1.0, e a fase 4 os subiu a 1.2.0 ([Fases](#fases-e-critérios-de-aceitação)), com a `description` "Diagramas draw.io como artefatos da conversa: o tipo `diagram`, a tool `drawio_diagram`, o editor no modal de canvas e a exportação para o Project." `drawio.svg/v1` fica em 1.0.0 nas três fases; `package.json` fica em 0.0.1; o resto do manifesto não muda.

```json
{
  "manifestVersion": 1,
  "id": "drawio",
  "version": "1.2.0",
  "engines": { "doric": "^1.2.0" },
  "description": "Diagramas draw.io como artefatos da conversa: o tipo `diagram`, a tool `drawio_diagram`, o editor no modal de canvas e a exportação para o Project.",
  "provides": ["drawio.diagrams/v1@1.2.0", "drawio.svg/v1@1.0.0"],
  "requires": [
    "runtime.lease/v1@^1.1.0",
    "runtime.workspace/v1@^1.2.0",
    "artifacts/v1@^1.1.0",
    "artifact.kind/v1@^1.0.0",
    "comments/v1@^1.0.0",
    "tools/v1@^1.0.0",
    "ui/v1@^1.0.0"
  ],
  "optional": ["chat.composer/v1", "chat.send/v1", "runtime.threads/v1"],
  "desktopScope": {
    "drawio.diagrams/v1": ["projectId", "threadId", "promptId"]
  }
}
```

- `runtime.workspace/v1` dá a pasta atual da Thread (`cwd()`) para resolver `path`, como no `files` (`bundles/features/files/manifest.json:15`); sem ele em `requires`, `services.use` lança `undeclared_requirement` (`packages/bundle/src/runtime/services.ts:125-143`).
- `runtime.threads/v1` (opcional) é a fonte de `watchThread` para o `ThreadWatchSource` de `desktop/ui/canvas`.
- `src/contracts/index.ts` tem as cópias estruturais de `artifacts/v1`, `artifact.kind/v1`, `comments/v1`, `runtime.lease/v1`, `runtime.workspace/v1` (`cwd`) e `runtime.threads/v1` (`watchThread`).

#### Constantes

```ts
export const DIAGRAM_KIND = 'diagram';
export const DIAGRAM_BLOCK_TYPE = 'drawio.diagram/v1';
export const DIAGRAM_BODY_TAG = 'drawio-diagram';
export const DIAGRAM_ENTRY = 'diagram.drawio';
export const DRAWIO_DIAGRAM_TOOL = 'drawio_diagram';
export const DRAWIO_DIAGRAM_ORDER = 1750; // entre papercraft_preview (1700) e comment_reply (1800)
export const DRAWIO_COMMENT_KIND = 'drawio-diagram';
/** Onde a skill manda o agente escrever os rascunhos. */
export const DRAFTS_DIR = '.doric/artifacts/drafts';
/** O teto do XML de um diagrama, em bytes UTF-8; a única fonte desse valor. */
export const MAX_DIAGRAM_BYTES = 2_097_152;
/** O teto de um SVG, no cache e na exportação. */
export const MAX_SVG_BYTES = 8_388_608;
export const MAX_PAGES = 50;
/** O teto de células somando todas as páginas. */
export const MAX_CELLS = 5_000;
export const USER_CHANGE_NOTE = 'Editado pelo usuário';
/** Prazo de um pedido ao renderizador ou ao frame de medida: max(3 × 322 ms, 5 000) (Medidas). */
export const RENDER_TIMEOUT_MS = 5_000;
/** Prazo do editor do modal até `load`, e de cada pedido a ele: max(3 × 299 ms, 10 000) (Medidas). */
export const EDITOR_LOAD_TIMEOUT_MS = 10_000;
/** Intervalo da verificação de que o editor do modal responde. */
export const EDITOR_HEARTBEAT_MS = 10_000;
```

#### Declaração do tipo

`src/host/index.ts` registra, como o Papercraft faz (`bundles/features/papercraft/src/host/index.ts:17-37`), e devolve o `Disposable` do tipo na limpeza:

```ts
export const activate = async ({ services }: HostContext): Promise<Cleanup> => {
  services.provide(drawioDiagramsService);

  const kind = await services.use(ArtifactKindV1).register({
    id: DIAGRAM_KIND,
    title: 'Diagrama',
    blockType: DIAGRAM_BLOCK_TYPE,
    bodyTag: DIAGRAM_BODY_TAG,
    header: 'body',
  });

  services
    .use(ToolsV1)
    .register(tool, { alwaysAvailable: true, order: DRAWIO_DIAGRAM_ORDER });

  return () => {
    kind.dispose();
  };
};
```

Sem `payload` nem `materialize`: a tool e o serviço montam as entradas e os bytes, como `papercraft_preview` (`bundles/features/papercraft/src/host/tools/papercraft-preview.ts:215-258`).

#### Tool `drawio_diagram`

Descrição (texto que o modelo lê):

> Publish a draw.io diagram as a node of the conversation, where the user sees it, comments on its shapes and connectors, and can edit it. Write the diagram as an uncompressed draw.io file (`mxfile`) under `.doric/artifacts/drafts/` and pass its `path`, absolute or relative to the current directory. Without `artifact_id` it creates a diagram. With the `artifact_id` of an earlier diagram it publishes the next revision from your draft at `path`: pass `base_revision`, the revision your draft holds. With `checkout: true`, it writes the latest revision to a new file at `path` and publishes nothing: use it when you need the content of a revision you did not write, such as the user's own edit. When a revision newer than `base_revision` exists, the call is refused and lists the newer revisions, the user's edits among them: check out the latest, reapply the changes you still want there, and call again. Keep cell ids stable across revisions and never reuse an id for another element. It returns the revision, the pages and the unresolved comments with their anchors and replies. Answer each comment with `comment_reply`.

Entrada:

```ts
export const input = z
  .object({
    /** Ausente: diagrama novo. Presente: a revisão seguinte, ou o checkout, desse diagrama. */
    artifact_id: artifactIdSchema.optional(),
    /** Obrigatório com `artifact_id` sem `checkout`: a revisão que o rascunho tem. */
    base_revision: z.number().int().positive().optional(),
    /** Com `artifact_id`: grava a última revisão num arquivo novo em `path`. */
    checkout: z.boolean().optional(),
    /** Obrigatório ao criar; 1 a 120 caracteres. Uma revisão mantém o título. */
    title: z.string().min(1).max(120).optional(),
    /** O `.drawio`, absoluto ou relativo à pasta atual da Thread. */
    path: z.string().min(1).max(512),
    /** Nota de criação, ou nota de mudança da revisão; até 2000 caracteres. */
    notes: z.string().max(2000).optional(),
  })
  .strict();
```

Saída:

```ts
export const output = z
  .object({
    artifactId: z.string(),
    revision: z.number().int().positive(),
    revisions: z.number().int().positive(),
    title: z.string(),
    /** Só no checkout: o caminho absoluto do arquivo gravado. */
    checkout: z.string().optional(),
    pages: z.array(pageSummarySchema),
    /** As raízes não resolvidas, com as respostas, na ordem do log. */
    comments: z.array(pendingCommentSchema),
    warnings: z.array(z.string()).optional(),
  })
  .strict();

/** Uma página: o `id` e o `name` do `<diagram>` e o número de células dele. */
export const pageSummarySchema = z
  .object({ id: z.string(), name: z.string(), cells: z.number().int() })
  .strict();
export type PageSummary = z.output<typeof pageSummarySchema>;
```

`pendingCommentSchema` é o do Papercraft (`bundles/features/papercraft/src/host/tools/papercraft-preview.ts:93-115`). Execução, toda dentro de um `withLease` (sem lease: `unavailable` com "The Project has no sandbox lease (<estado>)." e `details.lease`, `bundles/features/drawio/src/host/tools/drawio-diagram.ts:443-449`):

1. Combinações, antes de qualquer leitura, todas `invalid_input` (`drawio-diagram.ts:150-178`): sem `artifact_id`, `base_revision` e `checkout` são recusados ("checkout and base_revision need artifact_id.") e `title` é obrigatório ("A new diagram needs a title."); com `checkout`, `base_revision`, `title` e `notes` são recusados ("checkout takes no base_revision, title or notes."); com `artifact_id` sem `checkout`, `base_revision` é obrigatório ("Pass base_revision: the revision your draft holds.").
2. Com `artifact_id`, `artifacts/v1.read({ artifactId })`, a última revisão L; ausente: `invalid_input` ("There is no diagram "<artifact_id>"; omit artifact_id to create one."); de outro tipo: `invalid_input` ("The artifact "<artifact_id>" is a "<kind>", not a diagram.").
3. `path` é resolvido como `write` resolve (`path.normalize(path.isAbsolute(p) ? p : path.join(cwd, p))`, `bundles/features/files/src/host/tools/write.ts:172-173`, com `cwd` de `runtime.workspace/v1.cwd()`). Fora da raiz do Project: `invalid_input` ("The path is outside the Project."). Dentro de `.doric/artifacts/<artifact_id>/`: `invalid_input` ("That is where the registry keeps this diagram's revisions; use checkout to get a copy.").
4. **Checkout**: se `sandbox.exec({ cmd: ['test', '-e', path] })` sai com 0 (um arquivo ou um diretório), `invalid_input` ("<path> exists; checkout writes only a new file."); `exec` está na cópia estrutural `LeasedSandbox` (`bundles/features/drawio/src/contracts/index.ts:717-732`). `sandbox.getFile` não serve para conferir existência nem tipo: no Docker, `getFile` de um diretório devolve o primeiro arquivo dentro dele (`packages/docker-sandbox/src/lib/provider.ts:415-418`). Senão grava o XML de L com `sandbox.writeFile(path, xml)`, que cria as pastas que faltam (`packages/sandbox/src/lib/sandbox.ts:182-197`), e segue para o passo 9 com `checkout` na saída; `pages` vem de `normalizeDiagram` do XML de L, e uma falha dela vira `pages: []` e o aviso "The pages of revision L could not be read: <motivo>" (`drawio-diagram.ts:290-334`). Sem os bytes de L na cópia de trabalho (`read` sem `base64`, `bundles/features/artifacts/src/contracts/index.ts:105-110`): `unavailable` ("The stored bytes of revision L are gone."). Nada é publicado.
5. **Leitura do rascunho** (`drawio-diagram.ts:190-214`): `sandbox.exec({ cmd: ['test', '-f', path] })`; se não sai com 0 (ausente, diretório ou outro tipo): `invalid_input` ("Cannot read <path>: not a regular file."). Depois `sandbox.getFile(path)`; se lança: `invalid_input` ("Cannot read <path>: <motivo>."). Os bytes passam por `new TextDecoder('utf-8', { fatal: true })`; texto inválido: `invalid_input` ("<path> is not valid UTF-8 text."), a recusa do passo 1 de [Validação e normalização](#validação-e-normalização) com a mensagem da tool.
6. Com `artifact_id`, a regra de base de [Revisões e base](#revisões-e-base).
7. Valida e normaliza. Recusa: `invalid_input` com o motivo; nada é publicado. `notes` igual a `USER_CHANGE_NOTE` também é recusado ("That note is reserved for the user's own edits."). Um XML normalizado igual ao da última revisão é recusado ("The diagram did not change since revision L.").
8. Entradas `[{ path: DIAGRAM_ENTRY, sha256 }]` e `files: [{ path: DIAGRAM_ENTRY, base64 }]`; `artifacts/v1.create({ kind: DIAGRAM_KIND, title, path, notes?, entries, files })` ou `revise({ artifactId, path, changeNote?: notes, entries, files })`. `targets` fica ausente.
9. Lê os comentários pendentes por `comments/v1.list({ target: { kind: 'artifact', id } })`, como o Papercraft (`bundles/features/papercraft/src/host/tools/papercraft-preview.ts:266-275`); falha vira o aviso "The comments could not be read: <motivo>".

`create` e `revise` correm dentro do mesmo `withLease`. Se o lease cai durante a chamada, `withLease` responde `unavailable` mesmo com a operação feita (`bundles/runtime/runtime/src/host/domain/service.ts:576-580`): a revisão fica gravada e a tool responde `unavailable`. Um agente que repete um `create` cria um segundo diagrama; um que repete um `revise` com a mesma base é recusado pela regra 3 de [Revisões e base](#revisões-e-base), que lista a revisão já gravada. É um risco aceito ([Riscos e mitigações](#riscos-e-mitigações)).

#### Revisões e base

O host não guarda arquivo nem estado do diagrama fora do registro, e nunca escreve num arquivo que existe. O agente revisa a partir do próprio rascunho: depois de publicar a revisão R, o rascunho em `path` tem R, e a chamada seguinte passa `base_revision: R`. Quando precisa do conteúdo de uma revisão que não escreveu, pede `checkout: true` com um `path` novo, lê o arquivo com `terminal` e o edita.

Regras da tool, com L a última revisão:

1. **Base igual a L**: publica a revisão L+1.
2. **Base maior que L**: `invalid_input` ("Revision B does not exist; the latest is L.").
3. **Base menor que L**: lê `artifacts/v1.revisions({ artifactId })` (`bundles/features/artifacts/src/contracts/index.ts:253-262`) e recusa com `invalid_input`, sem publicar: "Revision L is newer than your base_revision B. Newer revisions: 4 (the user's edit in the editor), 5 ("<changeNote>"). Check out revision L to a new path, reapply the changes you still want there, and call again with base_revision L." Uma revisão cuja `changeNote` é `USER_CHANGE_NOTE` aparece como "the user's edit in the editor"; as outras, com a nota delas, ou "(no note)".

A regra 3 é o aviso de D15: um salvar do usuário cria uma revisão mais nova que a base do agente, e a chamada seguinte da tool o lista, sem fila guardada. A revisão não guarda de que base o usuário partiu (D13); a mensagem diz quais revisões são do usuário, e o agente compara a última com o seu rascunho.

**XML igual**: com o XML normalizado igual ao da última revisão (o SHA-256 dele é o da entrada `diagram.drawio` de L), nenhuma revisão nova é gravada. A tool recusa com a mensagem do passo 7; `drawio.diagrams/v1.save` responde L.

#### Serviço `drawio.diagrams/v1` (host)

Chamado pela janela (`expose: 'desktop'`). `desktopScope` do manifesto só lista as chaves de escopo que a ponte aceita (`projectId`, `threadId`, `promptId`); quem as preenche é o modal, e `callScopeOf(scope)` passa só `projectId` e `threadId`. Sem `promptId`, o registro de artefatos cai no prompt que criou o artefato (R6).

```ts
export type DiagramRead =
  | {
      readonly status: 'ok';
      readonly xml: string;
      readonly revision: number;
      /** Quantas revisões o artefato tem agora. */
      readonly revisions: number;
    }
  /** O artefato, a revisão ou os bytes dela não existem. */
  | { readonly status: 'missing' }
  /** Sem lease: o estado que `withLease` respondeu. */
  | {
      readonly status: 'unleased';
      readonly lease: 'pending' | 'unavailable' | 'expired' | 'missing';
    };

export interface DrawioDiagrams {
  /** 1.0.0 (fase 2): o XML de uma revisão, distinguindo a falta de lease. */
  read(
    input: { readonly artifactId: string; readonly revision: number },
    call?: CallArg,
  ): Promise<DiagramRead>;
  /**
   * 1.1.0 (fase 3): grava o XML do editor como a revisão seguinte, com a nota
   * USER_CHANGE_NOTE, mesmo com uma revisão mais nova que a aberta (D15). Com o
   * XML normalizado igual ao da última revisão, não grava e responde a última.
   * `invalid_input` para XML recusado (antes do lease) e para um artefato que
   * não é diagrama; `not_found` para artefato desconhecido (O1); `unavailable`
   * com `details.lease` sem lease.
   */
  save(
    input: { readonly artifactId: string; readonly xml: string },
    call?: CallArg,
  ): Promise<{
    readonly revision: number;
    readonly revisions: number;
    /** SHA-256 hex da entrada da revisão (o XML normalizado): o `sha256` do bloco. */
    readonly sha256: string;
  }>;
  /**
   * 1.2.0 (fase 4): grava `<path>.drawio` (o XML normalizado da revisão) e
   * `<path>.drawio.svg` (o `svg` dado, uma exportação `xmlsvg`). Antes de
   * gravar, confere as pastas do caminho e os dois arquivos: uma entrada que a
   * exportação nunca substitui responde `blocked`, também com `overwrite`;
   * sem ela, um dos dois como arquivo regular e `overwrite` falso responde
   * `exists`. Nos dois casos nada é gravado.
   */
  export(
    input: {
      readonly artifactId: string;
      readonly revision: number;
      readonly path: string;
      readonly svg: string;
      readonly overwrite: boolean;
    },
    call?: CallArg,
  ): Promise<ExportResult>;
}

/** Caminhos relativos ao Project, como o `path` da entrada. */
export type ExportResult =
  /** Os dois gravados; `files` é `[<path>.drawio, <path>.drawio.svg]`. */
  | { readonly status: 'written'; readonly files: readonly string[] }
  /** `overwrite` falso; `files`: os que são arquivos regulares, na mesma ordem. */
  | { readonly status: 'exists'; readonly files: readonly string[] }
  /**
   * Uma entrada que a exportação nunca substitui: `path` é um dos dois
   * arquivos (`directory`: uma pasta; `special`: um link simbólico, um fifo,
   * um socket ou um dispositivo) ou um prefixo de pasta do caminho que existe
   * e não é pasta (`not-a-folder`).
   */
  | {
      readonly status: 'blocked';
      readonly path: string;
      readonly reason: 'directory' | 'special' | 'not-a-folder';
    };
```

- `read` roda `artifacts/v1.read({ artifactId, revision })` dentro de `runtime.lease/v1.withLease`. Um desfecho diferente de `ready` (`bundles/runtime/runtime/src/contracts/lease.ts:88-92`) vira `unleased` com o estado; `read` sem registro ou sem `base64` vira `missing`. É o que separa "sem lease" de "artefato ausente", que `artifacts/v1.read` sozinho responde igual (`bundles/features/artifacts/src/host/artifacts.ts:387-398`, `:630`).
- `save` passa o XML pela mesma [validação](#validação-e-normalização) da tool e chama `artifacts/v1.revise({ artifactId, changeNote: USER_CHANGE_NOTE, entries, files })` com a chamada da janela, cujo escopo tem só `projectId` e `threadId` (`callScopeOf`). Sem `promptId`, `eventScopeOf` grava `artifacts.revised/v1` sob o prompt que criou o artefato, não sob o do node que o usuário expandiu (`bundles/features/artifacts/src/host/artifacts.ts:297-325`); é o risco aceito R6. O evento entra no fim do log, e o projetor do chat só junta um evento à última vez se ela é do mesmo prompt (`bundles/desktop/chat/src/client/domain/projector.ts:650-653`): o node novo aparece no fim da conversa (D13).
- `save` grava mesmo com uma revisão do agente mais nova que a revisão aberta no editor (D15); a regra de XML igual é a da tool ([Revisões e base](#revisões-e-base)).
- `export.path`: relativo ao Project, não vazio, até 512 caracteres, sem `/` inicial, sem segmento vazio, `.` ou `..`, fora de `.doric/` (o primeiro segmento não pode ser `.doric`; `.doric-notes/x` passa) e sem terminar em `.drawio` ou `.drawio.svg` (Q2 da fase 4). O `svg` precisa ser texto SVG (começar por `<svg`, depois de espaços e de uma declaração XML opcional), ter o atributo `content` e no máximo `MAX_SVG_BYTES`; senão `invalid_input`. Essas regras são conferidas em `execute`, antes do lease, e não no schema zod (DV2, ver [Questões em aberto](#questões-em-aberto)). Depois `export` lê a revisão com `readRevision`, dentro do mesmo `withLease` da conferência e da gravação; `missing` vira `ContractError('not_found', 'Revision <n> of <artifactId> does not exist.')`.
- **Conferência antes de gravar.** `export` não confere existência com `sandbox.getFile`: no Docker, `getFile` de uma pasta devolve o primeiro arquivo regular dentro dela, e o de uma pasta vazia lança, como um arquivo ausente (`packages/docker-sandbox/src/lib/provider.ts:415-418`, `packages/docker-sandbox/src/lib/utils/tar.ts:45-73`). Ela usa `sandbox.exec({ cmd: ['test', <op>, <absoluto>] })`, como a tool (`bundles/features/drawio/src/host/tools/drawio-diagram.ts:195`, `:291`), com `<absoluto> = posix.join(sandbox.root, <relativo>)`. Saída 0 é sim e 1 é não; outra saída, `null` ou um `exec` que rejeita lança `ContractError('internal', 'Could not check <relativo>: <motivo>')`, sem gravar nada. Os passos, nessa ordem, param na primeira resposta:
  1. **Pastas.** Com `D = posix.dirname(path)` diferente de `.`: `test -d D`; saindo 0, as pastas existem. Senão, para cada prefixo de `D`, do primeiro segmento ao último: `test -d` 0 passa ao prefixo seguinte; senão, `test -e` ou `test -h` 0 responde `blocked` com esse prefixo e `not-a-folder` (um arquivo regular, um link quebrado ou outra entrada no lugar de uma pasta); senão o prefixo não existe, e ele e os seguintes ficam para `writeFile` criar. Um link para uma pasta conta como pasta, como no `mkdir -p` de `writeFile`.
  2. **Os dois arquivos**, `<path>.drawio` e depois `<path>.drawio.svg`, cada um com `test -h`, `test -d`, `test -f` e `test -e`, nessa ordem, até o primeiro 0: `-h` é `blocked` com `special` (um link, mesmo para um arquivo regular: a exportação só substitui arquivos regulares); `-d` é `blocked` com `directory`, vazia ou não; `-f` é arquivo regular; `-e` é `blocked` com `special` (fifo, socket, dispositivo); nenhum 0 é ausente. O primeiro `blocked` responde, sem conferir o segundo arquivo.
  3. Com algum dos dois como arquivo regular e `overwrite` falso: `exists`, com os que existem. Senão grava; com `overwrite` verdadeiro, a gravação substitui os arquivos regulares.

  A pasta nunca é substituída porque o provedor Docker grava com `putArchive` sem `noOverwriteDirNonDir` (`packages/docker-sandbox/src/lib/provider.ts:407-414`, `packages/docker-sandbox/src/lib/docker.ts:323-330`), e o Docker Engine, sem essa opção, apaga o que está no caminho, também uma pasta com o conteúdo, antes de extrair o arquivo ([`moby/go-archive`, `archive.go`](https://github.com/moby/go-archive/blob/main/archive.go), `NoOverwriteDirNonDir`). O caso comum, nada no caminho e a pasta existente, faz 9 chamadas de `exec`: uma para a pasta e quatro por arquivo.

- `export` grava com `sandbox.writeFile`, que roda `mkdir -p` da pasta e depois grava o arquivo (`packages/sandbox/src/lib/sandbox.ts:182-197`): primeiro `<path>.drawio`, depois `<path>.drawio.svg`. As pastas que faltam são criadas pelo `mkdir -p` da primeira gravação; um prefixo que deixou de ser pasta depois do passo 1 faz o `mkdir -p` sair diferente de 0, e `writeFile` lança (`packages/sandbox/src/lib/sandbox.ts:199-209`). Se a primeira gravação lança, nada foi gravado, e `export` lança `ContractError('internal', 'Could not write <arquivo>: <motivo>')`. Se a segunda lança, `export` apaga a primeira com `sandbox.exec({ cmd: ['rm', '-f', '--', <absoluto do primeiro>] })` e lança o mesmo erro; uma falha do `rm` é engolida (Q4 da fase 4); ficam só as pastas que o `mkdir -p` criou, vazias. Com `overwrite`, o `.drawio` anterior já foi substituído e não volta.
- A cópia estrutural `LeasedSandbox` (`bundles/features/drawio/src/contracts/index.ts:717-732`) já tinha o `exec` com `cmd` e `exitCode` que a exportação usa; a fase 4 só trocou o comentário dele (`:724-729`), que nomeava só `test -f` e `test -e`, por: "Runs one command without a shell. This bundle runs `test -f`, `-e`, `-d` or `-h <path>`, and `rm -f -- <path>`. The tool reads exit code 0 as yes and any other code, or `null`, as no; `export` reads 0 as yes, 1 as no, and any other code, or `null`, as a failed check." Nenhum método novo.
- Todo acesso ao sandbox passa por `runtime.lease/v1.withLease`; em `save` e `export`, um estado diferente de `ready` vira `ContractError('unavailable', …, { lease: status })` (a função `leasedValue`, comum aos dois), a forma do store dos artefatos (`bundles/features/artifacts/src/host/store.ts:184-197`).

#### Serviço `drawio.svg/v1` (desktopMain)

Chamado pela janela (`expose: 'desktop'`), como `papercraft.snapshot/v1`. É só o cache das páginas desenhadas e medidas e do ponteiro para a primeira página de cada revisão (D27); quem desenha é o [renderizador](#renderizador-client), e quem mede é o [frame de medida](#frame-de-medida). Nenhum método precisa de lease. Os tipos estão em `bundles/features/drawio/src/contracts/index.ts:393-605`:

```ts
export interface DrawioSvg {
  /** `doric.drawio/v1.describe`, repassado; responde `available: false` sem rejeitar. */
  status(call?: CallArg): Promise<DrawioDescription>;
  /**
   * Com `pageId`, a entrada dessa página. Sem ele, a página que o ponteiro da
   * revisão nomeia, e a entrada dela no `theme` pedido. Null se o ponteiro ou
   * um arquivo da entrada falta, não lê ou não passa no schema.
   */
  get(input: DiagramSvgLookup, call?: CallArg): Promise<DiagramSvgPage | null>;
  /** Guarda o SVG e o layout; com `first`, grava depois o ponteiro da revisão. */
  put(input: DiagramSvgPut, call?: CallArg): Promise<void>;
}

/** Os bytes de uma revisão, como o cache os chaveia. */
export interface DiagramSvgRevision {
  readonly artifactId: string;
  readonly revision: number;
  /** O SHA-256 da entrada `diagram.drawio` da revisão: 64 dígitos hexadecimais minúsculos. */
  readonly sha256: string;
}

export interface DiagramSvgKey extends DiagramSvgRevision {
  /** De 1 a 128 caracteres, qualquer caractere. */
  readonly pageId: string;
  readonly theme: 'light' | 'dark';
}

/** A chave com `pageId` opcional: sem ele, a primeira página da revisão. */
export interface DiagramSvgLookup extends DiagramSvgRevision {
  readonly pageId?: string;
  readonly theme: 'light' | 'dark';
}

export interface DiagramSvgEntry {
  readonly svg: string;
  readonly layout: DiagramLayout;
}

/** O que `get` responde: a entrada e a página dela, a pedida ou a do ponteiro. */
export interface DiagramSvgPage extends DiagramSvgEntry {
  readonly pageId: string;
}

export interface DiagramSvgPut extends DiagramSvgKey, DiagramSvgEntry {
  /** A página é o primeiro `<diagram>` da revisão: o `put` grava também o ponteiro. */
  readonly first?: true;
}

/** O layout de uma página, em px de conteúdo (escala 1 do SVG). */
export interface DiagramLayout {
  readonly width: number;
  readonly height: number;
  /** Uma caixa por elemento com `data-cell-id`, na ordem do documento. */
  readonly cells: readonly {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }[];
}
```

- Os arquivos são `<doric.cache/v1.directory()>/svg/<artifactId>@<revision>/<sha256>/<encodeURIComponent(pageId)>.<theme>.svg` e, ao lado, `….<theme>.layout.json`: um par por página, cada um desenhado a partir do `mxfile` só com aquela página (D22). No mesmo diretório, `first-page.json` (`{ "pageId": … }`, `diagramFirstPageSchema`) é o ponteiro da revisão: um por artefato, revisão e `sha256`, para os dois temas, porque a primeira página não depende do tema; ele não colide com uma entrada, que sempre termina em `.<theme>.svg` ou `.<theme>.layout.json` (`bundles/features/drawio/src/desktop/svg-cache.ts:1-10`). `artifactId` segue `artifactIdSchema`; `sha256` tem 64 dígitos hexadecimais minúsculos; `pageId` de 1 a 128 caracteres; senão `invalid_input`, na ponte, também para um `get` fora do schema.
- `put` aceita só SVG que começa por `<svg` (depois de espaços e de uma declaração XML opcional), até `MAX_SVG_BYTES`, layout com números finitos não negativos, `id` de célula não vazio e até `MAX_CELLS` caixas, e `first` só como `true`. Grava o layout, depois o SVG e, com `first`, por último o ponteiro, cada um num arquivo temporário do mesmo diretório renomeado, como o cache dos artefatos (`bundles/features/artifacts/src/desktop/cache.ts:5`, `:166`); por isso um ponteiro lido sempre nomeia uma página cuja entrada foi gravada em pelo menos um tema (`svg-cache.ts:228-266`). Um `put` com `first` de outra página troca o ponteiro.
- `get` sem `pageId` lê o ponteiro e depois a entrada da página dele no tema pedido; com `pageId`, a entrada dessa página. A resposta traz o `pageId` resolvido. Responde `null` se o ponteiro falta, não lê, não é JSON ou não passa no schema, ou se um dos dois arquivos da entrada falta, não lê ou não passa no schema (`svg-cache.ts:183-227`).
- O client só chama `put` depois de conferir que o SHA-256 dos bytes de `diagram.drawio` que leu é o `sha256` da entrada da revisão.
- Sem despejo na v1. O diretório de `doric.cache/v1` não tem teto, como o cache dos artefatos (`bundles/features/artifacts/src/desktop/cache.ts`) e o da plataforma (`app/desktop/doric/src/platform/native/cache.ts`); um teto é da plataforma ([Riscos e mitigações](#riscos-e-mitigações)).

#### Renderizador (client)

`src/client/renderer.ts`, um por janela (estado do módulo):

```ts
export interface RenderRequest {
  /** `mxfile` normalizado, como está na revisão, com todas as páginas. */
  readonly xml: string;
  /** A página; ausente, a primeira. */
  readonly pageId?: string;
  readonly theme: 'light' | 'dark';
  /** `svg`: imagem com `data-cell-id`; `xmlsvg`: imagem com o diagrama dentro. */
  readonly format: 'svg' | 'xmlsvg';
}

/** Rejeita com `RenderError('invalid-xml' | 'unavailable')`. */
export const renderDiagram: (request: RenderRequest) => Promise<string>;

/**
 * Em `src/client/single-page.ts`, um módulo sem imports, com `RenderError`;
 * `renderer.ts` reexporta os dois, e o e2e empacota o módulo sozinho.
 * O `mxfile` só com a página `pageId` (ausente, a primeira): os atributos do
 * `<mxfile>` de origem menos `pages`, e o `<diagram>` da página copiado inteiro,
 * com o mesmo `id`, o mesmo `name` e o mesmo `mxGraphModel`. Lança
 * `RenderError('invalid-xml')` se a página não existe.
 */
export const singlePageOf: (xml: string, pageId?: string) => string;
```

- No primeiro pedido, põe no `document.body` um iframe oculto (`aria-hidden="true"`, `tabindex="-1"`, `sandbox="allow-scripts allow-same-origin"`, fora da tela com `visibility: hidden`, nunca `display: none`) com `${DRAWIO_ORIGIN}/index.html?embed=1&proto=json&configure=1&stealth=1&lockdown=1&pwa=0&noSaveBtn=1&noExitBtn=1&saveAndExit=0&spin=0&dark=<0 ou 1>`, e cria `new DrawioClient(iframe, { url, config: { compressXml: false }, requestTimeout: RENDER_TIMEOUT_MS })` (`config` só com `compressXml`, sem o `suppressNewWindows` do editor do modal; `bundles/features/drawio/src/client/renderer.ts:164-168`), sem `onInit`: a cada `init` a biblioteca carrega um diagrama vazio ([client.ts#L440-L459](https://github.com/jgraph/drawio-react/blob/main/src/client.ts#L440-L459)).
- **Uma página por pedido (D22).** No draw.io 32.6.1 a ação `export` em SVG ignora `pageId` e desenha sempre a página atual; só a exportação PNG lê `pageId` (`webapp/js/app.min.js`, achado da fase 0, [A3](#a3-cada-célula-tem-data-cell-id-no-svg)). Por isso o renderizador nunca passa `pageId` ao editor: cada pedido é uma ação só, `export({ xml: singlePageOf(request.xml, request.pageId), format, keepTheme: false, embedImages: true, embedFonts: false })`, que carrega o XML e exporta ([protocol.ts#L277-L300](https://github.com/jgraph/drawio-react/blob/main/src/protocol.ts#L277-L300)). Com uma página só, a página atual é a pedida.
- `singlePageOf` faz o parse com o `DOMParser` do client (`application/xml`) e serializa com `XMLSerializer`; o XML da revisão já está sem compressão ([Validação e normalização](#validação-e-normalização), passo 8), e o `id` de página é único e sem `/` (passo 5).
- O renderizador não usa `merge`: a fase 0 mostrou que um `merge` com o mesmo `id` de página troca as células dessa página, e cada pedido carrega o seu `mxfile` inteiro.
- **As células continuam as da página original.** O `<diagram>` vai copiado sem mudança, então os `id` das células, e com eles os `data-cell-id` do SVG, são os da página na revisão. Os `id` são únicos na página (passo 7 da validação), e o layout medido nesse SVG é guardado com a chave da página (`pageId` em `DiagramSvgKey`): uma caixa do layout da página P é sempre a célula de mesmo `id` na página P.
- Os pedidos formam uma fila serial; o tema vai no parâmetro `dark` da URL do iframe, e um pedido de outro tema recria o iframe. O resultado é o texto do SVG decodificado do data URI.
- `DrawioError` `editor` ou `invalid`: `invalid-xml`. `timeout` ou `restarted`, ou o iframe que não carrega: `unavailable`; o iframe é removido e o pedido seguinte cria outro. Um processo que caiu aparece como `timeout`, porque a biblioteca só lança `closed` depois de `close()`.
- `RENDER_TIMEOUT_MS` é 5 000: o triplo do p95 medido do primeiro `export` a frio (322 ms × 3 = 966 ms) fica abaixo do piso de 5 000 ([Medidas](#medidas)).
- O iframe é removido depois de 60 s sem pedidos.

#### Âncora

Uma célula:

```ts
{
  form: 'selector',
  selector: `page/${pageId}/cell/${cellId}`,
  label: string,        // texto da célula, espaços colapsados, até 200 caracteres; '' sem texto
  x: number, y: number, // centro da caixa da célula no SVG da revisão, px de conteúdo
  cellKind: 'vertex' | 'edge',
  index: number,        // ordem da célula entre as de mesmo rótulo e tipo na página, desde 0
}
```

Um ponto livre também é `form: 'selector'`, porque o envelope não mostra a página de uma âncora `point` (`bundles/desktop/chat/src/client/domain/prompt-envelope.ts:103-108`):

```ts
{
  form: 'selector',
  selector: `page/${pageId}/point/${Math.round(x)},${Math.round(y)}`,
  label: string, // rótulo da célula de centro mais perto; '' sem células
  x: number, y: number, // o ponto, px de conteúdo
}
```

O agente vê `anchor="page/<p>/point/<x>,<y>" element="<rótulo mais perto>"`; a skill explica a forma. As duas cabem no schema de hoje, que aceita chaves extras (`bundles/features/comments/src/contracts/index.ts:198-221`). O alvo do comentário é `{ kind: 'artifact', id: artifactId, revision, anchor }`.

A página, a célula e o ponto são lidos do `selector`: a página é o trecho entre `page/` e a barra seguinte (a validação recusa `id` de página com `/`); depois dela, `/cell/` e o `id` da célula até o fim, ou `/point/` e `x,y`.

Rótulo de uma célula: o atributo `label` do `<object>`/`<UserObject>` que a embrulha, senão o `value` do `mxCell`; HTML é reduzido a texto (sem tags, entidades decodificadas), espaços colapsados.

O `CanvasHitTester` do diagrama, sobre as caixas do layout: `targetAt` devolve, entre as células cuja caixa contém o ponto, a de menor área, e no empate a última na ordem do documento, nos dois modos; sem célula, nada. `anchorAt` monta a âncora da célula, com o centro da caixa; sem célula, a âncora de ponto livre, com o rótulo da célula de centro mais perto.

Re-ancoragem numa revisão R, sempre na página da âncora e só quando ela é a página na tela (D24): uma âncora de outra página de R, ou de uma página ausente em R, é um pino solto, empilhado na borda esquerda (`placeAnchor`, `bundles/features/drawio/src/client/anchor.ts:254-326`). No node, a página na tela é a primeira; no modal, a escolhida.

1. célula com o `id` da âncora e mesmo `cellKind`: o pino vai a ela; se o rótulo atual difere de `label`, o pino ganha o estado visual **célula alterada** (D25): `ChangedCells`, de `bundles/features/drawio/src/client/diagram-view.tsx:638-715`, desenha um contorno tracejado sobre a caixa da célula, sem eventos de ponteiro, com o título "A célula mudou desde o comentário" e `data-testid="drawio-cell-changed"`, um por célula; `desktop/ui/canvas` não muda;
2. senão, células do mesmo `cellKind` e `label` igual: a de mesma posição `index` entre elas, senão a de centro mais perto de `x`, `y`;
3. senão, pino solto no ponto `x`, `y` da página; fora da página na tela, empilhado na borda esquerda, como o Papercraft faz (`docs/architecture/bundles/papercraft/README.md:272`).

Uma âncora de ponto livre vai sempre ao seu ponto `x`, `y` na página dela, ou à borda esquerda fora dela. Sem o modelo da revisão (sem lease), uma âncora de célula vai ao centro da caixa do layout com o `id` dela, senão ao ponto `x`, `y`, nunca marcada como alterada.

#### Tipo de comentário e flush

Itens da pilha com `kind: DRAWIO_COMMENT_KIND`, `elementTag: 'chat-comment-line'` (`bundles/features/papercraft/src/contracts/chat.ts:96`) e `data: { target, pin, inReplyTo?, refs: { title, source: 'diagram.drawio' }, point }`: `target` é o alvo do comentário (acima), `pin` o número do pino que o fluxo de comentário deu, `inReplyTo` a raiz que uma resposta responde, `refs` o que a linha da pilha mostra (o título do diagrama e a entrada), e `point` o ponto de conteúdo do clique, onde o pino de um rascunho fica até ele ter âncora resolvida. O client implementa `CommentStore` em `src/client/comment.ts`, no molde de `bundles/features/papercraft/src/client/comment.ts:198-302`. A parte desktopMain registra o flush por `chat.composer/v1.registerFlush`, igual ao do Papercraft (`bundles/features/papercraft/src/desktop/comment-flush.ts:40-58`): item sem nota ou sem alvo fica na pilha; senão um `comments/v1.add` com `commentId = item.id`.

O flush é copiado, não compartilhado: cada tipo de item tem um dono só ("a second is a conflict", `bundles/features/papercraft/src/contracts/chat.ts:249-250`), e um tipo genérico de comentário de artefato precisaria de um dono novo — o `artifacts`, que não depende de `chat.composer/v1` (`bundles/features/artifacts/manifest.json:17-26`) — e da migração do tipo `papercraft-preview`, que filtra os itens pelo próprio tipo (`bundles/features/papercraft/src/client/comment.ts:161`). A cópia são cerca de 20 linhas de lógica.

#### Skill `drawio-diagram`

`src/skills/drawio-diagram/SKILL.md`, front matter:

```yaml
name: drawio-diagram
description: 'Publishes a draw.io diagram as a node of the conversation, where the user comments on shapes and connectors and can edit it. Use when the user asks for a diagram, or for an architecture, a flow, a sequence or a data model.'
allowed-tools:
  - drawio_diagram
  - comment_reply
  - write
  - edit
  - terminal
order: 3410
```

Corpo, em regras:

- quando usar: o usuário pediu um diagrama, ou a resposta é uma arquitetura, um fluxo, uma sequência ou um modelo de dados; ajuste de um diagrama existente é revisão (`artifact_id`), não diagrama novo;
- o formato: `mxfile` sem compressão, uma `<diagram>` por página com `id` e `name`, células com geometria (`mxGeometry`) e conectores com `source` e `target`; rótulos em texto simples;
- âncoras: manter os `id` entre revisões; nunca reusar um `id` para outro elemento; elemento novo, `id` novo;
- fluxo: para criar, escrever o rascunho em `.doric/artifacts/drafts/<nome>.drawio` e passar `title` e `path`; para revisar, editar o mesmo rascunho e passar `artifact_id`, `base_revision` (a revisão que a última saída deu) e `path`; numa recusa por revisão mais nova, chamar com `checkout: true` e um `path` novo, ler o arquivo com `terminal` (`cat`), reaplicar nele o que ainda vale e publicar a partir dele;
- âncoras no envelope: `page/<p>/cell/<id>` é uma célula; `page/<p>/point/<x>,<y>` é um ponto livre da página, e `element` é a célula mais perto;
- comentários: responder cada um com `comment_reply` e resolvê-lo depois de publicar a revisão que faz o que ele pede;
- não há aprovação de diagramas: publicar e seguir.

### Bundle `papercraft` 2.0.0

- `provides` perde `papercraft.open-canvas/v1@1.0.0`; `requires` perde `windows/v1@^1.0.0` (usado só por `openCanvas`, `bundles/features/papercraft/src/desktop/commands.ts:34`), `navigation/v1@^1.0.0` (usado só pela rota, `bundles/features/papercraft/src/client/index.ts:62-66`) e `menus/v1@^1.0.0` (usado só pelas teclas da rota, `:78-85`); o snapshot usa `doric.windows/v1`, que é de plataforma (`bundles/features/papercraft/src/desktop/snapshot.ts:47-52`). A versão vai a 2.0.0 porque um contrato fornecido some (`docs/architecture/bundles/versioning.md:53`).
- Saem: `CANVAS_ROUTE`, `canvasPathOf`, `OPEN_CANVAS_COMMAND` e `PAPERCRAFT_CANVAS_TAG` dos contratos; o elemento `<papercraft-canvas>` (`bundles/features/papercraft/src/client/elements.tsx:115-151`, `:156`); `src/desktop/commands.ts`; o registro da rota e das teclas por `menus/v1` (`bundles/features/papercraft/src/client/index.ts:62-85`); `openCanvas` de `useCommandDispatch` (`bundles/features/papercraft/src/client/surface/controller.ts:154-176`) e o seu uso em `preview-container.tsx:280`, `:530`; o valor `'window'` de `CanvasHeader.host`. A classe CSS `papercraft-canvas` da superfície (`preview-container.tsx:550`, `styles.css:61-63`) fica: ela não é a janela.
- Ficam: `papercraft.send/v1` e o botão `Enviar ao agente (n)` no cabeçalho do modal, porque o prompt fica atrás do modal (D20); os comandos da barra, despachados por `commands/v1.execute` a partir do `keydown` do modal (S9), com as teclas de `PAPERCRAFT_KEYBINDINGS` (`bundles/features/papercraft/src/contracts/index.ts:593`).
- O botão `abrir` do cabeçalho do node vira `expandir` (ícone `Maximize2`, rótulo "Expandir") e abre o `CanvasModal` com a superfície em `chrome: 'canvas'`, chave de frame vivo `undefined` (sempre vivo, fora do teto de 3) e `CanvasHeader host="modal"`.
- O fechamento do modal do preview não pede confirmação: o rascunho de comentário em aberto já entra na pilha como hoje.

### Fluxos

#### O agente publica

```text
agente ──write──▶ .doric/artifacts/drafts/x.drawio
agente ──drawio_diagram{title,path}──▶ host: lê (lease), valida, normaliza
host ──artifacts/v1.create(kind diagram, entries, files)──▶ .doric/artifacts/<id>/1/diagram.drawio
                                                           log: artifacts.created/v1
host ◀──comments/v1.list── pendentes ──▶ saída da tool
agente ──edit do rascunho──▶ drawio_diagram{artifact_id, base_revision, path}
agente ──(recusa por base)──▶ drawio_diagram{artifact_id, checkout, path novo} ──▶ terminal cat
```

#### O node mostra a revisão

1. A moldura cria `<drawio-diagram>` com `block` (`bundles/features/artifacts/src/contracts/index.ts:360-367`); o bloco já traz as entradas da revisão com o `sha256` de `diagram.drawio` (`bundles/features/artifacts/src/client/elements.ts:193`).
2. O elemento pede `drawio.svg/v1.get({ artifactId, revision, sha256, theme })`, sem `pageId`, com `artifactId`, `revision` e `sha256` do bloco e o tema do app: o cache acha a primeira página (D18) pelo ponteiro da revisão (D27). Isso não precisa de lease, também depois de reiniciar o app. A resposta traz o `pageId` da página, que é a página na tela.
3. Em paralelo com o passo 2, o elemento lê a revisão por `drawio.diagrams/v1.read({ artifactId, revision })`, que precisa de lease, e confere que o SHA-256 dos bytes de `diagram.drawio` é o do bloco; `missing` mostra "O diagrama não pôde ser lido", e um SHA-256 diferente também.
4. `model.ts` lê páginas, células, tipos e rótulos (DOMParser do client); um modelo sem página também mostra "O diagrama não pôde ser lido".
5. Sem SVG guardado no passo 2: `drawio.svg/v1.status()`; com `available: false`, o node mostra a falha de desenho, com `Tentar de novo`. Senão `drawPage` (`bundles/features/drawio/src/client/drawing.ts:63-103`): `renderDiagram({ xml, pageId, theme, format: 'svg' })` com `pageId = model.pages[0].id`, que exporta o `mxfile` só com essa página (D22), `measureDiagram(svg)` e `drawio.svg/v1.put` dos dois resultados com a chave dessa página e `first: true`, que grava o ponteiro. O `put` não é esperado, e uma falha dele é ignorada: a página é desenhada de novo na montagem seguinte. Os passos 2 a 5 estão em `useDiagramData` (`bundles/features/drawio/src/client/diagram-data.ts:124-151`).
6. Mostra o SVG num `<img src="data:image/svg+xml;base64,…">` de `width` × `height` do layout, dentro do `Viewport` de `desktop/ui/canvas`; o enquadramento recebe `content = { x: 0, y: 0, width, height }`.
7. Lê os comentários do artefato (`comments/v1.list`) e a pilha (`chat.composer/v1`) e coloca os pinos pela re-ancoragem, sobre as caixas do layout.

Enquanto não há SVG, o node mostra o placeholder: título, `rev N`, "N páginas · M células" (sem a revisão lida, só título e `rev N`) e um indicador de carregamento; `Comentar` fica desabilitado. Se o desenho ou a medida falham, ou `status()` responde `available: false`, o placeholder troca o indicador pela linha "O diagrama não pôde ser desenhado" e um botão `Tentar de novo`, que recomeça do passo 2.

Com o SVG na tela e mais de uma página no modelo, o node mostra `pág 1/N` (D18) num rótulo `drawio-page` sob a faixa do cabeçalho; `CanvasHeader` não tem prop de página (`bundles/features/drawio/src/client/diagram-view.tsx:447-453`, `:506-513`). `expandir` fica habilitado quando a revisão foi lida e desenhada: modelo lido, SVG na tela e nenhuma falha; não precisa de Thread, porque ver não comenta, e `Comentar` continua exigindo a Thread e `chat.composer/v1` (`bundles/features/drawio/src/client/diagram-node.tsx:60-68`).

Sem lease, o passo 3 responde `unleased`. Com o SVG e o layout do passo 2, o node mostra o SVG e põe cada pino na caixa do layout com o `id` da célula da âncora, senão no ponto `x`, `y` gravado, com `Comentar` e `expandir` desabilitados e a linha "O Project está sem sandbox ativo"; sem SVG, o placeholder mostra a mesma linha e `Tentar de novo`.

Trocar o tema do app troca o `<img>` de cada node montado pelo SVG do outro tema, desenhando e medindo os que faltam no cache.

#### Frame de medida

Entrada do frame: `doric://app/bundles/drawio@<versão do bundle>/client/frames/diagram.js`. Mensagens por `MessageChannel`, validadas com zod no app (`src/client/frame-protocol.ts`, versão 1):

| Sentido     | Mensagem                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------- |
| app → frame | `{ type: 'render', version: 1, svg: string, theme: 'light' \| 'dark' }`                           |
| frame → app | `{ type: 'ready', version: 1 }`                                                                   |
| frame → app | `{ type: 'rendered', width, height, cells: [{ id, x, y, width, height }] }` (px do SVG, escala 1) |
| frame → app | `{ type: 'error', message }`, com `message` de até `FRAME_ERROR_LIMIT` (4096) caracteres          |

O frame só mede; ninguém o vê. Ele faz o parse do SVG com `DOMParser` (`image/svg+xml`) e o limpa com `sanitizeSvg` (D26, `bundles/features/drawio/src/client/frames/diagram/runtime.ts:20-83`): remove, em qualquer profundidade, `<script>`, `<iframe>`, `<object>` e `<embed>`; todo `<foreignObject>` que contém `img`, `video`, `audio`, `canvas`, `input`, `textarea`, `select`, `button`, `form`, `link` ou `meta`, e mantém o que só tem marcação de texto XHTML (`div`, `span`, `br`, `b`, …, com texto e `style`); todo atributo `on*`; e todo `href`/`xlink:href` que não comece por `#` ou `data:image/`. Depois insere o resultado no `<body>` e mede, com `measureSvg`, cada elemento com `data-cell-id` não vazio por `getBoundingClientRect`, relativo ao `<svg>`, na ordem do documento; um número não finito ou negativo vira 0 (`runtime.ts:85-114`).

O app valida cada mensagem com `frameMessageSchema` (`bundles/features/drawio/src/client/frame-protocol.ts:71-96`); um `error` com mais de `FRAME_ERROR_LIMIT` caracteres não passa, como no Papercraft, e o frame corta as suas mensagens nesse limite. `FRAME_ERROR_LIMIT` e `DIAGRAM_FRAME_PROTOCOL` ficam em `src/client/frame-constants.ts`, fora de `frame-protocol.ts`, porque o frame que importasse um valor de `frame-protocol.ts` levaria zod e os contratos junto ([Estrutura](#estrutura)).

A limpeza é uma lista do que sai, não do que fica: a barreira é o CSP do frame (`default-src 'none'`, `script-src` só com `doric://app` e o hash do import map, `connect-src 'none'`, `app/desktop/doric/src/platform/protocol/csp.ts:47-58`), que não executa script do SVG nem deixa o frame chamar a rede. O teste de hoje compara o cabeçalho inteiro com a política esperada (`app/desktop/doric/tests/protocol.test.ts:83-84`, `:486`): afrouxar `frameCsp` já o quebra.

#### O modal do diagrama

O botão `expandir` do node abre o `CanvasModal` sobre a janela, na revisão do node. Conteúdo:

- `CanvasHeader host="modal"`, desenhado por `DiagramCanvas`: título, `rev N` e `Enviar ao agente (n)` quando há rascunhos (chama `chat.send/v1.send`); o botão fechar é do `CanvasModal` (`packages/desktop/src/canvas/modal.tsx:120-127`). `CanvasHeader` não tem prop de página: `pág P/N`, com mais de uma página, é o rótulo `drawio-page` do `drawio` sob a faixa do cabeçalho, como no node, e o texto do botão do menu de página;
- a área do canvas: em **Revisar**, a mesma visão do node (`DiagramCanvas`, o `<img>` e os pinos), na página e na revisão escolhidas (D18); os pinos ancorados em páginas fora da tela são soltos (D24); em **Editar**, o iframe do editor;
- `CanvasToolbar` no centro inferior. Em **Revisar**: ferramenta (Selecionar `V`, Comentar `C`, Mão `H`), vista (menos `CmdOrCtrl+-`, zoom, mais `CmdOrCtrl+=`, 100% `CmdOrCtrl+0`, Ajustar `Shift+1`), página (menu, com mais de uma), revisão (menu `rev n/N`, com mais de uma), `Editar` (`E`, fase 3) e `Salvar no Project` (fase 4). Em **Editar**: `Salvar` (`CmdOrCtrl+S`, desabilitado em `carregando` e `editando`, sem mudança) e `Concluir edição`.

Em **Revisar** (`bundles/features/drawio/src/client/diagram-modal.tsx:369`, `DiagramReview`):

- O menu de revisão lê `artifacts/v1.revisions({ artifactId })` uma vez por abertura do modal; uma rejeição ou uma lista vazia deixa só a revisão do node, sem menu. Trocar de revisão mostra a página 1 dela. Cada abertura começa na revisão do node, página 1.
- A página escolhida passa a `useDiagramData` como `pageId`: `drawio.svg/v1.get` com esse `pageId` e, sem cache, `drawPage` dela, com `first: true` só para `model.pages[0].id`; trocar de página não lê a revisão de novo (`bundles/features/drawio/src/client/diagram-data.ts:113-122`).
- As teclas vêm do `onKeyDown` do `CanvasModal`, nunca de um campo de texto (S9): `C`, `Esc` e espaço ficam com o canvas, e as outras passam por `reviewKeyOf` (`diagram-modal.tsx:1803-1838`): `V` e `H` sem modificador; `CmdOrCtrl` com `=` ou `+`, e também `CmdOrCtrl+Shift` com `+`, porque `+` pede Shift no teclado US, aumentam o zoom; `CmdOrCtrl+-` diminui; `CmdOrCtrl+0` volta a 100%; `Shift+1` ajusta. Com `Alt`, ou com Meta e Ctrl juntos, nada.
- O node e o modal do diagrama não respondem a `doric:comment-thread-open` na fase 2; abrir a thread de um comentário do diagrama por esse evento fica para depois.

**Onde fica cada parte** (fase 2, em `bundles/features/drawio/src/client/`): o node e o estado `'closed' | 'open' | 'closing'` do modal em `diagram-node.tsx` (`DiagramNode`, `diagram-node.tsx:34-40`); a visão de **Revisar**, a mesma no node e no modal, em `diagram-view.tsx` (`DiagramCanvas`, `diagram-view.tsx:228`, e `DiagramCanvasControls`, o que a barra e as teclas comandam, `:155-171`); o modal em `diagram-modal.tsx` (`DiagramModal`, `diagram-modal.tsx:126`, `ReviewToolbar`, `:1573`, `reviewKeyOf`, `:1803-1838`, e `revisionBlockOf`, `:1885-1907`); a leitura em `diagram-data.ts` (`useDiagramData`, `diagram-data.ts:124-151`). `elements.tsx` só define `<drawio-diagram>` e monta `DiagramNode` (`elements.tsx:129-189`). A fase 3 muda:

- `diagram-modal.tsx`: a máquina de estados, **Editar** e o diálogo de saída. `DiagramModal` só chama o `onCloseRequest` do node quando a máquina chega a `fechado` (linhas 6, 13, 24 e 30, e D2 com o destino `fechado`); os pedidos de fechar das linhas 15 e 26 ficam no modal, e `diagram-node.tsx` não muda. `ReviewKey` ganha `'edit'`, que `reviewKeyOf` dá para `E` sem modificador, em qualquer caixa, e `ReviewToolbar` ganha `Editar`. Em **Editar**, `reviewKeyOf` não vale; o `onKeyDown` do `CanvasModal` só trata `CmdOrCtrl+S` (exatamente um de Meta e Ctrl, sem Alt nem Shift, `key` `s` em qualquer caixa), que é o `Salvar` da linha 18, com `preventDefault`.
- `editor-frame.tsx` (novo): o iframe do editor e a `DrawioClient`, com os parâmetros e a configuração abaixo.
- `diagram-data.ts`: `DiagramData` (`diagram-data.ts:66-106`) ganha `xml?: string`, o XML lido que passou pela conferência do SHA-256, e `revisions?: number`, o `revisions` dessa mesma leitura; os dois estão presentes exatamente quando `model` está. Antes da fase 3 o hook já guardava o XML e descartava `revisions`; a fase 3 passou a guardar os dois (`diagram-data.ts:258`). São o XML de B da linha 4 e o `latest` inicial da [faixa de revisão nova](#o-modal-do-diagrama); a fase 4 usa `xml` na exportação.

A fase 4 muda só `diagram-modal.tsx` no client: `ReviewToolbar` ganha `Salvar no Project`, e o modal ganha o diálogo de [Exportar](#exportar).

O iframe do editor tem `sandbox="allow-scripts allow-same-origin"`, `title="Editor de diagrama"` e a URL `${DRAWIO_ORIGIN}/index.html` montada por `buildEditorUrl` da `@drawio/react`, com estes parâmetros:

| Parâmetros                                    | Por quê                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `embed=1`, `proto=json`, `configure=1`        | embed mode com o protocolo JSON da `DrawioClient`; `configure` para receber a configuração abaixo |
| `stealth=1`, `lockdown=1`, `pwa=0`            | nenhuma requisição fora da origem e nenhum service worker (D3)                                    |
| `noSaveBtn=1`, `noExitBtn=1`, `saveAndExit=0` | salvar e sair são da barra do modal                                                               |
| `ui=min`, `dark=0` ou `1`, `lang=pt-br`       | o tema e a língua do app                                                                          |
| `spin=1`                                      | o indicador de carga do editor, que `editorUrl` passa a `buildEditorUrl`                          |

O protocolo é `new DrawioClient(iframe, { url, config, onInit, onEvent, requestTimeout: EDITOR_LOAD_TIMEOUT_MS })`. A configuração é `{ suppressNewWindows: true, compressXml: false, passThroughKeys: [{ key: 's', ctrl: true, command: 'save' }] }`. `onInit` manda `load` com `autosave: true` e o XML guardado na memória do modal, se houver, senão o XML da revisão B; a biblioteca chama `onInit` a cada `init`, também quando o editor reinicia, e antes rejeita os pedidos pendentes com `restarted` (`reload()`, [client.ts#L179-L186](https://github.com/jgraph/drawio-react/blob/main/src/client.ts#L179-L186); [client.ts#L440-L459](https://github.com/jgraph/drawio-react/blob/main/src/client.ts#L440-L459)).

Eventos do editor tratados: `autosave` (guarda o XML na memória e marca modificado) e `shortcut` com `command: 'save'`.

**O editor que não responde.** A `DrawioClient` só lança `closed` depois de `close()` chamado pelo app ([client.ts#L169-L176](https://github.com/jgraph/drawio-react/blob/main/src/client.ts#L169-L176), `:473`); um iframe cujo processo caiu não manda evento nenhum, e os pedidos só vencem o prazo. Por isso, em `editando` e `editando-modificado`, a cada `EDITOR_HEARTBEAT_MS` sem pedido pendente, o modal chama `getXml()` e descarta a resposta; um `DrawioError` `timeout` (prazo `EDITOR_LOAD_TIMEOUT_MS`) desse pedido, ou do `getXml()` da linha 18, é o evento "o editor não responde" da máquina de estados.

**Faixa de revisão nova.** Ao abrir **Editar**, o modal guarda B e `latest = revisions` da leitura de B (`drawio.diagrams/v1.read`), e chama `watchArtifactRevisions` de `desktop/ui/canvas` para o artefato ([`desktop/ui/canvas`](#desktopuicanvas)), sem abrir outra assinatura de `watchThread`; cada `artifacts.revised/v1` entregue, do replay ou novo, faz `latest = max(latest, revision)`. Em `carregando`, `carregando-modificado`, `editando` e `editando-modificado`, com `latest > B`, o modal mostra a faixa "A revisão `latest` foi publicada depois da revisão B, de onde esta edição parte". O máximo torna repetições e replays inócuos; abrir **Editar** numa revisão mais velha que a última mostra a faixa desde o início; uma revisão salva pelo usuário em outra janela aparece igual, porque a faixa não diz o autor; o salvar deste modal descarrega o editor, e a faixa some com ele. O modal solta a assinatura em `salvando`, ao voltar a `revisar` e ao fechar; em `indisponível` ela fica ativa e só a faixa some, para `latest` estar atual em `Tentar de novo`. Sem `runtime.threads/v1`, `latest` fica no valor da leitura, e o salvar grava a revisão assim mesmo (D15).

**Tema.** **Revisar** segue o tema do app (`useAppTheme`). O editor fica no tema com que abriu (`dark=` da URL) até descarregar; uma troca de tema durante **Editar** não recarrega o iframe.

**Lease.** O modal não observa o lease: ele só aparece na resposta de `save` e `export` ([Máquina de estados](#máquina-de-estados-do-modal-do-diagrama), regras transversais).

`exit` e `openLink` são ignorados: um link do diagrama não abre nada, porque a guarda nega `window.open` e cancela a navegação de subframe para fora da origem do editor (`app/desktop/doric/src/platform/windows/navigation-guard.ts:36-49`).

#### Máquina de estados do modal do diagrama

Estados: `fechado`, `revisar`, `carregando`, `carregando-modificado`, `editando`, `editando-modificado`, `salvando` e `indisponível`; os `-modificado` e `indisponível` com XML na memória guardam uma edição não salva (D11). Uma linha por transição; uma linha com mais de um estado de origem vale para cada um, e a fase 3 tem um teste por estado de origem de cada linha.

| #   | Estado                                                                 | Evento                                                | Ação                                                                                                                    | Próximo estado                            |
| --- | ---------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 1   | `fechado`                                                              | `expandir`                                            | abre o modal na revisão do node, página 1                                                                               | `revisar`                                 |
| 2   | `revisar`                                                              | troca de página                                       | mostra a página, do cache, senão desenhada e medida                                                                     | `revisar`                                 |
| 3   | `revisar`                                                              | troca de revisão (menu `rev n/N`)                     | lê a revisão n e mostra a página 1                                                                                      | `revisar`                                 |
| 4   | `revisar`                                                              | `Editar`, com `drawio.svg/v1.status` disponível       | guarda B = a revisão na tela; monta o iframe; `onInit` manda `load` com o XML de B                                      | `carregando`                              |
| 5   | `revisar`                                                              | `Editar`, com `status` indisponível                   | mostra o motivo                                                                                                         | `indisponível`                            |
| 6   | `revisar`                                                              | fechar (`Esc`, fundo, botão)                          | fecha                                                                                                                   | `fechado`                                 |
| 7   | `carregando`                                                           | `load` respondeu                                      | —                                                                                                                       | `editando`                                |
| 8   | `carregando-modificado`                                                | `load` respondeu                                      | —                                                                                                                       | `editando-modificado`                     |
| 9   | `carregando`, `carregando-modificado`                                  | o editor reinicia (`init` de novo)                    | `onInit` manda `load` de novo, com o mesmo XML                                                                          | o mesmo                                   |
| 10  | `carregando`                                                           | `EDITOR_LOAD_TIMEOUT_MS` sem `load`, ou `DrawioError` | remove o iframe; mostra o erro                                                                                          | `indisponível`                            |
| 11  | `carregando-modificado`                                                | `EDITOR_LOAD_TIMEOUT_MS` sem `load`, ou `DrawioError` | remove o iframe; mostra o erro; o XML fica na memória                                                                   | `indisponível`                            |
| 12  | `carregando`, `editando`                                               | `Concluir edição`                                     | descarrega o editor                                                                                                     | `revisar`                                 |
| 13  | `carregando`, `editando`                                               | fechar                                                | descarrega o editor                                                                                                     | `fechado`                                 |
| 14  | `carregando-modificado`, `editando-modificado`, `indisponível` com XML | `Concluir edição` ou `Voltar`                         | abre o diálogo de saída com o destino `revisar`                                                                         | o mesmo                                   |
| 15  | `carregando-modificado`, `editando-modificado`, `indisponível` com XML | fechar                                                | abre o diálogo de saída com o destino `fechado`                                                                         | o mesmo                                   |
| 16  | `editando`                                                             | `autosave`                                            | guarda o XML na memória                                                                                                 | `editando-modificado`                     |
| 17  | `editando-modificado`                                                  | `autosave`                                            | guarda o XML na memória                                                                                                 | `editando-modificado`                     |
| 18  | `editando-modificado`                                                  | `Salvar`, `CmdOrCtrl+S` ou `shortcut` `save`          | `getXml()`; descarrega o editor; `drawio.diagrams/v1.save({ artifactId, xml })`; destino `revisar`                      | `salvando`                                |
| 19  | `editando`                                                             | o editor reinicia (`init` inesperado)                 | `onInit` manda `load` com o XML de B                                                                                    | `carregando`                              |
| 20  | `editando-modificado`                                                  | o editor reinicia (`init` inesperado)                 | `onInit` manda `load` com o XML da memória; faixa "O editor reiniciou; a edição voltou do último salvamento automático" | `carregando-modificado`                   |
| 21  | `editando`                                                             | o editor não responde                                 | remove o iframe                                                                                                         | `indisponível`                            |
| 22  | `editando-modificado`                                                  | o editor não responde                                 | remove o iframe; o XML fica na memória                                                                                  | `indisponível`                            |
| 23  | `salvando`, destino `revisar`                                          | `save` respondeu                                      | esquece o XML da memória                                                                                                | `revisar`, na revisão que `save` devolveu |
| 24  | `salvando`, destino `fechado`                                          | `save` respondeu                                      | esquece o XML da memória                                                                                                | `fechado`                                 |
| 25  | `salvando`                                                             | `save` falhou                                         | faixa de erro com o motivo; recria o iframe; `onInit` manda `load` com o XML da memória                                 | `carregando-modificado`                   |
| 26  | `salvando`                                                             | fechar (`Esc`, fundo, botão)                          | nada: o modal espera a resposta                                                                                         | `salvando`                                |
| 27  | `indisponível` sem XML                                                 | `Tentar de novo`                                      | recria o iframe; `onInit` manda `load` com o XML de B                                                                   | `carregando`                              |
| 28  | `indisponível` com XML                                                 | `Tentar de novo`                                      | recria o iframe; `onInit` manda `load` com o XML da memória                                                             | `carregando-modificado`                   |
| 29  | `indisponível` sem XML                                                 | `Voltar`                                              | —                                                                                                                       | `revisar`                                 |
| 30  | `indisponível` sem XML                                                 | fechar                                                | —                                                                                                                       | `fechado`                                 |

O diálogo de saída fica por cima do estado em que abriu, que continua recebendo os eventos do editor (um `load` que responde com o diálogo aberto leva `carregando-modificado` a `editando-modificado`, e o diálogo segue aberto):

| #   | Ação no diálogo                                | Efeito                                                                                   | Próximo estado       |
| --- | ---------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------- |
| D1  | `Salvar`                                       | fecha o diálogo; descarrega o editor; `save` com o XML da memória e o destino do diálogo | `salvando`           |
| D2  | `Descartar`                                    | fecha o diálogo; descarrega o editor; esquece o XML da memória                           | o destino do diálogo |
| D3  | `Continuar editando`, `Esc` ou clique no fundo | fecha o diálogo                                                                          | o estado de baixo    |

Regras transversais:

- **Sem lease**: `save` responde `unavailable` com `details.lease`, e a linha 25 se aplica com a faixa "O Project está sem sandbox ativo; a edição continua aqui, e Salvar tenta de novo". `export` responde igual, e o diálogo de exportação mostra "O Project está sem sandbox ativo; tente de novo quando ele voltar" (Q5 da fase 4) e fica aberto. Nenhum botão é desabilitado pelo lease em si; mas `Editar` e `Salvar no Project` precisam do XML da revisão (`data.xml`) e ficam desabilitados sem ele, e sem lease a leitura responde `unleased`, que não o dá.
- **App ou janela fechados durante a edição**: a edição não salva se perde; não há rascunho na v1.
- **Revisão nova durante a edição**: a faixa de [O modal do diagrama](#o-modal-do-diagrama). Salvar grava a revisão seguinte assim mesmo (D15); o agente sabe dela pela recusa da chamada seguinte da tool ([Revisões e base](#revisões-e-base)).
- O `Esc` com o foco dentro do iframe é do editor: eventos de teclado de um iframe de outra origem não chegam ao documento do app.
- O modal tem no máximo um iframe de editor; descarregar o editor remove o iframe.

#### Exportar

1. Em **Revisar**, `Salvar no Project` abre um diálogo dentro do modal com o campo de caminho, valor inicial `defaultExportPath(title)`, `docs/diagrams/<slug do título>`: o título passa por NFD, perde as marcas combinantes, vai a minúsculas, cada sequência fora de `[a-z0-9]` vira `-`, sem `-` nas pontas, e um slug vazio vira `diagrama` (Q1 da fase 4: "Ação de Pedido" dá `docs/diagrams/acao-de-pedido`, "日本語" dá `docs/diagrams/diagrama`). O botão `Salvar no Project` (`drawio-export`) fica depois de `Editar` e, como ele, desabilitado sem `data.xml` ou sem scope. O diálogo é um `form` com `role="dialog"` (`drawio-export-dialog`), sobre o painel do modal e com o próprio backdrop; o campo tem `aria-label="Caminho"` e o foco, e o diálogo mostra o texto "Grava <caminho>.drawio, com todas as páginas, e <caminho>.drawio.svg, só com a página 1".
2. Confirmado, o client chama `drawing.render({ xml, format: 'xmlsvg', theme: 'light' })`, o `DiagramDrawing` que o modal recebe (`bundles/features/drawio/src/client/drawing.ts:22-35`; na janela, `renderDiagram`), com `data.xml`, o XML da revisão na tela, sem `pageId`: o `mxfile` só com a primeira página (D22). O `content` do `.drawio.svg` leva só essa página. Se `render` rejeita, o diálogo fica aberto com "O diagrama não pôde ser desenhado" e `export` não é chamado. Senão chama `drawio.diagrams/v1.export({ …, overwrite: false })`.
3. `exists`: o diálogo lista os arquivos existentes e mostra `Substituir` ao lado de `Salvar`, que continua visível; `Substituir` repete com `overwrite: true` e o mesmo SVG já desenhado (Q3 da fase 4), e a resposta dessa chamada segue os passos 3 a 6.
4. `blocked`: o diálogo fica aberto, sem `Substituir`, com o campo de caminho editável e a mensagem do motivo, com `path` da resposta: `directory`, "Já existe uma pasta em <path>; escolha outro caminho"; `special`, "<path> não é um arquivo comum; escolha outro caminho"; `not-a-folder`, "<path> existe e não é uma pasta; escolha outro caminho".
5. `written`: o diálogo fecha e `toast` de `desktop/ui/sonner` (`packages/desktop/src/components/sonner.tsx:44-47`) diz "Gravado em <caminho>.drawio e .drawio.svg".
6. Erro (`invalid_input`, `not_found`, `unavailable`, `internal`): o diálogo fica aberto com a mensagem; `unavailable` com a frase do lease das Regras transversais; as outras rejeições com "Não foi possível salvar no Project: <mensagem>", com a mensagem do host, em inglês.
7. Editar o caminho em `exists` limpa a lista de arquivos e esconde `Substituir` (`editPath` em `diagram-modal.tsx`).
8. `Esc` (também com o foco no campo), o backdrop do diálogo e `Cancelar` fecham só o diálogo e são ignorados enquanto uma resposta está pendente, com todos os botões desabilitados; com o diálogo aberto, os pedidos de fechar o modal são ignorados (Q3 da fase 4).

O `.drawio` tem todas as páginas; o `.drawio.svg`, imagem e diagrama embutido, tem só a primeira.

#### Papercraft no modal

`expandir` → `CanvasModal` com a superfície do preview em `chrome: 'canvas'`. As teclas de `PAPERCRAFT_KEYBINDINGS` (`bundles/features/papercraft/src/contracts/index.ts:593`: `V`, `C`, `H`, `I`, as de zoom e `CmdOrCtrl+Shift+Enter`, autorizar sob `request`) vêm do `onKeyDown` do modal e são despachadas por `commands/v1.execute` para os ids que o Papercraft já registra. `CmdOrCtrl+Enter` continua sendo o envio do `chat`.

- O modal abre na revisão que o node mostra, e não na mais nova: o node passa `blockRevision: selectedRevision ?? blockRevision` à superfície do modal (`bundles/features/papercraft/src/client/surface/preview-container.tsx:791-793`); sem nenhuma das duas, a superfície do modal escolhe a revisão como o node.
- O node guarda o estado do modal como `'closed' | 'open' | 'closing'` (`preview-container.tsx:186`). Fechar passa de `open` a `closing` (`:559-562`); o node fica ativo em `closing`, com o `expandir` visível para receber o foco de volta, e passa a `closed` quando o foco chega a ele (`:235-236`).
- O `Esc` dentro do canvas cancela uma coisa por vez e a toma (`preventDefault`), e o modal não fecha nele: com o campo de comentário aberto, fecha o campo; com a ferramenta de comentário armada, a desarma (`packages/desktop/src/canvas/gestures.ts:553-567`); com o foco na thread aberta, fecha a thread (`packages/desktop/src/canvas/thread-popover.tsx:318-327`). O `Esc` não desfaz o isolamento (`I`): sem campo, ferramenta nem thread a fechar, ele fecha o modal.
- O `Esc` com o foco dentro do iframe do preview não chega ao documento do app; o frame o relata como mensagem `key`. Se a superfície não o toma, ela chama `onFrameEscape` (`preview-container.tsx:442-444`), que o node liga ao mesmo fechamento do `onCloseRequest` (`:794`): o modal fecha sem passar pelo `Dialog`.
- O evento `doric:comment-thread-open` chega ao node e à superfície do modal. A guarda vale só para o node: enquanto o modal do mesmo artefato está aberto (`canvasOpen`, `bundles/features/papercraft/src/client/canvas-registry.ts:76-77`), o node não abre a thread (`preview-container.tsx:288-291`); a superfície do modal, em `chrome: 'canvas'`, abre a thread de todo pedido do artefato (`packages/desktop/src/canvas/thread-open.ts:44-48`).

### Validação e normalização

Em `bundles/features/drawio/src/host/xml.ts`, uma função pura `normalizeDiagram(text: string): { xml: string; pages: PageSummary[] } | { error: string }`, com `@xmldom/xmldom` e `node:zlib`:

1. Tamanho até `MAX_DIAGRAM_BYTES` em UTF-8; texto que não é UTF-8 válido: recusa.
2. Recusa `<!DOCTYPE` e `<!ENTITY` (sem diferença de caixa) antes do parse. A mesma regra vale para o texto de cada página comprimida depois de descomprimida (passo 6).
3. Parse com `DOMParser` do xmldom e um `errorHandler` que transforma aviso, erro e erro fatal em recusa.
4. Raiz `mxGraphModel`: embrulhada em `<mxfile><diagram id="page-1" name="Página 1">…</diagram></mxfile>`. Raiz `mxfile`: aceita. Outra raiz: recusa.
5. De 1 a `MAX_PAGES` `<diagram>`. Página sem `id` ganha `page-<n>`; sem `name`, `Página <n>`; `id` repetido, com `/` ou com mais de 128 caracteres: recusa.
6. Página com texto em vez de `<mxGraphModel>`: base64 → `inflateRawSync(bytes, { maxOutputLength: MAX_DIAGRAM_BYTES })` → `decodeURIComponent` → passo 2 → parse como no passo 3; saída acima do teto ou falha: recusa. A soma dos textos de todas as páginas depois de descomprimidos também fica até `MAX_DIAGRAM_BYTES`.
7. Cada `mxGraphModel` com o elemento `<root>`; até `MAX_CELLS` células somando as páginas; `id` não vazio, até 128 caracteres e único na página (contando `object`/`UserObject`); todo `parent` existe na página, exceto o da célula raiz.
8. Saída: `mxfile` com os atributos de origem, `compressed="false"` e cada página como `mxGraphModel` em texto, serializada por `XMLSerializer`.

Mensagens de recusa em inglês, para o modelo: por exemplo `Page "page-2" has two cells with id "a1".`

A função é síncrona e roda no host. Os tetos limitam o pior caso a 2 MiB de XML e 5.000 células; a fase 2 mede o tempo de `normalizeDiagram` na maior entrada aceita (2 MiB, 50 páginas comprimidas, 5.000 células) e exige menos de 250 ms no CI; acima disso, a fase baixa `MAX_DIAGRAM_BYTES` e `MAX_CELLS` até caber, e registra os valores em [Medidas](#medidas).

## Alternativas consideradas

| Alternativa                                                                                                         | Por que não                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contrato genérico para um bundle registrar uma origem `https:`                                                      | Um consumidor; daria a qualquer bundle uma entrada no `frame-src` do shell; o CSP do shell passaria a depender da geração (S1)                                                                                                                                                                                                                                                        |
| Webapp no catálogo, em `client/**` do bundle                                                                        | 3.092 arquivos baixados e conferidos um a um; a origem é servida pela plataforma de qualquer forma (S2)                                                                                                                                                                                                                                                                               |
| Webapp com `templates/`                                                                                             | 312 arquivos e 4,9 MB que o embed mode desta spec não abre (D16)                                                                                                                                                                                                                                                                                                                      |
| Webapp cortado por uma lista de inclusão                                                                            | Sem `shapes/`, `stencils/` e `img/lib/`, um diagrama que usa essas bibliotecas sai em branco; manter a lista exigiria provar, a cada versão do draw.io, tudo o que o editor carrega ([o webapp vendorizado](#plataforma-o-webapp-vendorizado))                                                                                                                                        |
| Servidor HTTP em `127.0.0.1`                                                                                        | Socket alcançável por processos e navegadores locais; origem que muda a cada execução                                                                                                                                                                                                                                                                                                 |
| Servir o editor em `doric://app` num frame opaco                                                                    | A biblioteca recusa a origem `"null"`; o editor perde `localStorage` e as requisições à própria origem                                                                                                                                                                                                                                                                                |
| Exportar as peças do canvas como Web Components do Papercraft                                                       | Props que mudam junto com os dois bundles; o pacote compartilhado já é o caminho de `comment-pin` (S3)                                                                                                                                                                                                                                                                                |
| Copiar para o `drawio` a lógica de canvas do Papercraft                                                             | Cerca de 1.800 linhas duplicadas, quando o acoplamento ao scene graph está em cinco trechos (`bundles/features/papercraft/src/client/surface/gestures.ts:37-47`, `:55`, `:57`, `:168-248` e `:293-312`; `bundles/features/papercraft/src/client/surface/fit.ts:18-19` e `:33`) (S3)                                                                                                   |
| Janela oculta de render no processo principal                                                                       | Um segundo cliente do protocolo e um módulo de janela na plataforma, sem medida que os justifique; voltaria só por decisão do usuário, se a fase 0 medisse mais que o teto de memória; a fase 0 mediu 296,5 MB, abaixo dos 400 MB de D23; descrita abaixo                                                                                                                             |
| Frames de SVG vivos, com teto de 3 e um substituto `<img>` (versão 7)                                               | Dois caminhos de exibição e uma cópia do registro de frames vivos do Papercraft, sem medida que os peça; o Papercraft limita frames porque cada um avalia o próprio React (`bundles/features/papercraft/src/client/surface/live-frames.ts:4-5`), e o frame do diagrama só mede caixas, que ficam guardadas com o SVG (S5)                                                             |
| Despejo do cache de SVG pelo `drawio`                                                                               | Um teto de cache é da plataforma: os outros caches também não têm (`bundles/features/artifacts/src/desktop/cache.ts`, `app/desktop/doric/src/platform/native/cache.ts`), e nada mediu o tamanho que o pediria                                                                                                                                                                         |
| Arquivo de trabalho reescrito pelo host, com estado, cópia das edições não publicadas e avisos guardados (versão 7) | Um arquivo que o host e o agente escrevem pede o estado do que o host gravou, a cópia das edições do agente e uma fila de avisos; o registro já guarda cada revisão imutável, e a recusa por `base_revision` dá o mesmo aviso, tirado das revisões (S7, D15)                                                                                                                          |
| `save` idempotente pela nota e repetido depois de 30 s sem resposta (versão 7)                                      | A ponte não tem prazo (`packages/desktop/src/client/bridge.ts`, sem timeout), e o repositório desliga a repetição de mutações (`bundles/features/files/src/client/sandbox-store.ts:43`); a regra de XML igual vale para a tool e para o `save`                                                                                                                                        |
| `review: 'none'` na declaração do tipo                                                                              | O usuário escolheu a lista na política (D21): ela deixa um Project voltar a exigir aprovação de diagramas sem um release                                                                                                                                                                                                                                                              |
| O viewer do draw.io (`js/viewer-static.min.js`, 4,6 MB) no frame de SVG                                             | No frame de origem opaca, o viewer carrega formas e stencils sob demanda por requisição, que o CSP do frame bloqueia (`connect-src 'none'`, `app/desktop/doric/src/platform/protocol/csp.ts:54`); servi-lo da origem do editor pediria um documento e um protocolo próprios, porque o viewer não fala `postMessage`; a `export` da `DrawioClient` já devolve o SVG com `data-cell-id` |
| Guardar o SVG em `artifacts.cache/v1`                                                                               | `ensure` só grava e o protocolo só serve por URL (`bundles/features/artifacts/src/contracts/index.ts:728-743`); a janela e o frame têm `connect-src 'none'` (`app/desktop/doric/src/platform/protocol/csp.ts:22`, `:54`), e o frame precisa do SVG como texto para medir as células, o que um `<img>` não dá                                                                          |
| Atalhos do modal por `menus/v1` com `when.focus`                                                                    | O listener da janela intercepta o atalho também dentro do campo de comentário (S9)                                                                                                                                                                                                                                                                                                    |
| Pinos por cima do editor em **Editar**                                                                              | O protocolo não informa seleção nem scroll do editor                                                                                                                                                                                                                                                                                                                                  |
| Mesclar revisões concorrentes, ou bloquear o salvar do usuário                                                      | Fora de D1–D10; o salvar grava (D15), e a tool recusa a chamada do agente com base velha ([Revisões e base](#revisões-e-base))                                                                                                                                                                                                                                                        |
| `author: 'agent' \| 'user'` na revisão do registro                                                                  | Muda três contratos do `artifacts` para um consumidor (D13)                                                                                                                                                                                                                                                                                                                           |
| Um tipo de comentário genérico para artefatos                                                                       | Precisa de um dono novo para o flush e da migração do tipo do Papercraft, por cerca de 20 linhas ([Tipo de comentário e flush](#tipo-de-comentário-e-flush))                                                                                                                                                                                                                          |
| Rascunho da edição gravado no Project, com recuperação                                                              | Fora da v1 (D11)                                                                                                                                                                                                                                                                                                                                                                      |
| Abrir links do diagrama com confirmação                                                                             | Fora da v1 (D12)                                                                                                                                                                                                                                                                                                                                                                      |
| Fonte `drawio` no `papercraft_preview`                                                                              | Rejeitada pelo usuário (D8)                                                                                                                                                                                                                                                                                                                                                           |
| Exportação gravando `artifacts.applied/v1`                                                                          | O evento significa "chegou ao código", e `apply` recusa revisão não aprovada sob `request` (`bundles/features/artifacts/src/contracts/index.ts:296-297`)                                                                                                                                                                                                                              |

### A janela oculta de render

A alternativa que a fase 0 deixa de reserva: uma janela oculta do processo principal, com um editor só para todas as janelas, desenharia os SVGs no lugar do iframe oculto de cada janela. Ela traria à plataforma um segundo cliente do protocolo e um módulo de janela, sem medida que os justifique; voltaria só por decisão do usuário, se a fase 0 medisse mais que o teto de memória. A fase 0 mediu 296,5 MB no Linux, abaixo dos 400 MB de D23; ela volta à mesa se a nova medida em macOS ou Windows passar do teto.

## Riscos

### Riscos e mitigações

| Risco                                                                                                                                                                                                                                     | Mitigação                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A `@drawio/react` tem uma versão (0.1.0, de 2026-10-19) e pode mudar                                                                                                                                                                      | Versão exata no `package.json`; o plano B já descreve o cliente próprio                                                                                                                                                                                                                                                                                                                                     |
| Uma correção de segurança do draw.io só chega ao usuário quando o lock é atualizado e um release do Doric sai                                                                                                                             | Lock com versão e SHA-256; conferência a cada minor do Doric (D19)                                                                                                                                                                                                                                                                                                                                          |
| O handler de `https:` fica no caminho de toda requisição `https:` da sessão padrão                                                                                                                                                        | Passagem com `bypassCustomProtocolHandlers`; hoje o shell empacotado tem `connect-src 'none'` e o único `net.fetch` do processo principal é o proxy de desenvolvimento, em `http:` (`app/desktop/doric/src/platform/app.ts:491-497`). Uma passagem que falha chega como `net::ERR_UNEXPECTED`, não com o código original; aceito, porque nenhum código do app lê esse código                                |
| O build precisa de rede uma vez para baixar o draw.io                                                                                                                                                                                     | Cache em `node_modules/.cache/drawio`, conferido por SHA-256                                                                                                                                                                                                                                                                                                                                                |
| O app cresce com o webapp: 2.753 arquivos, 103 MB sem compressão                                                                                                                                                                          | Aceito para desenhar qualquer biblioteca (S2, D16)                                                                                                                                                                                                                                                                                                                                                          |
| Fontes embutidas como `data:` no SVG não carregam no frame (`font-src doric://app`)                                                                                                                                                       | A exportação usa `embedFonts: false`; o texto cai na fonte do sistema                                                                                                                                                                                                                                                                                                                                       |
| O iframe oculto do renderizador custa memória em cada janela que desenha um diagrama                                                                                                                                                      | Um por janela, removido depois de 60 s sem pedidos; o SVG fica no cache. A fase 0 mediu 205,1 MB com um editor e 296,5 MB com dois, no Linux, abaixo dos 400 MB de D23                                                                                                                                                                                                                                      |
| A memória medida no Linux não vale para macOS e Windows                                                                                                                                                                                   | A medida 7a da fase 0 se repete nos dois antes do release; acima de 400 MB, volta ao usuário com [a janela oculta de render](#a-janela-oculta-de-render) (D23)                                                                                                                                                                                                                                              |
| Uma versão futura do draw.io passa a respeitar `pageId` no `export` em SVG, ou muda a página atual depois de um `load`                                                                                                                    | O renderizador não depende de `pageId`: com uma página só no `mxfile`, a página atual é a pedida (D22); o critério 12 da fase 2 roda a cada atualização do lock                                                                                                                                                                                                                                             |
| Uma Thread longa com cache frio desenha e mede muitas revisões                                                                                                                                                                            | Cada SVG e layout é feito uma vez por revisão, página e tema e guardado; a fase 2 mede uma Thread de 30 revisões                                                                                                                                                                                                                                                                                            |
| O cache de SVG cresce sem teto: a plataforma não apaga o diretório de `doric.cache/v1` (`app/desktop/doric/src/platform/native/cache.ts`), como já acontece com o cache dos artefatos (`bundles/features/artifacts/src/desktop/cache.ts`) | Fora desta spec: um teto para `doric.cache/v1` é da plataforma e vira uma issue própria                                                                                                                                                                                                                                                                                                                     |
| `normalizeDiagram` bloqueia o loop de eventos do host                                                                                                                                                                                     | Tetos de bytes e de células, e a medida da fase 2 ([Validação e normalização](#validação-e-normalização))                                                                                                                                                                                                                                                                                                   |
| Um salvar do usuário feito sobre uma revisão velha tira da última revisão as mudanças do agente                                                                                                                                           | A revisão é gravada (D15); a chamada seguinte do agente com a base velha é recusada, com as revisões novas listadas, e ele reaplica o que ainda vale ([Revisões e base](#revisões-e-base))                                                                                                                                                                                                                  |
| O agente acha e edita, com `terminal`, o arquivo guardado de uma revisão                                                                                                                                                                  | A saída da tool não nomeia esse arquivo, a tool recusa um `path` dentro de `.doric/artifacts/<artifact_id>/` e o `checkout` dá uma cópia. Editado no lugar, o arquivo deixa de bater com o SHA-256 da revisão, e `read` serve a revisão sem bytes (`bundles/features/artifacts/src/host/store.ts:326-344`, `bundles/features/artifacts/src/contracts/index.ts:105-110`); o node continua com o SVG do cache |
| A skill depende da tool `terminal`, de outro bundle                                                                                                                                                                                       | `terminal` está registrada (`bundles/features/terminal/src/host/tool.ts:123`) e na composição (`app/backend/doric-host/composition.json:12`), e as skills do `files` já a listam; numa composição sem ela, o registro da skill falha com `unavailable_tool` (`bundles/foundation/core/src/host/skills.ts:54-67`)                                                                                            |
| A edição não salva se perde se o app fechar                                                                                                                                                                                               | Aceito na v1 (D11); fechar o modal pede confirmação                                                                                                                                                                                                                                                                                                                                                         |
| O modal cobre o prompt                                                                                                                                                                                                                    | `Enviar ao agente (n)` no cabeçalho e `CmdOrCtrl+Enter` (D20)                                                                                                                                                                                                                                                                                                                                               |
| Perde-se o canvas num segundo monitor                                                                                                                                                                                                     | Aceito em D5                                                                                                                                                                                                                                                                                                                                                                                                |
| Entre a conferência de `export` e a gravação, outro processo do sandbox cria uma pasta num dos dois caminhos, e o provedor Docker a apaga ao gravar (sem `noOverwriteDirNonDir`, `packages/docker-sandbox/src/lib/provider.ts:407-414`)   | Aceito: a janela é a de algumas chamadas de `exec`, e o caminho é o que o usuário acabou de escolher; passar `noOverwriteDirNonDir` no provedor muda todos os usuários de `putFile` e fica fora desta spec                                                                                                                                                                                                  |
| Com `overwrite`, uma falha na gravação do `.drawio.svg` apaga o `.drawio` novo, e o anterior não volta                                                                                                                                    | Aceito: os dois arquivos ficam coerentes (nenhum ou os dois), e o `.drawio` sai de novo da revisão, que não muda                                                                                                                                                                                                                                                                                            |
| Uma chamada da tool cujo lease cai depois de `create` ou `revise` responde `unavailable` com a revisão gravada, e o agente que repete um `create` cria um diagrama a mais                                                                 | Aceito na fase 2: tudo corre num `withLease` só ([Tool `drawio_diagram`](#tool-drawio_diagram)); um `revise` repetido é recusado pela regra de base, que lista a revisão gravada                                                                                                                                                                                                                            |
| R6: o `save` da janela vai sem `promptId` (`callScopeOf` passa só `projectId` e `threadId`), e `eventScopeOf` grava a revisão sob o prompt que criou o artefato                                                                           | Aceito: o node novo aparece no fim da conversa do mesmo jeito (D13); levar o prompt do node expandido muda o modal e a ponte e fica para depois                                                                                                                                                                                                                                                             |

### Modos de falha

| Falha                                                                                                   | Onde               | Comportamento                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assets/drawio` ausente                                                                                 | processo principal | `describe` responde `missing-assets`; sem SVG no cache, o node mostra "O diagrama não pôde ser desenhado" e `Tentar de novo`; `Editar` leva a `indisponível`                           |
| `protocol.handle('https')` lança                                                                        | processo principal | `handler-failed`; o resto do app segue                                                                                                                                                 |
| A passagem `net.fetch` de uma URL de outro host falha                                                   | processo principal | quem pediu recebe `net::ERR_UNEXPECTED`, o código que o Electron dá a toda rejeição do handler                                                                                         |
| `pageId` pedido não existe na revisão                                                                   | client             | `singlePageOf` lança `invalid-xml`; o node mostra o erro                                                                                                                               |
| O renderizador ou o frame de medida passa do prazo ou cai                                               | client             | `unavailable`; o iframe é removido; o pedido seguinte cria outro; o node mostra `Tentar de novo`                                                                                       |
| O editor recusa o XML                                                                                   | client             | `invalid-xml`; o node mostra o erro; no modal, `indisponível`                                                                                                                          |
| O editor do modal reinicia                                                                              | client             | linhas 9, 19 e 20 da [máquina de estados](#máquina-de-estados-do-modal-do-diagrama): recarrega o XML da memória                                                                        |
| O processo do iframe do modal cai                                                                       | client             | nenhum evento chega; o `getXml()` periódico vence o prazo, e as linhas 21 e 22 levam a `indisponível`, com o XML na memória                                                            |
| `checkout` com `path` que existe                                                                        | host (tool)        | `invalid_input`; nada gravado                                                                                                                                                          |
| XML inválido da tool                                                                                    | host               | `invalid_input` com o motivo; nada publicado                                                                                                                                           |
| XML inválido do salvar                                                                                  | host               | `invalid_input`; o modal descarta o editor e vai a `carregando-modificado` num iframe novo, com o XML na memória (linha 25)                                                            |
| Página comprimida acima do teto ao descomprimir                                                         | host               | `invalid_input`; nada publicado                                                                                                                                                        |
| `base_revision` ausente, acima da última ou abaixo dela                                                 | host (tool)        | `invalid_input`; abaixo, com as revisões novas e o arquivo da última ([Revisões e base](#revisões-e-base)); nada publicado                                                             |
| `path` da tool fora da raiz do Project ou num arquivo guardado do diagrama                              | host (tool)        | `invalid_input`; nada publicado                                                                                                                                                        |
| Sem lease, no host                                                                                      | host               | `unavailable` com `details.lease`; regras de [Sem lease](#máquina-de-estados-do-modal-do-diagrama)                                                                                     |
| Sem lease, no node                                                                                      | client             | `drawio.diagrams/v1.read` responde `unleased`; SVG do cache sem `Comentar` nem `expandir`, ou o placeholder com `Tentar de novo` ([O node mostra a revisão](#o-node-mostra-a-revisão)) |
| Frame de medida manda mensagem fora do schema                                                           | client             | a medida falha com `unavailable`; o erro vai para `doric.log/v1`                                                                                                                       |
| SHA-256 dos bytes lidos não confere com o bloco                                                         | client             | nada é desenhado nem guardado; o node mostra o erro                                                                                                                                    |
| SVG, layout ou ponteiro do cache ilegível ou fora do formato                                            | desktopMain        | `get` responde `null`; o client desenha, mede e grava de novo, e o ponteiro com a página 1                                                                                             |
| Arquivo da exportação existe como arquivo regular                                                       | host               | `exists`; nada gravado até `overwrite: true`                                                                                                                                           |
| Arquivo da exportação é uma pasta (vazia ou não), um link, um fifo, um socket ou um dispositivo         | host               | `blocked` com `directory` ou `special` e o caminho; nada gravado, também com `overwrite: true`; o diálogo pede outro caminho                                                           |
| Um prefixo de pasta do caminho de exportação existe e não é pasta                                       | host               | `blocked` com `not-a-folder` e o prefixo; nada gravado                                                                                                                                 |
| A conferência da exportação falha (`exec` rejeita, ou `test` sai com outro código que 0 e 1, ou `null`) | host               | `internal`; nada gravado                                                                                                                                                               |
| Caminho de exportação inválido                                                                          | host               | `invalid_input`                                                                                                                                                                        |
| `chat.composer/v1` ausente                                                                              | client             | `Comentar` desabilitado, como no Papercraft                                                                                                                                            |
| `runtime.threads/v1` ausente                                                                            | client             | sem a faixa de revisão nova no modal; o salvar grava a revisão (D15)                                                                                                                   |

### Segurança

- O editor roda numa origem própria, sem preload e sem IPC (`docs/architecture/bundles/papercraft/isolamento.md:35`), com o CSP do editor; ele só alcança a própria origem. O diagrama trafega só por `postMessage`, e a `DrawioClient` aceita mensagens só do próprio iframe e da origem do editor ([client.ts#L386-L388](https://github.com/jgraph/drawio-react/blob/main/src/client.ts#L386-L388)). O iframe oculto do renderizador tem o mesmo isolamento.
- O handler da origem serve só arquivos estáticos do pacote do app, só `GET`/`HEAD`, dentro da raiz.
- O shell só ganha `frame-src` para a origem do editor; a guarda continua cancelando qualquer outro subframe e toda janela nova.
- O SVG só entra num DOM no frame de medida, de origem opaca, cujo CSP não executa script do conteúdo nem deixa o frame chamar a rede, depois da limpeza ([Frame de medida](#frame-de-medida)). No documento do app ele só aparece como `<img>`, contexto em que o navegador não executa script nem carrega recurso externo do SVG. O cache guarda texto e só o devolve ao client.
- Todo XML que vira revisão passa pela validação do host, sem DTD nem entidades, também depois de descomprimido.
- Links do diagrama não abrem (D12): `openLink` é ignorado, e `window.open` é negado.
- A exportação grava só caminhos que `resolvePath` aceita sob a raiz (`packages/sandbox/src/lib/sandbox.ts:220-233`) e nunca substitui uma pasta, um link ou uma entrada especial ([Serviço `drawio.diagrams/v1`](#serviço-drawiodiagramsv1-host)). Um link para pasta num prefixo do caminho é seguido, como pelo `mkdir -p` de `writeFile`: a gravação pode cair fora da raiz do Project, dentro do sandbox do próprio Project, onde o link aponta. Aceito: o usuário escolhe o caminho no diálogo, e o sandbox é do Project.

### Suposições a provar na fase 0

#### A1. O editor self-hosted roda em embed mode sem rede

A página de embed mode do draw.io diz que o modo só é suportado em `embed.diagrams.net`; a `@drawio/react` testa contra o webapp local. Prova: critério 2 da fase 0.

Resultado: **passou**. As 16 requisições foram a `doric://app` ou à origem do editor, sem nenhum 404, com a resolução de nomes bloqueada. O plano B não foi preciso.

#### A2. O editor roda sob o CSP do editor

Prova: critério 3 da fase 0.

Resultado: **passou**. Houve dois `kEvalViolation` de `script-src`, e o editor funcionou mesmo assim; `'unsafe-eval'` não entrou e `drawioCsp` não mudou ([Plataforma: a origem do editor](#plataforma-a-origem-do-editor)).

#### A3. Cada célula tem `data-cell-id` no SVG

Prova: critério 4 da fase 0.

Resultado: **falhou**. No draw.io 32.6.1 a ação `export` em SVG ignora `pageId` e desenha sempre a página atual; só a exportação PNG lê `pageId` (conferido em `webapp/js/app.min.js`). O `export` da segunda página do diagrama de teste desenhou outra página, e as células dela ficaram sem elemento. Um `merge` com o mesmo `id` de página também troca as células dessa página, e por isso não serve para trocar de página.

Decisão do usuário (D22): o renderizador carrega um `mxfile` só com o `<diagram>` da página pedida e o exporta ([Renderizador](#renderizador-client)). A prova de que toda célula de cada página tem `data-cell-id` com o `id` da página original passa ao critério 12 da fase 2.

#### A4. As bibliotecas de formas carregam sem rede

Prova: critério 5 da fase 0.

Resultado: **passou**. A forma `mxgraph.aws4.lambda_function` e a imagem de `img/lib/` foram desenhadas sem rede.

## Fases e critérios de aceitação

Cada fase deixa o código compilando e os testes passando. As fases 0 e 1a correm em paralelo; 1b depende de 1a; 2 depende de 0 e 1a; 3 depende de 0, 1a e 2; 4 depende de 2 (D6). A fase 2 depende de 1a porque o node do diagrama usa a lógica de `desktop/ui/canvas` (S3).

### Fase 0 — origem do editor e provas

Entrega: o projeto `drawio-webapp`, a origem, o contrato `doric.drawio/v1`, o CSP do shell, a guarda, o `.xml` em `mime.ts` e a plataforma uma minor acima ([Plataforma: versão](#plataforma-versão)). Nenhuma UI usa nada disso ainda.

Critérios:

1. `npx nx run drawio-webapp:build` produz `dist/app/desktop/doric/assets/drawio/manifest.json` com a versão do lock e sem `WEB-INF/`, `META-INF/` nem `templates/`, e falha se o SHA-256 do arquivo baixado não confere.
2. Teste e2e `app/desktop/doric-e2e/tests/drawio-editor.test.ts`, no harness de hoje (a plataforma contra o `FakeHost`, `app/desktop/doric-e2e/tests/support/harness.ts:54`), com a resolução de nomes bloqueada: `app/desktop/doric-e2e/tests/run.ts:27-32` acrescenta a chave `host-resolver-rules` com `MAP * ~NOTFOUND, EXCLUDE 127.0.0.1` só quando `drawio-editor.test.js` está entre os arquivos da execução (o `FakeHost` escuta em `127.0.0.1`, que a regra não toca); o teste põe na janela do app um iframe do editor com os parâmetros do modal e fala o protocolo JSON direto; recebe `init`, faz `load` de um diagrama de duas páginas, recebe `autosave` depois de uma ação `merge`, e faz `export` em `svg` e `xmlsvg`. Todas as requisições registradas por `session.defaultSession.webRequest.onBeforeRequest` são de `doric://app` ou `https://drawio.doric.invalid`; nenhuma resposta da origem do editor é 404 ([A1](#a1-o-editor-self-hosted-roda-em-embed-mode-sem-rede)).
3. O mesmo teste não registra, pelo domínio `Audits` do CDP ([Plataforma: a origem do editor](#plataforma-a-origem-do-editor)), problema de CSP além dos permitidos pela regra de `script-src`; a política final fica em `drawioCsp` ([A2](#a2-o-editor-roda-sob-o-csp-do-editor)).
4. No mesmo teste, o `export` em `svg` de um diagrama de formas, conectores, grupos e duas páginas tem, para toda célula com geometria, um elemento com `data-cell-id` ([A3](#a3-cada-célula-tem-data-cell-id-no-svg)).
5. No mesmo teste, o `export` em `svg` com `embedImages: true` de um diagrama com uma forma `mxgraph.aws4.lambda_function` (de `shapes/`) e uma imagem de `img/lib/` desenha a forma (o grupo dela tem ao menos um `<path>`) e embute a imagem como `data:image/` ([A4](#a4-as-bibliotecas-de-formas-carregam-sem-rede)).
6. Testes de unidade: o handler serve arquivos da raiz, um `.xml` como `application/xml`, recusa `..`, responde 405 a `POST`, põe o CSP em HTML e passa adiante uma URL `https:` de outro host; o CSP do shell contém o `frame-src` novo; o teste de hoje do CSP do frame (`app/desktop/doric/tests/protocol.test.ts:83-84`, `:486`) passa sem mudança; a guarda aceita subframe da origem do editor e cancela um subframe de outra origem; `describe` responde `missing-assets` sem o manifesto; `packages/bundle/tests/values.test.ts` tem `doric.drawio/v1`; os testes que chamam `provideBroker` passam com o `drawio` falso.
7. O mesmo teste e2e mede e grava em [Medidas](#medidas): (a) a memória do processo do editor, `memory.workingSetSize` (KB, definido em todos os sistemas; `privateBytes` só existe no Windows) da entrada de `app.getAppMetrics()` cujo `pid` é o `WebFrameMain.osProcessId` do iframe do editor, com dois iframes do editor abertos ao mesmo tempo, um no papel do renderizador e um no do modal, depois de um `export` e de um `load`; (b) o tempo de montar o iframe até `init` e até a resposta do primeiro `load` e do primeiro `export`, a frio, 20 vezes cada, com p50 e p95.

Decisões da fase 0 a partir das medidas:

- Se 2 falhar por causa da interceptação de `https:`, a fase aplica o plano B e repete os critérios. Se 2, 3 ou 5 falharem por outro motivo, a fase para e volta ao usuário com as saídas de [A1](#a1-o-editor-self-hosted-roda-em-embed-mode-sem-rede), [A2](#a2-o-editor-roda-sob-o-csp-do-editor) ou [A4](#a4-as-bibliotecas-de-formas-carregam-sem-rede) antes das fases 2 e 3.
- Se a memória de 7a passar de 400 MB (D23, no lugar dos 300 MB de D14), a fase para e volta ao usuário antes da fase 2, com [a janela oculta de render](#a-janela-oculta-de-render) como alternativa.
- Se o p95 de 7b até `init` passar de 5 s, a fase para e volta ao usuário: o modal levaria mais que isso para abrir **Editar**, e cada node com cache frio para aparecer.
- `EDITOR_LOAD_TIMEOUT_MS` passa a ser o triplo do p95 até a resposta do primeiro `load`, nunca menos de 10 000; `RENDER_TIMEOUT_MS`, o triplo do p95 até a resposta do primeiro `export`, nunca menos de 5 000.

**Resultado (2026-10-29; Linux arm64, GL por software, Electron 44.4.3, draw.io 32.6.1).** Fase concluída, menos a nova medida de memória em macOS e Windows, que fica para antes do release (D23).

| Critério | Resultado                                                                                                                                                                  |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | o webapp tem 2.753 arquivos, 103 MB; `sha256` do arquivo no lock                                                                                                           |
| 2 (A1)   | passou: 16 requisições, todas a `doric://app` ou à origem do editor, sem 404                                                                                               |
| 3 (A2)   | passou: dois `kEvalViolation` de `script-src`, sem efeito; `drawioCsp` sem mudança                                                                                         |
| 4 (A3)   | falhou: o `export` em SVG ignora `pageId`; resolvido por D22 e provado de novo no critério 12 da fase 2                                                                    |
| 5 (A4)   | passou                                                                                                                                                                     |
| 6        | passou                                                                                                                                                                     |
| 7        | 205,1 MB com um editor, 296,5 MB com dois (teto 400 MB, D23); `init` p95 272 ms (limite 5 s); prazos derivados: `EDITOR_LOAD_TIMEOUT_MS` 10 000, `RENDER_TIMEOUT_MS` 5 000 |

Também medido: o Electron troca toda rejeição do handler de `protocol.handle` por `net::ERR_UNEXPECTED` ([Plataforma: a origem do editor](#plataforma-a-origem-do-editor)).

### Fase 1a — o modal e a lógica de canvas em `desktop/ui/canvas`

Entrega: `desktop/ui/canvas` com as peças visuais, a lógica movida, as portas e o `CanvasModal`; a plataforma uma minor acima; o Papercraft 1.3.0 usa tudo do pacote, com `sceneHitTester` e `papercraftCommentStore`, e abre o modal pelo botão `expandir`. A janela, a rota e o comando continuam existindo, sem uso pelo botão.

Critérios:

1. Os testes do Papercraft passam com as peças e a lógica importadas de `desktop/ui/canvas`; os testes das peças movidas rodam em `packages/desktop`.
2. Os testes novos de `packages/desktop` exercitam gestos, enquadramento, threads, log, fluxo de comentário e abertura de thread com um `CanvasHitTester` e um `CommentStore` falsos, sem o Papercraft.
3. Duas superfícies de bundles diferentes na mesma Thread abrem uma assinatura só de `watchThread`; `watchThreadComments` entrega os `comments.*`, e `watchArtifactRevisions` os `artifacts.revised/v1` do artefato dado.
4. Clicar `expandir` no node abre o modal com o mesmo preview, a barra de comandos e a árvore; o frame do modal fica vivo sem tirar um dos 3 frames vivos da conversa.
5. `V`, `C`, `H`, `I` e os atalhos de zoom agem com o foco no modal e não agem com o foco no prompt; com o foco no campo de comentário do modal, as letras são texto.
6. Um comentário feito no modal entra na pilha; `Enviar ao agente (n)` e `CmdOrCtrl+Enter` enviam; `doric:comment-thread-open` abre a thread no modal aberto.
7. `Esc` sem nada a cancelar no canvas, também com o foco no preview, clique no fundo e o botão fechar fecham o modal e devolvem o foco ao botão `expandir` ([Papercraft no modal](#papercraft-no-modal)).
8. O cabeçalho do modal não tem região de arrastar a janela; a janela do canvas, que ainda existe, mantém a sua faixa de barra de título (`host="window"`).
9. O manifesto do Papercraft 1.3.0 declara `engines.doric` com a versão que a fase criou, e a composição o ativa nela.
10. `npx nx run desktop:test` roda os testes de `packages/desktop/tests/canvas/`.

### Fase 1b — a janela do Papercraft sai

Entrega: o Papercraft 2.0.0 descrito em [Bundle `papercraft` 2.0.0](#bundle-papercraft-200), com `engines.doric: "^1.2.0"`.

Critérios:

1. Nada no repositório referencia `papercraft.open-canvas/v1`, `CANVAS_ROUTE`, `canvasPathOf`, `OPEN_CANVAS_COMMAND`, `PAPERCRAFT_CANVAS_TAG` ou o elemento `<papercraft-canvas>`, fora das [Revisões](#revisões) deste documento. A classe CSS `papercraft-canvas` da superfície fica.
2. O manifesto do Papercraft não exige `windows/v1`, `navigation/v1` nem `menus/v1`. `app/backend/doric-host/tests/bridge-exposure.test.ts:152` continua esperando `'windows/v1': ['open']`, que vem do contrato básico (`packages/bundle/src/contracts/basic/windows.ts:117-121`), fornecido pelo core.
3. Os testes da composição (`app/backend/doric-host/tests/bundles.test.ts`) passam com o Papercraft 2.0.0.
4. Os critérios 4–7 da fase 1a continuam passando, e `CanvasHeader` não tem mais `host="window"`.

### Fase 2 — o diagrama somente leitura

Entrega: o registro de artefatos 1.1.0; o bundle `drawio` 1.0.0 com a tool, o tipo, a skill, `drawio.diagrams/v1@1.0.0` (só `read`), `drawio.svg/v1` com o layout e o ponteiro da primeira página, o renderizador, a medida, o node, o modal só com **Revisar** (linhas 1, 2, 3 e 6 da [máquina de estados](#máquina-de-estados-do-modal-do-diagrama), em `diagram-modal.tsx`), os comentários e o flush; a composição com o bundle novo.

Feita em sete passos, cada um terminando com o build e os testes verdes: 1, o registro de artefatos 1.1.0; 2, o host do `drawio` (tool, tipo, skill, `drawio.diagrams/v1`); 3a, o desktopMain (`drawio.svg/v1` e o flush); 3b, o renderizador e o frame de medida; 3c, o node; 4a, o canvas compartilhado (`DiagramCanvas`, `host: 'node' | 'modal'`) e o `pág 1/N` do node; 4b, os dados por página e o modal.

Critérios:

1. A tool cria um diagrama a partir de um `.drawio` válido, com `path` relativo à pasta atual da Thread e com `path` absoluto; a revisão tem uma entrada `diagram.drawio` com o XML normalizado.
2. A tool recusa, sem publicar, cada caso de [Validação e normalização](#validação-e-normalização), cada combinação inválida do passo 1, um `path` fora da raiz do Project, um `path` dentro de `.doric/artifacts/<artifact_id>/`, um `path` ausente ou que é um diretório, `notes` igual a `Editado pelo usuário`, um XML igual ao da última revisão e `base_revision` acima da última; aceita XML comprimido e grava a forma em texto.
3. Com `artifact_id`, `base_revision` igual à última revisão e o `path` do rascunho, a tool publica a revisão seguinte; com `base_revision` abaixo da última, recusa sem publicar e lista as revisões novas, com as de nota `Editado pelo usuário` marcadas como edição do usuário; `checkout: true` grava a última revisão num `path` novo, cria as pastas que faltam, recusa um `path` que existe e não publica.
4. O node mostra o placeholder e depois o SVG num `<img>`; montar de novo a mesma revisão lê o SVG e o layout de `drawio.svg/v1.get` sem criar o iframe oculto nem o frame de medida; com `drawio.diagrams/v1.read` respondendo `unleased` e o cache presente, o node mostra o SVG e os pinos, sem `Comentar`; com `missing`, a linha de erro.
5. Um comentário numa forma e outro num conector chegam ao agente no envelope com `anchor="page/<p>/cell/<id>"` e `element="<rótulo>"`, um ponto livre chega com `anchor="page/<p>/point/<x>,<y>"` e `element="<rótulo mais perto>"`, e todos aparecem na saída seguinte da tool.
6. Numa revisão que mantém o `id`, o pino volta à célula; com o rótulo mudado, volta marcado como célula alterada; com a célula removida e outra de mesmo rótulo, vai para ela; sem nenhuma, fica solto; um ponto livre volta ao seu ponto na página dele.
7. Sob a política `request`, o node do diagrama não mostra `Autorizar`, `artifacts/v1.approve` de um diagrama devolve o registro sem gravar `artifacts.approved/v1`, e `awaitApproval` de um diagrama libera na hora; o preview continua mostrando `Autorizar`; com `diagram` fora de `exemptKinds`, o diagrama mostra `Autorizar`.
8. `bundles.test.ts` lista a tool `drawio_diagram` e o bundle `drawio` ativo; `bridge-exposure.snapshot.json` tem `drawio.diagrams/v1` (`read`), e a lista desktopMain de `app/backend/doric-host/tests/bridge-exposure.test.ts:127-156` tem `drawio.svg/v1` (`get`, `put`, `status`) e `papercraft.snapshot/v1` (`capture`), que faltava nela desde antes desta mudança.
9. `normalizeDiagram` da maior entrada aceita roda em menos de 250 ms no CI ([Validação e normalização](#validação-e-normalização)).
10. `app/desktop/doric-e2e/tests/drawio-editor.test.ts` ganha um caso: num iframe oculto do editor a frio, `export` em `svg`, em série, de 30 diagramas que o teste gera (o diagrama do critério 4 da fase 0 com rótulos numerados, cada um passado por `singlePageOf` da página 1) termina em menos de 10 s; e de novo num iframe com `dark=1`, em menos de 10 s. Os tempos e o tamanho dos SVGs vão para [Medidas](#medidas).
11. As linhas 1, 2, 3 e 6 da máquina de estados têm um teste cada em `bundles/features/drawio/tests/client/diagram-modal.test.tsx`.
12. No mesmo e2e, com o diagrama de formas, conectores, grupos e duas páginas do critério 4 da fase 0, cujas páginas têm células de mesmo `id`: para cada página P, o `export` em `svg` de `singlePageOf(xml, P)` tem, para toda célula com geometria de P, um elemento com `data-cell-id` igual ao `id` dela, e nenhum `data-cell-id` de célula que só existe na outra página; os SVGs das duas páginas diferem ([A3](#a3-cada-célula-tem-data-cell-id-no-svg), D22).
13. `bundles/features/drawio/tests/client/renderer.test.ts`: `singlePageOf` mantém os atributos do `<mxfile>` menos `pages`, copia o `<diagram>` pedido sem mudança, escolhe a primeira página sem `pageId` e lança `invalid-xml` para uma página que não existe; o `DrawioClient` falso recebe `export` sem `pageId` e com o `mxfile` de uma página; o layout é guardado com o `pageId` pedido.

### Fase 3 — edição no modal

Entrega: o bundle `drawio` 1.1.0, com `drawio.diagrams/v1@1.1.0` (`save`), o modo **Editar** em `diagram-modal.tsx`, `editor-frame.tsx`, `xml` e `revisions` em `DiagramData` (`diagram-data.ts`), a máquina de estados inteira e o diálogo de saída ([Onde fica cada parte](#o-modal-do-diagrama)).

Critérios:

1. Cada linha da [máquina de estados](#máquina-de-estados-do-modal-do-diagrama), para cada estado de origem, e cada ação do diálogo de saída têm um teste com um `DrawioClient` falso.
2. Salvar grava exatamente uma revisão com a nota `Editado pelo usuário`, e o modal vai a **Revisar** nela; salvar um XML igual ao da última revisão não grava outra e vai a **Revisar** nela.
3. Depois de um salvar sobre uma revisão nova do agente, a chamada seguinte da tool com a `base_revision` do agente é recusada e lista a revisão do usuário.
4. O `autosave` não grava revisão nem arquivo.
5. Fechar ou concluir com edição não salva, também em `carregando-modificado` e em `indisponível` com XML, pergunta, por `Esc`, fundo e botão; `Esc` e fundo no diálogo voltam à edição.
6. Sem lease, `save` responde `unavailable`, a faixa da linha 25 aparece e a edição volta ao editor.
7. Um link do diagrama não abre janela nem navega o editor.
8. Um `DrawioClient` falso que para de responder a `getXml()` leva `editando-modificado` a `indisponível` em até `EDITOR_HEARTBEAT_MS` + `EDITOR_LOAD_TIMEOUT_MS`, com o XML na memória.
9. A faixa de revisão nova aparece com um `artifacts.revised/v1` de revisão maior que B, não aparece com repetições de revisões até B, e aparece desde a abertura de **Editar** numa revisão mais velha que a última.
10. `app/desktop/doric-e2e/tests/drawio-editor.test.ts`, no harness da fase 0: o iframe do editor com a URL e a configuração do modal recebe um `merge` com a página inteira e uma forma movida (um `merge` com o mesmo `id` de página troca as células dela, achado da fase 0) e manda `autosave` com a geometria nova; depois de `reload()`, `onInit` com esse XML traz a forma movida de volta; a rede fica bloqueada. O caminho do salvar até o node novo fica nos testes de unidade (critérios 1 e 2), com serviços falsos.

### Fase 4 — exportar

Entrega: o bundle `drawio` 1.2.0, com `drawio.diagrams/v1@1.2.0` (`export`), e o diálogo.

Critérios:

1. Exportar grava `<caminho>.drawio` igual ao XML da revisão, com todas as páginas, e `<caminho>.drawio.svg` com o atributo `content`, que tem só a página 1, criando as pastas que faltam; o diálogo diz que o `.drawio.svg` tem só a página 1.
2. Com um dos arquivos como arquivo regular, `export` responde `exists` com ele e nada é gravado até `Substituir`; `Substituir` grava os dois.
3. Com `<caminho>.drawio` ou `<caminho>.drawio.svg` como pasta vazia, pasta com arquivos, link (para arquivo ou quebrado) ou fifo, `export` responde `blocked` com esse caminho e `directory` ou `special`, com `overwrite` falso e verdadeiro; nada é gravado, e a pasta fica com o conteúdo. O diálogo mostra a mensagem do motivo, sem `Substituir`.
4. Com um prefixo de pasta do caminho como arquivo regular, `export` responde `blocked` com esse prefixo e `not-a-folder`, e nada é gravado.
5. Um `test` que sai com código diferente de 0 e 1, ou `null`, e um `exec` que rejeita fazem `export` responder `internal` sem gravar.
6. Caminhos vazios, com mais de 512 caracteres, com `/` inicial, com segmento vazio, `.` ou `..`, dentro de `.doric/` (primeiro segmento `.doric`; `.doric-notes/x` passa) ou terminando em `.drawio` ou `.drawio.svg` são recusados com `invalid_input`, antes do lease.
7. Uma falha na gravação do `.drawio.svg` apaga o `.drawio` já gravado e responde `internal`.
8. O caminho inicial translitera o título ("Ação de Pedido" dá `docs/diagrams/acao-de-pedido`), e um título sem nada que sobre dá `docs/diagrams/diagrama`.
9. Sem lease, o diálogo mostra "O Project está sem sandbox ativo; tente de novo quando ele voltar" e fica aberto.
10. A exportação nunca chama `sandbox.getFile`.

## Medidas

Preenchidas pelas fases. A fase 0 rodou em 2026-10-29 no Linux arm64, com GL por software, Electron 44.4.3 e draw.io 32.6.1. As medidas da fase 2 são do mesmo ambiente, em 2026-10-29: `normalizeDiagram` no teste X16 (`bundles/features/drawio/tests/xml.test.ts:378-436`) e os 30 `export` no E1 (`app/desktop/doric-e2e/tests/drawio-editor.test.ts:686-726`), um iframe por tema.

| Medida                                                                         | Fase | Limite                          | Valor                                                                                        |
| ------------------------------------------------------------------------------ | ---- | ------------------------------- | -------------------------------------------------------------------------------------------- |
| Memória do processo do editor (`workingSetSize`), um editor                    | 0    | —                               | 205,1 MB                                                                                     |
| Memória do processo do editor (`workingSetSize`), renderizador e modal abertos | 0    | 400 MB (D23)                    | 296,5 MB no Linux; macOS e Windows pendentes, antes do release                               |
| Montar o iframe até `init`, a frio, p50 e p95                                  | 0    | p95 até 5 s                     | p50 264 ms, p95 272 ms                                                                       |
| Até a resposta do primeiro `load`, a frio, p95                                 | 0    | define `EDITOR_LOAD_TIMEOUT_MS` | 299 ms → `EDITOR_LOAD_TIMEOUT_MS` = max(897, 10 000) = 10 000                                |
| Até a resposta do primeiro `export`, a frio, p95                               | 0    | define `RENDER_TIMEOUT_MS`      | 322 ms → `RENDER_TIMEOUT_MS` = max(966, 5 000) = 5 000                                       |
| Webapp vendorizado                                                             | 0    | —                               | 2.753 arquivos, 103 MB                                                                       |
| `normalizeDiagram` da maior entrada aceita                                     | 2    | 250 ms                          | 123–193 ms, mediana de cerca de 133 ms                                                       |
| 30 diagramas exportados em série, a frio                                       | 2    | 10 s                            | cerca de 0,7 s; `export` p95 22–23 ms                                                        |
| Os mesmos 30 com `dark=1`                                                      | 2    | 10 s                            | cerca de 0,7 s; `export` p95 22–23 ms                                                        |
| Tamanho dos SVGs dos diagramas de teste                                        | 2    | `MAX_SVG_BYTES`                 | não anotado; o E1 o escreve no log (`app/desktop/doric-e2e/tests/drawio-editor.test.ts:719`) |

## Arquivos a mudar

### Fase 0

- Novos: `app/desktop/drawio-webapp/{project.json,vendor.mjs,drawio.lock.json,README.md}`; `app/desktop/drawio-webapp/tests/vendor.test.mjs`; `app/desktop/doric/src/platform/drawio/{origin.ts,assets.ts,index.ts}`; `app/desktop/doric/tests/drawio-origin.test.ts`; `app/desktop/doric-e2e/tests/drawio-editor.test.ts`.
- Alterados: `packages/bundle/src/contracts/platform.ts` (`DRAWIO_ORIGIN`, contrato, schema); `packages/bundle/src/contracts/index.ts` (reexporta `DRAWIO_ORIGIN`, `DoricDrawioV1`, `DoricDrawio`, `DrawioDescription` e `drawioDescriptionSchema`); `packages/bundle/tests/{values,platform-contracts}.test.ts`; `packages/bundle/src/runtime/version.ts`; `app/desktop/doric/src/platform/protocol/{resources.ts,csp.ts,mime.ts,handler.ts}` (`handler.ts` exporta `segmentsOf`); `app/desktop/doric/src/platform/windows/navigation-guard.ts`; `app/desktop/doric/src/platform/app.ts`; `app/desktop/doric/src/platform/generation/{process.ts,broker.ts}`; `app/desktop/doric/project.json` (`dependsOn` e `:51`); `app/desktop/doric/src/splash-page/index.html`; `app/desktop/doric-renderer/src/shell.html`; `app/desktop/doric-renderer/webpack.config.js` (`shellPath`); `app/desktop/doric/tests/{navigation-guard,protocol,generation,menus,window-capture,splash}.test.ts`; `app/desktop/doric/tests/artifacts-cache.test.ts` (o `drawioRoot` de `Resources`); `app/desktop/doric-platform/tests/import-map.test.mjs`; `app/desktop/doric-e2e/tests/{privileges,windows-protocol}.test.ts`; `app/desktop/doric-e2e/tests/support/harness.ts` (o registro de requisições, o domínio `Audits` do CDP e `PLATFORM_VERSION`); `app/desktop/doric-e2e/tests/run.ts` (o bloqueio de nomes, `:27-32`); `package.json` e `package-lock.json` (`tar`). `vendor.mjs` é JS; o `tsconfig.json` da raiz não muda.

### Fase 1a

- Novos em `packages/desktop/src/canvas/`: `index.ts`, `modal.tsx`, `toolbar.tsx`, `geometry.ts`, `gestures.ts`, `fit.ts`, `threads.ts`, `threads-view.ts`, `thread-log.ts`, `comment-flow.ts`, `thread-open.ts`, `theme.ts` e os módulos visuais movidos (`viewport.ts`, `header.tsx`, `footer.tsx`, `comment-field.tsx`, `pins-layer.tsx`, `thread-popover.tsx`, `avatar.tsx`, `comment-overlay.tsx`). Testes novos: `packages/desktop/tests/canvas/{gestures,fit,threads,threads-view,comment-flow,thread-open}.test.ts` e `packages/desktop/tests/canvas/modal.test.tsx`; `packages/desktop/tests/canvas/{viewport,thread-log}.test.ts`, movidos de `bundles/features/papercraft/tests/client/{viewport,thread-log}.test.ts`, com casos novos em `thread-log.test.ts` para a chave por Thread e `watchArtifactRevisions`. Stories: `packages/desktop/stories/canvas/{modal,header,footer,comment-field,pins-layer,thread-popover,avatar}.stories.tsx`. No Papercraft, novo `bundles/features/papercraft/src/client/surface/scene-hit.ts`.
- Novo fora de `src/canvas/`: `packages/desktop/src/styles/canvas.css` (as regras de componente do canvas, que saem de `bundles/features/papercraft/src/client/styles.css`).
- Alterados: `packages/desktop/package.json` (export `./ui/canvas`, `jdenticon`); `packages/desktop/project.json` (o glob de `tests/canvas/`); `packages/desktop/src/styles/theme.css` (`@import './canvas.css'` e `@source '../canvas'`, `:13`, `:17`); `packages/desktop/src/tokens/tokens.ts` (`version: PLATFORM_VERSION` no lugar de `'1.0.0'`, porque `packages/desktop/tests/tokens.test.ts:69-71` espera a versão da plataforma); `package-lock.json`; `bundles/features/papercraft/package.json` (sem `jdenticon`); em `bundles/features/papercraft/src/client/`: `styles.css` (as regras do canvas saem), `canvas-registry.ts` (`canvasOpen`), `frame-protocol.ts`, `surface/snapshots.ts` e `surface/live-frame.tsx` (o tema passa a `CanvasTheme` de `desktop/ui/canvas`); `packages/bundle/src/runtime/version.ts` e os caminhos fixos de [Plataforma: versão](#plataforma-versão) (e os testes de versão, se a 1a entrar antes da 0); `bundles/features/papercraft/manifest.json` (1.3.0, `engines`); em `bundles/features/papercraft/src/client/`: `index.ts`, `elements.tsx`, `comment.ts`, `domain/preview-state.ts`, `surface/{preview-container.tsx,preview-data.ts,preview-surface.tsx,controller.ts,overlays.tsx,command-toolbar.tsx,threads-view.ts,pin-geometry.ts}`; `bundles/features/papercraft/stories/support/{frame.tsx,preview.ts}`; `bundles/features/papercraft/tests/client/{pins,preview-state,element,pin-geometry}.test.ts` (`pin-geometry.test.ts:21-27` importa `ContentPoint`).
- Apagados em `bundles/features/papercraft/src/client/surface/`: `viewport.ts`, `preview-header.tsx`, `node-footer.tsx`, `comment-field.tsx`, `pins-layer.tsx`, `thread-popover.tsx`, `avatar.tsx`, `comment-overlay.tsx`, `gestures.ts`, `fit.ts`, `thread-log.ts`, `comment-flow.ts`, `thread-open.ts`; `bundles/features/papercraft/tests/client/{thread-log,viewport}.test.ts`; `bundles/features/papercraft/stories/surface/{avatar,comment-field,node-footer,pins-layer,preview-header,thread-popover}.stories.tsx`.

### Fase 1b

- Alterados: `bundles/features/papercraft/manifest.json` (2.0.0, `engines`, `provides`, `requires`); `bundles/features/papercraft/src/contracts/index.ts`; `bundles/features/papercraft/src/client/{index.ts,elements.tsx,commands.ts,styles.css}`; `bundles/features/papercraft/src/client/surface/{controller.ts,preview-container.tsx}`; `bundles/features/papercraft/src/desktop/index.ts`; `packages/desktop/src/canvas/header.tsx` (sem `'window'`); `bundles/features/papercraft/tests/client/{commands,element,live-frames}.test.ts`; `bundles/features/papercraft/tests/snapshot.test.ts`; `bundles/features/papercraft/stories/elements.stories.tsx`; `packages/desktop/stories/canvas/header.stories.tsx`.
- Apagados: `bundles/features/papercraft/src/desktop/commands.ts`; `bundles/features/papercraft/tests/client/route.test.ts` (o único teste dele é o da rota do canvas, `:11`).
- Não mudam: `app/backend/doric-host/tests/bridge-exposure.test.ts` (`:152` vem do contrato básico); `bundles/features/papercraft/src/skills/papercraft-preview/SKILL.md`, que não fala da janela do canvas (a única "window" dele é a metáfora de `:16`).

### Fase 2

- Alterados em `bundles/features/artifacts/`: `manifest.json`, `src/contracts/index.ts`, `src/client/elements.ts`, `src/host/artifacts.ts`, `tests/policy.test.ts`, `tests/client/element.test.ts`. `src/host/index.ts`, `tests/artifacts.test.ts` e `tests/support/harness.ts` não mudam.
- Novo, o bundle `bundles/features/drawio/` da [estrutura](#estrutura), sem `editor-frame.tsx` e sem `README.md` (que a etapa de docs cria):
  - `manifest.json`, `package.json`, `project.json`, `tsconfig.json`, `tsconfig.parts.json`, `tsconfig.client.json`, `tsconfig.spec.json`, `tsconfig.client-spec.json`;
  - `src/contracts/{index.ts,chat.ts}`; `src/host/{index.ts,kind.ts,xml.ts,diagrams.ts,tools/drawio-diagram.ts}`; `src/desktop/{index.ts,svg-cache.ts,comment-flush.ts}`; `src/skills/drawio-diagram/SKILL.md`;
  - `src/client/{index.ts,styles.css,elements.tsx,diagram-node.tsx,diagram-data.ts,diagram-view.tsx,diagram-modal.tsx,drawing.ts,model.ts,anchor.ts,comment.ts,renderer.ts,single-page.ts,measure.ts,frame-protocol.ts,frame-constants.ts}`, `src/client/frames/diagram.ts` e `src/client/frames/diagram/runtime.ts`; `diagram-modal.tsx` só com **Revisar**;
  - testes em `tests/{xml,drawio-diagram,diagrams,svg-cache,kind,comment-flush}.test.ts`, com `tests/support/{fakes,services}.ts`, e em `tests/client/{anchor,frame,element,renderer,measure}.test.ts` e `tests/client/diagram-modal.test.tsx`, com `tests/client/support/{diagram-harness,dom}.ts`.
- Composição: `tsconfig.json` da raiz (a referência, `:160`); `app/backend/doric-host/composition.json` (`"drawio"` depois de `"papercraft"`); `app/backend/doric-host/project.json` (o caminho no comando `stage` de `build-bundles` e `bundle-drawio` no `dependsOn`); `app/backend/doric-host/tests/bundles.test.ts`; `app/backend/doric-host/tests/bridge-exposure.snapshot.json` (`read`); `app/backend/doric-host/tests/bridge-exposure.test.ts` (a lista desktopMain, critério 8); os fixtures `app/backend/doric-host/tests/fixtures/stage1-parity/{skills,tools}.json` (a skill `drawio-diagram` e a tool `drawio_diagram`); `package-lock.json`.
- E2e: `app/desktop/doric-e2e/tests/drawio-editor.test.ts` (E1, os 30 diagramas, e E2, uma página por `export`).

### Fase 3

- Novos: `bundles/features/drawio/src/client/editor-frame.tsx`.
- Novos, também: `bundles/features/drawio/tests/client/{diagram-banner,diagram-editor,diagram-exit,diagram-save,editor-frame}.test.tsx` e `bundles/features/drawio/tests/client/support/modal-gestures.ts`.
- Alterados: `bundles/features/drawio/manifest.json` (1.1.0; `package.json` fica em 0.0.1); `bundles/features/drawio/src/{contracts/index.ts,host/diagrams.ts,host/tools/drawio-diagram.ts,client/diagram-modal.tsx,client/diagram-data.ts,client/drawing.ts}` (`drawio-diagram.ts` importa `sha256` de `../diagrams.js`; `drawing.ts` ganha `DiagramDrawing.createEditorClient`, Q3); `bundles/features/drawio/tests/diagrams.test.ts`; `bundles/features/drawio/tests/client/diagram-modal.test.tsx` e `bundles/features/drawio/tests/client/support/diagram-harness.ts` (o `DrawioClient` falso do editor e o `save` falso); `app/backend/doric-host/tests/bridge-exposure.snapshot.json` (`save`); `app/desktop/doric-e2e/tests/drawio-editor.test.ts`.
- Não mudam: `src/client/elements.tsx`, `src/client/diagram-node.tsx` e `src/client/diagram-view.tsx` ([Onde fica cada parte](#o-modal-do-diagrama)).

### Fase 4

- Alterados: `bundles/features/drawio/manifest.json` (1.2.0, `drawio.diagrams/v1@1.2.0` e a `description` nova; `package.json` não muda e fica em 0.0.1, DV1); `bundles/features/drawio/src/{contracts/index.ts,host/diagrams.ts,client/diagram-modal.tsx}` (`contracts/index.ts`: `DiagramExportInput`, `ExportResult`, `diagramExportInputSchema`, `exportResultSchema`, `drawioDiagramsMethods.export`, o método `export` de `DrawioDiagrams` e o comentário do `exec` de `LeasedSandbox`; o esboço de `DrawioDiagrams` em [Serviço `drawio.diagrams/v1` (host)](#serviço-drawiodiagramsv1-host) escreve os tipos em linha, e o código usa os tipos nomeados; `host/diagrams.ts`: `export`, `exportPathError`, `exportSvgError`, `exportDiagram` e `leasedValue`, comum a `save` e `export`; `client/diagram-modal.tsx`: o botão `drawio-export`, `ExportDialog` e `defaultExportPath`); `bundles/features/drawio/tests/diagrams.test.ts` (E1–E14) e `bundles/features/drawio/tests/support/fakes.ts` (o sandbox falso ganha links, entradas especiais, um `exec` substituível, `failWrites`, o registro `execs`, o `mkdir -p` e a troca de uma pasta pelo arquivo, como o Docker faz); `app/backend/doric-host/tests/bridge-exposure.snapshot.json` (`["export","read","save"]`).
- Alterados nos testes: `bundles/features/drawio/tests/client/support/diagram-harness.ts` (o `export` falso) e `bundles/features/drawio/tests/client/support/modal-gestures.ts` (os gestos do diálogo, DV3).
- Novo: `bundles/features/drawio/tests/client/diagram-export.test.tsx` (X1–X12). Nenhum e2e novo.

## Plano de testes

Seguindo a skill de testes comportamentais que o `AGENTS.md` exige: testes pelo contrato público, sem espiar estado interno.

| Fase | Teste                   | Onde                                                                                                                                 | O que prova                                                                                                                                                                                                                                                                                                                                                            |
| ---- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | handler da origem       | `app/desktop/doric/tests/drawio-origin.test.ts`                                                                                      | arquivos da raiz, `.xml` como `application/xml`, 404 fora dela, 405, CSP em HTML, passagem de outro host, `describe`                                                                                                                                                                                                                                                   |
| 0    | CSP e guarda            | `app/desktop/doric/tests/protocol.test.ts`, `app/desktop/doric/tests/navigation-guard.test.ts`                                       | `frame-src` novo; subframe da origem aceito, outro cancelado, `window.open` negado                                                                                                                                                                                                                                                                                     |
| 0    | contrato e broker       | `packages/bundle/tests/values.test.ts`, `app/desktop/doric/tests/{generation,menus,window-capture}.test.ts`                          | `doric.drawio/v1` entre os métodos de plataforma; `provideBroker` com `drawio`                                                                                                                                                                                                                                                                                         |
| 0    | editor offline          | `app/desktop/doric-e2e/tests/drawio-editor.test.ts`                                                                                  | A1, A2, A3, A4 e as medidas                                                                                                                                                                                                                                                                                                                                            |
| 1a   | lógica de canvas        | `packages/desktop/tests/canvas/*.test.ts`, portas falsas                                                                             | gestos, enquadramento, threads, log compartilhado por Thread entre dois `Services`, `watchArtifactRevisions`, fluxo de comentário, abertura de thread                                                                                                                                                                                                                  |
| 1a   | modal                   | `packages/desktop/tests/canvas/modal.test.tsx`                                                                                       | `onCloseRequest` por motivo; foco; `onKeyDown` filtrado                                                                                                                                                                                                                                                                                                                |
| 1a   | Papercraft no modal     | `bundles/features/papercraft/tests/client/{element,commands,live-frames}.test.ts`                                                    | critérios 4–8 da fase 1a                                                                                                                                                                                                                                                                                                                                               |
| 1b   | composição              | `app/backend/doric-host/tests/bundles.test.ts`                                                                                       | Papercraft 2.0.0 sem janela                                                                                                                                                                                                                                                                                                                                            |
| 2    | `normalizeDiagram`      | `bundles/features/drawio/tests/xml.test.ts`                                                                                          | cada regra de validação; compressão com teto; saída estável; o tempo da maior entrada                                                                                                                                                                                                                                                                                  |
| 2    | tool                    | `bundles/features/drawio/tests/drawio-diagram.test.ts`, serviços falsos                                                              | criar, revisar, `checkout`, combinações, caminhos, leitura do rascunho, `base_revision` e a lista de revisões novas, recusas, nota reservada                                                                                                                                                                                                                           |
| 2    | `read`                  | `bundles/features/drawio/tests/diagrams.test.ts`                                                                                     | `ok`, `missing` e `unleased`                                                                                                                                                                                                                                                                                                                                           |
| 2    | registro                | `bundles/features/artifacts/tests/policy.test.ts`, `bundles/features/artifacts/tests/client/element.test.ts`                         | `exemptKinds` na moldura, em `approve`, `awaitApproval` e `apply`; valor gravado sem o campo lê com o padrão                                                                                                                                                                                                                                                           |
| 2    | âncora e re-ancoragem   | `bundles/features/drawio/tests/client/anchor.test.ts`                                                                                | o hit-test por caixas, o `selector` de célula e de ponto, as três regras, o ponto livre e o estado de célula alterada                                                                                                                                                                                                                                                  |
| 2    | frame de medida         | `bundles/features/drawio/tests/client/frame.test.ts` (happy-dom)                                                                     | mensagens fora do schema, com `error` acima de `FRAME_ERROR_LIMIT`; limpeza do SVG, com o `foreignObject` só de texto mantido e o de mídia removido (D26); layout por `data-cell-id`, sem os vazios                                                                                                                                                                    |
| 2    | node                    | `bundles/features/drawio/tests/client/element.test.ts`                                                                               | cache antes da leitura, sem `pageId` em nenhum `get` do node; `put` da página 1 com `first`; `<img>` com os pinos do layout; `unleased` e `missing`; SHA-256 diferente; `Tentar de novo`; célula alterada; troca de tema; `pág 1/N` só com mais de uma página                                                                                                          |
| 2    | renderizador e medida   | `bundles/features/drawio/tests/client/{renderer,measure}.test.ts`, `DrawioClient` e frame falsos                                     | `singlePageOf` e `export` sem `pageId` (critério 13 da fase 2), filas seriais, `invalid-xml`, `unavailable` e recriação, mensagens fora do schema, remoção ociosa, troca de tema                                                                                                                                                                                       |
| 2    | uma página por `export` | `app/desktop/doric-e2e/tests/drawio-editor.test.ts`                                                                                  | critério 12 da fase 2                                                                                                                                                                                                                                                                                                                                                  |
| 2    | cache de SVG            | `bundles/features/drawio/tests/svg-cache.test.ts`                                                                                    | `put` e `get` do SVG e do layout, chave inválida recusada, SVG ou layout fora do formato recusado, arquivo ausente ou ilegível vira `null`; o ponteiro: `put` com `first` e `get` sem `pageId`, um ponteiro para os dois temas, ponteiro danificado ou sem entrada vira `null`, `put` recusado não grava o ponteiro, `get` fora do schema é `invalid_input` pela ponte |
| 2    | flush                   | `bundles/features/drawio/tests/comment-flush.test.ts`                                                                                | rascunho com nota e alvo vira um `comments/v1.add`; sem nota ou sem alvo fica na pilha; a ativação do desktopMain registra o flush e a limpeza o tira                                                                                                                                                                                                                  |
| 2    | modal em **Revisar**    | `bundles/features/drawio/tests/client/diagram-modal.test.tsx`                                                                        | linhas 1, 2, 3 e 6; cada abertura na revisão do node, página 1; pinos de outra página soltos (D24); as teclas de `reviewKeyOf`; sem a lista de revisões, sem menu; sem lease, sem `expandir`                                                                                                                                                                           |
| 2    | 30 diagramas            | `app/desktop/doric-e2e/tests/drawio-editor.test.ts`                                                                                  | critério 10 da fase 2                                                                                                                                                                                                                                                                                                                                                  |
| 3    | máquina de estados      | `bundles/features/drawio/tests/client/{diagram-modal,diagram-editor,diagram-save,diagram-exit,diagram-banner,editor-frame}.test.tsx` | cada linha por estado de origem, o diálogo, o `getXml()` periódico e a faixa; `E` em `reviewKeyOf`, `CmdOrCtrl+S` só em **Editar**; `onCloseRequest` do node só ao chegar a `fechado`; `xml` e `revisions` de `DiagramData`                                                                                                                                            |
| 3    | `save`                  | `bundles/features/drawio/tests/diagrams.test.ts`                                                                                     | revisão com a nota, XML igual sem revisão nova, revisão do agente mais nova, XML recusado, sem lease                                                                                                                                                                                                                                                                   |
| 3    | ponte                   | `app/backend/doric-host/tests/bridge-exposure.snapshot.json`                                                                         | `save` exposto à janela                                                                                                                                                                                                                                                                                                                                                |
| 3    | editor e `reload`       | `app/desktop/doric-e2e/tests/drawio-editor.test.ts`                                                                                  | critério 10 da fase 3 (E3)                                                                                                                                                                                                                                                                                                                                             |
| 4    | `export`                | `bundles/features/drawio/tests/diagrams.test.ts`                                                                                     | dois arquivos, pastas criadas, `exists` só para arquivo regular, `blocked` para pasta vazia e cheia, link e fifo (também com `overwrite`) e para prefixo que não é pasta, conferência que falha como `internal`, nenhum `getFile`, caminhos recusados, falha na segunda gravação                                                                                       |
| 4    | diálogo                 | `bundles/features/drawio/tests/client/diagram-export.test.tsx`                                                                       | slug, `Substituir`, as três mensagens de `blocked` sem `Substituir`, `render` que rejeita, erro e sem lease                                                                                                                                                                                                                                                            |

Comandos: `npx nx run bundle-drawio:test`, `npx nx run bundle-papercraft:test`, `npx nx run bundle-artifacts:test`, `npx nx run bundle:test`, `npx nx run desktop:test` (o projeto de `packages/desktop`), `npx nx run doric-app:test`, `npx nx run doric-platform:test`, `npx nx run doric-app-e2e:e2e`, `npx nx run doric-host:test`, e `typecheck` de cada projeto tocado (o de `doric-app` é inferido pelo Nx).

## Docs a atualizar

Por fase; a etapa de docs de cada fase atualiza o feature doc e os docs da arquitetura que a fase tocou.

- Fase 0 (feito):
  - `docs/features/threads-drawio-diagrams.md` (novo, status `accepted`): o comportamento da fase 0 (`doric.drawio/v1`, a origem do editor, o `frame-src` e a guarda, o webapp vendorizado) e as decisões tomadas até aqui.
  - `GROUNDING.md`: o projeto `app/desktop/drawio-webapp`, `doric.drawio/v1` desde a plataforma 1.1.0, a passagem com `net::ERR_UNEXPECTED`, o `frame-src` do shell e a guarda de navegação.
  - `docs/architecture/bundles/doric-protocol.md`: a origem do editor ao lado de `doric://app` e o `frame-src` novo.
  - `docs/architecture/bundles/versioning.md`: `doric.drawio/v1` entre os contratos `doric.*`, desde a plataforma 1.1.0.
- Fase 1a (feito): `docs/architecture/bundles/versioning.md` (plataforma 1.2.0, com `desktop/ui/canvas`); `docs/architecture/bundles/papercraft/README.md` (o botão `expandir` e o modal); `docs/architecture/bundles/papercraft/isolamento.md:71` ("a revisão aberta no modal fica sempre viva"); o feature doc.
- Fase 1b (feito): `docs/architecture/bundles/papercraft/README.md` (as seções da janela, `:278-351`, `:541-543`, `:580`, `:594-606`, passam a descrever o modal; a limitação 19, `:588`, fica, marcada "Resolvido", para as seguintes não mudarem de número); `docs/architecture/bundles/comments.md` (`:106` e `:122` passam da janela do canvas ao modal); `bundles/features/papercraft/README.md`; o feature doc.
- Fase 2: `docs/architecture/bundles/artifacts.md` (a linha `diagram`, `:137`, passa a "Sim", com o bundle `drawio`; `exemptKinds` na política de revisão, `:155-166`, e no contrato); `docs/architecture/bundles/comments.md` (a tabela de consumidores, `:156`, ganha o `drawio`, com o alvo "A revisão de um artefato `diagram`" e a âncora "Uma célula (`page/<p>/cell/<id>`) ou um ponto da página (`page/<p>/point/<x>,<y>`)"); o `README.md` novo do `drawio`; o feature doc.
- Fase 3: o `README.md` do `drawio` (o modo **Editar**); `GROUNDING.md`; `docs/architecture/bundles.md`; o feature doc.
- Fase 4: o `README.md` do `drawio` (a exportação); `GROUNDING.md`; `docs/architecture/bundles.md`; o feature doc, com status `implemented`.

## Questões em aberto

A Q11 foi fechada por D21. As quatro decisões que a fase 2 deixou para a fase 3 foram tomadas antes dela, todas pela recomendação:

- **Q1 da fase 3 — Revisar depois do salvar.** Fechada por (a): `save` devolve `{ revision, revisions, sha256 }`, com o `sha256` da entrada `diagram.drawio` da revisão que responde; o modal monta o bloco com ele e relê `artifacts/v1.revisions` para o menu (`useRevisionRecords` devolve `{ records, reload }`).
- **Q2 da fase 3 — o cabeçalho em Editar.** Fechada por (a): em **Editar**, `diagram-modal.tsx` desenha o próprio `CanvasHeader host="modal"` com o título e `rev B`, sem `Comentar` nem `Enviar ao agente`.
- **Q3 da fase 3 — o `DrawioClient` falso do editor.** Fechada por (a): `DiagramDrawing` ganha `createEditorClient`, o ponto de injeção dos testes.
- **Q4 da fase 3 — `Editar` e `Salvar no Project` sem a revisão lida.** Fechada por (a): ficam desabilitados enquanto `data.xml` ou o scope faltam (`editBaseOf`: `save` precisa do scope) (`Salvar no Project` chegou na fase 4, com a mesma regra).

As questões da fase 4 foram decididas pelo usuário antes da implementação:

- **Q1 da fase 4 — slug e acentos.** Transliterar: NFD, sem as marcas combinantes, minúsculas, cada sequência fora de `[a-z0-9]` vira `-`, sem `-` nas pontas; vazio vira `diagrama`.
- **Q2 da fase 4 — regras do caminho.** Recusar um segmento `.` e um caminho terminado em `.drawio` ou `.drawio.svg`; outros pontos, como `v1.2`, passam.
- **Q3 da fase 4 — fechar o diálogo.** `Esc`, o backdrop do diálogo e `Cancelar` fecham só o diálogo e são ignorados enquanto ocupado; os pedidos de fechar o modal são ignorados com o diálogo aberto; `Substituir` reusa o SVG já desenhado.
- **Q4 da fase 4 — `rm` que falha no desfazer.** Engolido; `export` lança o erro da gravação.
- **Q5 da fase 4 — a mensagem de `unavailable`.** "O Project está sem sandbox ativo; tente de novo quando ele voltar".

A implementação da fase 4 tomou três decisões próprias, citadas no texto por estes nomes:

- **DV1.** `bundles/features/drawio/package.json` fica em 0.0.1; só o manifesto vai a 1.2.0.
- **DV2.** As regras de `path` e `svg` de `export` são conferidas em `execute`, antes do lease, e não no schema zod.
- **DV3.** `tests/client/support/modal-gestures.ts` ganha os gestos da exportação.

## Revisões

| Versão | Data       | Mudança                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Reviews                                                                                                                                                                                                                                                                                                                                     |
| ------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | 2026-10-28 | Conceito inicial                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | —                                                                                                                                                                                                                                                                                                                                           |
| 2      | 2026-10-28 | Decisões D1–D5, glossário, fases, origem por `protocol.handle`, alternativa da fonte `drawio`, aprovação definida, exportação num formato, Mermaid fora da v1, sem detecção de conflito, sandbox e guarda de navegação, links, rascunho e recuperação, lease, re-ancoragem, páginas e XML comprimido, SVG derivado, caminhos completos                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Conceito: Scope, Critique, Comprehension                                                                                                                                                                                                                                                                                                    |
| 3      | 2026-10-28 | Conceito aceito. D6–D10: fases como propostas; editor por `protocol.handle` num host `https:` fixo, com plano B; bundle novo com tipo, tool e skill; aprovação fora da v1; exportação em `.drawio` e `.drawio.svg`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Usuário                                                                                                                                                                                                                                                                                                                                     |
| 4      | 2026-10-28 | Spec, depois do relatório de busca: origem e webapp na plataforma (S1, S2); contrato `doric.drawio/v1`; peças do canvas em `desktop/ui/canvas` (S3); SVG derivado (S4); frame de SVG (S5); âncora `page/<p>/cell/<id>` (S6); arquivo de trabalho (S7); `review` no registro (S8); atalhos pelo modal (S9); manifesto, tool, serviços, máquina de estados, falhas, critérios por fase                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Relatório de busca                                                                                                                                                                                                                                                                                                                          |
| 5      | 2026-10-28 | A lógica de canvas que não depende da âncora vai para `desktop/ui/canvas`, com portas, e a fase 2 depende da 1a; o SVG é desenhado no client por um iframe oculto com a `DrawioClient`, e `doric.drawio/v1` fica só com `describe`; o cache de SVG fica no `drawio`; o registro não ganha `author`; uma fonte só para a origem e para o teto do XML; sem aquecer o cache ao salvar; sem rascunho, sem `openLink`, sem a tecla de envio e sem `libraries=1`; âncora sem `page`, `cell` e `ends`; parâmetros do editor resumidos                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Etapa 1: Scope                                                                                                                                                                                                                                                                                                                              |
| 6      | 2026-10-28 | D11–D14; Q7 e Q12 fechadas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Usuário                                                                                                                                                                                                                                                                                                                                     |
| 7      | 2026-10-28 | Formato de spec do repositório (ordem das seções, cabeçalho, Questões em aberto, Revisões, Medidas); glossário do runtime antes das decisões; estado do arquivo de trabalho com avisos ao agente, edições não publicadas preservadas, `baseRevision` e `save` idempotente (S7); caminhos da tool pela pasta atual e `workingFile` absoluto; webapp inteiro menos `WEB-INF/` e `META-INF/`, com prova das bibliotecas (A4); plataforma 1.2.0 e `engines.doric` (S10); descompressão com teto e tetos medidos; node sem lease a partir do cache; 3 frames vivos de diagrama e substituto `<img>`; medidas e limites da fase 0 e da fase 2, com os prazos derivados delas; viewer avaliado; `export` com `xml`; S9 com o motivo real; reinício e queda do editor na máquina de estados, uma linha por transição; despejo do cache; `.drawio.svg` com a página 1; limpeza do SVG apoiada no CSP, com teste; janela oculta de render descrita; revisão nova do agente pelo log da Thread; registro de violações de CSP pelo CDP; Q13 e Q14 novas                                                                                                                                                                                                                                                                                                                                                                                                                      | Etapa 2: Critique, Comprehension, Structural, Style                                                                                                                                                                                                                                                                                         |
| 8      | 2026-10-28 | D15–D20 (Q4, Q8, Q9, Q10, Q13, Q14 fechadas); Q11 aberta, com a lista de tipos isentos na política como desenho de trabalho (S8); sem arquivo de trabalho nem estado: a saída nomeia o arquivo guardado da revisão, a tool pede `base_revision` e recusa base velha listando as revisões do usuário (S7); uma regra de XML igual para a tool e o `save`, sem idempotência nem repetição; o SVG num `<img>`, com o layout medido uma vez e guardado no cache, sem frames vivos nem substituto (S5); sem despejo do cache; `watchArtifactRevisions` no log compartilhado; webapp sem `templates/`; janela oculta de render resumida; sem teste novo de `frameCsp` e sem as medidas de páginas do `xmlsvg` e do instalador                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Etapa 3: Scope; Usuário                                                                                                                                                                                                                                                                                                                     |
| 9      | 2026-10-28 | D21 (Q11 fechada); status approved; `checkout` no lugar de nomear o arquivo guardado, e `terminal` no lugar de `read` na skill (S7); `runtime.workspace/v1` nos requisitos; `drawio.diagrams/v1.read` para separar falta de lease de artefato ausente, e versões 1.0.0–1.2.0 por fase; ponto livre como `selector` com a página; log compartilhado por Thread no módulo; máquina de estados com `carregando-modificado`, diálogo de saída, destino do salvar, verificação periódica do editor e sem desabilitar por lease; faixa de revisão nova definida; prompt do node no `save`; plataforma: `drawioDescriptionSchema`, `Object.freeze`, `BrokerDeps.drawio`, os testes e caminhos de versão, `.xml` em `mime.ts`; Tailwind e globs de teste do `drawio` e de `packages/desktop`; memória por `workingSetSize`; e2e no nível da plataforma; listas de arquivos corrigidas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Etapa 4: Readiness, Codebase; Usuário                                                                                                                                                                                                                                                                                                       |
| 10     | 2026-10-29 | Resultados da fase 0: A1, A2 e A4 passaram, A3 falhou (o `export` em SVG ignora `pageId`); D22: o renderizador exporta um `mxfile` só com a página pedida, com `singlePageOf`, e o `.drawio.svg` tem só a página 1; D23: teto de memória de 400 MB para os dois editores, no lugar de D14, com 296,5 MB medidos no Linux e nova medida em macOS e Windows antes do release; Medidas preenchidas; `RENDER_TIMEOUT_MS` 5 000 e `EDITOR_LOAD_TIMEOUT_MS` 10 000; `sha256` no lock, sem `NOTICE`; `drawioCsp` sem `'unsafe-eval'`; `net::ERR_UNEXPECTED` na passagem; `merge` troca as células da página; critérios 12 e 13 da fase 2; fase 0 concluída                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Fase 0; Usuário                                                                                                                                                                                                                                                                                                                             |
| 11     | 2026-10-29 | A spec segue o código da fase 0: os quatro caminhos fixos de versão, com `webpack.config.js`, e os testes que já leem `PLATFORM_VERSION`; o que `origin.ts` e `assets.ts` exportam, `drawioRoot` em `resources.ts` e `segmentsOf` de `handler.ts`; o bloqueio de nomes em `run.ts`, com `EXCLUDE 127.0.0.1`; `tar`, `vendor.test.mjs` e o alvo `test` de `drawio-webapp`; `NOTICE` só quando o arquivo tem um; Docs a atualizar por fase, com o que a fase 0 já mudou                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Docs (fase 0)                                                                                                                                                                                                                                                                                                                               |
| 12     | 2026-10-29 | A spec segue o código das fases 1a e 1b: o tema da plataforma lê `../canvas` e importa `canvas.css`, e o `drawio` não lê mais `packages/desktop/src`; `canvas.css`, `theme.css`, `tokens.ts` (`version: PLATFORM_VERSION`) e os arquivos do Papercraft que a fase 1a tocou nos Arquivos a mudar; no Papercraft no modal, a revisão que o node mostra, o `Esc` relatado pelo frame, o `Esc` do canvas que não desfaz o isolamento, o estado `closed \| open \| closing` do node e a guarda de abertura de thread só no node; fases 1a e 1b feitas em Docs a atualizar, com a limitação 19 mantida como "Resolvido"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Docs (fases 1a e 1b)                                                                                                                                                                                                                                                                                                                        |
| 13     | 2026-10-29 | Implementação da fase 2: D24–D27 (Q1, Q2, Q3 e Q7 da fase 2); `drawio.svg/v1.get` com `pageId` opcional e o ponteiro `first-page.json` por revisão, `put` com `first`, e o node pede a página 1 sem `pageId`; `pág P/N` no rótulo `drawio-page`, sem prop de página em `CanvasHeader`; `expandir` sem Thread; `doric:comment-thread-open` adiado para o diagrama; `status()` indisponível como falha de desenho; `reviewKeyOf` com `CmdOrCtrl+Shift` e `+`; revisões lidas uma vez por abertura; limpeza do SVG e `FRAME_ERROR_LIMIT`; `test -f` e `test -e` na tool, as mensagens dela e o risco aceito da repetição depois de o lease cair; reexporte de `./chat.js` e o build; manifesto da fase 2 em 1.0.0; lista desktopMain da ponte; Estrutura, Arquivos a mudar e Plano de testes da fase 2 como entregues; Medidas da fase 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Fase 2; Usuário                                                                                                                                                                                                                                                                                                                             |
| 14     | 2026-10-29 | Fases 3 e 4 aprovadas para começar. Exportação: a existência sai de `sandbox.getFile`, que no Docker lê uma pasta como arquivo e uma pasta vazia como ausente, e passa a `exec` com `test -h`, `-d`, `-f` e `-e` nos dois arquivos e `test -d`/`-e`/`-h` nos prefixos de pasta; `ExportResult` com `blocked` (`directory`, `special`, `not-a-folder`), nunca substituído por `overwrite`; códigos diferentes de 0 e 1 como `internal`; leitura da revisão com `not_found`; as pastas criadas pelo `mkdir -p` de `writeFile`; o comentário do `exec` de `LeasedSandbox`; passo `blocked` do diálogo, com as mensagens, e `drawing.render` no lugar de `renderDiagram`; critérios, modos de falha, riscos, segurança, Arquivos a mudar (`tests/support/fakes.ts`, `diagram-harness.ts`) e Plano de testes da fase 4. Fase 3: os arquivos como a fase 2 os criou (`diagram-node.tsx`, `diagram-view.tsx`, `diagram-modal.tsx`, `diagram-data.ts`), sem `elements.tsx`; "Onde fica cada parte" no modal; `xml` e `revisions` em `DiagramData`; `E` em `reviewKeyOf`, `CmdOrCtrl+S` em **Editar** e `onCloseRequest` só ao chegar a `fechado`; o botão fechar é do `CanvasModal`; Q1–Q4 da fase 3 abertas                                                                                                                                                                                                                                                             | Usuário                                                                                                                                                                                                                                                                                                                                     |
| 15     | 2026-10-29 | Implementação da fase 3: Q1–Q4 da fase 3 fechadas pelas recomendações; só `manifest.json` do `drawio` sobe a 1.1.0 (`drawio.diagrams/v1@1.1.0`), `package.json` fica em 0.0.1; o cliente manda `autosave: true` (o e2e, o valor cru 1); `editorUrl` mantém `spin=1`; O1: `save` responde `not_found` para artefato desconhecido e `invalid_input`, com a redação da tool, para um que não é diagrama; textos e test ids do diálogo de saída ("Salvar as alterações?": Salvar, Descartar, Continuar editando); R6: o `save` da janela vai sem `promptId`, e a revisão cai no prompt que criou o artefato (risco aceito); `useDiagramData` sobe para o conteúdo do modal; `Tentar de novo` não reconfere `status`; pedidos de fechar são ignorados com o diálogo de saída aberto; `useRevisionRecords` devolve `{ records, reload }`; `save` devolve `sha256` (Q1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Usuário; `Editar` e `E` ficam desabilitados também sem scope (`editBaseOf`), porque `save` precisa dele; em `indisponível` a assinatura de `watchArtifactRevisions` fica ativa e só a faixa some; o corpo da spec (contrato de `save`, escopo da ponte, URL, estrutura, manifesto, arquivos e testes da fase 3) passa a descrever a entrega |
| 16     | 2026-10-29 | Implementação da fase 4: Q1 (o slug translitera: NFD, sem marcas), Q2 (recusa um segmento `.` e um caminho terminado em `.drawio` ou `.drawio.svg`), Q3 (`Esc`, o backdrop do diálogo e `Cancelar` fecham só o diálogo, ignorados enquanto ocupado; pedidos de fechar o modal ignorados com o diálogo aberto; `Substituir` reusa o SVG), Q4 (um `rm` que falha no desfazer é engolido) e Q5 (a frase de `unavailable` no diálogo é "O Project está sem sandbox ativo; tente de novo quando ele voltar", não a do `save`: desvio das Regras transversais, corrigidas); a regra "nenhum botão é desabilitado por lease" passa a dizer que `Editar` e `Salvar no Project` ficam desabilitados sem `data.xml`, que uma leitura `unleased` não dá; DV1: `package.json` fica em 0.0.1; DV2: as regras de caminho e SVG ficam em `execute`, antes do lease, não no schema; DV3: `modal-gestures.ts` ganha os gestos da exportação; `readRevision` no mesmo `withLease`, e `leasedValue` comum a `save` e `export`; `Salvar` continua visível ao lado de `Substituir` em `exists`; test ids `drawio-export` e `drawio-export-dialog` e o campo `aria-label="Caminho"`; `Esc` tomado no `form`; testes do diálogo em `tests/client/diagram-export.test.tsx` (X1–X12), não em `diagram-modal.test.tsx`; sem e2e novo; contrato, manifesto, Exportar, critérios, Arquivos a mudar, Plano de testes e Questões em aberto da fase 4 como entregues; todas as fases concluídas | Usuário (Q1–Q5)                                                                                                                                                                                                                                                                                                                             |

## Referências

- [Papercraft](../architecture/bundles/papercraft/README.md) e [o preview num iframe isolado](../architecture/bundles/papercraft/isolamento.md).
- [Artefatos](../architecture/bundles/artifacts.md), [Comentários](../architecture/bundles/comments.md), [Eventos e nodes](../architecture/bundles/events-and-nodes.md), [Chat](../architecture/bundles/chat.md), [Versionamento](../architecture/bundles/versioning.md).
- [Janelas abertas pelo core](../architecture/bundles/windows.md) e [UI composta por bundles](../architecture/bundles/ui-composition.md).
- draw.io for React: <https://www.drawio.com/react/?framework=other>; [`jgraph/drawio-react`](https://github.com/jgraph/drawio-react).
- draw.io: [embed mode](https://www.drawio.com/docs/reference/embed-mode/), [parâmetros de URL](https://www.drawio.com/docs/reference/supported-url-parameters/), [repositório do editor](https://github.com/jgraph/drawio).
