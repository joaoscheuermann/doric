# O bundle chat

**Estado:** proposta. Parte da [arquitetura de bundles](../bundles.md); nada aqui descreve comportamento já implementado, e `GROUNDING.md` continua sendo o contrato da implementação atual.

## Resumo

Na composição padrão, o bundle `chat` é dono da superfície de conversa do desktop: o elemento `<chat-view>`, a store de leitura, a projeção, o compositor, o trail e o comportamento da conversa. Ele não produz eventos duráveis; ele interpreta e apresenta no client os eventos que outros bundles registram e gravam no host, e envia prompts e lê Threads por `runtime.threads/v1` (`RuntimeThreadsV1`), do `runtime`. Ele registra a rota `/projects/:projectId/threads/:threadId`, filha de `/`, que aparece no `<core-outlet>` do [layout](./layout.md). Para estender a conversa, oferece um serviço independente de editor, `chat.views/v1`, onde outros bundles registram projetores de stream e renderizadores de bloco, e um serviço específico da implementação padrão, `chat.lexical/v1`, para extensões e nodes Lexical. O log durável continua sendo a fonte dos dados da conversa.

## O que o bundle possui, requer e fornece

### Possui

Na composição padrão, `chat` é dono de:

- `<chat-view>`;
- store de leitura;
- projeção;
- compositor;
- trail;
- comportamento da conversa;
- a rota de Thread `/projects/:projectId/threads/:threadId` (antes `threads.detail/v1`, do bundle `threads`).

O bundle `threads` continua dono das tools de delegação e dos cards de Thread filha; ele não fornece mais um serviço de comandos de Thread.

### Requer

- `runtime.threads/v1` (`RuntimeThreadsV1`), fornecido pelo `runtime` no host, para enviar prompts, ler Threads e assinar o stream durável; ele também cobre os controles de Threads filhas do `Host` atual. O contrato `threads.commands/v1` (`ThreadsCommandsV1`) deixa de existir. Como é fornecido no host, a parte client do `chat` o alcança pela ponte client→host ao declará-lo em `requires` (ver [serviços e canais](./services-and-channels.md)).
- `ui/v1`, fornecido pelo core no client, para definir `<chat-view>` e criá-lo com `ui.create` (ver [UI no client](./core.md#ui-no-client)). O `chat` não adiciona item de região: a conversa aparece na área principal do workspace porque a rota tem `parent: '/'` e é mostrada no `<core-outlet>` que o [layout](./layout.md) põe no seu template.
- `commands/v1`, fornecido pelo core no client, para despachar comandos a partir de intenções DOM dos blocos da conversa, como `git.open-comparison/v1`.
- `hooks/v1`, fornecido pelo core por padrão, no qual a parte client do `chat` define e executa os próprios hooks, `chat.hooks/v1` (`ChatHooksV1`), como `onBeforeRenderBlockHook` (ver [hooks](./hooks.md)).
- `navigation/v1`, fornecido pelo core no client, para registrar a rota `/projects/:projectId/threads/:threadId` (ver [navegação e rotas](./navigation.md)).
- `history` é uma otimização opcional, não um requisito (ver [armazenamento](./storage.md)).

Pela regra de `requires`, a parte client do `chat` declara todo contrato que usa com `use`, inclusive os básicos do core; contratos `doric.*` e os opcionais usados com `whenAvailable` ficam fora (ver [manifesto](./manifest.md)).

### Fornece

- O elemento `<chat-view>`, definido com `ui.define('chat-view', ChatView)`. Quem quer a conversa navega para o path da Thread ou cria o elemento com `ui.create('chat-view', { projectId, threadId })`, que entrega ao elemento os serviços do `chat` (ver [`ui.create` passo a passo](./core.md#uicreate-passo-a-passo)).
- A rota `/projects/:projectId/threads/:threadId`, com `parent: '/'`, registrada em `navigation/v1`, que cria `<chat-view>` com os parâmetros do path. Trocar de Thread só atribui os novos parâmetros ao mesmo elemento (ver [o outlet](./navigation.md#o-outlet-core-outlet)).
- Dois serviços client:
  - `chat.views/v1` (`ChatViewsV1`), independente de editor;
  - `chat.lexical/v1`, específico da implementação padrão.
- Os hooks `chat.hooks/v1` (`ChatHooksV1`), definidos e executados pela parte client no `hooks/v1` do client; outros bundles registram handlers neles, por exemplo com `whenAvailable` (ver [hooks](./hooks.md)).

Uma conversa alternativa substitui o bundle `chat` na composição: registra o mesmo path com o próprio elemento e pode fornecer `chat.views/v1` sem Lexical. Dois bundles que registram o mesmo path produzem um conflito de rota, e o segundo vai para quarentena com motivo. `chat.views/v1` tem cardinalidade `one`, a padrão de `defineService`; se dois bundles habilitados o fornecem, a composição escolhe o provedor em `providers`, e a escolha vale no ambiente client. Sem escolha, o segundo provedor vai para quarentena com motivo (ver [composição e distribuição](./composition-and-distribution.md)).

Os dois serviços só funcionam no client: recebem funções, classes ou elementos, descritos por `z.custom` nos schemas, e o dispatcher recusa uma chamada que atravessaria processos (ver [contratos](./contracts.md)). Cada um é uma definição com `defineService` em que cada método traz seu `execute(input, call, services)`; o bundle os fornece na ativação client com `services.provide(chatViews)` e `services.provide(chatLexical)`, e o loader os descarta em ordem inversa na desativação.

### Ativação client do `chat`

Em **pseudocódigo da API proposta**, a parte client do `chat` define `<chat-view>`, fornece os serviços e registra a rota:

```ts
// chat, client/index.ts
import {
  HooksV1,
  NavigationV1,
  UiV1,
  type ClientContext,
} from 'bundle/contracts';
import { ChatHooksV1 } from '../contracts/index.js';
import { chatLexical } from './lexical.js'; // defineService('chat.lexical/v1', { ... })
import { chatViews } from './views.js'; // defineService('chat.views/v1', { ... })

export function activate({ services }: ClientContext) {
  // o dono define os próprios hooks e os executa antes de renderizar cada bloco
  const chatHooks = services.use(HooksV1).define(ChatHooksV1);
  renderer.beforeRender = (block, call) =>
    chatHooks.onBeforeRenderBlockHook.execute(block, call);

  const ui = services.use(UiV1);
  ui.define('chat-view', ChatView); // ChatView envia prompts e lê Threads por RuntimeThreadsV1 e despacha comandos por CommandsV1

  services.provide(chatViews);
  services.provide(chatLexical);

  services.use(NavigationV1).register({
    path: '/projects/:projectId/threads/:threadId',
    parent: '/',
    create: (params) => ui.create('chat-view', params), // params: { projectId, threadId }
  });
}

// chat, contracts/index.ts: referências para os consumidores
import { ref } from 'bundle/contracts';
import type { chatLexical } from '../client/lexical.js';
import type { chatViews } from '../client/views.js';
export const ChatViewsV1 = ref<typeof chatViews>('chat.views/v1');
export const ChatLexicalV1 = ref<typeof chatLexical>('chat.lexical/v1');
export { ChatHooksV1 } from './hooks.js'; // chat, contracts/hooks.ts (ver hooks)
```

`chat/contracts` exporta essas referências, com `ref` de `bundle/contracts`, e as definições sem lógica, como `ChatHooksV1`; o `import type` some no build. Quem estende a conversa usa `services.whenAvailable(ChatViewsV1, ...)`.

Dentro de `<chat-view>`, o envio de prompt usa o stub remoto no escopo da janela, por exemplo `await services.use(RuntimeThreadsV1, { projectId }).sendPrompt({ threadId, text }, { signal })`; o dispatcher preenche `call.caller` com o `chat` e `call.scope.windowKey` com a janela de origem.

O manifesto, no formato de [manifesto v1](./manifest.md), lista em `provides` os contratos que o `chat` define e em `requires` os que esse código usa com `use`. `hooks/v1`, `ui/v1` e `navigation/v1` entram pelo uso na ativação; `runtime.threads/v1`, pelo envio de prompts dentro de `<chat-view>`; e `commands/v1`, pelo despacho de comandos que `<chat-view>` faz a partir de intenções DOM; `history` fica fora porque é opcional. A parte client é encontrada por convenção em `client/index.js`:

```json
{
  "manifestVersion": 1,
  "id": "chat",
  "version": "1.0.0",
  "engines": { "doric": "^1.0.0" },
  "provides": [
    "chat.views/v1@1.0.0",
    "chat.lexical/v1@1.0.0",
    "chat.hooks/v1@1.0.0"
  ],
  "requires": [
    "hooks/v1@^1.0.0",
    "ui/v1@^1.0.0",
    "navigation/v1@^1.0.0",
    "commands/v1@^1.0.0",
    "runtime.threads/v1@^1.0.0"
  ]
}
```

## Projetores e renderizadores: `chat.views/v1`

O serviço `chat.views/v1` registra **projetores de stream** e **renderizadores de bloco** separadamente.

- **Projetor.** Consome eventos ordenados de tipos e versões declarados e reduz deltas, início e fim de tools e agrupamentos em blocos com IDs estáveis, tipo e versão próprios.
- **Renderizador.** Associa esse tipo de bloco a uma tag Web Component e a metadados de edição, seleção, trail e ações. A tag é definida pelo bundle que registra o renderizador, por `ui/v1`, e começa com o ID desse bundle.

Regras:

- A mesma redução é aplicada no replay. Rewind recompõe a partir do log sobrevivente, sem executar efeitos.
- Conflitos de dono primário para um tipo/versão são rejeitados.
- Evento sem projetor conhecido produz um bloco genérico com tipo, ID, horário e o payload, sem descartar o registro (ver [eventos e nodes](./events-and-nodes.md)).

### Quem registra o quê

Os schemas e o append dos **eventos duráveis** são registrados pela parte host do bundle que os produz, no catálogo de eventos do host, com `defineEvent` e `services.use(EventsV1).register(...)`. O bundle `chat` só oferece a interpretação e a apresentação client desses eventos.

Assim, um bundle `git` pode registrar `git.branch-switched/v1` no host e, no client, usar `chat.views/v1` como dependência opcional, por `services.whenAvailable(ChatViewsV1, ...)`, para projetá-lo em um bloco `git.branch-change/v1` renderizado por `<git-branch-event>`. Git continua funcional numa UI sem conversa, e não há dependência inversa de `chat` para `git`.

## O serviço Lexical: `chat.lexical/v1`

- O serviço aceita extensões e classes de node apenas durante a ativação client, **antes** da criação do editor. A lista de nodes da geração é então congelada.
- Cards de evento comuns usam um único `DecoratorNode` estável que guarda o ID do bloco projetado e hospeda a tag do bundle. Isso evita criar uma classe Lexical para cada card.
- Nodes Lexical específicos ficam para semântica de edição real.
- A plataforma fornece o singleton de `lexical` e `@lexical/*` pelo import map, externalizado dos artefatos client, e `engines.doric` garante a versão compatível antes de aceitar classes (ver [pacotes compartilhados](./platform-packages.md) e [manifesto](./manifest.md)).
- Alterar a lista exige reconstruir o editor, preservando rascunho, foco e seleção quando possível.
- Uma UI que não usa Lexical consome `chat.views/v1` e ignora esse serviço opcional.
- O log durável continua sendo a fonte dos dados da conversa, não um estado Lexical serializado.

As duas famílias de node estão em [eventos e nodes](./events-and-nodes.md).

## Exemplo: a troca de branch do Git na conversa

O fluxo completo:

1. O bundle `git` registra o schema de `git.branch-switched/v1` na parte host.
2. O comando client `switchBranchCommand` chama `switchBranch` de `git.commands/v1` no host pela ponte client→host; o `execute` de `switchBranch` grava o evento repassando o `call` recebido.
3. O stream o entrega à conversa.
4. O projetor produz um bloco que `<git-branch-event>` apresenta.
5. Um clique nesse elemento emite uma intenção DOM.
6. A conversa despacha o comando `git.open-comparison/v1` para abrir a comparação.

Replay percorre o mesmo projetor sem repetir a mudança de branch.

Os passos 1 e 2, na parte host de `git`, em **pseudocódigo da API proposta**:

```ts
// git, contracts/events.ts (exportado por git/contracts)
import { defineEvent } from 'bundle/contracts';
import { z } from 'zod';

export const branchSwitchedEvent = defineEvent({
  type: 'git.branch-switched/v1',
  payload: z
    .object({
      projectId: z.string(),
      repository: z.string(),
      from: z.string(),
      to: z.string(),
    })
    .strict(),
});

// git, host/git-commands.ts
import { defineMethod, defineService, EventsV1 } from 'bundle/contracts';
import { z } from 'zod';
import { branchSwitchedEvent } from '../contracts/index.js';

export const gitCommands = defineService('git.commands/v1', {
  switchBranch: defineMethod({
    input: z.object({ projectId: z.string(), to: z.string() }).strict(),
    output: z.object({ from: z.string(), to: z.string() }).strict(),
    // `call.caller` é quem chamou o git; o dispatcher o preenche
    execute: async (input, call, services) => {
      const repository = await resolveRepository(input.projectId, call.signal);
      const result = await checkoutBranch(repository, input.to, call.signal);
      // o novo salto herda scope, signal e trace; o caller visto por events/v1 é `git`
      await services.use(EventsV1).append(
        branchSwitchedEvent,
        {
          projectId: input.projectId,
          repository,
          from: result.from,
          to: result.to,
        },
        call,
      );
      return result;
    },
  }),
});

// git, host/index.ts
import { EventsV1, type HostContext } from 'bundle/contracts';
import { branchSwitchedEvent } from '../contracts/index.js';
import { gitCommands } from './git-commands.js';

export function activate({ services }: HostContext) {
  services.use(EventsV1).register(branchSwitchedEvent); // na ativação; descartado pelo loader na desativação
  services.provide(gitCommands);
}
```

O manifesto do `git` declara `events/v1` em `requires`, porque a parte host usa `EventsV1` com `use` (o manifesto completo está mais abaixo). O payload de `git.branch-switched/v1` é `.strict()` e exige `repository`, que não vem no input (`{ projectId, to }`) nem no output (`{ from, to }`) de `switchBranch`; por isso o `execute` resolve o repositório do Project antes de gravar. A versão completa do evento vem de `provides` no manifesto. `EventsV1` é uma referência básica exportada por `bundle/contracts`, e o core fornece a definição com `execute`; `services` no `execute` são os serviços do `git`, ligados em `services.provide(gitCommands)`. O `git` importa os próprios contratos por caminho relativo.

No client, `git` define a tag do bloco, registra os comandos e registra o projetor e o renderizador por `chat.views/v1`, como dependência opcional:

```ts
// git, client/index.ts
import { CommandsV1, UiV1, type ClientContext } from 'bundle/contracts';
import { ChatViewsV1 } from 'chat/contracts';
import { openComparisonCommand, switchBranchCommand } from './commands.js';

export function activate({ services }: ClientContext) {
  services.use(UiV1).define('git-branch-event', GitBranchEvent);

  const commands = services.use(CommandsV1);
  commands.register(switchBranchCommand); // chama o stub de GitCommandsV1.switchBranch
  commands.register(openComparisonCommand); // git.open-comparison/v1

  services.whenAvailable(ChatViewsV1, (views) => {
    views.registerProjector(branchSwitchedProjector); // git.branch-switched/v1 → bloco git.branch-change/v1
    views.registerRenderer({
      blockType: 'git.branch-change/v1',
      elementTag: 'git-branch-event',
    });
  });
}
```

O manifesto completo do `git`, no formato de [manifesto v1](./manifest.md), cobre as partes host e client deste exemplo e as dos exemplos de [hooks](./hooks.md) e do [documento principal](../bundles.md):

```json
{
  "manifestVersion": 1,
  "id": "git",
  "version": "1.5.0",
  "engines": { "doric": "^1.0.0" },
  "provides": [
    "git.commands/v1@1.3.0",
    "git.hooks/v1@1.0.0",
    "git.settings/v1@1.0.0",
    "git.branch-switched/v1@1.0.0"
  ],
  "requires": [
    "hooks/v1@^1.0.0",
    "events/v1@^1.0.0",
    "settings/v1@^1.0.0",
    "tools/v1@^1.0.0",
    "commands/v1@^1.0.0",
    "ui/v1@^1.0.0",
    "navigation/v1@^1.0.0",
    "regions/v1@^1.0.0",
    "windows/v1@^1.0.0",
    "menus/v1@^1.0.0",
    "git.commands/v1@^1.0.0",
    "runtime.lease/v1@^1.0.0",
    "runtime.workspace/v1@^1.0.0",
    "runtime.hooks/v1@^1.0.0"
  ]
}
```

No client, `ui/v1` e `commands/v1` entram pelo código acima; `navigation/v1`, porque a parte client registra as rotas `/git/diff/:threadId/:repository` e `/settings/git` com `services.use(NavigationV1)` (ver [navegação e rotas](./navigation.md)); `regions/v1`, pelo item `<git-changes>` que ela põe na região `layout.panel` do [layout](./layout.md) e pelo link `{ id: 'git', tag: 'settings-link', props: { label: 'Git', path: '/settings/git' } }` na região `settings.sections`; `windows/v1`, porque `openComparisonCommand` abre a comparação com `services.use(WindowsV1)` (ver [abrir um path numa janela](./navigation.md#abrir-um-path-numa-janela)); `menus/v1`, pelo item de menu que a parte client pede; e `hooks/v1`, também usado pela parte client para consumir `chat.hooks/v1` com `whenAvailable`. `git.commands/v1` entra em `requires` embora o próprio `git` o forneça no host, porque `switchBranchCommand` usa o stub com `use` no client, como no [documento principal](../bundles.md). `chat.views/v1` e `chat.hooks/v1` ficam fora por serem usados com `whenAvailable`. `commands/v1` existe no `desktopMain` e no client, não no host, por isso os comandos ficam na parte client.

Um clique em `<git-branch-event>` emite uma intenção DOM, e a conversa despacha o comando `git.open-comparison/v1`, definido pelo `git` com `defineCommand` e registrado em `commands/v1`, para abrir a comparação. A ação é um comando, não um serviço.

## Relações

- [Hooks](./hooks.md): define `chat.hooks/v1`, executado pelo `chat`, e o consumo opcional pelo `git`.
- [Contratos e a família define\*](./contracts.md): define `defineService`, `defineMethod`, `ref`, `defineEvent` e os schemas com `z.custom` usados por `chat` e por quem o estende.
- [Contextos de ativação](./contexts.md): define `ClientContext` e `HostContext` só com `services`, o `call` recebido pelos handlers, sua propagação entre saltos e a função de limpeza devolvida por `activate`.
- [Manifesto](./manifest.md): define `requires` e `provides` por ambiente, como nos manifestos de exemplo.
- [O core](./core.md): fornece `hooks/v1`, `ui/v1`, `navigation/v1`, `regions/v1`, `commands/v1`, `windows/v1`, `menus/v1` e `events/v1`, usados por `chat` e por quem o estende; `bundle/contracts` exporta as referências e os tipos desses contratos, e o core fornece as definições com `execute`.
- [Navegação e rotas](./navigation.md): o serviço `navigation/v1` em que o `chat` registra `/projects/:projectId/threads/:threadId` e o `<core-outlet>` que a mostra.
- [O bundle layout](./layout.md): o workspace da rota `/`, em cujo outlet a conversa aparece.
- [Serviços entre bundles e canais de mensagens](./services-and-channels.md): descreve a ponte client→host, pela qual `chat` consome `runtime.threads/v1` e o stream durável.
- [Eventos e nodes](./events-and-nodes.md): define os eventos duráveis, o bloco genérico de evento sem projetor e as duas famílias de node.
- [UI composta por bundles](./ui-composition.md): explica as intenções DOM e o Light DOM da primeira extração da conversa.
- [React dentro de Web Components](./react-web-components.md): como `<chat-view>` monta React dentro do elemento e reage às propriedades que o outlet atribui.
- [Pacotes compartilhados e tokens do tema](./platform-packages.md): fornece `lexical` e `@lexical/*` pelo import map.
- [Armazenamento genérico e histórico](./storage.md): define o histórico durável e o `history` opcional.
- [Divisão das funcionalidades atuais](./feature-split.md): situa `chat`, `runtime`, `threads` e `git` entre os bundles de destino.
- [Versionamento semântico](./versioning.md): rege as majors de `chat.views/v1`, `chat.lexical/v1` e dos tipos de bloco.
