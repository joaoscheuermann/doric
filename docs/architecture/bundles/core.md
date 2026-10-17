# Bundle core e quarentena

**Estado:** proposta. Parte da [arquitetura de bundles](../bundles.md); nada aqui descreve comportamento já implementado, e `GROUNDING.md` continua sendo o contrato da implementação atual.

## Resumo

O bundle `core` cobre todas as funcionalidades básicas: fornece por padrão os serviços básicos (`hooks/v1`, `log/v1`, `settings/v1`, `secrets/v1`, `tools/v1`, `skills/v1`, `storage/v1`, `events/v1`, `models/v1`, `commands/v1`, `ui/v1`, `navigation/v1`, `regions/v1`, `windows/v1`, `menus/v1`) e abre as janelas. Na UI, ele fornece só os mecanismos: criar elementos (`ui/v1`), rotas por path com o `<core-outlet>` (`navigation/v1`) e regiões com o `<core-region>` (`regions/v1`); o que aparece na tela vem de outros bundles, como o [layout](./layout.md). Qual bundle é o core é uma escolha da composição, não um nome fixo no código. Em cada ambiente, o loader ativa primeiro a **fundação** (os provedores escolhidos em `providers` para contratos que o core fornece ou consome, como `postgres` para `storage.backend/v1` e `secrets.backend/v1`), depois o core e por último os demais bundles. O core recebe o mesmo contexto que qualquer bundle (`{ services }`); a diferença é que ele usa os contratos nativos `doric.windows/v1` e `doric.menus/v1`, enquanto os outros bundles usam `windows/v1` e `menus/v1`. Qualquer contrato do core pode ser fornecido por outro bundle escolhido pela composição. Quando um bundle que não é o core falha na validação ou na ativação, só ele e quem depende dele por `requires` entram em quarentena, com motivo no catálogo. Um core mínimo de teste prova que trocar o core troca a interface inteira.

## Como a composição escolhe o core

A composição nomeia exatamente um bundle core (`"core": "core"`); o manifesto do core não tem nenhum campo especial.

- O loader recusa uma composição sem core.
- O core pode declarar em `requires` apenas contratos que a fundação fornece: `storage.backend/v1` e `secrets.backend/v1`, ambos na parte `host`. O loader recusa um core que declare `requires` de qualquer outro contrato. Contratos de plataforma (`doric.*`, como `doric.app.hooks/v1` e `doric.windows/v1`) não entram em `requires` de nenhum bundle: a plataforma os garante em todos os ambientes, e `use` deles é sempre permitido.
- Um bundle que usa com `use` um contrato do core o declara em `requires`, como qualquer outro contrato, inclusive os básicos (`hooks/v1`, `events/v1`, `settings/v1`, `tools/v1`, `commands/v1`, `ui/v1`, `storage/v1` etc.). Contratos opcionais usam `whenAvailable` e não entram em `requires`.

Assim, “qual é o core” é uma escolha da composição, não um nome fixo no código, e outra distribuição pode fornecer um core próprio. O que mais a composição escolhe está em [composição e distribuição pelo host](./composition-and-distribution.md); o formato do manifesto está em [manifesto v1](./manifest.md).

## Ordem de ativação: fundação, core e demais bundles

Em cada ambiente, o loader ativa os bundles em três fases:

1. **Fundação.** Os bundles escolhidos em `providers` para contratos que o core fornece ou consome, por exemplo `myhooks` para `hooks/v1` ou `postgres` para `storage.backend/v1` e `secrets.backend/v1`. Bundles da fundação só podem declarar `requires` de contratos `doric.*`; o loader recusa um bundle da fundação que exija um contrato do core ou de outro bundle.
2. **Core.** Ativa depois da fundação e já encontra os provedores de que precisa. É por isso que o core pode declarar `requires` de `storage.backend/v1` e `secrets.backend/v1`.
3. **Demais bundles**, em ordem de dependência pelos `requires`. Todos dependem do core implicitamente para a ordem de ativação.

Quando a composição escolhe outro provedor para um contrato que o core também fornece, o loader não registra a implementação do core para esse contrato naquele ambiente, e o `services.use` do próprio core devolve o provedor escolhido. A escolha vale em cada ambiente em que o bundle escolhido fornece o contrato; nos outros ambientes o provedor padrão, o core, continua. Com `"providers": { "hooks/v1": "myhooks" }` e um `myhooks` que só tem parte `host`, o `hooks/v1` do host é o `myhooks`, e o do `desktopMain` e do `client` continua sendo o do core.

Sem escolha em `providers`, um segundo provedor de um contrato de cardinalidade única vai para quarentena com motivo. Como a fundação e o core ativam antes, é o bundle substituto que vai para quarentena se a composição não o escolher; o core continua fornecendo o contrato.

## O core recebe o mesmo contexto que qualquer bundle

Não existem `CoreDesktopContext` nem `CoreClientContext`. Partes `host` recebem `HostContext`, partes `desktopMain` recebem `DesktopContext` e partes `client` recebem `ClientContext`, todos importados de `bundle/contracts`; os três têm só `services` (`{ readonly services: Services }`). O core usa `services.provide`, `services.use` e `services.whenAvailable` como qualquer bundle. Tudo que ele registra é rastreado pelo loader e descartado em ordem inversa na desativação; a limpeza própria vem da função devolvida por `activate`.

O que torna um bundle o core é só a escolha da composição. O core usa os contratos nativos `doric.windows/v1` e `doric.menus/v1`; os outros bundles usam `windows/v1` e `menus/v1`. O `caller` (`{ bundleId: string; version: string; generation: number }`) é sempre o bundle que faz a chamada, preenchido pelo dispatcher da plataforma em cada salto, e serve para diagnóstico e log. O modelo de contexto está em [contextos e capacidades](./contexts.md), e `Services` e `call` em [serviços e canais](./services-and-channels.md).

## O que faz parte do core

O core cobre todas as funcionalidades básicas. `bundle/contracts` exporta as referências desses contratos básicos (`HooksV1`, `LogV1`, `SettingsV1`, `SecretsV1`, `SecretsBackendV1`, `ToolsV1`, `SkillsV1`, `StorageV1`, `StorageBackendV1`, `EventsV1`, `ModelsV1`, `ModelsProviderV1`, `CommandsV1`, `UiV1`, `NavigationV1`, `RegionsV1`, `WindowsV1`, `MenusV1`) e os tipos deles, porque qualquer bundle pode fornecê-los; o core fornece as definições com `execute`, escritas com a referência no lugar do ID, como `defineService(WindowsV1, { open: defineMethod({ input, output, execute }) })`, para que o compilador confira os métodos. `core/contracts` exporta apenas o que é do core: `CoreHooksV1` (`core.hooks/v1`) e a referência `OpenSettingsCommandV1` ao comando `core.open-settings/v1`.

Por ambiente:

| Ambiente      | Contratos que o core fornece                                                                                                   | Comportamento                                                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`        | `hooks/v1`, `log/v1`, `settings/v1`, `secrets/v1`, `tools/v1`, `skills/v1`, `storage/v1`, `events/v1`, `models/v1`             | Fachadas: `storage/v1` sobre `storage.backend/v1` e `secrets/v1` sobre `secrets.backend/v1`, ambos fornecidos pela fundação (`postgres`, por padrão); `models/v1` agrega os provedores de `models.provider/v1`; validação com os schemas dos contratos                        |
| `desktopMain` | `hooks/v1`, `log/v1`, `settings/v1` (preferências locais do desktop), `windows/v1`, `menus/v1`, `commands/v1`, `core.hooks/v1` | Abre a janela principal em `/` no `onAppReadyHook`, reabre no `onAppActivateHook`, monta no `onAppReadyHook` o esqueleto do menu (App, Editar, Visualizar, Janela, Ajuda) e os atalhos básicos, abre a janela de settings em `/settings` pelo comando `core.open-settings/v1` |
| `client`      | `hooks/v1`, `log/v1`, `ui/v1`, `navigation/v1`, `regions/v1`, `commands/v1`                                                    | Cria elementos com os serviços do bundle dono, roteia por path com `<core-outlet>`, monta regiões com `<core-region>` e mostra `<core-not-found>` e `<core-unavailable>`; veja [UI no client](#ui-no-client)                                                                  |

Por isso o core sempre tem uma parte `desktopMain`: é ali que roda o código que abre a primeira janela, antes de existir qualquer renderer.

`commands/v1` existe no `desktopMain` e no `client`, não no `host`. Comandos de UI e de menu são definidos com `defineCommand` e registrados na parte `client` ou `desktopMain` de um bundle; uma parte `host` nunca registra comando.

`windows/v1` (abrir e focar janelas pelas políticas do core) e `menus/v1` (itens, atalhos e `setContext`) são fornecidos no `desktopMain`. Como qualquer serviço do `desktopMain` ou do `host`, partes `client` que os declaram em `requires` os alcançam pela ponte, e o dispatcher preenche `scope.windowKey` em toda chamada que sai de uma janela.

A parte `client` do próprio core usa `windows/v1` e `menus/v1` pela ponte sem declará-los em `requires`, por exemplo no `setContext` de [menus nativos e atalhos](./menus-and-keybindings.md), porque são contratos que o próprio core fornece no `desktopMain`. Qualquer outro bundle que os use declara `windows/v1` e `menus/v1` em `requires`.

### Backends da fundação

O armazenamento durável e o de segredos são contratos separados, de cardinalidade `one`, fornecidos pela fundação e não pelo core:

- `storage.backend/v1` é fornecido pelo bundle `postgres` por padrão. O `storage/v1` do core é a fachada sobre ele.
- `secrets.backend/v1` também é fornecido pelo `postgres` por padrão. O backend padrão guarda cada segredo como envelope AES-256-GCM sob `DORIC_CREDENTIAL_KEY`, como o credential store atual do host. O `secrets/v1` do core é a fachada sobre ele e aplica redação antes do log.

Um bundle que queira trocar um desses armazenamentos fornece o backend e é escolhido em `providers`; como entra na fundação, ativa antes do core.

### Fachadas do core

`storage/v1` é a fachada sobre `storage.backend/v1`, e `secrets/v1` sobre `secrets.backend/v1`. Definições de settings e tipos de storage são identificados pelo ID qualificado. `log/v1` marca cada registro com `bundleId`, `version` e `generation` vindos de `call.caller` e com o `environment` do processo em que roda. `settings.get(definição)` é assíncrono e devolve o valor validado pelo schema da definição.

### Cardinalidade dos contratos

Cada contrato tem cardinalidade `one` (padrão; um provedor ativo, escolhido pela composição) ou `many`, declarada na opção `cardinality` de `defineService` só quando é `many` (vários provedores sem conflito, agregados pelo consumidor). Os contratos que o core fornece são `one`. O `models/v1` do core é o exemplo de agregação: `openai`, `openrouter` e `codex` fornecem `models.provider/v1`, de cardinalidade `many`, cada um registrando tipo configurável, campos e catálogo de modelos, e o `models/v1` do core os agrega sem que a composição escolha um.

### Hooks do ciclo de vida

`onAppReadyHook` e `onAppActivateHook` são hooks do app, definidos pela plataforma em `AppHooksV1` (`doric.app.hooks/v1`, importado de `bundle/contracts`). Depois que o provedor de `hooks/v1` de um ambiente ativa (o core, por padrão, ou o escolhido em `providers`), a plataforma daquele ambiente obtém esse provedor, chama `define(AppHooksV1)` e passa a disparar `execute` nos pontos do ciclo de vida. `WindowHooksV1` (`doric.window.hooks/v1`, com `onCloseHook` e `onFlushHook`) é definido pela plataforma no ambiente `client`: o bootstrap de cada janela o define no `hooks/v1` do client e o executa quando o main pede o fechamento da janela. A plataforma é só mais um consumidor do contrato: se outro bundle fornecer `hooks/v1`, o app usa esse. Pela mesma lógica, a plataforma lê settings, secrets, tools e storage pelos contratos, sem conhecer a implementação.

Qualquer bundle, não só o core, registra handlers dos hooks do app. O core registra os seus como qualquer consumidor, sem atalho no contexto:

```ts
// core, parte desktopMain
import {
  AppHooksV1,
  CommandsV1,
  DoricMenusV1,
  DoricWindowsV1,
  HooksV1,
  type DesktopContext,
} from 'bundle/contracts';
import { CoreHooksV1 } from '../contracts/index.js';
import { openSettings } from './commands.js';
import { createHooks } from './hooks.js';
import { defaultMenuSkeleton } from './menu.js';

export function activate({ services }: DesktopContext) {
  // Se a composição escolheu outro provedor de hooks/v1 neste ambiente,
  // o loader não registra esta definição.
  services.provide(createHooks()); // devolve defineService(HooksV1, { ... })
  const hooks = services.use(HooksV1); // o provedor deste ambiente
  const nativeWindows = services.use(DoricWindowsV1);
  const nativeMenus = services.use(DoricMenusV1);

  hooks.define(CoreHooksV1);
  services.use(CommandsV1).register(openSettings);

  hooks.use(AppHooksV1).onAppReadyHook(() => {
    // App, Editar, Visualizar, Janela, Ajuda e os atalhos básicos
    nativeMenus.setSkeleton(defaultMenuSkeleton);
    return nativeWindows.open({ key: 'workspace', path: '/' });
  });
  hooks
    .use(AppHooksV1)
    .onAppActivateHook(() => nativeWindows.focusOrOpen('workspace'));
}

// core, desktopMain/commands.ts
import { defineCommand, DoricWindowsV1 } from 'bundle/contracts';
import { z } from 'zod';

export const openSettings = defineCommand({
  id: 'core.open-settings/v1',
  // Path de settings a abrir, como '/settings/providers'; omitido, '/settings'.
  input: z.object({ path: z.string().optional() }).strict(),
  execute: async ({ path }, call, services) => {
    await services
      .use(DoricWindowsV1)
      .open({ key: 'settings', path: path ?? '/settings' }, call);
  },
});

// core, contracts/index.ts
import { ref } from 'bundle/contracts';
import type { openSettings } from '../desktopMain/commands.js';
export { CoreHooksV1 } from './hooks.js';
export const OpenSettingsCommandV1 = ref<typeof openSettings>(
  'core.open-settings/v1',
);
```

O `execute` de `openSettings` recebe os serviços do core, ligados em `register`, e repassa o `call` a `open`. O core importa as referências dos contratos básicos, os contratos de plataforma, as funções `define*` e o tipo `DesktopContext` de `bundle/contracts`, e os próprios contratos (`CoreHooksV1`) e o comando `openSettings` por caminho relativo. Nenhum código importa o entrypoint `bundle`, que é o loader Node. O código acima usa `hooks/v1` e `commands/v1`, que o próprio core fornece no `desktopMain`, e contratos `doric.*`; por isso a parte `desktopMain` do core não declara `requires`. Com `"providers": { "hooks/v1": "myhooks" }` e um `myhooks` com parte `desktopMain`, o `myhooks` ativa na fundação, o `provide` do core não é registrado, e `services.use(HooksV1)` devolve o `myhooks`.

O core pode chamar `hooks.use(AppHooksV1)` antes de a plataforma chamar `define(AppHooksV1)`. Isso é aceito: `hooks.use` de um contrato de hook ainda não definido guarda os handlers registrados, e eles passam a valer quando o dono chama `define`. Também é aceito registrar depois do `define`, porque a plataforma só dispara `onAppReadyHook` quando todos os bundles do desktop ativaram. Em nenhuma das ordens um handler se perde.

Uma falha do `activate` de um bundle leva à quarentena desse bundle. Uma falha de um handler de `onActivateHook`, que é `observe`, só vai ao diagnóstico e não coloca ninguém em quarentena. Quando o core é o provedor de `hooks/v1`, o `onActivateHook` do próprio core e dos bundles da fundação não é observável: eles ativam antes de o contrato existir. O mesmo vale para um provedor substituto, como `myhooks`. O modelo de hooks está em [hooks e ciclo de vida](./hooks.md), e a definição dos contratos com `defineHooks`, `defineService` e o restante da família `define*` está em [contratos](./contracts.md).

## UI no client

O core não desenha nenhuma tela de produto. No client, a UI do core se resume a três serviços (`ui/v1`, `navigation/v1`, `regions/v1`) e quatro elementos; o resto da UI vem de outros bundles.

| Serviço ou elemento  | O que faz                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ui/v1`              | `define(tag, classe)`, `create(tag, props?)` e `dispose(elemento)`                                                          |
| `navigation/v1`      | Rotas por path: `register`, `navigate`, `back`, `current` e `subscribe`; veja [navegação e rotas](./navigation.md)          |
| `regions/v1`         | `add(região, { id, tag, props?, order? })`: põe um elemento numa região com nome                                            |
| `<core-outlet>`      | Mostra o elemento da rota ativa; dentro do elemento de uma rota pai, mostra a rota filha, como o `<Outlet>` do React Router |
| `<core-region name>` | Cria, na ordem, os elementos adicionados àquela região com `regions.add`                                                    |
| `<core-not-found>`   | O que o outlet mostra para um path sem rota                                                                                 |
| `<core-unavailable>` | O que `ui.create` devolve para uma tag que nenhum bundle ativo definiu                                                      |

O bootstrap de cada janela ativa as partes client, com o core primeiro, e põe um `<core-outlet>` no `body`. A partir daí, tudo que aparece é escolhido pelo path da URL: o outlet de topo mostra a rota que casa com ele. Na janela principal, aberta em `/`, essa rota é a do [layout](./layout.md); na de settings, aberta em `/settings`, é a do bundle `settings`.

### `define`: registrar a tag

`ui.define('chat-view', ChatView)` chama `customElements.define` e anota no catálogo da janela que a tag pertence ao bundle que chamou. A tag precisa começar com o ID do bundle seguido de hífen (`chat-`), o que evita conflito de nomes e diz a `create` quem é o dono. Uma tag já definida na janela não pode ser trocada sem recarregar, porque `customElements.define` não substitui definições.

### `ui.create` passo a passo

`ui.create(tag, props)` é o `document.createElement` da plataforma. A diferença é que ele entrega ao elemento os serviços do bundle dono:

```ts
const view = ui.create('chat-view', { projectId: 'p1', threadId: 't1' });
main.replaceChildren(view);
```

1. **Acha o dono.** Procura a tag no catálogo da janela. `chat-view` foi definida pelo `chat`. Se nenhum bundle ativo definiu a tag, porque o bundle não está na composição ou está em quarentena, devolve um `<core-unavailable>` com o nome da tag, e quem chamou não precisa tratar o caso.
2. **Cria.** Chama `document.createElement('chat-view')`. O elemento ainda não está no DOM.
3. **Entrega os serviços do dono.** Atribui `element.services`, um escopo filho dos serviços do `chat`, e não dos de quem chamou `create`. Assim, quando `<chat-view>` chama `runtime.threads/v1`, o `call.caller` é o `chat`. O que o elemento registra por esse escopo é descartado no `ui.dispose` do elemento ou, no mais tardar, quando o `chat` é desativado.
4. **Atribui as props.** Faz `Object.assign(element, props)`. Props são propriedades JavaScript, não atributos, então aceitam objetos.
5. **Devolve.** Quem chamou decide onde pôr o elemento. Só quando ele é conectado ao DOM o `connectedCallback` roda, já com `services` e props prontos.

Um bundle pode usar `document.createElement` direto para os próprios elementos internos, que não precisam de serviços. `ui.create` é necessário quando o elemento é de outro bundle, ou quando ele vai chamar serviços.

Os elementos do core (`<core-outlet>`, `<core-region>`, `<core-not-found>` e `<core-unavailable>`) são exceção: usam os serviços do core da própria janela, como `navigation/v1` e `regions/v1`, e não precisam receber `element.services`. Por isso podem ser escritos direto no template de um elemento, como o layout faz com `<core-outlet>` e `<core-region>`, ou criados com `document.createElement`, como o bootstrap faz com o `<core-outlet>` do `body`, sem `ui.create`.

`ui.dispose(element)` tira o elemento do DOM, chama `element.dispose()` uma vez, se existir, e descarta o que ele registrou pelo seu escopo de `services`; os registros do bundle dono continuam. O outlet, as regiões e as abas do layout chamam `dispose` quando uma view deixa de existir; mover um elemento no DOM não chama.

### `regions/v1`: lugares com nome

Uma região é um `<core-region name="…">` que um bundle põe no template do seu elemento. O dono do template escolhe os nomes, com o próprio ID como prefixo (`layout.panel`, `settings.sections`). Outros bundles adicionam elementos:

```ts
services.use(RegionsV1).add('layout.panel', { id: 'files', tag: 'files-tree' });
```

`<core-region>` cria cada item com `ui.create(tag, props)`, ordenado por `order` e depois pela ordem de ativação, e chama `ui.dispose` quando o bundle do item é desativado. Uma região que não existe na tela, porque o bundle dono do template não está na composição, simplesmente não mostra nada.

## O que o core decide

Os outros bundles fazem só o que o core expõe:

- registrar rotas por `navigation/v1` e montar elementos nas regiões por `regions/v1` e `ui/v1`;
- adicionar itens de menu, atalhos e contexto de menu por `menus/v1`, inclusive de partes `client`, pela ponte;
- abrir e focar janelas por `windows/v1`, inclusive de partes `client`, pela ponte;
- registrar e executar comandos por `commands/v1`, nas partes `desktopMain` e `client`;
- estender comportamento pelos hooks que o core define em `core.hooks/v1`.

Cada um desses usos exige o contrato em `requires` do bundle que o faz. As APIs nativas de janela e menu da plataforma são os contratos `doric.windows/v1` e `doric.menus/v1`, usados pelo core. Os outros bundles usam `windows/v1` e `menus/v1`, que o core expõe sobre esses contratos nativos com suas políticas. Os detalhes estão em [janelas abertas pelo core](./windows.md), [menus nativos e atalhos](./menus-and-keybindings.md) e [contextos e capacidades](./contexts.md).

## O que não pertence ao core

| Fora do core                                                                                     | Dono                                                  |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Catálogo, quarentena, diagnóstico, splash, recuperação, `doric://app`, IPC, processos de geração | Plataforma                                            |
| Log próprio da plataforma, independente do `log/v1` do core                                      | Plataforma                                            |
| APIs nativas de janela e menu (`doric.windows/v1`, `doric.menus/v1`)                             | Plataforma                                            |
| Diretório de cache por bundle no desktop (`doric.cache/v1`)                                      | Plataforma                                            |
| Referências e tipos dos contratos básicos (`HooksV1`, `StorageV1`, `UiV1` e os demais)           | Plataforma (`bundle/contracts`)                       |
| Backends de storage e de segredos (`storage.backend/v1`, `secrets.backend/v1`)                   | Bundle `postgres`                                     |
| Provedores de modelos (`models.provider/v1`)                                                     | `openai`, `openrouter`, `codex`                       |
| Modelo de domínio e `runtime/v1`                                                                 | Bundle `runtime`                                      |
| Executor (`executor/v1`)                                                                         | Bundle `direct`                                       |
| Rotas, regiões e o conteúdo da tela (workspace, conversa, settings)                              | `layout`, `chat`, `settings`, `files`, `git` e outros |

Catálogo, diagnóstico, splash e recuperação continuam na plataforma (`doric.catalog/v1` e `doric.diagnostics/v1`) porque precisam funcionar sem o core: a recuperação precisa deles justamente quando o core falha. Pelo mesmo motivo, a plataforma tem log próprio, que não depende do `log/v1` do core. A superfície que mostra esse estado é descrita em [splash e recuperação](./splash-and-recovery.md).

## Substituição de contratos do core

Qualquer contrato sem prefixo `doric.` pode ser fornecido por outro bundle, inclusive os do core. Se dois bundles habilitados fornecem o mesmo contrato de cardinalidade `one`, a composição escolhe o provedor em `providers`:

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

A escolha vale em cada ambiente em que o bundle escolhido fornece o contrato. Quando o contrato é um que o core fornece ou consome (como `hooks/v1`, `storage.backend/v1` e `secrets.backend/v1`), o provedor escolhido ativa na fundação, antes do core; o provedor escolhido para os demais contratos (como `runtime/v1`, `executor/v1` e `sandbox/v1`) ativa depois do core, com os outros bundles, em ordem de dependência. Sem escolha, o segundo provedor, que é o substituto, vai para quarentena com motivo. Com a escolha, a plataforma e os outros bundles, inclusive o próprio core, passam a usar o provedor escolhido sem mudar código, porque consomem só o contrato. Os antigos papéis exclusivos (armazenamento durável, segredos, runtime de domínio, executor, provider de sandbox) são exatamente isso: contratos `one` com um provedor escolhido (`storage.backend/v1`, `secrets.backend/v1`, `runtime/v1`, `executor/v1`, `sandbox/v1`). Contratos `many`, como `models.provider/v1`, não precisam de escolha. Contratos `doric.*` são da plataforma e não aceitam outro provedor.

Como o core vira dependência de quase todos os bundles, uma falha do core leva ao modo de recuperação, descrito em [splash e recuperação](./splash-and-recovery.md).

## O bundle `bundles/foundation/core` atual

O bundle `bundles/foundation/core` atual contém tools de arquivos, terminal e web. Ele é renomeado para `files` na primeira etapa, preservando os nomes públicos das tools e skills, e o ID `core` passa a pertencer ao bundle core novo. Na etapa 1, o contexto passa a ter só serviços, `bundle/contracts` passa a exportar as funções `define*`, `ref` e as referências e os tipos dos contratos básicos, e o core novo fornece `hooks/v1`, `log/v1`, `tools/v1` e `skills/v1`. `settings/v1`, `secrets/v1`, `storage/v1` e `events/v1` do core entram na etapa 2, junto com o `postgres` fornecendo `storage.backend/v1` e `secrets.backend/v1` sobre o Prisma atual. A sequência de etapas está em [migração em entregas verificáveis](./migration.md), e o destino das funcionalidades atuais em [divisão das funcionalidades atuais](./feature-split.md).

## Quarentena

Uma falha de validação ou de ativação de um bundle que não é o core coloca **apenas esse bundle** em quarentena, com motivo no catálogo.

- Bundles que exigem um contrato dele em `requires` também entram em quarentena, com o motivo “depende de um bundle em quarentena”.
- Quem só o consulta por `whenAvailable` degrada a funcionalidade dependente.
- Um provedor substituto não escolhido em `providers` para um contrato `one` vai para quarentena com motivo, e o provedor da fundação ou do core continua.
- Se o provedor escolhido de `storage.backend/v1` ou `secrets.backend/v1` estiver em quarentena, a parte `host` do core, que os exige em `requires`, não ativa, e o host entra no modo de recuperação: mostra o diagnóstico, preserva os dados e bloqueia as operações de domínio, sem iniciar histórico vazio.
- Se o provedor escolhido de outro contrato estrutural, como `runtime/v1`, estiver em quarentena, o host continua no modo só core: mostra o diagnóstico, preserva os dados e bloqueia as operações de domínio, sem iniciar histórico vazio.
- Uma falha de um handler `observe`, como os de `onActivateHook`, vai só ao diagnóstico e não causa quarentena.

A escolha de provedores está em [contextos e capacidades](./contexts.md), e `storage.backend/v1` em [armazenamento genérico e histórico](./storage.md).

## Core mínimo de teste

Um **core mínimo de teste**, usado só nos testes, abre uma janela simples sem nenhum bundle da UI padrão. Ele prova que trocar o core troca a interface inteira: se esse teste quebrar, alguém criou uma dependência da plataforma com a UI padrão.

## O que o core não conhece

- **Eventos.** `events/v1` do core não lê IDs de Project, Thread ou prompt. Cada provedor tem um sumidouro registrado pelo dono (ver [eventos e nós](./events-and-nodes.md#sumidouro-registrado-pelo-dono)), e o `runtime` registra o do log de Thread.
- **Segredos.** `secrets/v1.registerKind` aceita kinds de bundles. Os básicos `API_TOKEN` e `USERNAME_PASSWORD` ficam no contrato genérico. O bundle `git` registra `GIT` com usuário e e-mail, sem segredo.
- **Credenciais na partida.** O start hook `credential_activation` fica no core (`bundles/foundation/core/src/host/secrets/activation.ts`), e é o único lugar do host que carrega as credenciais na ativação.
- **Escopo.** O core só repassa o `call.scope`, que é opaco. Ele não monta nem interpreta chaves de bundle.

## Relações

- [Arquitetura de bundles](../bundles.md): documento principal que mostra como o core e a fundação se encaixam no conjunto.
- [Manifesto v1](./manifest.md): o manifesto do core é um manifesto comum, sem campo especial, cujo `requires` só pode citar contratos da fundação, e o loader ordena a ativação com a fundação primeiro, depois o core e por fim os demais bundles.
- [Composição e distribuição pelo host](./composition-and-distribution.md): é a composição que nomeia o core e escolhe provedores em `providers`, por ambiente.
- [Contratos e a família define\*](./contracts.md): os contratos que o core fornece, como `windows/v1`, `menus/v1` e `regions/v1`, têm referência e tipo em `bundle/contracts`, e o core escreve as definições com `defineService` e `defineMethod`, com `execute(input, call, services)` em cada método e `cardinality` nas opções de `defineService` quando é `many`.
- [Hooks e ciclo de vida](./hooks.md): o core fornece `hooks/v1`, a plataforma define `AppHooksV1` em cada ambiente e `WindowHooksV1` no client, e o core abre a janela principal e monta o menu pelos hooks do app.
- [Contextos e capacidades](./contexts.md): o core recebe o mesmo `HostContext`, `DesktopContext` ou `ClientContext` que qualquer bundle, e os provedores escolhidos determinam a fundação e o modo só core.
- [Serviços e canais](./services-and-channels.md): `services.provide`, `use` e `whenAvailable`, e o `call` com `caller` preenchido pelo dispatcher em cada salto.
- [Janelas abertas pelo core](./windows.md): detalha `windows/v1` sobre `doric.windows/v1`, alcançável pelo client.
- [Menus nativos e atalhos](./menus-and-keybindings.md): detalha `menus/v1` sobre `doric.menus/v1`, alcançável pelo client, pelo qual outros bundles adicionam menus e atalhos.
- [UI composta por bundles](./ui-composition.md): os outros bundles montam componentes nas regiões que o core expõe por `regions/v1` e `ui/v1`.
- [Navegação e rotas](./navigation.md): rotas como paths, `parent` e o funcionamento do `<core-outlet>`.
- [O bundle layout](./layout.md): o workspace, que usa a rota `/`, o outlet e as regiões do core.
- [Isolamento por processo](./process-isolation.md): com processos por geração, as chamadas do core a `doric.windows/v1` e `doric.menus/v1` passam pelo dispatcher da plataforma.
- [Splash e recuperação](./splash-and-recovery.md): mostra quarentena e diagnóstico mesmo quando o core falha, com log próprio da plataforma.
- [Armazenamento genérico e histórico](./storage.md): `storage/v1` do core sobre `storage.backend/v1`, e `secrets/v1` sobre `secrets.backend/v1`, ambos fornecidos pelo `postgres` na fundação.
- [Observabilidade e diagnóstico](./observability.md): o motivo da quarentena chega ao diagnóstico da plataforma, e `log/v1` usa `call.caller` para identificar o bundle de origem.
- [Migração em entregas verificáveis](./migration.md): a etapa 1 renomeia o `bundles/foundation/core` atual para `files` e cria o core com `hooks/v1`, `log/v1`, `tools/v1` e `skills/v1`; a etapa 2 acrescenta `settings/v1`, `secrets/v1`, `storage/v1`, `events/v1` e o `postgres`.
