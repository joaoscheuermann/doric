# Contextos e capacidades

**Estado:** proposta. Parte da [arquitetura de bundles](../bundles.md); nada aqui descreve comportamento já implementado, e `GROUNDING.md` continua sendo o contrato da implementação atual.

## Resumo

Um bundle nunca recebe os objetos internos do host. Em `activate(ctx)` ele recebe só serviços: partes `host` recebem `HostContext`, partes `desktopMain` recebem `DesktopContext` e partes `client` recebem `ClientContext`, e os três têm apenas `services`. O core recebe o mesmo contexto que qualquer bundle. Hooks, log, settings, segredos, tools, eventos, storage, comandos, UI, janelas e menus deixam de ser membros do contexto e viram contratos de serviço, fornecidos pelo [core](./core.md) por padrão e substituíveis por outro bundle escolhido em `providers`. Antes do core, cada ambiente ativa a fundação, os provedores dos contratos que o core fornece ou consome. Toda chamada recebe `call`, com o chamador preenchido pela plataforma e o escopo da operação; não existe mais `ExecutionContext` como objeto de capacidades. As definições vêm da família `define*` de [contratos](./contracts.md).

## Escopos

| Escopo           | O que um bundle recebe                                                                                                             | Encerramento                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Aplicação        | Os serviços que declarou em `provides` e `requires`, os opcionais por `whenAvailable` e os contratos `doric.*`, que sempre existem | Desativação ou parada do processo       |
| Project          | Identidade e operações do `runtime` para o Project, mesmo sem sandbox ativo                                                        | Fechamento do escopo ou exclusão        |
| Lease de sandbox | Operações no sandbox adquirido para um Project                                                                                     | Liberação ou revogação do lease         |
| Execução         | IDs da Thread e prompt, sinal de cancelamento, modelo, tools, histórico e emissão de eventos                                       | Conclusão, pausa, falha ou cancelamento |
| Janela           | Ponte de comandos, leituras, assinaturas e registros visuais                                                                       | Fechamento ou recarga da janela         |
| Node de conversa | Dados projetados e ações declaradas                                                                                                | Desmontagem do node                     |

O escopo é o `call.scope` de cada chamada: um registro opaco de chaves de string limitadas. A plataforma só reserva `windowKey`. As chaves de Project, Thread e prompt pertencem ao bundle `runtime`, que as monta com `runtimeScope` e as lê com `readRuntimeScope` (ambos em `runtime/contracts`). Um serviço usado com `services.use(contrato, call.scope)` age só sobre aquele escopo e só pela sua duração. O `Host` atual de `packages/host` é o precedente da API por execução; sua parte específica de Project/Thread passa a ser fornecida pelo bundle `runtime`. As capacidades de uma execução são contratos pequenos e tipados, obtidos no escopo da chamada: `services.use(EventsV1).append(definição, payload, call)` (`events/v1`), `services.use(ModelsV1, call.scope).resolve(ref)` (`models/v1`), `runtime.workspace/v1`, `runtime.threads/v1` (envio de prompt, leitura de Threads e controles de Threads filhas), `terminal/v1` e, para o estado opaco de histórico de um executor, `services.use(RuntimeHistoryV1, call.scope)` (`runtime.history/v1`, com `load` e `save`). O bundle `runtime` vincula cada uma à identidade e à duração corretas.

Liberar o lease não apaga o Project nem invalida suas leituras de histórico; apenas revoga operações dependentes daquele sandbox.

Bundles de domínio guardam dados por `storage/v1`, a fachada do core sobre `storage.backend/v1` (ver [armazenamento](./storage.md)). Bundles de tools, providers e UI não recebem `ProjectRuntime`, Prisma, `ThreadStore` nem `WorkspacePublisher`.

## O contexto só com serviços

Pseudocódigo da API proposta. Os três tipos de contexto têm a mesma forma, e cada parte usa o tipo do seu ambiente:

```ts
/** Partes host. */
interface HostContext {
  readonly services: Services;
}
/** Partes desktopMain. */
interface DesktopContext {
  readonly services: Services;
}
/** Partes client. */
interface ClientContext {
  readonly services: Services;
}

interface Services {
  /** Fornece a definição de um serviço declarado em provides; cada execute recebe (input, call, services). */
  provide<D extends ServiceDefinition>(definition: D): Disposable;
  /** Obtém, pela ref, um contrato declarado em requires (ou um contrato doric.*), opcionalmente vinculado a um escopo. */
  use<R extends ServiceRef>(contract: R, scope?: CallScope): ServiceApi<R>;
  /** Registra o callback para quando um contrato opcional ficar disponível. */
  whenAvailable<R extends ServiceRef>(
    contract: R,
    callback: (api: ServiceApi<R>) => void,
  ): Disposable;
}

/** activate pode devolver uma função de limpeza. */
type Activate<Ctx extends HostContext | DesktopContext | ClientContext> = (
  ctx: Ctx,
) => void | Cleanup | Promise<void | Cleanup>;
type Cleanup = () => void | Promise<void>;
```

Os serviços são definidos por `defineService` e `defineMethod`, com o `execute` de cada método, e as definições que os membros de registro recebem, por `defineHooks`, `defineEvent`, `defineSettings`, `defineCommand` e `defineStorageType` (esta usada como `defineType(defineStorageType(...))` em `storage/v1`). Quem consome um serviço ou despacha um comando de outro bundle usa uma referência criada com `ref`, só com o ID e o tipo. Os imports seguem três origens:

| Origem                                                         | O que exporta                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundle/contracts` (subpath browser-safe de `packages/bundle`) | As funções `define*` e `ref`; os tipos `HostContext`, `DesktopContext`, `ClientContext`, `Services` e `Call`; os contratos da plataforma (`AppHooksV1`, `WindowHooksV1`, `DoricWindowsV1`, `DoricMenusV1`, `DoricCatalogV1`, `DoricDiagnosticsV1`, `DoricBundleV1`, `DoricCacheV1`, `DoricTokensV1`); as referências dos contratos básicos, com seus tipos (`HooksV1`, `LogV1`, `SettingsV1`, `SecretsV1`, `SecretsBackendV1`, `ToolsV1`, `SkillsV1`, `StorageV1`, `StorageBackendV1`, `EventsV1`, `ModelsV1`, `ModelsProviderV1`, `CommandsV1`, `UiV1`, `NavigationV1`, `RegionsV1`, `WindowsV1`, `MenusV1`) |
| `core/contracts`                                               | Só o que é do core: `CoreHooksV1` e a referência `OpenSettingsCommandV1` do comando `core.open-settings/v1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `<bundle>/contracts`                                           | As refs de serviços e comandos e as definições sem lógica de outro bundle (`git/contracts`, `runtime/contracts`, `files/contracts` e outros)                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

As referências e os tipos dos contratos básicos ficam na plataforma porque qualquer bundle pode fornecê-los; o core fornece as definições com `execute`, por exemplo `defineService(WindowsV1, { open: defineMethod({ input, output, execute }) })`, e passar a ref no lugar do ID faz o compilador conferir os métodos. O próprio bundle importa seus contratos por caminho relativo (`../contracts/index.js`), e nenhum código importa o entrypoint `bundle`, que é o loader Node. Nenhum membro recebe JSON Schema escrito à mão.

Um bundle declara em `requires` todo contrato que usa com `use`, inclusive os básicos do core (`hooks/v1`, `events/v1`, `settings/v1`, `tools/v1`, `commands/v1`, `ui/v1`, `storage/v1` e os demais). Contratos `doric.*` são da plataforma, sempre existem e nunca entram em `requires`; `use` deles é sempre permitido. Contratos opcionais são obtidos com `whenAvailable` e também não entram em `requires`.

Tudo que um bundle registra por meio de serviços (um provedor, um handler de hook, um tipo de evento, uma tool, um comando, um elemento de UI) é rastreado pelo loader e descartado em ordem inversa na desativação. A função de limpeza devolvida por `activate` roda nesse momento e substitui o `onDispose` e o `signal` do contexto antigo; o cancelamento de cada operação chega por `call.signal`.

### `call`

Todo `execute` de método de serviço, de comando e de tool, e todo handler de hook, recebe `call`, cujo tipo `Call` vem de `bundle/contracts`:

```ts
interface Call {
  /** Preenchido pelo dispatcher da plataforma em cada salto, nunca pelo bundle e nunca herdado. */
  readonly caller: {
    readonly bundleId: string;
    readonly version: string;
    readonly generation: number;
  };
  readonly scope?: {
    readonly projectId?: string;
    readonly threadId?: string;
    readonly promptId?: string;
    readonly windowKey?: string;
  };
  /** Cancelado junto com a operação, o prompt ou a geração do chamador. */
  readonly signal: AbortSignal;
  readonly trace: TraceContext;
}
```

O bundle que faz uma chamada nunca monta um `call`. Todo stub aceita, como último argumento opcional, um `call` pai (o `call` que o chamador recebeu) ou `{ signal, deadline }`. A regra é a mesma em todo salto:

- `call.caller` do salto novo é sempre o bundle que faz a chamada, preenchido pelo dispatcher, e nunca é herdado do `call` pai. No `execute` de `switchBranch` do git, `call.caller` é quem chamou o git; quando o git chama `events.append(branchSwitchedEvent, payload, call)` repassando esse `call`, o `caller` desse novo salto é `git`, e é o git que o `events/v1` vê como chamador.
- O dispatcher herda do `call` pai `scope`, `signal` e `trace`; com `{ signal, deadline }` ou sem argumento, a chamada sai sem escopo de execução, com o sinal informado (ou o da geração do chamador) e um trace novo.
- Em toda chamada que sai de uma janela client, o dispatcher preenche `scope.windowKey` com a chave daquela janela, mesmo sem `call` pai. É isso que permite registrar `onCloseHook` e `onFlushHook` no `activate` do client.

`call.caller` serve ao diagnóstico, ao log e ao handler que precisa saber quem disparou a chamada; o `log/v1`, por exemplo, marca cada linha com o bundle, a versão e a geração tirados dele.

### Antes e agora

O que antes era membro do contexto vira contrato de serviço, fornecido pelo core ou pela plataforma:

| Antes                                                  | Agora                                                                                                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.hooks`                                            | `hooks/v1` (`define`, `use`, `whenAvailable`)                                                                                                |
| `ctx.log`                                              | `log/v1`                                                                                                                                     |
| `ctx.config`, `ctx.settings`                           | `settings/v1` (`register(definição)`, `await get(definição)`, `subscribe`)                                                                   |
| `ctx.secrets`                                          | `secrets/v1`, fachada do core sobre `secrets.backend/v1`                                                                                     |
| `ctx.tools` e skills                                   | `tools/v1`, `skills/v1`                                                                                                                      |
| `ctx.events`                                           | `events/v1` (`register`, `append(definição, payload, call)`)                                                                                 |
| `ctx.storage`                                          | `storage/v1`, fachada do core sobre `storage.backend/v1`                                                                                     |
| `ctx.commands`                                         | `commands/v1`, no `desktopMain` e no `client`                                                                                                |
| `ctx.ui`                                               | `ui/v1` (`define`, `create` e `dispose`, por tag; veja [`ui.create` passo a passo](./core.md#uicreate-passo-a-passo))                        |
| `ctx.windows`                                          | `windows/v1`, alcançável pelo client, sobre `doric.windows/v1`, nativo                                                                       |
| `ctx.menus`, `ctx.keybindings`, `DesktopContextV1.set` | `menus/v1` (itens, atalhos e `setContext`), alcançável pelo client, sobre `doric.menus/v1`, nativo                                           |
| Diretório de cache do `DesktopContext`                 | `doric.cache/v1`, da plataforma, no `desktopMain`                                                                                            |
| `ctx.roles.provide('durableState', backend)`           | `services.provide(postgresStorage)`, com `postgresStorage = defineService(StorageBackendV1, { ... })` e o provedor escolhido pela composição |
| `ctx.bundle`                                           | `doric.bundle/v1`                                                                                                                            |
| `ctx.signal`, `ctx.onDispose`                          | Função de limpeza devolvida por `activate` e `call.signal` em cada chamada                                                                   |

| Serviço                                          | O que entrega ao chamador                                                                                                                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doric.bundle/v1`, `log/v1`                      | Identidade do chamador nesta geração e log marcado com `bundleId`, `version` e `generation` tirados de `call.caller`, com o escopo da chamada e o `environment` do processo; redige segredos |
| `hooks/v1`                                       | `define` para os hooks próprios, `use` e `whenAvailable` para os de outros bundles                                                                                                           |
| `settings/v1`                                    | `register(definição)` e leitura tipada com `await get(definição)`                                                                                                                            |
| `tools/v1`, `skills/v1`                          | Registro de tools e skills                                                                                                                                                                   |
| `events/v1`                                      | Registro de tipos de evento e `append` com payload validado pelo schema zod da definição                                                                                                     |
| `storage/v1`                                     | Fachada do core sobre `storage.backend/v1`: `defineType`, `get`, `query`, `read` e `commit`                                                                                                  |
| `secrets/v1`                                     | Fachada sobre `secrets.backend/v1`: `resolve(ref: CredentialRef, call): Promise<Secret>`                                                                                                     |
| `commands/v1`, `ui/v1`, `windows/v1`, `menus/v1` | Registro de comandos, elementos visuais, janelas e menus pelas políticas do core                                                                                                             |
| `navigation/v1`, `regions/v1`                    | Rotas por path mostradas no `<core-outlet>` e regiões com nome mostradas no `<core-region>`                                                                                                  |

O contexto **não** entrega, e nenhum serviço básico expõe, `ProjectRuntime`, `ThreadStore`, `WorkspacePublisher`, o app Express, o listener de rede, `process.env` nem o diretório de dados do host. Esses objetos ficam no kernel ou no bundle `runtime`.

Uso típico na ativação da parte `host` do git, com as referências básicas de `bundle/contracts`, os contratos do próprio git por caminho relativo e as definições com `execute` (o serviço `gitCommands` e a tool `gitTool`) no código da própria parte:

```ts
// git, host/index.js (pseudocódigo da API proposta)
import {
  EventsV1,
  HooksV1,
  SettingsV1,
  ToolsV1,
  type HostContext,
} from 'bundle/contracts';
import {
  GitHooksV1,
  branchSwitchedEvent,
  gitSettings,
} from '../contracts/index.js';
import { gitCommands } from './git-commands.js';
import { gitTool } from './git-tool.js';

export function activate({ services }: HostContext) {
  services.use(SettingsV1).register(gitSettings); // await settings.get(gitSettings) passa a ser tipado por este schema
  services.use(EventsV1).register(branchSwitchedEvent);
  services.use(ToolsV1).register(gitTool, { alwaysAvailable: false }); // definida abaixo
  services.use(HooksV1).define(GitHooksV1);
  services.provide(gitCommands);

  return () => {
    /* libera recursos próprios; os registros acima o loader já descarta */
  };
}

// git, host/git-commands.js
import { z } from 'zod';
import {
  defineMethod,
  defineService,
  EventsV1,
  HooksV1,
} from 'bundle/contracts';
import { GitHooksV1, branchSwitchedEvent } from '../contracts/index.js';

export const gitCommands = defineService('git.commands/v1', {
  switchBranch: defineMethod({
    input: z.object({ projectId: z.string(), to: z.string() }).strict(),
    output: z.object({ from: z.string(), to: z.string() }).strict(),
    execute: async ({ projectId, to }, call, services) => {
      // call.caller é quem chamou o git
      const gitHooks = services.use(HooksV1).define(GitHooksV1); // o mesmo handle do activate
      const repository = await repositoryOf(projectId, call.signal);
      const from = await currentBranch(projectId);
      const decision = await gitHooks.onBeforeSwitchBranchHook.execute(
        { projectId, from, to },
        call,
      );
      if (!decision.allow)
        throw new GitError('switch-refused', decision.reason);
      /* ... troca o branch ... */
      await services
        .use(EventsV1)
        .append(branchSwitchedEvent, { projectId, repository, from, to }, call); // neste salto, call.caller é git
      return { from, to };
    },
  }),
});
```

Do serviço, `git/contracts` exporta só a referência `GitCommandsV1 = ref<typeof gitCommands>('git.commands/v1')`, ao lado das definições sem lógica (`GitHooksV1`, `branchSwitchedEvent`, `gitSettings`); os consumidores usam a ref com `services.use(GitCommandsV1)`.

A parte `host` do git declara no manifesto, em `requires`, os contratos que esse código e a tool usam: `settings/v1`, `events/v1`, `hooks/v1`, `tools/v1` e `runtime.workspace/v1`; em `provides`, `git.commands/v1`, `git.hooks/v1`, `git.settings/v1` e `git.branch-switched/v1`.

`commands/v1` existe só no `desktopMain` e no `client`, nunca no `host`: o comando `switchBranchCommand` fica em `client/commands.js` e é registrado na parte client do git (ver [contextos do desktop](#contextos-do-desktop)), chamando o stub de `GitCommandsV1.switchBranch`. Uma parte `host` nunca registra comando.

Um consumidor registra handlers nos hooks de outro bundle com `hooks.use(GitHooksV1).onBeforeSwitchBranchHook(handler)`, ou com `hooks.whenAvailable(GitHooksV1, (h) => h.onBeforeSwitchBranchHook(handler))` quando o contrato é opcional. Os hooks do app são registrados pelo mesmo caminho, `hooks.use(AppHooksV1).onAppReadyHook(handler)`, por qualquer bundle, não só pelo core; não há mais o atalho `ctx.hooks.onAppReadyHook`.

O modelo completo de hooks, com `kind` e `execute`, está em [hooks](./hooks.md); serviços, stubs e canais estão em [serviços e canais](./services-and-channels.md).

### A plataforma como consumidora

Em cada ambiente, depois que o provedor de `hooks/v1` daquele ambiente ativa (o core, por padrão, ou o bundle escolhido em `providers`), a plataforma daquele ambiente obtém esse provedor, chama `define(AppHooksV1)` e passa a disparar `execute` nos pontos do ciclo de vida. `WindowHooksV1` (`onCloseHook`, `onFlushHook`) é definido pela plataforma no ambiente `client`: o bootstrap de cada janela o define no `hooks/v1` do client e o executa quando o main pede o fechamento daquela janela.

A plataforma é só mais um consumidor do contrato: se outro bundle fornecer `hooks/v1`, o app usa esse. Pela mesma lógica a plataforma lê settings, segredos, tools e storage pelos contratos, sem conhecer a implementação. O log da própria plataforma é independente do core e não passa por `log/v1`. O `onActivateHook` do próprio provedor de `hooks/v1` não é observável, porque ele ativa antes de o contrato existir.

Uma falha do `activate` de um bundle leva esse bundle à quarentena. Uma falha de um handler de `onActivateHook`, que é `observe`, só vai ao diagnóstico.

### Ordem de ativação e fundação

Em cada ambiente, o loader ativa os bundles nesta ordem:

1. **Fundação:** os bundles escolhidos em `providers` para contratos que o core fornece ou consome, por exemplo `myhooks` para `hooks/v1` e `postgres` para `storage.backend/v1` e `secrets.backend/v1`. Bundles da fundação só podem declarar `requires` de contratos `doric.*`.
2. **Core:** o core pode declarar `requires` apenas de contratos que a fundação fornece (`storage.backend/v1`, `secrets.backend/v1`).
3. **Demais bundles**, em ordem de dependência.

Quando a composição escolhe outro provedor para um contrato que o core também fornece, o loader não registra a implementação do core para esse contrato naquele ambiente, e o `services.use` do próprio core devolve o provedor escolhido.

### Substituição de provedores e cardinalidade

Qualquer contrato sem prefixo `doric.` pode ser fornecido por outro bundle. A cardinalidade é `one` por padrão; um contrato `many` a declara com `{ cardinality: 'many' }` em `defineService`:

| Cardinalidade  | Significado                                               | Exemplos                                                                                                                                             |
| -------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `one` (padrão) | Um provedor ativo por ambiente, escolhido pela composição | `hooks/v1`, `storage.backend/v1`, `secrets.backend/v1`, `runtime/v1`, `executor/v1`, `sandbox/v1`                                                    |
| `many`         | Vários provedores sem conflito, agregados pelo consumidor | `models.provider/v1`: `openai`, `openrouter` e `codex` registram tipo configurável, campos e catálogo de modelos, agregados pelo `models/v1` do core |

Para um contrato `one` com mais de um provedor habilitado, a composição escolhe o provedor em `providers`:

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

A escolha vale em cada ambiente em que o bundle escolhido fornece o contrato; nos outros ambientes o provedor padrão continua. Sem escolha em `providers`, o segundo provedor de um contrato `one` vai para quarentena com motivo; como a fundação e o core ativam antes, é o bundle substituto que vai para quarentena se a composição não o escolher. Os antigos papéis exclusivos (armazenamento durável, segredos, runtime de domínio, executor, provider de sandbox) passam a ser exatamente isso: contratos `one` (`storage.backend/v1`, `secrets.backend/v1`, `runtime/v1`, `executor/v1`, `sandbox/v1`). O bundle que não foi escolhido não fornece o contrato; não há mais `ctx.roles`. Contratos `doric.*` são da plataforma e não aceitam outro provedor. A escolha está em [composição e distribuição](./composition-and-distribution.md).

Por padrão, `storage.backend/v1` e `secrets.backend/v1` são fornecidos pelo bundle `postgres`. O `secrets.backend/v1` padrão guarda os segredos como o credential store atual do host. Sobre eles, o core fornece as fachadas `storage/v1` e `secrets/v1`.

## O fim do `ExecutionContext`

Não existe mais `ExecutionContext` como objeto de capacidades. O `Host` atual, a fachada por prompt entregue a cada handler de tool com `threads`, `workspace` e `terminals` opcional (os tipos ficam em `runtime/contracts`, pois `packages/host` foi removido), é decomposto em contratos: os controles `threads`, `workspace` e `terminals` viram `runtime.threads/v1`, `runtime.workspace/v1` e `terminal/v1`. Um handler recebe `call` e obtém capacidades como serviços no escopo da chamada:

| Capacidade                                                                        | Como obter                                                                           |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Envio de prompt, leitura de Threads e controles de Threads filhas do `Host` atual | `services.use(RuntimeThreadsV1, call.scope)` (`runtime.threads/v1`)                  |
| `cwd` e `setCwd`                                                                  | `services.use(RuntimeWorkspaceV1, call.scope)` (`runtime.workspace/v1`)              |
| Terminais                                                                         | `services.use(TerminalV1, call.scope)` (`terminal/v1`)                               |
| Emissão de evento durável                                                         | `services.use(EventsV1).append(definição, payload, call)`                            |
| Resolução de modelo                                                               | `services.use(ModelsV1, call.scope).resolve(ref)` (`models/v1`, do core)             |
| Estado de histórico de um executor                                                | `services.use(RuntimeHistoryV1, call.scope)` (`runtime.history/v1`, `load` e `save`) |

`defineTool` continua sendo a API do pacote `tool`, e o bundle registra a tool com `services.use(ToolsV1).register(gitTool, { alwaysAvailable: false })`. Hoje o `execute` de `defineTool` recebe `(sandbox, host, payload, config)`; na proposta ele recebe `(payload, call, services)`, como `defineMethod` e `defineCommand`, com os serviços do bundle ligados no `register` de `tools/v1`. Isso é uma **mudança proposta do pacote `tool`**.

```ts
// git, host/git-tool.js (pseudocódigo da API proposta)
import { EventsV1 } from 'bundle/contracts';
import { RuntimeWorkspaceV1 } from 'runtime/contracts';
import { defineTool } from 'tool';
import { branchSwitchedEvent } from '../contracts/index.js';

export const gitTool = defineTool({
  /* nome, descrição, schema */
  async execute(payload, call, services) {
    const workspace = services.use(RuntimeWorkspaceV1, call.scope);
    /* ... usa workspace.cwd ... */
    await services.use(EventsV1).append(branchSwitchedEvent, payload, call);
  },
});
```

Um handler de hook recebe o mesmo `call`, com `scope`, `signal` e `trace` da operação que disparou o hook. Com processos por geração, nada muda na forma desses objetos: os serviços que dependem do kernel viram stubs sobre o envelope RPC, e `call` atravessa o envelope (ver [isolamento por processo](./process-isolation.md)).

## Contextos do desktop

Partes `desktopMain` recebem `DesktopContext` e partes `client` recebem `ClientContext`; ambos têm a mesma forma do `HostContext`: só `services`. Não existem `CoreDesktopContext` nem `CoreClientContext`; o que só o core fazia passa a ser o core fornecendo contratos:

| Ambiente      | Serviços que o core fornece por padrão                                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktopMain` | `hooks/v1`, `log/v1`, `settings/v1` (preferências locais do desktop), `windows/v1`, `menus/v1`, `commands/v1`, `core.hooks/v1`                                  |
| `client`      | `hooks/v1`, `log/v1`, `ui/v1`, `navigation/v1`, `regions/v1`, `commands/v1`; define `<core-outlet>`, `<core-region>`, `<core-not-found>` e `<core-unavailable>` |

Qualquer serviço fornecido no `desktopMain` ou no host é alcançável pela ponte por uma parte `client` que o declara em `requires` ou o consome com `whenAvailable`. É assim que uma parte client usa `windows/v1` (abrir e focar janelas pelas políticas do core) e `menus/v1` (itens, atalhos e `setContext`), com `services.use(WindowsV1)` e `services.use(MenusV1)`.

Os contratos nativos `doric.windows/v1` e `doric.menus/v1` são usados pelo core; os outros bundles usam `windows/v1` e `menus/v1`, que o core expõe com suas políticas. O core monta o esqueleto do menu num handler de `onAppReadyHook`, não direto no `activate`. O diretório de cache próprio que o antigo `DesktopContext` entregava deixa de fazer parte do contexto e passa a vir de `doric.cache/v1`, contrato da plataforma no `desktopMain`, que entrega um diretório por bundle; é dele que `history` grava `<hostId>/<storageGeneration>/<threadId>`.

`commands/v1` existe no `desktopMain` e no `client`. Comandos de UI e de menu são definições de `defineCommand`, que carregam `execute` como uma tool, definidas e registradas na parte client (ou `desktopMain`) com `services.use(CommandsV1).register(switchBranchCommand)`. No client, `hooks.use(WindowHooksV1).onCloseHook(handler)` e `hooks.use(WindowHooksV1).onFlushHook(handler)` registram para a janela do client que chamou (o `call.scope.windowKey`), no `hooks/v1` em que o bootstrap daquela janela definiu `WindowHooksV1`. Janelas, menus e atalhos estão em [janelas](./windows.md) e [menus e atalhos](./menus-and-keybindings.md); `ui/v1`, `navigation/v1` e `regions/v1` estão em [UI no client](./core.md#ui-no-client), [navegação e rotas](./navigation.md) e [UI composta por bundles](./ui-composition.md); o workspace, a sidebar e as abas estão no [bundle layout](./layout.md).

## Ressalvas

- O core vira dependência de quase todos os bundles; por isso falha do core leva ao modo de recuperação, como já previsto em [splash e recuperação](./splash-and-recovery.md).
- Catálogo, diagnóstico, splash e recuperação continuam na plataforma (`doric.catalog/v1`, `doric.diagnostics/v1`), com log próprio, porque precisam funcionar sem o core.

## Relações

- [Contratos e a família `define*`](./contracts.md): define os objetos que `hooks/v1`, `services.provide`, `events/v1`, `settings/v1`, `commands/v1` e `storage/v1` recebem e a cardinalidade de `defineService`.
- [Hooks e ciclo de vida](./hooks.md): explica `kind`, `execute`, o `call` que os handlers de hook recebem, o contrato `hooks/v1` e a definição de `AppHooksV1` e `WindowHooksV1` pela plataforma.
- [Serviços entre bundles e canais de mensagens](./services-and-channels.md): detalha `Services`, `call` e os stubs tipados.
- [Armazenamento genérico e histórico](./storage.md): descreve `storage/v1` e o contrato `storage.backend/v1`, com o provedor escolhido pela composição.
- [Eventos e nodes](./events-and-nodes.md): explica os eventos duráveis registrados e emitidos por `events/v1`.
- [Isolamento por processo](./process-isolation.md): mostra como os serviços dependentes do kernel viram stubs sobre o envelope RPC.
- [Composição e distribuição pelo host](./composition-and-distribution.md): escolhe o core e os provedores de cada contrato em `providers`, por ambiente.
- [Bundle core e quarentena](./core.md): lista os contratos que o core fornece em cada ambiente, a fundação e a ordem de ativação.
- [Janelas abertas pelo core](./windows.md) e [Menus nativos e atalhos](./menus-and-keybindings.md): detalham `windows/v1`, `menus/v1` e `commands/v1`, sobre `doric.windows/v1` e `doric.menus/v1`.
- [UI composta por bundles](./ui-composition.md): detalha `ui/v1` e `regions/v1`.
- [Navegação e rotas](./navigation.md): detalha `navigation/v1`, as rotas por path e o `<core-outlet>`.
- [Bundle layout](./layout.md): descreve o `<layout-workspace>`, as regiões `layout.*` e as abas.
- [Observabilidade](./observability.md): descreve a marcação do log por `call.caller` e o log próprio da plataforma.
- [Protocolo `doric://`](./doric-protocol.md): descreve como o renderer carrega shell e bundles numa única origem.
