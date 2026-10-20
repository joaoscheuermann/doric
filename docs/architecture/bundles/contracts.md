# Contratos e a família define\*

**Estado:** proposta. Parte da [arquitetura de bundles](../bundles.md); nada aqui descreve comportamento já implementado, e `GROUNDING.md` continua sendo o contrato da implementação atual.

## Resumo

Um contrato é a parte pública e versionada de um bundle que outro bundle pode usar sem importar código interno: hooks, serviços, eventos, comandos, configuração e tipos de storage. Os contratos são escritos em zod e definidos por funções `define*` (`defineHook`, `defineHooks`, `defineService`, `defineMethod`, `defineEvent`, `defineCommand`, `defineSettings` e `defineStorageType`), no mesmo molde do `defineTool` que já existe em `packages/tool/src/lib/tools.ts`. O JSON Schema 2020-12 continua sendo o formato canônico serializável, mas é gerado do zod no build e publicado no catálogo; nenhum bundle escreve JSON Schema à mão. Serviços, métodos e comandos trazem o `execute` na própria definição, como uma tool: a definição fica no código da parte que fornece o contrato, e o entrypoint `contracts/` do bundle publica só uma referência tipada (`ref`), que é o que os consumidores importam. As funções `define*`, `ref` e as referências e os tipos dos contratos básicos vêm de `bundle/contracts`, porque qualquer bundle pode fornecê-los; o core fornece por padrão as definições com `execute`. Como o contexto de ativação só entrega `services`, todo registro e todo uso dessas definições passa por contratos de serviço (`hooks/v1`, `settings/v1`, `events/v1`, `commands/v1`, `tools/v1`, `storage/v1`), implementados pelo core por padrão e substituíveis por outro bundle. As definições expõem só as propriedades necessárias; um serviço declara apenas a cardinalidade, quando ela é `many`. Esta proposta não trata segurança. Este documento é a referência da especificação dessa API, das regras de IDs de contrato, da propagação de `call` e da substituição de provedores, incluindo a fundação que ativa antes do core.

## O molde: `defineTool`

Hoje `defineTool`, em `packages/tool/src/lib/tools.ts`, recebe `name`, `description`, `input` (um `z.object`), `output` (um schema zod) e `execute`. Ele:

- recusa um `input` que não seja `z.ZodObject`;
- converte `input` e `output` para JSON Schema com `z.toJSONSchema`, e esse JSON Schema é o que vai para o provider;
- valida a saída de `execute` com `safeParse` e transforma uma saída inválida em erro tipado.

A família `define*` segue o mesmo desenho: uma única definição em zod dá o tipo TypeScript para quem escreve o código, a validação em runtime e o JSON Schema serializável. Onde existe lógica, ela fica na definição, num `execute`, como numa tool: em cada `defineMethod` de um serviço e em cada `defineCommand`. Num hook é diferente: a lógica é dos handlers que outros bundles registram, e o `execute` do hook é o disparo, que fica no handle que o dono recebe de `services.use(HooksV1).define(...)`.

`defineTool` continua sendo a API do pacote `tool`, com uma mudança proposta nesse pacote: hoje o `execute` recebe `(sandbox, host, payload, config)`; na proposta ele recebe `(payload, call, services)`, como `defineMethod` e `defineCommand`. `services` são os serviços do bundle que registrou a tool, ligados no registro, do mesmo jeito que hoje `sandbox` e `host` são ligados pela factory. O bundle registra a tool com `services.use(ToolsV1).register(gitTool, { alwaysAvailable: false })`.

## O objeto `call`

Todo `execute` de método, comando e tool recebe `(input, call, services)`, e todo handler de hook recebe `(input, call)`:

```ts
// pseudocódigo da API proposta
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

`call.caller` é preenchido pelo dispatcher da plataforma, nunca pelo bundle, e serve para diagnóstico, log e para o handler saber quem disparou a chamada. Não existe objeto de capacidades por execução: o handler obtém o que precisa como serviço e repassa `call`, por exemplo `services.use(EventsV1).append(definição, payload, call)` ou `services.use(ModelsV1, call.scope).resolve(ref)`. Os detalhes estão em [contextos e capacidades](./contexts.md).

### Propagação de `call`

Todo stub de serviço aceita como último argumento opcional um `call` pai (o `call` que o handler recebeu) ou `{ signal, deadline }`:

- com um `call` pai, o dispatcher herda dele `scope`, `signal` e `trace`;
- `call.caller` do salto novo é sempre o bundle que faz a chamada, preenchido pelo dispatcher, e nunca é herdado do pai;
- o dispatcher preenche `scope.windowKey` em toda chamada que sai de uma janela client.

No exemplo do git: no `execute(input, call, services)` de `switchBranch`, `call.caller` é o bundle que chamou o git. Quando o git chama `events/v1` repassando esse `call`, o novo salto herda `scope`, `signal` e `trace`, mas o `caller` que `events/v1` recebe é `git`.

## JSON Schema canônico gerado do zod

A decisão registrada em 2026-10-08 é: JSON Schema 2020-12 é o formato canônico serializável; o código pode gerá-lo a partir de zod. Com a família `define*`, a geração deixa de ser opcional para contratos de bundle:

- o JSON Schema de cada contrato é gerado do zod no build do bundle e publicado no catálogo do host;
- nenhum bundle escreve JSON Schema à mão;
- a convenção de pasta `schemas/*.json` ("JSON Schemas referenciados pelo código") desaparece da lista de convenções do bundle, e com ela todos os `$ref` para arquivos de schema;
- o JSON Schema gerado é o que atravessa processos e máquinas, o que o catálogo publica e o que a verificação de semver vai comparar quando voltar, suspensa até a publicação (etapa 11) (veja [versionamento semântico](./versioning.md)).

O mesmo vale para o próprio manifesto: na proposta, o manifesto v1 é validado por um JSON Schema publicado em `doric://app/schemas/bundle-manifest/v1.json`, gerado a partir do schema zod de `packages/bundle` (veja [manifesto v1](./manifest.md)). Hoje `packages/bundle/src/lib/load.ts` valida só o formato atual, que passa a ser o manifesto v0, com zod em modo `strict`.

### De onde vêm as funções

As funções `define*` e `ref` vêm do subpath browser-safe `bundle/contracts` de `packages/bundle`, junto com:

- as constantes dos contratos da plataforma: `DoricCatalogV1` (`doric.catalog/v1`), `DoricDiagnosticsV1` (`doric.diagnostics/v1`), `DoricBundleV1` (`doric.bundle/v1`), `DoricWindowsV1` (`doric.windows/v1`), `DoricMenusV1` (`doric.menus/v1`), `DoricCacheV1` (`doric.cache/v1`) e `DoricTokensV1` (`doric.tokens/v1`);
- as definições de hooks da plataforma `AppHooksV1` (`doric.app.hooks/v1`) e `WindowHooksV1` (`doric.window.hooks/v1`);
- os tipos `HostContext`, `DesktopContext`, `ClientContext`, `Services` e `Call`, que todo bundle importa daqui (partes `host` usam `HostContext`, partes `desktopMain` usam `DesktopContext` e partes `client` usam `ClientContext`);
- as **referências** (`ref`) e os tipos dos contratos básicos: `HooksV1`, `LogV1`, `SettingsV1`, `SecretsV1`, `SecretsBackendV1`, `ToolsV1`, `SkillsV1`, `StorageV1`, `StorageBackendV1`, `EventsV1`, `ModelsV1`, `ModelsProviderV1`, `CommandsV1`, `UiV1`, `NavigationV1`, `RegionsV1`, `WindowsV1` e `MenusV1`.

As referências e os tipos dos básicos ficam na plataforma porque qualquer bundle pode fornecer esses contratos. O core escreve as definições com `execute`, com a referência no lugar do ID (`defineService(WindowsV1, { open: defineMethod({ input, output, execute }) })`), e as fornece. Um provedor substituto como `myhooks`, o `postgres` (com `storage.backend/v1` e `secrets.backend/v1`) ou um core alternativo nomeado pela composição importa as mesmas referências de `bundle/contracts` e fornece a própria definição com `execute`.

Os demais entrypoints seguem esta regra:

- `core/contracts` exporta só o que é do core: `CoreHooksV1` (`core.hooks/v1`) e a referência `OpenSettingsCommandV1 = ref<typeof openSettings>('core.open-settings/v1')`, com `import type` da definição; a definição `openSettings`, com o `execute`, fica no código `desktopMain` do core (veja [comandos](#comandos-definecommand));
- contratos de outros bundles vêm de `<bundle>/contracts`, por exemplo `git/contracts` ou `chat/contracts`;
- o próprio bundle importa seus contratos por caminho relativo (`../contracts/index.js`), nunca pelo próprio `<bundle>/contracts`;
- nenhum código de bundle importa o entrypoint `bundle`, que é o loader Node;
- bundles não importam `packages/desktop`, que é o runtime client do loader usado por `app/doric-renderer`; componentes, tokens e Tailwind continuam em `desktop/ui`.

## IDs de contrato

Todo contrato tem um ID com major (`/vN`). O prefixo do ID diz quem é o dono e se outro bundle pode fornecê-lo:

| Categoria         | Forma do ID                                                      | Exemplos                                                                                                                                                                                                                                                              | Substituível                                                                                                                                                                                                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plataforma        | `doric.<nome>/vN`                                                | `doric.catalog/v1`, `doric.diagnostics/v1`, `doric.bundle/v1`, `doric.windows/v1`, `doric.menus/v1`, `doric.cache/v1`, `doric.tokens/v1`, `doric.app.hooks/v1` (`AppHooksV1`), `doric.window.hooks/v1` (`WindowHooksV1`)                                              | Não                                                                                                                                                                                                                                                                                                                                                       |
| Serviços básicos  | só o domínio: `<domínio>/vN`                                     | `hooks/v1`, `log/v1`, `settings/v1`, `secrets/v1`, `secrets.backend/v1`, `tools/v1`, `skills/v1`, `storage/v1`, `storage.backend/v1`, `events/v1`, `models/v1`, `models.provider/v1`, `commands/v1`, `ui/v1`, `navigation/v1`, `regions/v1`, `windows/v1`, `menus/v1` | Sim; o core fornece por padrão, exceto `storage.backend/v1` e `secrets.backend/v1`, cujo provedor padrão é `postgres`, e `models.provider/v1`, fornecido por bundles como `openai`, `openrouter` e `codex`                                                                                                                                                |
| Papéis de domínio | só o domínio: `<domínio>/vN`                                     | `executor/v1`, `sandbox/v1`                                                                                                                                                                                                                                           | Sim; contratos `one` sem provedor no core, como `storage.backend/v1`: os provedores são bundles como `direct`, `docker` e `firecracker`. As referências e os tipos não estão em `bundle/contracts`; ficam em `runtime/contracts`, publicados pelo `runtime`, que os consome; cada provedor escreve sua definição com `defineService(ExecutorV1, { ... })` |
| Outros bundles    | `<bundle>.<nome>/vN`, ou `<bundle>/vN` para o contrato principal | `git.commands/v1`, `git.hooks/v1`, `git.settings/v1`, `git.switch-branch/v1`, `git.branch-switched/v1`, `chat.views/v1`, `layout.tabs/v1`, `core.hooks/v1`, `runtime.threads/v1`, `runtime.thread/v1`, `files/v1`                                                     | Sim                                                                                                                                                                                                                                                                                                                                                       |

- O prefixo `doric.` é reservado à plataforma; contratos `doric.*` são da plataforma, sempre existem, não aparecem no `provides` nem no `requires` de nenhum bundle e não aceitam outro provedor. `use` de um contrato `doric.*` é sempre permitido.
- Os serviços básicos não levam o nome do core no ID, porque o core é só o provedor padrão.
- Eventos, comandos, settings, tipos de storage e blocos de conteúdo seguem a mesma regra dos contratos de bundle: `git.branch-switched/v1`, `git.switch-branch/v1`, `git.settings/v1`, `runtime.thread/v1`, `git.branch-change/v1`.
- Tags de custom elements começam com o ID do bundle dono (`core-outlet`, `layout-workspace`, `chat-view`, `git-branch-event`); o `ui/v1` recusa uma tag que não comece com `<id do bundle chamador>-`.

## Substituição de provedores

Qualquer contrato sem prefixo `doric.` pode ser fornecido por outro bundle, inclusive os serviços básicos do core. Se dois bundles habilitados fornecem o mesmo contrato de cardinalidade `one`, a composição escolhe o provedor em `providers`:

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

### Cardinalidade

A cardinalidade é a única opção de `defineService`, e só é escrita quando é `many`:

- `one` (padrão): um provedor ativo por ambiente, escolhido pela composição. Os antigos papéis exclusivos passam a ser exatamente isso: `storage.backend/v1`, `secrets.backend/v1`, `runtime/v1`, `executor/v1` e `sandbox/v1`. O antigo `ctx.roles.provide('durableState', backend)` vira `services.provide(postgresStorage)`, com `postgresStorage = defineService(StorageBackendV1, { ... })`, e a composição escolhe o provedor.
- `many`: vários provedores sem conflito, agregados pelo consumidor. Por exemplo, `openai`, `openrouter` e `codex` fornecem `models.provider/v1`, cada um registrando seu tipo configurável, seus campos e seu catálogo de modelos, e o `models/v1` do core agrega todos. Um contrato `many` não aparece em `providers`.

Todo provedor de um contrato `many` declara `{ cardinality: 'many' }` na própria definição, e o loader compara essa cardinalidade com a do contrato publicado no catálogo. Um provedor que diverge, inclusive por omitir a opção, vai para quarentena com motivo. Assim a `ref` continua só com o ID, e o consumidor sabe pelo catálogo que o contrato é `many`.

### Escolha por ambiente

A escolha em `providers` vale em cada ambiente em que o bundle escolhido fornece o contrato; nos outros ambientes o provedor padrão continua. Quando a composição escolhe outro provedor para um contrato que o core também fornece, o loader não registra a implementação do core para esse contrato naquele ambiente, e o `services.use` do próprio core devolve o provedor escolhido.

Sem escolha em `providers`, um segundo provedor de um contrato `one` vai para quarentena com motivo. Como a fundação e o core ativam antes dos demais bundles, é o bundle substituto que vai para quarentena se a composição não o escolher. Contratos `doric.*` são da plataforma e não aceitam outro provedor.

### Fundação e ordem de ativação

Em cada ambiente, o loader ativa nesta ordem:

1. A **fundação**: os bundles escolhidos em `providers` para contratos que o core fornece ou consome, por exemplo `myhooks` para `hooks/v1` e `postgres` para `storage.backend/v1` e `secrets.backend/v1`. Bundles da fundação só podem declarar `requires` de contratos `doric.*`.
2. O core, que pode declarar `requires` apenas de contratos que a fundação fornece (`storage.backend/v1`, `secrets.backend/v1`).
3. Os demais bundles, em ordem de dependência.

### Backends e fachadas

`storage.backend/v1` e `secrets.backend/v1` são fornecidos pelo bundle `postgres` por padrão. O `secrets.backend/v1` padrão guarda cada segredo como envelope AES-256-GCM sob `DORIC_CREDENTIAL_KEY`, como o credential store atual do host. Sobre eles, o core fornece as fachadas:

- `secrets/v1` resolve a referência que a operação declarou e aplica redação antes do log, como hoje;
- `storage/v1` é a fachada sobre `storage.backend/v1`; tipos e registros são identificados pelo ID qualificado.

### A plataforma como consumidora

A plataforma é só mais um consumidor dos contratos básicos. Depois que o provedor de `hooks/v1` de um ambiente ativa (o core, por padrão, ou o escolhido em `providers`), a plataforma daquele ambiente chama `define(AppHooksV1)` e passa a disparar `execute` nos pontos do ciclo de vida. `WindowHooksV1` é definido pela plataforma no ambiente `client`: o bootstrap de cada janela o define no `hooks/v1` do client e o executa quando o main pede o fechamento da janela. Da mesma forma a plataforma lê settings, secrets, tools e storage pelos contratos, sem conhecer a implementação. A plataforma tem log próprio, independente do core. A composição e a quarentena estão em [composição e distribuição](./composition-and-distribution.md) e [bundle core e quarentena](./core.md).

## O entrypoint `contracts/` de cada bundle

O dono de um contrato o publica num entrypoint público `contracts/` do bundle. Hooks, eventos, settings e tipos de storage não têm lógica e são exportados como definições. Serviços e comandos têm `execute`, então a definição fica no código da parte que os fornece, e `contracts/` exporta só uma referência tipada criada com `ref`:

```ts
// git, host/git-commands.ts: definição com execute
export const gitCommands = defineService('git.commands/v1', {
  switchBranch: defineMethod({
    /* input, output, execute */
  }),
});

// git, contracts/refs.ts: só os IDs e os tipos
import { ref } from 'bundle/contracts';
import type { gitCommands } from '../host/git-commands.js';
import type { switchBranchCommand } from '../client/commands.js';

export const GitCommandsV1 = ref<typeof gitCommands>('git.commands/v1');
export const SwitchBranchCommandV1 = ref<typeof switchBranchCommand>(
  'git.switch-branch/v1',
);
```

`ref` guarda só o ID; os dois `import type` somem no build, então importar `git/contracts` no client não traz o código do host, e importá-lo no host não traz o código do client. O consumidor:

1. importa só esse entrypoint, por exemplo `git/contracts` ou `default/contracts`;
2. declara o ID do contrato em `requires` no manifesto, ou o consulta com `whenAvailable` quando a dependência é opcional.

Em runtime, o loader resolve o contrato pelo ID, então o consumidor nunca importa código interno do dono. O import de `contracts/` traz referências, tipos e as definições sem lógica. A validação de um serviço ou comando acontece no provedor, com o zod da definição, e entre processos com o JSON Schema gerado dela e publicado no catálogo. O próprio dono não importa `git/contracts`: o código de `git` importa seus contratos por caminho relativo (`../contracts/index.js`).

A regra de `requires` vale para todo contrato usado com `use`, inclusive os básicos do core (`hooks/v1`, `events/v1`, `settings/v1`, `tools/v1`, `commands/v1`, `ui/v1`, `storage/v1` e os demais). Contratos `doric.*` nunca entram em `requires`, porque sempre existem. Contratos opcionais usados com `whenAvailable` também não entram em `requires`.

```ts
// git, contracts/index.ts (pseudocódigo da API proposta)
export { onBeforeSwitchBranchHook, GitHooksV1 } from './hooks.js';
export { GitCommandsV1, SwitchBranchCommandV1 } from './refs.js'; // ref<typeof …>(id)
export { branchSwitchedEvent } from './events.js';
export { gitSettings } from './settings.js';
```

## Registro em código

Tools, eventos, comandos, rotas, views, custom elements, settings, tipos de storage, hooks, janelas, menus e atalhos são registrados pelo código de ativação, cada um com seu schema e sempre por um contrato de serviço. Janelas, menus e atalhos são registrados por `windows/v1` e `menus/v1`, que o core expõe com suas políticas sobre os contratos nativos `doric.windows/v1` e `doric.menus/v1`, usados pelo core (veja [bundle core e quarentena](./core.md)). `windows/v1` (abrir e focar janelas pelas políticas do core) e `menus/v1` (itens, atalhos e `setContext`) são fornecidos no `desktopMain`, e partes `client` que os declaram em `requires` os alcançam pela ponte. O loader valida cada registro e detecta conflitos no momento do registro; um conflito coloca o bundle em quarentena com motivo. Tudo que um bundle registra por meio de serviços é rastreado pelo loader e descartado em ordem inversa na desativação.

Com a família `define*`, cada registro recebe a definição em vez de um ID solto e um schema separado:

```ts
// git, host/index.ts (pseudocódigo da API proposta)
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
import { gitTool } from './git-tool.js';
import { gitCommands } from './git-commands.js';

export const activate = ({ services }: HostContext) => {
  services.use(ToolsV1).register(gitTool, { alwaysAvailable: false });
  services.use(EventsV1).register(branchSwitchedEvent);
  services.use(SettingsV1).register(gitSettings);
  services.use(HooksV1).define(GitHooksV1);
  services.provide(gitCommands);
};

// git, client/index.ts
import { CommandsV1, UiV1, type ClientContext } from 'bundle/contracts';
import { ChatViewsV1 } from 'chat/contracts';
import { switchBranchCommand } from './commands.js';
import { GitBranchEvent } from './git-branch-event.js';

export const activate = ({ services }: ClientContext) => {
  services.use(UiV1).define('git-branch-event', GitBranchEvent);
  services.use(CommandsV1).register(switchBranchCommand);
  services.whenAvailable(ChatViewsV1, (views) =>
    views.registerRenderer({
      blockType: 'git.branch-change/v1',
      elementTag: 'git-branch-event',
    }),
  );
};
```

O manifesto desse exemplo lista em `requires` todos os contratos que o código usa com `use`: `tools/v1`, `events/v1`, `settings/v1` e `hooks/v1` na parte `host`, mais `runtime.lease/v1`, que o `execute` de `switchBranch` usa (veja [hooks](./hooks.md)), e `runtime.workspace/v1`, que `gitTool` usa (veja [contextos e capacidades](./contexts.md)); e `ui/v1`, `commands/v1` e `git.commands/v1` na parte `client`, porque `switchBranchCommand` usa o stub de `git.commands/v1`. `chat.views/v1` não entra, porque é consumido com `whenAvailable`.

```json
{
  "provides": [
    "git.commands/v1@1.3.0",
    "git.hooks/v1@1.0.0",
    "git.settings/v1@1.0.0",
    "git.branch-switched/v1@1.0.0",
    "git.switch-branch/v1@1.0.0",
    "git.open-comparison/v1@1.0.0"
  ],
  "requires": [
    "hooks/v1@^1.0.0",
    "tools/v1@^1.0.0",
    "events/v1@^1.0.0",
    "settings/v1@^1.0.0",
    "commands/v1@^1.0.0",
    "ui/v1@^1.0.0",
    "git.commands/v1@^1.0.0",
    "runtime.lease/v1@^1.0.0",
    "runtime.workspace/v1@^1.0.0"
  ]
}
```

As formas antigas `ctx.events.define(id, schema)` e `ctx.settings.define(id, schema)` dão lugar a `services.use(EventsV1).register(definição)` e `services.use(SettingsV1).register(definição)`. Partes `host` usam `HostContext`, partes `desktopMain` usam `DesktopContext` e partes `client` usam `ClientContext`; os três têm a mesma forma, `{ readonly services: Services }`, e `activate` pode devolver uma função de limpeza; veja [contextos e capacidades](./contexts.md).

## Hooks: `defineHook` e `defineHooks`

`defineHook` recebe só `kind` e `input`; o nome do hook é a chave em `defineHooks`. O registro e o uso passam por `hooks/v1`.

```ts
// git, contracts/hooks.ts
import { defineHook, defineHooks } from 'bundle/contracts';
import { z } from 'zod';

export const onBeforeSwitchBranchHook = defineHook({
  kind: 'decide',
  input: z
    .object({ projectId: z.string(), from: z.string(), to: z.string() })
    .strict(),
});

export const GitHooksV1 = defineHooks('git.hooks/v1', {
  onBeforeSwitchBranchHook,
});
```

- `defineHook` define um único hook. `defineHooks` agrupa hooks sob um ID de contrato versionado, que é o que aparece em `provides` e `requires`.
- `kind` fixa a saída, por isso `defineHook` não recebe `output`:

  | `kind`      | Saída do handler                                                                               | Retorno de `execute` |
  | ----------- | ---------------------------------------------------------------------------------------------- | -------------------- |
  | `observe`   | Nenhuma                                                                                        | `Promise<void>`      |
  | `transform` | Um valor do mesmo schema da entrada, o que permite encadear handlers                           | `Promise<Input>`     |
  | `decide`    | `Decision`, que a plataforma define como `{ allow: true } \| { allow: false; reason: string }` | `Promise<Decision>`  |

- Não há política de falha por hook. Para os três `kind`, um handler que falha ou passa do prazo padrão do provedor de `hooks/v1` é ignorado, a cadeia segue como se ele não existisse e a falha vai ao diagnóstico. Em `decide`, um handler ignorado não recusa. O prazo padrão não vale para os handlers de `WindowHooksV1`: o `onCloseHook` não tem prazo e o `onFlushHook` tem prazo fixo definido pela plataforma (veja [hooks](./hooks.md)).

### Disparar: `execute`

O dono define o contrato pelo serviço `hooks/v1` e dispara o hook com `execute`, como no `defineTool`:

```ts
const hooks = services.use(HooksV1);
const gitHooks = hooks.define(GitHooksV1);
const decision = await gitHooks.onBeforeSwitchBranchHook.execute(input, call);
```

`execute` valida a entrada com o zod, roda os handlers na ordem, valida a saída de cada handler, ignora o handler que falha ou passa do prazo padrão e devolve `Promise<void>` (`observe`), `Promise<Input>` (`transform`) ou `Promise<Decision>` (`decide`). O `call` repassado leva o escopo, o `signal` e o `trace` da chamada que originou o disparo; o `caller` que cada handler recebe é o dono que disparou o hook, conforme a [propagação de `call`](#propagação-de-call).

### Consumir: `use` e `whenAvailable`

O consumidor registra handlers com `hooks.use(GitHooksV1).onBeforeSwitchBranchHook(handler)` ou, se a dependência for opcional, com `hooks.whenAvailable(GitHooksV1, (h) => h.onBeforeSwitchBranchHook(handler))`, sempre sobre `const hooks = services.use(HooksV1)`. O handler recebe `(input, call)`, com `call.caller`, `call.scope`, `call.signal` e `call.trace`, e registra logs por `log/v1`. O registro devolve um descarte, liberado automaticamente quando o bundle que registrou é desativado.

```ts
// pseudocódigo da API proposta
import { HooksV1 } from 'bundle/contracts';
import { GitHooksV1 } from 'git/contracts';

const hooks = services.use(HooksV1);

hooks
  .use(GitHooksV1)
  .onBeforeSwitchBranchHook(async ({ to }, call) =>
    to.startsWith('release/')
      ? { allow: false, reason: 'Branches de release são protegidos.' }
      : { allow: true },
  );
```

### Hooks do app

Os hooks do app são definidos com `defineHooks` pela plataforma, em `bundle/contracts`: `AppHooksV1` (`doric.app.hooks/v1`) para o ciclo de vida do app e das gerações, `WindowHooksV1` (`doric.window.hooks/v1`) para `onCloseHook` e `onFlushHook`. Qualquer bundle, não só o core, registra handlers dos hooks do app, com `hooks.use(AppHooksV1).onAppReadyHook(handler)`; não há mais o atalho `ctx.hooks.onAppReadyHook`. No client, `hooks.use(WindowHooksV1).onCloseHook(handler)` e `hooks.use(WindowHooksV1).onFlushHook(handler)` registram para a janela do client que chamou (o `call.scope.windowKey`, preenchido pelo dispatcher).

Quem define e dispara esses hooks é a plataforma, como consumidora de `hooks/v1`:

- depois que o provedor de `hooks/v1` de um ambiente ativa (o core, por padrão, ou o escolhido em `providers`), a plataforma daquele ambiente chama `define(AppHooksV1)` e passa a chamar `execute` nos pontos do ciclo de vida;
- `WindowHooksV1` é definido pela plataforma no ambiente `client`: o bootstrap de cada janela o define no `hooks/v1` do client e executa `onCloseHook` e `onFlushHook` quando o main pede o fechamento da janela.

Uma falha do `activate` de um bundle leva à quarentena; uma falha de um handler de `onActivateHook` (`observe`) só vai ao diagnóstico. O `onActivateHook` do próprio provedor de `hooks/v1` não é observável, porque ele ativa antes de o contrato existir.

O modelo completo (quem define hooks, as tabelas de hooks do app e dos bundles, as regras de ordem e os exemplos entre bundles) está em [hooks e ciclo de vida](./hooks.md).

## Serviços: `defineService` e `defineMethod`

```ts
// git, host/git-commands.ts (pseudocódigo da API proposta)
import { defineMethod, defineService, HooksV1 } from 'bundle/contracts';
import { z } from 'zod';
import { RuntimeLeaseV1 } from 'runtime/contracts';
import { GitHooksV1 } from '../contracts/index.js';

export const gitCommands = defineService('git.commands/v1', {
  switchBranch: defineMethod({
    input: z.object({ projectId: z.string(), to: z.string() }).strict(),
    output: z.object({ from: z.string(), to: z.string() }).strict(),
    execute: async ({ projectId, to }, call, services) => {
      const gitHooks = services.use(HooksV1).define(GitHooksV1);
      const from = await currentBranch(projectId);
      const decision = await gitHooks.onBeforeSwitchBranchHook.execute(
        { projectId, from, to },
        call,
      );
      if (!decision.allow)
        throw new GitError('switch-refused', decision.reason);
      /* ... usa services.use(RuntimeLeaseV1) e troca o branch ... */
      return { from, to };
    },
  }),
});

// git, host/index.ts
services.provide(gitCommands);

// git, contracts/refs.ts (recorte)
import { ref } from 'bundle/contracts';
import type { gitCommands } from '../host/git-commands.js';

export const GitCommandsV1 = ref<typeof gitCommands>('git.commands/v1');

// qualquer consumidor, inclusive uma parte client
await services.use(GitCommandsV1).switchBranch({ projectId, to }, call);
```

- `defineService` recebe o ID versionado, os métodos e, opcionalmente, `{ cardinality: 'many' }`; sem opções, a cardinalidade é `'one'` (veja [cardinalidade](#cardinalidade)).
- `defineMethod` recebe `input`, `output` e `execute(input, call, services)`. `call` é a chamada, com `call.caller` preenchido pelo dispatcher e o escopo em `call.scope`; `services` são os serviços do bundle que forneceu o serviço, ligados em `services.provide(definição)`.
- `execute` valida a entrada e a saída com o zod da definição, como o `defineTool`. Um erro rejeita a Promise com `code` e `message`, que o dispatcher repassa pela ponte.
- O dono obtém seus handles com o próprio `services`: `services.use(HooksV1).define(GitHooksV1)` devolve sempre o mesmo handle para o mesmo dono, então pode ser chamado dentro do `execute`.
- O consumidor usa a referência: `services.use(GitCommandsV1)` devolve um stub tipado por `typeof gitCommands`. Cada método do stub aceita como último argumento opcional um `call` pai ou `{ signal, deadline }`; veja a [propagação de `call`](#propagação-de-call).
- Qualquer serviço fornecido no `desktopMain` ou no `host` é alcançável pela ponte por uma parte `client` que o declara em `requires` ou o consome com `whenAvailable`, como `windows/v1`, `menus/v1` e o `git.commands/v1` acima. Entre processos, a validação usa o JSON Schema gerado da definição e publicado no catálogo.
- Um método cujo schema usa `z.custom` (funções, classes, elementos), como em `chat.views/v1`, só funciona no mesmo processo; o dispatcher recusa a chamada que atravessaria processos.
- Outro bundle que fornece o mesmo contrato escreve a própria definição com o mesmo ID, ou com a referência no lugar do ID (`defineService(GitCommandsV1, { ... })`), o que faz o compilador conferir os métodos contra o tipo. A checagem de semver, suspensa até a etapa 11, vai comparar os JSON Schemas gerados com a versão publicada.

Os serviços básicos seguem a mesma regra. `bundle/contracts` exporta as referências (`HooksV1`, `StorageV1`, `UiV1` e as demais), com os tipos dos contratos; o core escreve as definições com `execute` e as fornece, e outro bundle pode fornecer as suas no lugar:

```ts
// bundle/contracts (pseudocódigo da API proposta)
export const StorageBackendV1 = ref<StorageBackend>('storage.backend/v1');
export const ModelsProviderV1 = ref<ModelsProvider>('models.provider/v1');

// openai, host/models.ts
export const openaiModels = defineService(
  ModelsProviderV1,
  {
    /* métodos com execute */
  },
  { cardinality: 'many' },
);
```

O diretório de serviços, os stubs tipados e a ponte entre processos estão em [serviços entre bundles e canais de mensagens](./services-and-channels.md).

## Eventos: `defineEvent`

```ts
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

const events = services.use(EventsV1);
events.register(branchSwitchedEvent); // na ativação
await events.append(branchSwitchedEvent, payload, call); // numa execução
```

- `type` é o ID com major; a versão completa vem de `provides` no manifesto (`git.branch-switched/v1@1.0.0`).
- `payload` é o schema zod do evento durável.
- `events.register` registra a definição na ativação; `events.append(definição, payload, call)` grava um evento validado numa execução, no escopo de `call`, e o publica como é.

O papel dos eventos duráveis está em [eventos e nodes](./events-and-nodes.md).

## Comandos: `defineCommand`

Um comando tem uma forma só: `id`, `input` e `execute`, como uma tool. `commands/v1` existe no `desktopMain` e no `client`, não no `host`, então comandos são definidos e registrados na parte `client` ou `desktopMain` do bundle.

```ts
// git, client/commands.ts (pseudocódigo da API proposta)
import { defineCommand } from 'bundle/contracts';
import { z } from 'zod';
import { GitCommandsV1 } from '../contracts/index.js';
import { resolveSwitchBranchInput } from './switch-branch-input.js';

export const switchBranchCommand = defineCommand({
  id: 'git.switch-branch/v1',
  input: z
    .object({ projectId: z.string().optional(), to: z.string().optional() })
    .strict(),
  execute: async (input, call, services) => {
    // menu e atalho despacham sem entrada: o Project vem da rota ativa e a branch, de um seletor
    const { projectId, to } = await resolveSwitchBranchInput(
      input,
      call,
      services,
    );
    await services.use(GitCommandsV1).switchBranch({ projectId, to }, call);
  },
});

// git, client/index.ts, dentro de activate({ services })
import { CommandsV1 } from 'bundle/contracts';
import { switchBranchCommand } from './commands.js';

services.use(CommandsV1).register(switchBranchCommand);

// git, contracts/refs.ts (recorte), para despacho tipado por outros bundles
import { ref } from 'bundle/contracts';
import type { switchBranchCommand } from '../client/commands.js';

export const SwitchBranchCommandV1 = ref<typeof switchBranchCommand>(
  'git.switch-branch/v1',
);

// outro bundle
await services.use(CommandsV1).execute(SwitchBranchCommandV1, {
  projectId,
  to: 'main',
});
```

- `id` é o ID com major; a versão completa vem de `provides` no manifesto (`git.switch-branch/v1@1.0.0`, `git.open-comparison/v1@1.0.0`).
- `execute(input, call, services)` recebe os serviços do bundle que registrou o comando, ligados em `register`.
- Quem despacha usa a referência exportada em `contracts/` e recebe o tipo da entrada. Menus e atalhos despacham pelo ID, como em [menus nativos e atalhos](./menus-and-keybindings.md).
- Uma ação disparada por outro bundle também é um comando, não um serviço: `git.open-comparison/v1` é definido na parte `client` do `git` e despachado pela conversa (`<chat-view>`) ou pelo layout. O core faz o mesmo com `core.open-settings/v1`, registrado no `desktopMain` e exportado como referência em `core/contracts`; veja [janelas](./windows.md).

## Configuração: `defineSettings`

```ts
export const gitSettings = defineSettings({
  id: 'git.settings/v1',
  schema: z.object({ defaultRemote: z.string().default('origin') }).strict(),
});

const settings = services.use(SettingsV1);
settings.register(gitSettings);
const { defaultRemote } = await settings.get(gitSettings); // tipado por este schema
settings.subscribe(gitSettings, (value) => {
  /* ... */
});
```

`settings.get` é assíncrono e devolve uma `Promise` com o valor tipado pela definição, porque a chamada pode atravessar processos até o provedor de `settings/v1`. `settings/v1` substitui os antigos `ctx.config` e `ctx.settings`; cada definição é identificada pelo ID qualificado, e a versão completa vem de `provides`. Uma major nova de settings registra sua migração junto da definição.

## Tipos de storage: `defineStorageType`

```ts
export const threadType = defineStorageType({
  type: 'runtime.thread/v1',
  schema: z
    .object({
      projectId: z.string(),
      parentThreadId: z.string().nullable(),
      createdAt: z.string(),
    })
    .strict(),
  indexes: [
    { name: 'byProject', fields: ['projectId', 'createdAt'] },
    { name: 'byParent', fields: ['parentThreadId', 'createdAt'] },
  ],
});

services.use(StorageV1).defineType(threadType);
```

`storage/v1` é a fachada do core sobre `storage.backend/v1`, e cada tipo é identificado pelo ID qualificado; o provedor de `storage.backend/v1` é `postgres` por padrão, e a composição pode escolher outro em `providers`. Os campos de índice são caminhos de propriedade do schema; o backend os converte em JSON Pointer. O contrato de storage independente de backend está em [armazenamento genérico e histórico](./storage.md).

## Tabela da família define\*

| Função                        | Define                                                              | Registro ou uso                                                                    | Disparo                                                                                            |
| ----------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `defineHook`                  | Um hook com `kind` e `input`                                        | Agrupado por `defineHooks`                                                         | `handle.<nome>.execute(input, call)`                                                               |
| `defineHooks`                 | Um contrato de hooks versionado                                     | `hooks/v1`: `define`, `use`, `whenAvailable`                                       | Pelo dono                                                                                          |
| `defineService`               | Um serviço versionado, com `cardinality` opcional                   | `services.provide(definição)`; consumidores usam `ref` com `use` e `whenAvailable` | Chamada de método pelo dispatcher, com `call`                                                      |
| `defineMethod`                | Um método com `input`, `output` e `execute`                         | Dentro de `defineService`                                                          | `execute(input, call, services)`                                                                   |
| `defineEvent`                 | Um evento durável com `type` e `payload`                            | `events/v1`: `register`                                                            | `events.append(evento, payload, call)`                                                             |
| `defineCommand`               | Um comando com `id`, `input` e `execute`                            | `commands/v1` (`client` ou `desktopMain`): `register`                              | `commands.execute(ref ou ID, input)` por menu, atalho ou UI; roda `execute(input, call, services)` |
| `defineSettings`              | A configuração de um bundle                                         | `settings/v1`: `register`                                                          | `await settings.get(definição)` tipado e `subscribe`                                               |
| `defineStorageType`           | Um tipo de storage com índices                                      | `storage/v1`: `defineType`                                                         | Primitivas de storage                                                                              |
| `ref` (de `bundle/contracts`) | A referência tipada a um serviço ou comando, só com o ID            | Exportada em `contracts/`; passada a `use`, `whenAvailable` e `commands.execute`   | —                                                                                                  |
| `defineTool` (pacote `tool`)  | Uma tool com `input`, `output` e `execute(payload, call, services)` | `tools/v1`: `register`                                                             | Quando o modelo pede a tool, `execute(payload, call, services)`                                    |

## O que não muda

- O formato do manifesto não muda: `provides` e `requires` continuam listando IDs de contrato; veja [manifesto v1](./manifest.md).
- Os IDs com major (`/vN`) e a política de versionamento não mudam. A verificação de build de semver, suspensa até a etapa 11, vai comparar os JSON Schemas gerados do zod; veja [versionamento semântico](./versioning.md).

## Relações

- [Arquitetura de bundles](../bundles.md): o documento principal, que mostra onde os contratos entram no conjunto.
- [Manifesto v1](./manifest.md): lista os IDs de contrato em `provides` e `requires` e perde a convenção `schemas/*.json`.
- [Hooks e ciclo de vida](./hooks.md): aplica `defineHook`, `defineHooks` e `execute` ao modelo de ciclo de vida, por `hooks/v1`, e aos exemplos entre bundles.
- [Serviços entre bundles e canais de mensagens](./services-and-channels.md): usa `defineService` e `defineMethod` no diretório de serviços e na ponte entre processos.
- [Contextos e capacidades](./contexts.md): define o contexto só com `services`, o objeto `call` e os contratos `events/v1`, `settings/v1`, `commands/v1`, `tools/v1`, `storage/v1` e `hooks/v1` que recebem as definições.
- [Eventos e nodes](./events-and-nodes.md): explica os eventos duráveis definidos com `defineEvent`.
- [Menus nativos e atalhos](./menus-and-keybindings.md): despacha os comandos definidos com `defineCommand`.
- [Armazenamento genérico e histórico](./storage.md): consome os tipos e índices declarados com `defineStorageType`.
- [Versionamento semântico](./versioning.md): compara os JSON Schemas gerados do zod para validar as versões dos contratos, mas a checagem está suspensa até a etapa 11.
- [Navegação e rotas](./navigation.md): define `navigation/v1`, contrato básico em `bundle/contracts`, com rotas por path de URL (`register({ path, create, parent? })`), sem ID versionado nem schema de parâmetros.
- [Composição e distribuição](./composition-and-distribution.md): escolhe o provedor de cada contrato substituível em `providers`, por ambiente.
- [Bundle core e quarentena](./core.md): ativa depois da fundação, fornece os serviços básicos por padrão e recebe os bundles cujo registro de contrato falha ou conflita.
- [Observabilidade](./observability.md): tira `bundleId`, `version` e `generation` de `call.caller`.
