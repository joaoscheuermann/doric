# Serviços entre bundles e canais de mensagens

**Estado:** proposta. Parte da [arquitetura de bundles](../bundles.md); nada aqui descreve comportamento já implementado, e `GROUNDING.md` continua sendo o contrato da implementação atual.

## Resumo

Serviços são o único canal que o contexto entrega: `activate(ctx)` recebe só `ctx.services`, em todos os ambientes, e tudo o mais (hooks, log, settings, secrets, tools, storage, eventos, comandos, UI, janelas e menus) é um contrato de serviço fornecido pelo core por padrão e substituível por outro bundle; os backends `storage.backend/v1` e `secrets.backend/v1` vêm do bundle `postgres` por padrão. Em cada ambiente o loader ativa primeiro a fundação (os provedores escolhidos para contratos que o core fornece ou consome), depois o core e por último os demais bundles. Bundles conversam entre si por **serviços nomeados e versionados**, definidos com `defineService` e `defineMethod` e mantidos pelo loader num diretório próprio, separado do que os serviços `tools/v1` e `ui/v1` registram. Quem consome recebe um stub tipado, como num cliente gRPC, sem saber se a implementação está no mesmo processo, em outro processo ou no `desktopMain` ou no host atrás das pontes do desktop. Cada método traz seu `execute(input, call, services)` na definição, como uma tool, e o `call` traz o chamador preenchido pela plataforma; um stub aceita o `call` recebido como último argumento para propagar escopo, cancelamento e trace. Cada contrato tem cardinalidade `one` (padrão) ou `many`, e a composição escolhe, por ambiente, o provedor de um contrato `one` quando dois bundles o fornecem. Qualquer serviço fornecido no `desktopMain` ou no host é alcançável por uma parte `client` que o declara em `requires`; a ponte client → desktopMain leva ao provedor no `desktopMain` contratos como `windows/v1` e `menus/v1`, com `call.scope.windowKey` preenchido pelo dispatcher do Electron main a partir do `webContents` de origem e `call.caller` preenchido com o bundle ao qual o runtime client vinculou o stub. Serviços do host não viram rotas de rede automaticamente; a ponte client → host é só a ponte desktop. Chamada de serviço é só um dos quatro canais de mensagens, ao lado de eventos duráveis, sinais efêmeros e hooks de lifecycle, e cada canal tem uma garantia diferente. `CustomEvent` fica restrito à comunicação visual local entre Web Components.

## Diretório de serviços versionados

O loader mantém um diretório de **serviços nomeados e versionados**, separado dos registros que os serviços `tools/v1` e `ui/v1` mantêm. Um contrato de serviço declara:

- ID qualificado com versão principal (por exemplo `git.commands/v1`);
- métodos, cada um com tipos de entrada e saída e um `execute`;
- cardinalidade, só quando é `many` (vários provedores sem conflito, agregados pelo consumidor); o padrão é `one`, um provedor ativo escolhido pela composição.

O escopo de cada chamada vem de `call.scope`. Um método rejeita a Promise com um erro que tem `code` e `message`, e o dispatcher repassa os dois pela ponte.

O contrato é escrito em zod com `defineService` e `defineMethod`, do subpath browser-safe `bundle/contracts` de `packages/bundle`, no mesmo molde do `defineTool` de `packages/tool/src/lib/tools.ts`. A definição, com os `execute`, fica no código da parte que fornece o serviço e é registrada com `services.provide(definição)`. O entrypoint público `contracts/` do bundle exporta uma referência tipada, `ref<typeof definição>(id)`, que guarda só o ID; o `import type` da definição some no build, então o consumidor não traz o código do provedor. Consumidores importam só esse entrypoint (por exemplo `git/contracts`), e o próprio bundle importa seus contratos por caminho relativo (`../contracts/index.js`).

Os imports seguem uma regra fixa:

- `bundle/contracts` exporta as funções `define*` e `ref`; os tipos `HostContext`, `DesktopContext`, `ClientContext`, `Services` e `Call`; as constantes dos contratos da plataforma (`AppHooksV1`, `WindowHooksV1`, `DoricWindowsV1`, `DoricMenusV1`, `DoricCatalogV1`, `DoricDiagnosticsV1`, `DoricBundleV1`, `DoricCacheV1`, `DoricTokensV1`); e as referências dos contratos básicos, com seus tipos (`HooksV1`, `LogV1`, `SettingsV1`, `SecretsV1`, `SecretsBackendV1`, `ToolsV1`, `SkillsV1`, `StorageV1`, `StorageBackendV1`, `EventsV1`, `ModelsV1`, `ModelsProviderV1`, `CommandsV1`, `UiV1`, `NavigationV1`, `RegionsV1`, `WindowsV1`, `MenusV1`). As referências e os tipos dos básicos ficam na plataforma porque qualquer bundle pode fornecê-los; o core fornece as definições com `execute`, por exemplo `defineService(WindowsV1, { open: defineMethod({ input, output, execute }) })`, e passar a referência no lugar do ID faz o compilador conferir os métodos.
- `core/contracts` exporta só o que é do core: `CoreHooksV1` e `OpenSettingsCommandV1`, a referência do comando `core.open-settings/v1`.
- Contratos de outros bundles vêm de `<bundle>/contracts`.
- Nenhum código importa o entrypoint `bundle`, que é o loader Node. O JSON Schema canônico de cada método é gerado do zod no build e publicado no catálogo; nenhum bundle escreve JSON Schema à mão. A especificação completa da família `define*` está em [contratos](./contracts.md).

```ts
// git, host/git-commands.ts: definição com execute
import { defineMethod, defineService } from 'bundle/contracts';
import { z } from 'zod';

export const gitCommands = defineService('git.commands/v1', {
  switchBranch: defineMethod({
    input: z.object({ projectId: z.string(), to: z.string() }).strict(),
    output: z.object({ from: z.string(), to: z.string() }).strict(),
    execute: async (input, call) => checkout(input, call.signal),
  }),
});

// git, contracts/refs.ts (reexportado por contracts/index.ts): só o ID e o tipo
import { ref } from 'bundle/contracts';
import type { gitCommands } from '../host/git-commands.js';

export const GitCommandsV1 = ref<typeof gitCommands>('git.commands/v1');
```

A única opção de `defineService` é a cardinalidade. Um contrato `many`, como `models.provider/v1`, aceita vários provedores ao mesmo tempo: `openai`, `openrouter` e `codex` registram por ele tipo configurável, campos e catálogo de modelos, e o `models/v1` do core os agrega:

```ts
// bundle/contracts: referência e tipo de `models.provider/v1`
export const ModelsProviderV1 = ref<ModelsProvider>('models.provider/v1');

// openai, host/models.ts: a definição do provedor
import { defineService, ModelsProviderV1 } from 'bundle/contracts';

export const openaiModels = defineService(
  ModelsProviderV1,
  {
    /* métodos com execute */
  },
  { cardinality: 'many' },
);
```

`execute(input, call, services)` recebe a entrada já validada, o `call` da chamada e os serviços do bundle que forneceu o serviço, ligados em `services.provide(definição)`. Métodos validam entrada e saída em runtime: o dispatcher usa o zod no mesmo processo e o JSON Schema gerado quando a chamada atravessa processos. Serviços locais de registro podem aceitar funções ou classes com `z.custom`, como `chat.views/v1`; um método cujo schema usa `z.custom` só funciona no mesmo processo, e o dispatcher recusa a chamada que atravessaria processos.

### `provides`, `requires` e validação da geração

O manifesto declara `provides` e `requires` **por contrato**, não só pelo nome do bundle, em listas no topo do manifesto no formato `<id>/v<major>@<faixa>`; assim outra implementação pode fornecer o mesmo serviço. O ambiente vem da definição do contrato, e as partes de cada ambiente são encontradas por convenção de pasta (`host/index.js`, `desktop/index.js`, `client/index.js`). O formato do manifesto está em [manifesto](./manifest.md).

Um bundle declara em `requires` todo contrato que usa com `use`, inclusive os básicos do core (`hooks/v1`, `events/v1`, `settings/v1`, `tools/v1`, `commands/v1`, `ui/v1`, `storage/v1` e os demais). Contratos `doric.*` são da plataforma, sempre existem e nunca entram em `requires`; `use` deles é sempre permitido. Contratos opcionais são consultados com `whenAvailable` e também não entram em `requires`.

Antes de ativar a geração, o loader confere os provedores de cada contrato: se dois bundles habilitados fornecem o mesmo contrato de cardinalidade `one` e a composição não escolheu o provedor, o que ativa depois vai para quarentena com motivo e o primeiro continua ativo (ver [substituição de provedores](#substituição-de-provedores)). Contratos `many` aceitam todos os provedores. O loader também rejeita:

- versões incompatíveis;
- dependências locais ausentes;
- ciclos obrigatórios;
- bundles da fundação com `requires` de contratos que não são `doric.*`;
- `requires` do core fora dos contratos que a fundação fornece (`storage.backend/v1`, `secrets.backend/v1`); a parte client do core não precisa de `requires` para alcançar `windows/v1` e `menus/v1`, que o próprio core fornece no `desktopMain` (ver [ponte client → desktopMain](#ponte-client--desktopmain)).

Exigências host de um client são conferidas contra o catálogo que o host publica: uma janela pode montar em estado desconectado, mas não invoca o serviço até encontrar uma versão compatível. Dependências opcionais são consultadas explicitamente e degradam apenas a funcionalidade que as usa. As regras de compatibilidade entre versões de contrato estão em [versionamento](./versioning.md).

## Stubs tipados

Um consumidor recebe um stub tipado, semelhante à experiência de chamar um serviço gRPC. A API abaixo é **pseudocódigo do destino**, não uma exportação existente. Os schemas de `RuntimeThreadsV1` são ilustrativos; o contrato `runtime.threads/v1` cobre o envio de prompt, a leitura de Threads e os controles de Threads filhas do `Host` atual:

```ts
// runtime, host/threads.ts (ilustrativo)
import { defineMethod, defineService } from 'bundle/contracts';
import { z } from 'zod';

export const runtimeThreads = defineService('runtime.threads/v1', {
  sendPrompt: defineMethod({
    input: z.object({ threadId: z.string(), text: z.string() }).strict(),
    output: z.object({}).strict(),
    execute: async ({ threadId, text }, call, services) => {
      /* ... */
    },
  }),
  // leitura de Threads e controles de Threads filhas: get, list, spawn, ...
});

// runtime, contracts/refs.ts
import { ref } from 'bundle/contracts';
import type { runtimeThreads } from '../host/threads.js';

export const RuntimeThreadsV1 =
  ref<typeof runtimeThreads>('runtime.threads/v1');

// chat, client/views.ts: serviço local do client (usa z.custom).
// Os registros são estado do módulo, um por geração.
import { defineMethod, defineService } from 'bundle/contracts';
import { z } from 'zod';

const projectorRegistry = createRegistry<ProjectorSpec>();
const rendererRegistry = createRegistry<RendererSpec>();

export const chatViews = defineService('chat.views/v1', {
  registerProjector: defineMethod({
    input: z.custom<ProjectorSpec>(),
    output: z.custom<Disposable>(),
    execute: async (spec, call) => projectorRegistry.add(spec, call.caller),
  }),
  registerRenderer: defineMethod({
    input: z.object({ blockType: z.string(), elementTag: z.string() }).strict(),
    output: z.custom<Disposable>(),
    execute: async (spec, call) => rendererRegistry.add(spec, call.caller),
  }),
});

// chat, contracts/refs.ts
import { ref } from 'bundle/contracts';
import type { chatViews } from '../client/views.js';

export const ChatViewsV1 = ref<typeof chatViews>('chat.views/v1');
```

```ts
// chat, client/index.ts. O contexto só entrega serviços.
import type { ClientContext } from 'bundle/contracts';
import { chatViews } from './views.js';

export function activate({ services }: ClientContext) {
  services.provide(chatViews);
}

// git, client/index.ts. Usa um serviço remoto e, se houver, o serviço local do chat.
import type { ClientContext } from 'bundle/contracts';
import { ChatViewsV1 } from 'chat/contracts';
import { RuntimeThreadsV1 } from 'runtime/contracts';

// Chamada pela UI do git, que conhece o projeto, a Thread e o texto.
async function sendFromGit(
  services: ClientContext['services'],
  projectId: string,
  threadId: string,
  text: string,
) {
  const threads = services.use(RuntimeThreadsV1, { projectId });
  await threads.sendPrompt(
    { threadId, text },
    { signal: AbortSignal.timeout(5_000) },
  );
}

export function activate({ services }: ClientContext) {
  // chat.views/v1 é opcional: o registro só acontece se a conversa estiver ativa,
  // e o loader descarta o que foi registrado por serviços na desativação.
  services.whenAvailable(ChatViewsV1, (views) =>
    views.registerRenderer({
      blockType: 'git.branch-change/v1',
      elementTag: 'git-branch-event',
    }),
  );
}
```

O manifesto do git declara em `requires` exatamente os contratos que esse código usa com `use`; `chat.views/v1` fica fora, porque é consumido com `whenAvailable`:

```json
{
  "requires": ["runtime.threads/v1@^1.0.0"]
}
```

O `execute` de cada método recebe a entrada já validada, o `call` da chamada e os serviços do bundle provedor, como em `switchBranch: defineMethod({ input, output, execute: async (input, call, services) => { /* ... */ } })`. Tudo que um bundle registra por meio de serviços (provedores, handlers de hooks, tools, comandos, elementos, assinaturas) é rastreado pelo loader e descartado em ordem inversa na desativação; `activate` pode devolver uma função de limpeza para o que o loader não rastreia, e cada chamada traz seu próprio `call.signal`. Os escopos e a forma de `HostContext`, `DesktopContext` e `ClientContext` estão em [contextos](./contexts.md); o uso de `chat.views/v1` por projetores e renderizadores está em [chat](./chat.md).

### O contexto só entrega serviços

`HostContext`, `DesktopContext` e `ClientContext` têm exatamente a mesma forma, `{ readonly services: Services }`, e o core recebe o mesmo contexto que qualquer outro bundle; não existem contextos especiais do core. `Services` tem três operações:

- `provide(definição)` registra a definição de um serviço, já com os `execute`, e liga a ela os serviços do bundle;
- `use(contract, scope?)` devolve um stub tipado, opcionalmente fixado a um escopo;
- `whenAvailable(contract, callback)` chama `callback` quando houver um provedor compatível, para dependências opcionais.

Para um contrato `many`, `use` não escolhe um provedor; o consumidor agrega com `whenAvailable`, que chama o callback uma vez por provedor ativo, inclusive os que ativam depois, e passa a cada chamada a `api` e o `bundleId` do provedor. O que o callback registra é descartado quando aquele provedor desativa. É assim que o `models/v1` do core consome `models.provider/v1`, sem `requires`: os provedores (`openai`, `openrouter`, `codex`) ativam depois do core, e um contrato consumido por `whenAvailable` não entra em `requires`.

O que antes era membro do contexto passa a ser contrato de serviço, fornecido pelo core por padrão (os backends, pelo `postgres`):

| Antes                                                  | Agora                                                                                                                                                                                                 |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.hooks`                                            | `hooks/v1` (`define`, `use`, `whenAvailable`)                                                                                                                                                         |
| `ctx.log`                                              | `log/v1`                                                                                                                                                                                              |
| `ctx.config`, `ctx.settings`                           | `settings/v1` (`register(definição)`, `await get(definição)`, `subscribe`)                                                                                                                            |
| `ctx.secrets`                                          | `secrets/v1`, fachada sobre `secrets.backend/v1`                                                                                                                                                      |
| `ctx.tools` e skills                                   | `tools/v1`, `skills/v1`                                                                                                                                                                               |
| `ctx.events`                                           | `events/v1` (`register`, `append(definição, payload, call)`)                                                                                                                                          |
| `ctx.storage`                                          | `storage/v1`, fachada sobre `storage.backend/v1`                                                                                                                                                      |
| `ctx.commands`                                         | `commands/v1`, no `desktopMain` e no `client`, não no host                                                                                                                                            |
| `ctx.ui`                                               | `ui/v1` (`define`, `create`, `dispose`; ver [UI no client](./core.md#ui-no-client))                                                                                                                   |
| `ctx.windows`                                          | `windows/v1`, sobre `doric.windows/v1`, nativo                                                                                                                                                        |
| `ctx.menus`, `ctx.keybindings`, `DesktopContextV1.set` | `menus/v1` (itens, atalhos e `setContext`), sobre `doric.menus/v1`, nativo                                                                                                                            |
| `ctx.roles.provide('durableState', backend)`           | `services.provide(postgresStorage)`, com `postgresStorage = defineService(StorageBackendV1, { ... })` (e `postgresSecrets` com `SecretsBackendV1`), do `postgres` por padrão ou do provedor escolhido |
| diretório de cache do desktop                          | `doric.cache/v1`, da plataforma, no `desktopMain`                                                                                                                                                     |
| `ctx.bundle`                                           | `doric.bundle/v1`                                                                                                                                                                                     |
| `ctx.signal`, `ctx.onDispose`                          | função de limpeza devolvida por `activate` e `call.signal` em cada chamada                                                                                                                            |

Não há objeto `ExecutionContext` de capacidades. Um handler recebe `call` e obtém capacidades como serviços no escopo da chamada: `services.use(RuntimeThreadsV1, call.scope)` (`runtime.threads/v1`), `services.use(RuntimeWorkspaceV1, call.scope)` (`runtime.workspace/v1`, com `cwd` e `setCwd`), `services.use(TerminalV1, call.scope)` (`terminal/v1`), `services.use(EventsV1).append(definição, payload, call)` e `services.use(ModelsV1, call.scope).resolve(ref)` (`models/v1`, do core). O `execute(sandbox, host, payload, config)` de `defineTool` em `packages/tool/src/lib/tools.ts` passa a `execute(payload, call, services)`, com os serviços do bundle ligados no `register` de `tools/v1`. Os controles `threads`, `workspace` e `terminals` do `Host` atual de `packages/host/src/lib/host.ts` viram, respectivamente, `runtime.threads/v1`, `runtime.workspace/v1` e `terminal/v1`.

A própria plataforma é só mais um consumidor desses contratos. Em cada ambiente, depois que o provedor de `hooks/v1` ativa (o core, por padrão, ou o bundle escolhido em `providers`), a plataforma daquele ambiente chama `define(AppHooksV1)` e passa a disparar `execute` nos pontos do ciclo de vida. `WindowHooksV1` (`onCloseHook`, `onFlushHook`) é definido pela plataforma no ambiente `client`: o bootstrap de cada janela o define no `hooks/v1` do client e o executa quando o main pede o fechamento da janela. Qualquer bundle, não só o core, registra handlers dos hooks do app. Uma falha do `activate` de um bundle leva à quarentena; uma falha de um handler de `onActivateHook` (`observe`) só vai ao diagnóstico. Settings, secrets, tools e storage também são lidos pelos contratos, sem conhecer a implementação. O `onActivateHook` do próprio provedor de `hooks/v1` não é observável, porque ele ativa antes de o contrato existir. A plataforma tem log próprio, independente do core, para registrar o que acontece antes ou sem o provedor de `log/v1`. Os detalhes estão em [hooks](./hooks.md) e em [core](./core.md).

### `call` e o chamador

Todo `execute` de método, de comando e de tool, e todo handler de hook, recebe `call`. `Call` é exportado por `bundle/contracts`:

```ts
interface Call {
  readonly caller: { bundleId: string; version: string; generation: number };
  readonly scope?: {
    projectId?: string;
    threadId?: string;
    promptId?: string;
    windowKey?: string;
  };
  readonly signal: AbortSignal;
  readonly trace: TraceContext;
}
```

`call.caller` é preenchido pelo dispatcher da plataforma, não pelo bundle que chama. Ele serve para diagnóstico, log e para o handler saber quem disparou a chamada, nunca como controle de acesso. O dispatcher preenche `call.scope.windowKey` em toda chamada que sai de uma janela client. `call.scope` carrega o Project, a Thread, o prompt ou a janela da chamada, e é o escopo passado a `services.use` quando o handler precisa de uma capacidade daquela execução. A observabilidade tira `bundleId`, `version` e `generation` de `call.caller`, e `environment` do processo do provedor de `log/v1` (ver [observabilidade](./observability.md)).

#### Propagação do `call`

Todo stub aceita como último argumento opcional um `call` pai (o `call` recebido) ou `{ signal, deadline }`. Com um `call` pai, o dispatcher herda dele `scope`, `signal` e `trace`, de modo que cancelamento, Project, Thread, prompt, janela e trace seguem a cadeia. `call.caller` nunca é herdado: em cada salto ele é o bundle que faz a chamada, preenchido pelo dispatcher.

```ts
// git, host/git-commands.ts
import { defineMethod, defineService, EventsV1 } from 'bundle/contracts';
import { z } from 'zod';
import { branchSwitchedEvent } from '../contracts/index.js';

export const gitCommands = defineService('git.commands/v1', {
  switchBranch: defineMethod({
    input: z.object({ projectId: z.string(), to: z.string() }).strict(),
    output: z.object({ from: z.string(), to: z.string() }).strict(),
    execute: async (input, call, services) => {
      // call.caller: quem chamou o git.
      const result = await checkout(input, call.signal);
      const repository = await repositoryOf(input.projectId, call.signal);
      const payload = {
        projectId: input.projectId,
        repository,
        from: result.from,
        to: result.to,
      };
      // Neste salto, o caller visto por events/v1 é git; scope, signal e trace vêm de call.
      await services.use(EventsV1).append(branchSwitchedEvent, payload, call);
      return result;
    },
  }),
});

// git, host/index.ts
import type { HostContext } from 'bundle/contracts';
import { gitCommands } from './git-commands.js';

export function activate({ services }: HostContext) {
  services.provide(gitCommands);
}
```

Para esse exemplo, o manifesto do git declara `"requires": ["events/v1@^1.0.0"]` e `"provides": ["git.commands/v1@1.3.0", "git.branch-switched/v1@1.0.0"]`; o ambiente `host` vem da definição de cada contrato.

### Substituição de provedores

Qualquer contrato sem o prefixo `doric.` pode ser fornecido por outro bundle, inclusive os básicos que o core fornece por padrão (`hooks/v1`, `log/v1`, `settings/v1`, `secrets/v1`, `tools/v1`, `skills/v1`, `storage/v1`, `events/v1`, `models/v1`, `commands/v1`, `ui/v1`, `navigation/v1`, `regions/v1`, `windows/v1`, `menus/v1`) e os backends que o `postgres` fornece por padrão (`storage.backend/v1`, `secrets.backend/v1`). O `secrets.backend/v1` padrão guarda cada segredo como envelope AES-256-GCM sob `DORIC_CREDENTIAL_KEY`, como o credential store atual do host. Se dois bundles habilitados fornecem o mesmo contrato de cardinalidade `one`, a composição escolhe o provedor em `providers`:

```json
{
  "core": "core",
  "providers": {
    "hooks/v1": "myhooks",
    "storage.backend/v1": "postgres",
    "secrets.backend/v1": "postgres"
  }
}
```

A escolha vale em cada ambiente em que o bundle escolhido fornece o contrato; nos outros ambientes o provedor padrão continua. Contratos `many`, como `models.provider/v1`, não passam por `providers`: todos os provedores ativam e o consumidor agrega.

Em cada ambiente, a ativação segue esta ordem:

1. **Fundação:** os bundles escolhidos em `providers` para contratos que o core fornece ou consome (por exemplo `myhooks` para `hooks/v1`, `postgres` para `storage.backend/v1` e `secrets.backend/v1`). Eles só podem declarar `requires` de contratos `doric.*`.
2. **Core:** pode declarar `requires` apenas de contratos que a fundação fornece (`storage.backend/v1`, `secrets.backend/v1`).
3. **Demais bundles**, em ordem de dependência.

Quando a composição escolhe outro provedor para um contrato que o core também fornece, o loader não registra a implementação do core para esse contrato naquele ambiente, e o `services.use` do próprio core devolve o provedor escolhido. Sem escolha em `providers`, um segundo provedor de um contrato `one` vai para quarentena com motivo, e o primeiro continua ativo; como a fundação e o core ativam antes, é o bundle substituto que vai para quarentena se a composição não o escolher.

Os antigos papéis exclusivos passam a ser exatamente isso: contratos `one`, com um provedor escolhido: `storage.backend/v1` (armazenamento durável), `secrets.backend/v1` (segredos), `runtime/v1` (runtime de domínio), `executor/v1` (executor) e `sandbox/v1` (provider de sandbox). Contratos `doric.*` (`doric.catalog/v1`, `doric.diagnostics/v1`, `doric.bundle/v1`, `doric.cache/v1`, `doric.windows/v1`, `doric.menus/v1`, `doric.tokens/v1`, `doric.app.hooks/v1` e `doric.window.hooks/v1`) são da plataforma, sempre existem e não aceitam outro provedor; `doric.cache/v1` entrega no `desktopMain` o diretório de cache por bundle; `doric.windows/v1` e `doric.menus/v1` são usados pelo core, e os outros bundles usam `windows/v1` e `menus/v1`. O formato da composição está em [composição e distribuição](./composition-and-distribution.md).

Como quase todo bundle depende de contratos do core, e o core depende da fundação, falha da fundação ou do core leva ao modo de recuperação (ver [splash e recuperação](./splash-and-recovery.md)); catálogo, diagnóstico, splash e recuperação continuam na plataforma porque precisam funcionar sem o core.

### Regras das chamadas

- Chamadas que podem atravessar processos são assíncronas. No mesmo processo o dispatcher pode chamar o `execute` diretamente, sem abrir um servidor gRPC.
- Um serviço local pode declarar leituras e assinaturas síncronas, como `current` e `subscribe` de `navigation/v1`, necessárias para integrar stores de UI (ver [navegação e rotas](./navigation.md#o-roteador-navigationv1)).
- Um serviço local client pode receber factories ou classes de componentes; argumentos que cruzam processos são dados serializáveis e validados.
- O stub aceita como último argumento um `call` pai ou `{ signal, deadline }` (ver [propagação do `call`](#propagação-do-call)). Cancelamento ou timeout não desfaz efeitos já confirmados, e chamadas que alteram estado não são repetidas automaticamente.
- O provider é fixado à geração ativa da operação, e handles de escopo encerrado deixam de aceitar chamadas.

## Ponte client → host

Para client → host, o contrato usa a ponte preload → Electron main → host. Qualquer serviço do host que a parte client declara em `requires` é roteado, com validação de schema da entrada e da saída. O Electron mantém o que já faz hoje na ponte. O envelope RPC entre processos está em [isolamento por processo](./process-isolation.md).

### Operações do host exigidas pelo client

O manifesto declara em `requires` as operações do host exigidas pela parte client. `commands/v1` não existe no host: comandos de UI e de menu são definidos e registrados na parte `client` ou `desktopMain`, e uma parte host expõe operações como serviços, nunca como comandos.

- Operações existentes preservam seus endpoints durante a migração.
- Serviços do host não viram rotas de rede automaticamente; a ponte desktop é o único caminho do client até eles.

## Ponte client → desktopMain

Alguns contratos que uma parte `client` usa têm provedor só no `desktopMain`: `windows/v1` (abrir e focar janelas pelas políticas do core) e `menus/v1` (itens, atalhos e `setContext`), por exemplo, são fornecidos pelo core no `desktopMain` e chamados por partes `client`, como a parte client do git com `services.use(WindowsV1).open(...)` ou a parte client do core, que informa o path da rota ativa com `services.use(MenusV1).setContext(...)`. Para esses contratos, `services.use` no client devolve um stub cuja chamada segue a rota renderer → preload → dispatcher do Electron main → `utilityProcess` da geração onde roda o provedor `desktopMain`, e a resposta volta pelo mesmo caminho.

- O dispatcher do Electron main preenche `call.scope.windowKey` a partir do `webContents` que originou a mensagem. O dispatcher também preenche `call.caller` com o bundle ao qual o runtime client (`packages/desktop`) vinculou o stub.
- Qualquer contrato que o provedor `desktopMain` declarou em `provides` e que a parte client declarou em `requires` é roteado, com validação de schema, como na ponte client → host. A parte client do core alcança pela ponte, sem `requires`, `windows/v1` e `menus/v1`, que o próprio core fornece no `desktopMain`, porque o core só pode declarar `requires` de contratos da fundação. É assim que a parte client do core chama `setContext` a cada navegação. Os outros bundles declaram em `requires` os contratos que usam com `use`, mesmo os que eles próprios fornecem, como o git com `git.commands/v1`.
- A chamada é assíncrona e fixada à geração ativa; se a geração `desktopMain` for trocada ou o provedor entrar em quarentena, o stub rejeita a chamada até haver um provedor compatível.

O envelope entre o main e o `utilityProcess` está em [isolamento por processo](./process-isolation.md).

## Os quatro canais de mensagens

"Canal de mensagens" aqui cobre quatro contratos distintos, sem prometer a mesma entrega para todos:

| Canal                     | Uso                                                       | Garantia                                                                               |
| ------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Chamada de serviço        | Um bundle pede uma resposta ou comanda uma operação       | Request/response, erro e cancelamento; sem replay.                                     |
| Evento durável de domínio | Project, Thread, prompt ou outro stream registra um fato  | Commit antes da publicação, sequência/cursor e replay; consumidores recuperam lacunas. |
| Sinal efêmero             | Aviso local de UI, presença ou invalidação de cache       | Pub/sub best effort, sem recuperação; não executa trabalho que exija entrega durável.  |
| Hook de lifecycle         | Runtime pede decisão ou transformação em um ponto nomeado | Ordem, espera e saída validada; handler que falha ou estoura o prazo é ignorado.       |

Cada canal tem seu contrato na família `define*`: serviços com `defineService`/`defineMethod`, eventos duráveis com `defineEvent` (ver [eventos e nodes](./events-and-nodes.md)) e hooks com `defineHook`/`defineHooks`, disparados pelo dono com `execute` (ver [hooks](./hooks.md)).

### `CustomEvent` e limites

Eventos DOM (`CustomEvent`) fazem a comunicação local entre Web Components e seus pais; não são o barramento durável, nem o meio para comandos entre host e client. As propriedades e eventos DOM da fronteira visual estão em [UI composta por bundles](./ui-composition.md).

Trabalho assíncrono que precisa sobreviver a uma falha usa stream durável com cursor ou outbox transacional/idempotente, não um assinante efêmero (ver [armazenamento](./storage.md)).

## Exposição à janela desktop

Um método só pode ser chamado por uma janela desktop quando a sua declaração o expõe. O padrão é negar.

- Nos contratos da plataforma, a exposição é o campo `expose` do `MethodSpec` (`'desktop'`), declarado em `packages/bundle`.
- Nos contratos de um provedor, a exposição fica em `x-doric-expose` do documento do contrato, e vale para os métodos que o provedor fornece.
- O manifesto do provedor declara em `desktopScope` as chaves de escopo que a janela pode enviar a cada contrato. Chaves fora da lista são recusadas, e `windowKey` é da plataforma.
- Um contrato sem provedor ativo responde como indisponível.

O conjunto exposto fica fixado pelo snapshot `agents/doric/tests/bridge-exposure.snapshot.json`. Mudar o que uma janela pode alcançar exige atualizar esse snapshot na revisão.

## Relações

- [Arquitetura de bundles](../bundles.md): documento principal que mostra onde os serviços e canais entram no conjunto.
- [Contratos e a família define\*](./contracts.md): especificação de `defineService`, `defineMethod` e das demais funções usadas pelos canais.
- [Manifesto v1](./manifest.md): onde `provides`, `requires` e as operações do host exigidas pelo client são declarados.
- [Versionamento semântico](./versioning.md): regras que o loader usa para aceitar ou rejeitar versões de serviço.
- [Contextos e capacidades](./contexts.md): define `HostContext`, `DesktopContext` e `ClientContext`, todos só com `services`, e os escopos levados em `call.scope`.
- [O bundle core](./core.md): fornece por padrão os contratos básicos (`hooks/v1`, `settings/v1`, `storage/v1`, `windows/v1`, `menus/v1` e os demais) que outro bundle pode substituir, e ativa depois da fundação.
- [Isolamento por processo](./process-isolation.md): o envelope RPC que carrega chamadas de serviço entre processos, inclusive entre o main e o `utilityProcess` da geração `desktopMain`.
- [Janelas](./windows.md) e [menus e atalhos](./menus-and-keybindings.md): `windows/v1` e `menus/v1`, chamados do client pela ponte client → desktopMain.
- [Composição e distribuição pelo host](./composition-and-distribution.md): o catálogo do host contra o qual exigências client são conferidas e a escolha de provedores em `providers`.
- [Hooks e ciclo de vida](./hooks.md): o canal de hooks de lifecycle, com ordem, espera e a regra única de falha e prazo.
- [Eventos e nodes](./events-and-nodes.md): o canal de eventos duráveis de domínio.
- [Armazenamento genérico e histórico](./storage.md): streams duráveis com cursor e outbox para trabalho que precisa sobreviver a falhas.
- [UI composta por bundles](./ui-composition.md): onde `CustomEvent` é usado entre Web Components e seus pais.
- [O bundle chat](./chat.md): fornece `chat.views/v1`, o exemplo de serviço local com `z.custom`.
- [Splash e recuperação](./splash-and-recovery.md): o modo de recuperação quando a fundação ou o core falham.
- [Observabilidade](./observability.md): como `call.caller` e o processo do provedor de `log/v1` identificam cada registro.
- [Navegação e rotas](./navigation.md): `navigation/v1`, do core, exemplo de serviço local com leituras e assinaturas síncronas.
