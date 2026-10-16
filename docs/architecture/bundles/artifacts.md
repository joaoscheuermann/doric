# Artefatos

**Estado:** parcialmente implementado. Parte da [arquitetura de bundles](../bundles.md); `GROUNDING.md` continua sendo o contrato da implementação atual. Já existem: o bundle `artifacts` (`bundles/features/artifacts`) com `artifacts/v1` (incluindo `revisions` e o método só de host `awaitApproval`), o registro `artifact.kind/v1`, o cache desktop `artifacts.cache/v1`, os quatro eventos, a política de revisão por Project, a moldura no desktop com o "Autorizar" sob `request` (sem lista de revisões: a conversa é o histórico), e o tipo `preview` do [papercraft](./papercraft.md) como corpo dentro dela. Diferenças em relação ao texto abaixo: a cópia de trabalho guarda os bytes em `.doric/artifacts/<artifactId>/<revision>/<path>` (leituras caem no layout antigo `<artifactId>/<path>`); `artifact.kind/v1` tem um provedor só, com `register` devolvendo um Disposable, em vez de cardinalidade `many`; o tipo declara o corpo com `bodyTag` e, com `header: 'body'`, desenha o próprio cabeçalho; a configuração se chama `artifacts.review-policy/v1` e guarda o mapa por Project dentro de um documento só; os eventos `created`/`revised` carregam também `entries`, `source`, `path`, `entry` e `notes`; uma aprovação ou aplicação vinda da janela cai no log da Thread e do prompt que criaram o artefato; e os `requires` do manifesto não incluem `tools/v1`, `skills/v1` nem `storage/v1`. Ainda não existem: quem emite `artifacts.applied/v1`, retenção e órfãos (decisões 7 e 8) e tipos além do `preview`.

## Resumo

Um artefato é o **entregável durável** que o agente produz dentro do app para **mostrar, explicar ou comprovar** uma mudança no código do Project — a superfície que a conversa não sabe dar: um preview vivo, uma gravação, um diagrama interativo. Ele é o canal de colaboração assíncrona do agente: em vez de o usuário acompanhar cada tool call, ele olha os entregáveis em marcos, e o comentário de um artefato orienta o agente.

O Doric é **YOLO por padrão**: o agente não pede licença para agir. Um artefato, portanto, **não é um portão** — é uma janela para o trabalho do agente, que o usuário olha, comenta e manda ajustar. A revisão prévia existe como **escolha de um Project** ([a política de revisão](#a-política-de-revisão)), e não como o caminho normal.

O Doric já tem as peças de que o artefato depende — log durável de eventos, nodes de conversa, storage, lease do sandbox, escopos de chamada — e o que falta é o registro que dá **identidade, revisões, âncoras e comentários** a esses entregáveis.

A definição operacional, que o resto do documento detalha: um artefato tem **identidade estável** (`artifactId`), **revisões** imutáveis, um **tipo** (`kind`) declarado por um provedor, **âncoras** no código que ele toca (`targets`), um **evento durável** por transição, um **node** na conversa e **comentários ancorados** ([comentários](./comments.md)) como estado de revisão.

## O que é e o que não é

Um artefato **é**:

- um entregável com **identidade** (`artifactId`) e **revisões** imutáveis — a revisão 2 não apaga a 1, porque o node e os comentários da 1 continuam válidos;
- um **retrato sobre código**: existe para o usuário ver o que está sendo feito, e por isso declara as âncoras que toca (`targets`);
- **durável e reconstruível**: cada transição é um evento do log, e o replay reconstrói a conversa inteira, revisão por revisão;
- **comentável**: comentários ancorados, que orientam a revisão seguinte.

Um artefato **não é**:

- **a mudança em si.** O diff aplicado ao código é o efeito, não o artefato; o artefato mostra o que a mudança faz. `artifacts.applied/v1` fecha o ciclo, mas o arquivo do Project continua sendo o arquivo do Project;
- **um plano, um resumo ou um diff.** Esses já têm casa: o texto do agente na conversa e o painel de mudanças do `git`. Um artefato só existe quando o entregável precisa de uma superfície que a conversa não dá — é a regra de [tipos](#os-tipos-artifactkindv1) abaixo;
- **o histórico do provider.** É o mesmo registro distinto de sempre ([eventos e nodes](./events-and-nodes.md)); o artefato é projeção do log durável, não do histórico de retomada;
- **log ou diagnóstico.** Rastreio, métricas e arquivos de log são [observabilidade](./observability.md), não entregável;
- **um artefato de bundle** — o sentido que a plataforma já usa, abaixo.

## Dois sentidos de artefato

A plataforma já chama de "artefato" outra coisa: o **arquivo distribuído de um bundle**, endereçado por SHA-256, que o host publica no catálogo e o desktop baixa e verifica antes de ativar.

| Sentido             | O que é                                                                                                 | Onde aparece hoje                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Artefato de bundle  | Um arquivo do pacote de um bundle, identificado pelo SHA-256                                            | `doric.catalog/v1.artifact({ sha256 })` → `{ sha256, base64 }` (`packages/bundle/src/contracts/platform.ts:406-415`)           |
| Artefato de bundle  | A cópia verificada no desktop, gravada só depois de o hash conferir                                     | `ArtifactCache`, em `userData/bundles/<id>@<version>/<path>` (`app/desktop/doric/src/platform/catalog/artifacts.ts:1-5,45-70`) |
| Artefato do Project | O entregável que o agente produz dentro do Project para mostrar uma mudança, com revisões e comentários | Este documento: `/workspace/.doric/artifacts/<artifactId>/`, eventos `artifacts.*`, node na conversa                           |

A composição usa o primeiro sentido — "o host guarda bundles instalados, artefatos e composição" (`bundles.md:21`), "o desktop guarda apenas um cache verificado desses artefatos" (`composition-and-distribution.md:7`).

Regra: **na plataforma, "artefato" é a unidade de distribuição; no Project, é o entregável revisável.** Os dois convivem porque vivem em escopos diferentes — um é catálogo de plataforma, o outro é estado de Project —, e os nomes novos não usam a palavra sozinha em nenhum contrato: o registro é `artifacts/v1`, os eventos são `artifacts.*`, e nenhum deles é confundível com `doric.catalog/v1`.

## Onde vive

No **root do workspace do Project**, que é o root do sandbox:

```text
/workspace/.doric/
  artifacts/<artifactId>/
    artifact.json      # manifesto pequeno: identidade, tipo, revisão, âncoras, entradas
    <payload>          # o que o tipo define: index.html, …
```

Três fatos da plataforma fixam esse lugar:

- O workspace de um Project é um só, e **as Threads o compartilham**: "Threads share their Project's sandbox; each Thread's working directory starts at the sandbox's workspace root `/workspace`" (`GROUNDING.md:605-607`). O `cwd` da Thread é o padrão `/workspace` do registro da Thread (`bundles/runtime/runtime/src/contracts/storage.ts:86`), e `runtime.workspace/v1` o move para qualquer path **dentro** do root do workspace (`bundles/runtime/runtime/src/contracts/workspace.ts:1-15,58-62`).
- O host alcança o workspace pelo **lease**: `runtime.lease/v1.describe()` devolve a identidade e o **root**, e o contrato tem `readFile` e `writeFile` (`bundles/runtime/runtime/src/contracts/lease.ts:96-105`). É exatamente o caminho que o `files` já usa (`bundles/features/files/src/host/sandbox.ts:1-39`).
- A guarda de caminho **já existe e não é do artefato**: a regra do sandbox recusa qualquer path que resolva fora do root do workspace (`GROUNDING.md:606-609`; `runtime.workspace/v1` devolve `outside` no `CwdChange`, `workspace.ts:15-16`).

Daí a regra: **tudo o que o Doric escreve no workspace vive sob `.doric/`**, nunca espalhado pelo código do usuário; e o que é **derivado e descartável** — a forma compilada de um preview, por exemplo — fica no **cache do app**, não no Project, porque o cache é da plataforma e o Project é do usuário.

`artifact.json` é o índice da cópia de trabalho:

```json
{
  "artifactId": "…",
  "kind": "preview",
  "title": "Checkout com o botão de pagar",
  "revision": 2,
  "targets": [{ "path": "src/checkout/Checkout.tsx", "lines": [40, 48] }],
  "entries": [{ "path": "index.html", "sha256": "…" }]
}
```

- **`.doric/` é estado do app no Project, não código do usuário.** Ele nasce ignorado pelo Git; versionar um artefato é escolha, não padrão. O entregável que se versiona é o diff do código de verdade; o artefato é o que o explica.
- **A verdade durável é o log, não o diretório.** O evento leva identidade, tipo, revisão, âncoras e as **entradas** (`path` + `sha256`) — nunca os bytes. O conteúdo fica no diretório e a forma derivada, no cache do app. O replay reconstrói o estado a partir do log; o manifesto é regenerável, e os hashes do evento verificam a cópia de trabalho.
- **De onde vem o conteúdo é do tipo.** Um `preview` é derivado: o payload é código do Project, e a forma compilada se reconstrói. Um tipo que escreve conteúdo próprio — uma gravação, um diagrama — guarda o arquivo no diretório, e sem ele o artefato aparece como indisponível, com o evento ainda nomeando o que existiu.

## Ciclo de vida e eventos

```text
created ──▶ revised ──▶ applied
               │
               └─▶ approved        (só com a política `request`)
```

| Evento                  | Payload (resumo)                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `artifacts.created/v1`  | `artifactId`, `revision`, `kind`, `title`, `targets`, `payload` (o schema do tipo) |
| `artifacts.revised/v1`  | `artifactId`, `revision`, `changeNote`                                             |
| `artifacts.approved/v1` | `artifactId`, `revision`, `scope` — só existe com a política `request`             |
| `artifacts.applied/v1`  | `artifactId`, `revision`, `files`                                                  |

Declarados em `contracts/` com `defineEvent` e registrados com `events/v1` na ativação, como qualquer evento ([contratos](./contracts.md)). O sumidouro é o do `runtime`, com `scopeKeys` `['projectId', 'threadId', 'promptId']` no stream `runtime.thread.events/{threadId}` (`bundles/runtime/runtime/src/contracts/events.ts:28-32`) — **não há sumidouro novo**, e um `append` fora desse escopo é recusado com `invalid_scope`, como manda o [eventos e nodes](./events-and-nodes.md).

O comentário **não** é um evento do artefato: ele é do registro de [comentários](./comments.md), que aponta para a revisão como alvo. São dois streams, e é isso que permite a qualquer funcionalidade comentar qualquer coisa.

Uma revisão é **imutável**: revisar publica um evento novo e um node novo, e o node antigo continua na conversa com os comentários que tinha. É o que permite ao usuário comparar "o que eu pedi" com "o que veio".

## O contrato `artifacts/v1`

Serviço de host fornecido pelo bundle `artifacts`, cardinalidade `one` como os demais. Os métodos que uma janela chama declaram `desktopScope` com `['projectId', 'threadId', 'promptId']` e `expose: 'desktop'`, como `resources/v1` e `screen.views/v1`.

| Método    | O que faz                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------- |
| `create`  | Pede ao provedor do tipo a materialização, grava a primeira revisão e o manifesto, e publica `artifacts.created/v1` |
| `revise`  | Materializa a revisão seguinte sobre a mesma identidade, sem tocar na anterior, e publica `artifacts.revised/v1`    |
| `read`    | Devolve o registro (título, tipo, revisão, âncoras) e as entradas `{ path, sha256, base64 }` da revisão             |
| `list`    | Lista os artefatos do Project e, quando o escopo traz Thread, os daquela Thread                                     |
| `approve` | Grava `artifacts.approved/v1` com o escopo autorizado — só é chamado sob a política `request`                       |
| `apply`   | Grava `artifacts.applied/v1` quando a mudança foi escrita                                                           |

`read` devolve as entradas em base64 pelo mesmo motivo que `doric.catalog/v1.artifact` — o envelope é JSON — e quem grava no cache verifica o hash antes de servir, como o desktop já faz com os bundles. O registro **lê e escreve o `.doric/` pelo lease**, como o `files` faz: sem lease não há cópia de trabalho, e o serviço responde estado em vez de falhar, como `files/v1`.

## Os tipos: `artifact.kind/v1`

Um artefato sem tipo é um arquivo. O **tipo** é que diz o que o agente pode pedir, o que é validado, o que é materializado e como isso aparece na tela. O contrato é de cardinalidade `many`, no `host`: cada bundle registra os tipos que possui.

| Campo         | O que declara                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------ |
| `id`          | O nome do tipo: `preview`, …                                                                     |
| `payload`     | O schema zod fechado do que o agente envia na criação e na revisão                               |
| `materialize` | `(input, call) => { entries, targets }` — compila ou renderiza a forma revisável e suas âncoras  |
| `blockType`   | A família de node que renderiza o corpo do artefato, registrada no client com `registerRenderer` |

**A regra que decide o que é um tipo**: o entregável precisa de uma **superfície renderizada e endereçável** que a conversa não dá, com revisões e âncoras que valem a pena revisar. Tudo o que a conversa ou outro bundle já mostram bem **não é** tipo de artefato:

| Candidato     | Veredito   | Por quê                                                                                                                        |
| ------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `preview`     | **Sim**    | É a razão de ser: uma interface viva, montada de código real, com âncora por elemento e revisões                               |
| `plan`        | **Não**    | O plano já é o texto do agente na conversa; um artefato seria a mesma coisa renderizada duas vezes                             |
| `walkthrough` | **Não**    | É o resumo final, e ele já é a última mensagem da Thread                                                                       |
| `diff`        | **Não**    | O diff tem casa: o painel de mudanças do `git`, com o editor e as cores que a plataforma já fornece                            |
| `diagram`     | **Não**    | Markdown com diagrama já renderiza na conversa; só um diagrama interativo precisaria de superfície própria                     |
| `recording`   | **Talvez** | Uma gravação é mídia que a conversa não mostra — mas o dono natural é o bundle que produz a captura (`screen`), não o registro |

O que a tabela compra: o registro **não é uma taxonomia copiada do Antigravity**. Ele existe pelo que a conversa não consegue mostrar, e a lista encolheu de seis tipos para um — o `preview` — mais a porta aberta para quem tiver uma superfície de verdade. Um `screen` que grave a execução de um app pode registrar `recording` no mesmo contrato, com o seu próprio `blockType` e o seu próprio `materialize`.

## O node

- **Um bloco por revisão**, com identidade estável: o replay reconstrói todos os blocos e nenhuma revisão some.
- **O `blockType` é do tipo**, registrado no client com `registerRenderer({ blockType, elementTag })` ([eventos e nodes](./events-and-nodes.md)); o elemento leva o prefixo do bundle dono, como manda a [UI composta por bundles](./ui-composition.md).
- **A moldura é do registro, o corpo é do tipo.** Título, tipo, leitura da revisão e a ação de comentar com a contagem são do bundle `artifacts` — as mesmas em todo artefato; o tipo renderiza o corpo (o canvas do preview, a mídia de uma gravação). A moldura tem variantes de chrome, como o papercraft desenha: a do node na conversa e a da janela em tela cheia. A ação de autorizar só aparece sob a política `request`. Um tipo cujo corpo sobrepõe o próprio cabeçalho declara `header: 'body'` (o padrão é `'frame'`): a moldura então não desenha a barra — título, tipo, revisão, estado e `Comentar` são do corpo — e mantém abaixo do corpo só o que é do registro, `Autorizar` (sob `request`, numa revisão aberta). A moldura não desenha lista de revisões: cada revisão é um node da conversa, e a conversa — com as respostas do agente — é o histórico. O `preview` do papercraft declara `header: 'body'`.
- **Um redutor só.** O bundle `artifacts` reduz `artifacts.*` a um estado por artefato — revisão atual, comentários pendentes —, e o mesmo redutor serve o node e a janela.

## Revisão: comentários

O comentário é a contribuição do usuário ao artefato, e tem spec própria em [comentários](./comments.md): um **alvo** (a revisão), uma **âncora** (o elemento carimbado, um seletor, uma posição), dois registros (o evento durável e o prompt que o agente lê), rascunho no host e flush no envio.

O artefato não define nada disso — ele só é um alvo como qualquer outro. É isso que faz o mesmo mecanismo servir para comentar uma mensagem, uma linha de código ou uma revisão de preview.

## A política de revisão

O Doric é **YOLO por padrão**: o agente publica o artefato e **segue direto**. O usuário olha, comenta e o agente ajusta na revisão seguinte — o comentário corrige o rumo, e não abre uma fila de aprovações.

A revisão prévia existe como **escolha do Project**, declarada com `defineSettings` e servida por `settings/v1`:

| Política           | O que acontece                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `proceed` (padrão) | O artefato é publicado e o agente continua; nenhum evento de aprovação é gravado                                 |
| `request`          | O agente publica, devolve o estado e **espera** o `artifacts.approved/v1` antes de escrever no código do Project |

A política é do Project porque um repositório de produção pode querer o portão que um protótipo não quer — mas o portão é exceção, não regra, e o desenho não depende dele: sem `request`, o botão de autorizar não existe, o evento de aprovação não existe, e a conversa continua sendo o lugar do ajuste. O que `proceed` significa exatamente fica em aberto (decisão 4).

## A tool do agente

**O tipo possui a sua tool.** O `preview` já tem `papercraft_preview` ([papercraft](./papercraft.md#tool-do-agente)), e um tipo futuro traz a sua: a forma da entrada, a validação e o materializar são do tipo, e uma tool genérica de artefato seria um schema de união ou um passthrough — pior nos dois casos. O bundle `artifacts` possui o registro, não a produção de cada tipo; é a mesma divisão de "o dono de uma operação define os hooks dela".

A tool **não bloqueia** sob a política padrão: ela publica o artefato, devolve o estado resolvido e o agente segue. Quem ensina **quando** propor um artefato é a skill do tipo, não o corpo da tool — a divisão que o [papercraft](./papercraft.md#skill-do-agente) já faz.

## Antigravity como referência

| No Antigravity                                                  | No Doric                                                                                     |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Artefato: entregável estruturado que comunica progresso         | Artefato do Project, com identidade, revisões e âncoras                                      |
| Plano de implementação, walkthrough, diff, diagrama, gravação   | **Só o que precisa de superfície própria** — o `preview` —, e a porta aberta para quem tiver |
| Painel de revisão no app e seletor de artefatos na CLI          | Nodes da conversa e `notifications` para o aviso                                             |
| Visualizador com comentário por linha e indicador de comentário | Comentário ancorado, com carimbo de origem e pino ([comentários](./comments.md))             |
| Política de revisão: pedir revisão ou seguir direto             | `artifacts.reviewPolicy` em `settings/v1`, com **`proceed` como padrão**                     |
| Aprovar e rejeitar por arquivo, e em lote                       | Só sob `request`: `artifacts.approved/v1` com `scope`                                        |
| Artefatos na pasta da conversa e no dado do app                 | `/workspace/.doric/` no Project, com o log durável como verdade                              |
| Detecção automática dos arquivos escritos                       | Declaração pelo tipo, na tool do tipo                                                        |

O que **não** se copia: a taxonomia de tipos (plano, walkthrough, diff, diagrama), porque no Doric essas coisas já têm casa — a conversa e o `git` —; a detecção implícita, porque um artefato declara o seu tipo e as suas âncoras; o armazenamento fora do Project; e o portão de aprovação como caminho normal, porque o Doric segue direto.

## Como entra na composição

| Parte         | O que contribui                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `host`        | `artifacts/v1`, o registro de tipos `artifact.kind/v1`, os eventos `artifacts.*` e as settings; `requires` `tools/v1`, `events/v1`, `skills/v1`, `settings/v1`, `storage/v1`, `runtime.lease/v1` |
| `desktopMain` | O cache verificado das entradas compiladas em `userData/artifacts/<artifactId>@<revision>/` e o prefixo `/artifacts/` no handler do protocolo                                                    |
| `client`      | A moldura do node, o redutor de `artifacts.*` e a ação de comentar                                                                                                                               |

O bundle entra em `enabled` na composição (`app/backend/doric-host/composition.json`), como o [papercraft](./papercraft.md) descreve para si. Nenhum contrato novo é `doric.*`: `artifacts/v1` e `artifact.kind/v1` são contratos de bundle e podem ser substituídos como qualquer um sem prefixo ([serviços entre bundles](./services-and-channels.md)).

## Etapas de entrega

1. **Registro e eventos.** `artifacts/v1`, o manifesto, `artifact.kind/v1`, o redutor e a moldura do node; o `preview` do papercraft passa a ser o tipo `preview`.
2. **Cache e rota.** O cache verificado por hash no `desktopMain` e a rota `/artifacts/<artifactId>@<revision>/…`, com a guarda de caminho que `/bundles/` já tem.
3. **Comentários.** O registro de [comentários](./comments.md) sobre o alvo `artifact`, com o flush e a pilha do compositor.
4. **Política.** `artifacts.reviewPolicy` em `settings/v1`, com `proceed` como padrão e o caminho `request` completo.
5. **Novos tipos.** Quando um bundle tiver uma superfície de verdade — uma gravação do `screen`, um diagrama interativo —, ela entra pelo mesmo `artifact.kind/v1`.

## Decisões em aberto

1. **Decidido: o diretório é `/workspace/.doric/artifacts/<artifactId>/`** — no root do workspace do Project, que as Threads compartilham, alcançado pelo lease, ignorado pelo Git por padrão. Fecha a decisão 4 do [papercraft](./papercraft.md#decisões-em-aberto).
2. **Decidido: os eventos são `artifacts.*`, com `kind` no payload**, e o comentário **não** é um deles: ele é do registro de [comentários](./comments.md), com o artefato como alvo.
3. **Decidido: `proceed` é o padrão** (YOLO) e `request` é escolha do Project. O que resta é o que `proceed` significa em detalhe.
4. **O que `proceed` significa.** Se o agente publica o artefato e segue sem gravar nada de aprovação, se um comentário chegando depois gera uma revisão automática, e se o `applied` sai no fim do turno ou quando o agente decide.
5. **Quem emite `artifacts.applied/v1`.** A tool do tipo depois da escrita, ou o passo de escrita de volta, quando ele existir como serviço.
6. **A forma do `artifactId`.** Um UUID opaco, um id legível derivado do título ou um prefixo por tipo (`preview-…`). Muda a cara do diretório e dos paths de URL.
7. **Retenção.** Quando a cópia de trabalho em `.doric/` e o cache podem ser apagados — por idade, por limite, quando a Thread termina — e o que a tela mostra depois.
8. **Artefato órfão.** O que acontece no replay quando o bundle do tipo não está ativo: o log já sabe mostrar evento sem projetor num bloco genérico ([eventos e nodes](./events-and-nodes.md)), e falta decidir o que a moldura mostra nesse estado.
9. **`request` em detalhe.** Se a política pode ser por tipo ou por caminho, e o que acontece com uma revisão autorizada que é substituída.
10. **Versionamento do manifesto.** Se `artifact.json` ganha `manifestVersion`, como o manifesto de bundle, e o que fazer com um diretório de uma versão anterior.
11. **Artefato fora de uma Thread.** Hoje o escopo exige `projectId`, `threadId` e `promptId`; um artefato do Project inteiro precisaria de outro escopo.
12. **`.doric/` como diretório do Doric.** `artifacts/` é o primeiro domínio; falta decidir o que mais mora nele (um índice, um estado de Project) e se ele ganha um `.gitignore` próprio.

## Referências

- [Artifacts](https://antigravity.google/docs/artifacts) (Antigravity): a definição de artefato e a colaboração assíncrona.
- [Implementation plan](https://antigravity.google/docs/implementation-plan) (Antigravity): o plano como artefato — o tipo que o Doric deliberadamente não copia, porque o plano já é a conversa.
- [Artifact review](https://antigravity.google/docs/artifact-review) (Antigravity): a política de revisão, `Request review` e `Always proceed` — o Doric inverte o padrão.
- [Reviewing artifacts](https://antigravity.google/docs/cli/artifacts) (Antigravity CLI): o seletor de artefatos, o visualizador e o comentário por linha.
- [Antigravity default files & directories](https://github.com/atdanri/ai-knowledge/blob/develop/docs/ai/tools/antigravity/files.md) (documentação de terceiros): a estrutura em disco do Antigravity — a pasta da conversa com `implementation_plan.md`, `task.md` e `walkthrough.md` —, útil como contraste com `/workspace/.doric/`.
- [Eventos e nodes](./events-and-nodes.md): o log durável, os sumidouros com `scopeKeys`, a projeção em blocos e `registerRenderer`.
- [Contratos e a família define\*](./contracts.md): `defineEvent`, `defineService`, `defineSettings` e a geração do JSON Schema canônico.
- [Armazenamento genérico e histórico](./storage.md): onde o log é persistido e como o cache local é endereçado por bundle.
- [Composição e distribuição pelo host](./composition-and-distribution.md): o catálogo, o cache verificado e o sentido de "artefato" na plataforma.
- [Serviços entre bundles e canais de mensagens](./services-and-channels.md): cardinalidade `one` e `many`, `desktopScope`, `expose: 'desktop'`.
- [Contextos e capacidades](./contexts.md): o `call` com `scope` e o `caller` de cada salto.
- [Papercraft](./papercraft.md): o tipo `preview`, o canvas no node e na janela.
- [Comentários](./comments.md): o spec do conceito que o artefato usa como estado de revisão.
