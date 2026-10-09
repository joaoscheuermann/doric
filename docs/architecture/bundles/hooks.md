# Hooks e ciclo de vida

**Estado:** proposta. Parte da [arquitetura de bundles](../bundles.md); nada aqui descreve comportamento já implementado, e `GROUNDING.md` continua sendo o contrato da implementação atual.

## Resumo

O ciclo de vida do app é definido por hooks: pontos nomeados em que o dono de uma operação pede a outros bundles que observem, transformem ou decidam algo. O próprio app define os hooks padrão do seu ciclo de vida, e qualquer bundle pode definir hooks próprios para que outros modifiquem o comportamento dele. A regra é uma só: **quem é dono de uma operação define os hooks dela**. Cada hook é declarado em zod com `defineHook`, agrupado sob um ID de contrato versionado com `defineHooks` e disparado pelo dono com `execute`, no mesmo molde do `defineTool`.

O sistema de hooks é um serviço como outro qualquer: o contrato `hooks/v1` (`HooksV1`), de cardinalidade `one`, fornecido pelo core por padrão. A referência `HooksV1` e o tipo do contrato vêm de `bundle/contracts`, como os dos outros contratos básicos; o core fornece a definição com `execute`. Um bundle obtém o sistema com `services.use(HooksV1)`, declara `hooks/v1` em `requires`, e o contexto de `activate` não tem membro `hooks`. Depois que o provedor de `hooks/v1` de um ambiente ativa, a plataforma daquele ambiente define nele os hooks do ciclo de vida do app, por isso outro bundle pode substituir o sistema inteiro de hooks sem que o app mude.

## O modelo

Além dos hooks padrão, o app fornece as funcionalidades de plataforma: splash, recuperação, janelas e menus nativos, `doric://`, catálogo e diagnóstico. A tabela mostra quem define hooks e quem registra handlers.

| Dono                  | Exemplos de hooks                                            | Quem registra handlers                            |
| --------------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| App (plataforma)      | Ciclo de vida do app, das gerações e das janelas             | Qualquer bundle, por `hooks/v1`, inclusive o core |
| Bundles estruturais   | `runtime`: Projects; `direct`: request ao modelo e tools     | Bundles que precisam modificar a execução         |
| Qualquer outro bundle | `git`: antes de trocar de branch; `chat`: montagem de blocos | Qualquer bundle que declare o contrato            |

Hooks são um dos quatro canais de mensagens entre bundles: o runtime pede decisão ou transformação em um ponto nomeado, com ordem, espera e saída validada pelo dono da operação. Eventos duráveis, sinais efêmeros e `CustomEvent` são canais distintos, descritos em [serviços e canais](./services-and-channels.md).

## O contrato `hooks/v1`

`hooks/v1` tem três operações, e todo bundle chega a elas pelo mesmo caminho:

```ts
import { type HostContext, HooksV1 } from 'bundle/contracts';

export const activate = ({ services }: HostContext) => {
  const hooks = services.use(HooksV1); // hooks/v1 em requires
  // hooks.define(Contrato): o dono obtém os hooks para disparar com execute.
  // hooks.use(Contrato).<hook>(handler): registro quando o contrato está em requires.
  // hooks.whenAvailable(Contrato, (h) => h.<hook>(handler)): registro opcional.
};
```

Partes `host` usam `HostContext`, partes `desktopMain` usam `DesktopContext` e partes `client` usam `ClientContext`; os três têm só `services` (`{ readonly services: Services }`), vêm de `bundle/contracts`, e o core recebe esse mesmo contexto. Todo registro feito por meio de `hooks/v1` é rastreado pelo loader com o bundle que o fez e descartado em ordem inversa quando esse bundle é desativado.

### Substituir o sistema de hooks

`hooks/v1` não tem prefixo `doric.`, por isso outro bundle pode fornecê-lo. Como o contrato é de cardinalidade `one`, só um provedor fica ativo em cada ambiente, e a composição o escolhe em `providers`:

```json
{
  "core": "core",
  "providers": { "hooks/v1": "myhooks" }
}
```

Um bundle escolhido em `providers` para um contrato que o core fornece ou consome faz parte da **fundação**. Em cada ambiente, o loader ativa primeiro a fundação, depois o core e, por último, os demais bundles, em ordem de dependência. Por isso um bundle como `myhooks` só pode declarar `requires` de contratos `doric.*`: ele ativa antes do core e não pode depender de nada que o core forneça.

A escolha vale em cada ambiente em que `myhooks` fornece `hooks/v1`; nos outros ambientes, o core continua sendo o provedor. Num ambiente em que a escolha vale, o loader não registra a implementação de `hooks/v1` do core, e o `services.use(HooksV1)` do próprio core devolve `myhooks`. Sem escolha em `providers`, um segundo provedor de `hooks/v1` vai para quarentena com motivo; como a fundação e o core ativam antes, é o bundle substituto que vai para quarentena, e o core continua provedor.

O provedor escolhido passa a receber todos os `define`, `use` e `whenAvailable`, inclusive os da plataforma, e é ele que aplica ordem, prazo padrão, validação e a regra de falha; o comportamento descrito neste documento é o contrato que qualquer provedor precisa cumprir. As definições `AppHooksV1` e `WindowHooksV1` continuam da plataforma (`doric.app.hooks/v1` e `doric.window.hooks/v1`) e não mudam com o provedor.

## Hooks definidos pelo app

A plataforma define os hooks do app do mesmo jeito que um bundle define os seus: `AppHooksV1` (`doric.app.hooks/v1`) reúne o ciclo de vida do app e das gerações, e `WindowHooksV1` (`doric.window.hooks/v1`) reúne `onCloseHook` e `onFlushHook`. Os dois vêm de `bundle/contracts`, junto com as funções `define*`.

| Hook                                  | Tipo    | Ambiente      | Quando dispara                                                                                        |
| ------------------------------------- | ------- | ------------- | ----------------------------------------------------------------------------------------------------- |
| `onActivateHook` / `onDeactivateHook` | observe | Todos         | Ativação e desativação de cada bundle; só observa, e uma falha de handler vai ao diagnóstico          |
| `onHostReadyHook`                     | observe | `host`        | Todos os bundles do host ativaram, antes de aceitar requisições de produto                            |
| `onAppReadyHook`                      | observe | `desktopMain` | Todos os bundles do desktop ativaram; o core monta o esqueleto do menu e abre a janela principal aqui |
| `onAppActivateHook`                   | observe | `desktopMain` | O app volta ao foco sem janelas, como um clique no dock do macOS                                      |
| `onBeforeQuitHook`                    | decide  | `desktopMain` | Pedido de encerramento do app; pode vetar, e um segundo pedido força                                  |
| `onGenerationReadyHook`               | observe | Todos         | Uma geração nova foi baixada e ativada no processo dela                                               |
| `onConnectionChangedHook`             | observe | `desktopMain` | A conexão com o host caiu ou voltou                                                                   |
| `onCloseHook`                         | decide  | `client`      | Pedido de fechamento de uma janela; pode vetar e espera a resposta do usuário                         |
| `onFlushHook`                         | observe | `client`      | Depois do `onCloseHook`; grava o que está pendente dentro do prazo fixo definido pela plataforma      |

### Como o app define os hooks do ciclo de vida

A plataforma é só mais um consumidor de `hooks/v1`. Em cada ambiente, depois que o provedor de `hooks/v1` daquele ambiente ativa (o core, por padrão, ou o bundle escolhido em `providers`), a plataforma chama `define(AppHooksV1)` nesse provedor e passa a disparar `execute` nos pontos do ciclo de vida do app que existem naquele ambiente, conforme a tabela acima: em todos os ambientes, `onActivateHook`, `onDeactivateHook` e `onGenerationReadyHook`; no `desktopMain`, também `onAppReadyHook`, `onAppActivateHook`, `onBeforeQuitHook` e `onConnectionChangedHook`; no `host`, também `onHostReadyHook`; no `client`, o bootstrap de cada janela define `AppHooksV1` no `hooks/v1` do client e dispara ali os hooks marcados como Todos. `WindowHooksV1` é definido pela plataforma no ambiente `client`: o bootstrap de cada janela chama `define(WindowHooksV1)` no `hooks/v1` do client e executa `onCloseHook` e `onFlushHook` quando o main pede o fechamento daquela janela; o main só sinaliza o pedido. A plataforma não conhece a implementação: se outro bundle fornecer `hooks/v1`, o app registra e dispara os hooks nesse provedor. Pela mesma lógica a plataforma lê settings, secrets, tools e storage pelos contratos `settings/v1`, `secrets/v1`, `tools/v1` e `storage/v1`.

O `onActivateHook` dos bundles ativados antes do provedor de `hooks/v1` daquele ambiente, inclusive o do próprio provedor, não é observável, porque o contrato ainda não existe; no caso padrão, isso vale para os bundles da fundação. O prazo de prontidão das janelas é medido pela plataforma, não pelo provedor: se o provedor de `hooks/v1` falha ou não ativa, a superfície entra em [recuperação](./splash-and-recovery.md) do mesmo jeito, e a falha do core leva ao modo de recuperação, como em [bundle core e quarentena](./core.md).

### Registro nos hooks do app

Não há atalhos para os hooks do app: qualquer bundle, não só o core, registra com `services.use(HooksV1).use(AppHooksV1).onAppReadyHook(handler)`, como faria com o hook de qualquer outro dono. O bundle declara `hooks/v1` em `requires`; `AppHooksV1` é `doric.*` e não entra.

```ts
import { AppHooksV1, type DesktopContext, HooksV1 } from 'bundle/contracts';

export const activate = ({ services }: DesktopContext) => {
  const hooks = services.use(HooksV1);
  hooks.use(AppHooksV1).onAppReadyHook(async (_input, call) => {
    await openMainWindow(call);
  });
};
```

No client, `hooks.use(WindowHooksV1).onCloseHook(handler)` e `hooks.use(WindowHooksV1).onFlushHook(handler)` registram handlers para a janela do client que chamou: o provedor associa o registro ao `call.scope.windowKey` preenchido pela plataforma. A falha da ativação de um bundle (o `activate` dele) leva à quarentena, descrita em [bundle core e quarentena](./core.md); o `onActivateHook` só observa a ativação, e uma falha num handler desse hook vai ao diagnóstico, como em qualquer hook `observe`. O fechamento de janelas está em [janelas abertas pelo core](./windows.md).

## Hooks definidos por bundles

| Dono                 | Hook                                          | Tipo                | Regra que continua com o dono                                                              |
| -------------------- | --------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------ |
| `runtime`            | `onProjectReadyHook` / `onProjectClosingHook` | observe             | Coordena lease, retomada e liberação única; handlers repetíveis são idempotentes           |
| `direct`             | `onBeforeModelRequestHook`                    | transform           | Cancelamento e admissão do histórico seguem no executor                                    |
| `direct`             | `onBeforeToolHook` / `onAfterToolHook`        | decide / observe    | O Agent valida o lote completo antes de qualquer handler                                   |
| Executor de workflow | `onBeforeNodeHook` / `onAfterNodeHook`        | transform / observe | Controla checkpoint e transição                                                            |
| `chat`               | `onMountHook` / `onUnmountHook`               | observe             | Replay não executa efeitos de runtime                                                      |
| `chat`               | `onBeforeRenderBlockHook`                     | transform           | A projeção e o tipo do bloco continuam do projetor; handlers só acrescentam ações e marcas |
| `git`                | `onBeforeSwitchBranchHook`                    | decide              | A troca em si, a trava do Project e o evento `git.branch-switched/v1` continuam do Git     |
| `core`               | `onBeforeOpenWindowHook`                      | transform           | O core aplica suas políticas depois dos handlers, e o main valida o resultado              |

## Como um hook funciona

Um hook é um contrato como qualquer serviço. `defineHook({ kind, input })` define um único hook só com o tipo e o schema de entrada em zod (de onde o build gera o JSON Schema canônico); o nome do hook é a chave em `defineHooks`. `defineHooks` agrupa hooks sob um ID de contrato com major, que é o que aparece em `provides` e `requires`; a versão completa vem de `provides`. O dono lista esse ID em `provides`; quem registra handlers o lista em `requires` ou o consulta com `whenAvailable`, e nesse caso não o lista. Os dois lados também declaram `hooks/v1` em `requires`, fornecido pelo core por padrão. A família `define*`, o subpath `bundle/contracts` e a geração de JSON Schema estão em [contratos](./contracts.md).

### Tipos

O `kind` fixa a saída do hook, por isso `defineHook` não recebe `output`.

| Tipo        | Saída de cada handler                                                                           | Execução                                                                                 | Falha de um handler                                  |
| ----------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `observe`   | Nenhuma                                                                                         | Depois da operação; não bloqueia o dono nem altera o resultado                           | Ignorado; os outros handlers seguem                  |
| `transform` | Um valor do mesmo schema da entrada, o que permite encadear handlers                            | Antes da operação, em série; cada handler recebe a saída validada do anterior            | Ignorado; o próximo recebe a entrada que ele recebeu |
| `decide`    | `Decision`, definida pela plataforma como `{ allow: true } \| { allow: false; reason: string }` | Antes da operação, em série; o primeiro handler que recusa encerra a cadeia com o motivo | Ignorado; não conta como recusa e a cadeia segue     |

Não há política de falha por hook. O provedor de `hooks/v1` aplica uma regra única aos três tipos: um handler que falha ou passa do prazo padrão do provedor é ignorado, a cadeia segue como se ele não existisse e a falha vai ao diagnóstico. O prazo padrão vale para todos os handlers, exceto os de `WindowHooksV1`: o `onCloseHook` não tem prazo, porque espera a resposta do usuário, e o `onFlushHook` tem prazo fixo definido pela plataforma.

### Disparo pelo dono

O dono obtém os hooks com `services.use(HooksV1).define(Contrato)` e dispara cada um com `execute`, como no `defineTool`. Como todo stub, `execute` aceita como último argumento opcional o `call` pai (o `call` da operação em curso) ou `{ signal, deadline }`:

```ts
const gitHooks = services.use(HooksV1).define(GitHooksV1);
const decision = await gitHooks.onBeforeSwitchBranchHook.execute(input, call);
```

`execute` valida a entrada com o zod, roda os handlers na ordem, valida a saída de cada handler, ignora o handler que falha ou passa do prazo padrão e devolve `Promise<void>` (`observe`), `Promise<Input>` (`transform`) ou `Promise<Decision>` (`decide`).

### Registro pelo consumidor

O consumidor registra handlers com `hooks.use(Contrato).<hook>(handler)` quando o contrato está em `requires`, ou com `hooks.whenAvailable(Contrato, (h) => h.<hook>(handler))` quando a dependência é opcional, sempre com `const hooks = services.use(HooksV1)`. O handler recebe `(input, call)`, com `call.caller` (`{ bundleId: string; version: string; generation: number }` do bundle que chamou `execute`, preenchido pelo dispatcher da plataforma), `call.scope` (`projectId`, `threadId`, `promptId`, `windowKey`, quando houver), `call.signal` e `call.trace`. Quando o dono repassa o `call` pai, o dispatcher herda dele `scope`, `signal` e `trace`, mas `call.caller` nunca é herdado: é sempre o bundle que faz a chamada. No `execute(input, call, services)` de `switchBranch` do Git, `call.caller` é quem chamou o Git; quando o Git executa `onBeforeSwitchBranchHook` ou chama `events/v1` repassando esse `call`, o `caller` desse salto é `git`. Numa chamada que sai de uma janela client, o dispatcher preenche `scope.windowKey`. Log vem de `log/v1`, não do `call`. Os contratos de hook da plataforma (`AppHooksV1` e `WindowHooksV1`) são exceção: usam `hooks.use` sem entrar em `requires`, porque a plataforma os garante em todos os ambientes em que eles existem, e contratos `doric.*` não entram em `requires`. O registro devolve um descarte, que o bundle pode liberar antes; o loader rastreia o registro e o libera automaticamente quando o bundle que registrou é desativado.

### Regras

- A ordem dos handlers segue a ordem de ativação dos bundles: a fundação, depois o core e depois os demais, em ordem de dependência; a composição pode fixar outra ordem.
- O provedor de `hooks/v1` aplica o mesmo prazo padrão a todos os handlers, exceto os de `WindowHooksV1`: o `onCloseHook` não tem prazo, porque espera a resposta do usuário, e o `onFlushHook` tem prazo fixo definido pela plataforma; com processos por geração, a chamada atravessa o mesmo envelope RPC dos serviços (ver [isolamento por processo](./process-isolation.md)).
- Nenhum hook executa de novo porque um evento antigo foi reproduzido, e ações iniciadas pela UI são comandos, não hooks.
- O nome do registro segue `on<Ponto>Hook`. Um ponto só entra na API quando tiver um consumidor real.

### Onde ficam os contratos de hook

O dono publica seus contratos de hook no entrypoint `contracts/` do bundle e os importa no próprio código por caminho relativo (`../contracts/index.js`), como em [manifesto v1](./manifest.md); o consumidor de outro bundle importa só esse entrypoint, por exemplo `direct/contracts`; os detalhes estão em [contratos](./contracts.md). `HooksV1`, `SettingsV1` e as demais referências dos contratos básicos, com seus tipos, vêm de `bundle/contracts`, junto com `AppHooksV1`, `WindowHooksV1` e os tipos de contexto; `core/contracts` exporta só o que é do core, como `CoreHooksV1`. Nenhum código importa o entrypoint `bundle` (loader Node).

## Exemplo: o Git define um hook

O Git define um hook para que outros bundles possam impedir uma troca de branch.

```ts
// git, contracts/hooks.ts: hooks não têm lógica, então a definição fica em contracts/.
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

```ts
// git, host/git-commands.ts: o dono executa o hook dentro do execute do método.
import { defineMethod, defineService, HooksV1 } from 'bundle/contracts';
import { z } from 'zod';
import { GitHooksV1 } from '../contracts/index.js';

export const gitCommands = defineService('git.commands/v1', {
  switchBranch: defineMethod({
    input: z.object({ projectId: z.string(), to: z.string() }).strict(),
    output: z.object({ from: z.string(), to: z.string() }).strict(),
    execute: async ({ projectId, to }, call, services) => {
      // call.caller é quem chamou o Git; no execute do hook, o caller do salto é git.
      const gitHooks = services.use(HooksV1).define(GitHooksV1);
      const from = await currentBranch(projectId);
      const decision = await gitHooks.onBeforeSwitchBranchHook.execute(
        { projectId, from, to },
        call,
      );
      if (!decision.allow)
        throw new GitError('switch-refused', decision.reason);
      await switchBranch(projectId, to);
      return { from, to };
    },
  }),
});
```

```ts
// git, host/index.ts: fornece a definição.
import { type HostContext } from 'bundle/contracts';
import { gitCommands } from './git-commands.js';

export const activate = ({ services }: HostContext) => {
  services.provide(gitCommands);
};
```

`services.use(HooksV1).define(GitHooksV1)` devolve sempre o mesmo handle para o mesmo dono, por isso pode ser chamado dentro do `execute`. O `services` que o `execute` recebe é o do Git, ligado em `services.provide(gitCommands)`.

```ts
// Outro bundle, que declara "hooks/v1@^1.0.0" e "git.hooks/v1@^1.0.0" em requires.
import { type HostContext, HooksV1 } from 'bundle/contracts';
import { GitHooksV1 } from 'git/contracts';

export const activate = ({ services }: HostContext) => {
  services
    .use(HooksV1)
    .use(GitHooksV1)
    .onBeforeSwitchBranchHook(async ({ to }) =>
      to.startsWith('release/')
        ? { allow: false, reason: 'Branches de release são protegidos.' }
        : { allow: true },
    );
};
```

O registro devolve um descarte, liberado automaticamente quando o bundle que registrou é desativado. `gitCommands` é o serviço definido com `defineService`, e `git/contracts` exporta para os consumidores a referência `GitCommandsV1 = ref<typeof gitCommands>('git.commands/v1')`, como em [contratos](./contracts.md).

## Exemplos de hooks entre bundles

Os exemplos cobrem os três tipos de hook, os três ambientes e os dois jeitos de depender de um hook: obrigatório (`requires`) e opcional (`whenAvailable`).

### 1. Recusar uma operação com um hook de bundle estrutural (`decide`, host)

Um bundle `allowlist` impede a tool `web` de acessar domínios fora de uma lista configurada. Ele usa o hook que o `direct` define antes de cada tool.

```json
{
  "manifestVersion": 1,
  "id": "allowlist",
  "version": "1.0.0",
  "engines": { "doric": "^1.0.0" },
  "provides": ["allowlist.settings/v1@1.0.0"],
  "requires": [
    "hooks/v1@^1.0.0",
    "settings/v1@^1.0.0",
    "direct.hooks/v1@^1.0.0"
  ]
}
```

```ts
import {
  defineSettings,
  type HostContext,
  HooksV1,
  SettingsV1,
} from 'bundle/contracts';
import { DirectHooksV1 } from 'direct/contracts';
import { z } from 'zod';

export const allowlistSettings = defineSettings({
  id: 'allowlist.settings/v1',
  schema: z.object({ domains: z.array(z.string()).default([]) }).strict(),
});

export const activate = ({ services }: HostContext) => {
  const settings = services.use(SettingsV1);
  settings.register(allowlistSettings);

  services
    .use(HooksV1)
    .use(DirectHooksV1)
    .onBeforeToolHook(async ({ tool, input }) => {
      if (tool !== 'web') return { allow: true };

      const { domains } = await settings.get(allowlistSettings); // tipado pela definição
      const hostname = new URL(input.url).hostname;
      return domains.includes(hostname)
        ? { allow: true }
        : { allow: false, reason: `O domínio ${hostname} não está liberado.` };
    });
};
```

Quando o handler recusa, o `direct` não executa a tool e devolve ao modelo o motivo como resultado de erro. O Agent continua validando o lote completo de tool calls antes de qualquer handler.

### 2. Transformar o contexto do modelo (`transform`, host)

Um bundle `rules` acrescenta ao prompt de sistema as regras do arquivo `AGENTS.md` do Project. O manifesto lista os contratos que o código usa:

```json
{
  "manifestVersion": 1,
  "id": "rules",
  "version": "1.0.0",
  "engines": { "doric": "^1.0.0" },
  "requires": ["hooks/v1@^1.0.0", "direct.hooks/v1@^1.0.0", "files/v1@^1.0.0"]
}
```

```ts
import { type HostContext, HooksV1 } from 'bundle/contracts';
import { DirectHooksV1 } from 'direct/contracts';
import { FilesV1 } from 'files/contracts';

export const activate = ({ services }: HostContext) => {
  services
    .use(HooksV1)
    .use(DirectHooksV1)
    .onBeforeModelRequestHook(async (request, call) => {
      const files = services.use(FilesV1, call.scope);
      const rules = await files.readIfExists('AGENTS.md', call);
      if (rules === undefined) return request;

      return {
        ...request,
        system: `${request.system}\n\n## Regras do Project\n\n${rules}`,
      };
    });
};
```

Cada handler de `transform` recebe a saída validada do anterior, e o `direct` valida o resultado final contra o schema do request antes de chamar o modelo; como o `kind` é `transform`, esse schema é o mesmo da entrada do hook. `call.scope` traz o Project e a Thread da execução, `services.use(FilesV1, call.scope)` devolve o serviço `files/v1` nesse escopo, e `call.signal` é cancelado junto com o prompt.

### 3. Consumir um hook e definir outro no mesmo bundle (`observe` e `decide`, host)

O Git observa o hook de Project pronto do `runtime` para aquecer o status do repositório, e define seu próprio `onBeforeSwitchBranchHook`, mostrado acima.

```ts
import { type HostContext, HooksV1 } from 'bundle/contracts';
import { RuntimeHooksV1 } from 'runtime/contracts';
import { gitCommands } from './git-commands.js';

export const activate = ({ services }: HostContext) => {
  const hooks = services.use(HooksV1);

  hooks.use(RuntimeHooksV1).onProjectReadyHook(async ({ projectId }, call) => {
    // observe: uma falha aqui vai ao diagnóstico e não impede o Project de abrir.
    await statusCache.warm(projectId, { signal: call.signal });
  });

  // o execute de switchBranch define GitHooksV1 e dispara onBeforeSwitchBranchHook.
  services.provide(gitCommands);
};
```

O manifesto do Git declara as duas coisas: o hook que ele define em `provides` e o que ele consome em `requires`. Como em [manifesto v1](./manifest.md), ele também lista os demais contratos que o código do Git usa com `use`: `hooks/v1`, `events/v1` (o evento `git.branch-switched/v1`, que o Git fornece), `settings/v1`, `tools/v1` e `runtime.workspace/v1` (usado pela tool do Git em [contextos](./contexts.md)) no host; `ui/v1`, `navigation/v1` (rotas `/git/diff/:threadId/:repository` e `/settings/git`), `regions/v1` (o item em `layout.panel`), `windows/v1` e `menus/v1` no client; e `runtime.lease/v1`, que o `execute` de `switchBranch` usa. `commands/v1` e `git.commands/v1` entram pela parte client, como em [chat](./chat.md): `commands/v1` existe no `desktopMain` e no client, não no host, então o comando `git.open-comparison/v1` e o `switchBranchCommand` são registrados no client, que chama `git.commands/v1` do host pela ponte. `git.commands/v1` entra em `requires` embora o próprio Git o forneça no host, porque `switchBranchCommand` usa o stub com `use` no client; o manifesto completo está em [chat](./chat.md). `chat.hooks/v1`, consumido pela parte client com `whenAvailable` no exemplo 4, não entra em `requires`.

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
    "git.commands/v1@^1.0.0",
    "ui/v1@^1.0.0",
    "navigation/v1@^1.0.0",
    "regions/v1@^1.0.0",
    "windows/v1@^1.0.0",
    "menus/v1@^1.0.0",
    "runtime.lease/v1@^1.0.0",
    "runtime.workspace/v1@^1.0.0",
    "runtime.hooks/v1@^1.0.0"
  ]
}
```

### 4. Definir um hook na UI e consumi-lo como dependência opcional (`transform`, client)

O `chat` define `onBeforeRenderBlockHook` para que outros bundles acrescentem ações a um bloco antes de ele ser renderizado. O Git acrescenta “Abrir comparação” aos blocos da tool `git`, mas só se o `chat` existir na composição.

```ts
// chat, contracts/hooks.ts: o dono define o hook.
import { defineHook, defineHooks } from 'bundle/contracts';
import { renderBlockSchema } from './blocks'; // schema zod do bloco renderizado

export const onBeforeRenderBlockHook = defineHook({
  kind: 'transform',
  input: renderBlockSchema,
});

export const ChatHooksV1 = defineHooks('chat.hooks/v1', {
  onBeforeRenderBlockHook,
});
```

```ts
// chat, parte client: o dono executa o hook; hooks/v1 está em requires.
import { type ClientContext, HooksV1 } from 'bundle/contracts';
import { ChatHooksV1 } from '../contracts/index.js';

export const activate = ({ services }: ClientContext) => {
  const chatHooks = services.use(HooksV1).define(ChatHooksV1);
  renderer.beforeRender = (block, call) =>
    chatHooks.onBeforeRenderBlockHook.execute(block, call);
};
```

```ts
// git, parte client: consumo opcional, sem requires de chat.hooks/v1.
import { type ClientContext, HooksV1 } from 'bundle/contracts';
import { ChatHooksV1 } from 'chat/contracts';

export const activate = ({ services }: ClientContext) => {
  services.use(HooksV1).whenAvailable(ChatHooksV1, (h) =>
    h.onBeforeRenderBlockHook((block) =>
      block.tool === 'git'
        ? {
            ...block,
            actions: [
              ...block.actions,
              { id: 'git.open-comparison/v1', label: 'Abrir comparação' },
            ],
          }
        : block,
    ),
  );
};
```

Um handler lento ou com erro é ignorado naquele bloco e aparece no diagnóstico, e o `chat` renderiza o bloco sem a contribuição. A ação `git.open-comparison/v1` é um comando definido com `defineCommand`, despachado pela conversa quando o usuário escolhe a ação; não é hook nem serviço. Ver [contratos](./contracts.md).

### 5. O core define um hook para ajustar janelas antes de abrir (`transform`, desktopMain)

O core define `onBeforeOpenWindowHook`, em `core.hooks/v1`, que deixa outros bundles ajustarem uma janela antes de ela abrir. Um bundle `geometry` usa esse hook para aplicar o tamanho preferido do usuário. As políticas do core rodam depois dos handlers.

```ts
// core, contracts/hooks.ts
import { defineHook, defineHooks } from 'bundle/contracts';
import { openWindowRequestSchema } from './windows'; // schema zod do pedido de janela

export const onBeforeOpenWindowHook = defineHook({
  kind: 'transform',
  input: openWindowRequestSchema,
});

export const CoreHooksV1 = defineHooks('core.hooks/v1', {
  onBeforeOpenWindowHook,
});
```

```ts
// core, desktopMain/windows.ts: a definição de windows/v1 com execute.
import {
  defineMethod,
  defineService,
  DoricWindowsV1, // doric.windows/v1, nativo
  HooksV1,
  WindowsV1,
} from 'bundle/contracts';
import { CoreHooksV1 } from '../contracts/index.js';
import {
  openWindowRequestSchema,
  openWindowResultSchema,
} from '../contracts/windows.js';

export const coreWindows = defineService(WindowsV1, {
  open: defineMethod({
    input: openWindowRequestSchema,
    output: openWindowResultSchema,
    execute: async (request, call, services) => {
      const coreHooks = services.use(HooksV1).define(CoreHooksV1);
      const adjusted = await coreHooks.onBeforeOpenWindowHook.execute(
        request,
        call,
      );
      return services.use(DoricWindowsV1).open(
        {
          ...applyCorePolicy(adjusted),
          key: `${call.caller.bundleId}:${request.key}`,
        },
        call,
      );
    },
  }),
});

// core, parte desktopMain: recebe o mesmo DesktopContext que qualquer bundle.
import { type DesktopContext } from 'bundle/contracts';
import { coreWindows } from './windows.js';

export const activate = ({ services }: DesktopContext) => {
  services.provide(coreWindows);
};

// geometry, parte desktopMain; requires: hooks/v1 e core.hooks/v1.
import { type DesktopContext, HooksV1 } from 'bundle/contracts';
import { CoreHooksV1 } from 'core/contracts';

export const activate = ({ services }: DesktopContext) => {
  services
    .use(HooksV1)
    .use(CoreHooksV1)
    .onBeforeOpenWindowHook((request) => {
      const size = preferredSizes.get(request.key);
      return size === undefined
        ? request
        : { ...request, appearance: { ...request.appearance, size } };
    });
};
```

Um handler que falha ou passa do prazo padrão é ignorado, e a janela abre com o pedido como estava antes dele. A chave da janela usa `call.caller.bundleId`, que a plataforma preenche com o bundle que chamou `windows/v1`, por isso chaves de bundles diferentes não colidem. O core usa `doric.windows/v1`; os outros bundles usam `windows/v1`. O contrato nativo `doric.windows/v1`, as chaves de janela e o serviço `windows/v1` estão em [janelas abertas pelo core](./windows.md).

## Relações

- [Contratos e a família define\*](./contracts.md): especifica `defineHook`, `defineHooks`, o entrypoint `contracts/` e a geração do JSON Schema que os hooks usam.
- [Serviços entre bundles e canais de mensagens](./services-and-channels.md): hooks são um dos quatro canais e atravessam o mesmo envelope dos serviços; `hooks/v1` é um serviço substituível como os outros.
- [Contextos e capacidades](./contexts.md): define o contexto só com serviços, `call` e os contratos que substituem os antigos membros do contexto, entre eles `hooks/v1`.
- [Manifesto v1](./manifest.md): os IDs de contrato de hook aparecem em `provides` e `requires`.
- [Versionamento semântico](./versioning.md): define como um contrato de hook evolui entre minor e major.
- [Bundle core e quarentena](./core.md): o core fornece `hooks/v1` por padrão e ativa depois da fundação; a falha da ativação de um bundle leva à quarentena, e o `onActivateHook` só observa essa ativação.
- [Composição e distribuição](./composition-and-distribution.md): `providers` escolhe, por ambiente, o provedor de `hooks/v1` quando mais de um bundle o fornece, e o bundle escolhido entra na fundação.
- [Splash e recuperação](./splash-and-recovery.md): a superfície entra em recuperação quando o provedor de `hooks/v1` falha.
- [Janelas abertas pelo core](./windows.md): usa `onBeforeOpenWindowHook`, `onCloseHook` e `onFlushHook`.
- [Isolamento por processo](./process-isolation.md): descreve o envelope RPC que leva handlers entre processos por geração.
- [O bundle chat](./chat.md): dono de `onMountHook`, `onUnmountHook` e `onBeforeRenderBlockHook`.
- [Eventos e nodes](./events-and-nodes.md): explica por que replay de eventos não reexecuta hooks.
- [Observabilidade e diagnóstico](./observability.md): recebe as falhas de handlers registradas pelos hooks.
