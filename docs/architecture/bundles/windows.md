# Janelas abertas pelo core

**Estado:** proposta. Parte da [arquitetura de bundles](../bundles.md); nada aqui descreve comportamento já implementado, e `GROUNDING.md` continua sendo o contrato da implementação atual.

## Resumo

No desktop, nenhuma janela de produto é fixa no main nem declarada em manifesto: o core abre janelas por código, com `open` do contrato nativo `doric.windows/v1`, normalmente dentro de hooks do ciclo de vida do app. Uma janela é uma chave estável mais um path: ela carrega a mesma shell em `doric://app/<path>`, e o path escolhe a [rota](./navigation.md) que o `<core-outlet>` mostra. O core usa `doric.windows/v1`; os outros bundles abrem janelas pelo serviço público `windows/v1`, que o core fornece por padrão com suas políticas. `windows/v1` vive no `desktopMain`, e partes `client` que o declaram em `requires` o alcançam pela ponte. Cada janela tem dois hooks de fechamento, `onCloseHook` e `onFlushHook`, de `WindowHooksV1`, que a plataforma define no `hooks/v1` do client pelo bootstrap de cada janela e executa quando o main pede o fechamento; qualquer bundle client registra handlers neles. As assinaturas atuais de Project e Thread ainda precisam ser indexadas por janela e recurso antes de suportar várias instâncias independentes.

## Quem abre janelas

O Electron continua criando e focalizando `BrowserWindow` e fornecendo um preload mínimo, mas **nenhuma janela de produto é fixa no main** e não existe tipo de janela declarado em manifesto. Uma janela é aberta por uma chamada de função, normalmente dentro de um hook do app: o app dispara seus [hooks de ciclo de vida](./hooks.md), e o core abre as janelas por código dentro deles. A API nativa da plataforma é o contrato `doric.windows/v1`, usado pelo [core](./core.md); a parte `desktopMain` do core recebe o mesmo `DesktopContext` de qualquer parte `desktopMain`, só com `services`, e a parte `client` recebe o `ClientContext`, descritos em [contextos e capacidades](./contexts.md).

Pseudocódigo da API proposta:

```ts
// core, parte desktopMain
import {
  AppHooksV1,
  CommandsV1,
  DoricWindowsV1,
  HooksV1,
  type DesktopContext,
} from 'bundle/contracts';
import { openSettings } from './commands.js';

export const activate = ({ services }: DesktopContext) => {
  const nativeWindows = services.use(DoricWindowsV1);
  const appHooks = services.use(HooksV1).use(AppHooksV1);

  appHooks.onAppReadyHook(async (input, call) => {
    // O esqueleto do menu também é montado aqui, não direto no activate.
    await buildMenuSkeleton(services, call);
    await nativeWindows.open(
      {
        key: 'workspace',
        path: '/',
      },
      call,
    );
  });
  appHooks.onAppActivateHook(() => nativeWindows.focusOrOpen('workspace'));

  // O item "Settings" do esqueleto de menu abre a janela de settings do core.
  services.use(CommandsV1).register(openSettings);
};

// core, desktopMain/commands.ts
import { defineCommand, DoricWindowsV1 } from 'bundle/contracts';
import { z } from 'zod';

export const openSettings = defineCommand({
  id: 'core.open-settings/v1',
  // Path de settings a abrir, como '/settings/providers'; omitido, '/settings'.
  input: z.object({ path: z.string().optional() }).strict(),
  execute: async ({ path }, call, services) => {
    await services.use(DoricWindowsV1).open(
      {
        key: 'settings',
        path: path ?? '/settings',
      },
      call,
    );
  },
});
```

Não há atalho `ctx.hooks.onAppReadyHook`: o core registra `onAppReadyHook` e `onAppActivateHook` com `services.use(HooksV1).use(AppHooksV1)`, descrito em [hooks](./hooks.md). Depois que o provedor de `hooks/v1` do `desktopMain` ativa (o core, por padrão, ou o bundle escolhido em `providers` da composição), a plataforma desse ambiente chama `define(AppHooksV1)` nele e passa a disparar `execute` nos pontos do ciclo de vida. Qualquer bundle, não só o core, pode registrar handlers dos hooks do app; uma falha do `activate` de um bundle o leva à quarentena, e uma falha de um handler de `onActivateHook`, que é `observe`, só vai ao diagnóstico. `WindowHooksV1` não é definido aqui, e sim no client, pelo bootstrap de cada janela (veja [hooks de fechamento](#hooks-de-fechamento)). O esqueleto do menu é montado pelo core dentro do `onAppReadyHook`, não direto no `activate`.

`HooksV1`, `CommandsV1` e as constantes `AppHooksV1` e `DoricWindowsV1` vêm de `bundle/contracts`: `bundle/contracts` exporta as referências e os tipos dos contratos básicos, porque qualquer bundle pode fornecê-los, e o core fornece as definições com `execute`. `core/contracts` publica só o que é do core, como `CoreHooksV1` e a referência `OpenSettingsCommandV1` ao comando `core.open-settings/v1`; o próprio core importa seus contratos por caminho relativo (`../contracts/index.js`). A referência é criada com `ref`, de [contratos](./contracts.md), e guarda só o ID, para que outros bundles despachem o comando com a entrada tipada sem importar o código do core:

```ts
// core, contracts/index.ts
import { ref } from 'bundle/contracts';
import type { openSettings } from '../desktopMain/commands.js';

export const OpenSettingsCommandV1 = ref<typeof openSettings>(
  'core.open-settings/v1',
);
```

O comando `openSettings` é definido com `defineCommand` no código da parte `desktopMain` do core, com `id`, `input` e `execute`, e registrado com `register(openSettings)` no `commands/v1` do `desktopMain`, como em [core](./core.md) e [contratos](./contracts.md). O `execute(input, call, services)` recebe os serviços do core, ligados em `register`, e usa `doric.windows/v1` por eles. O `import type` de `core/contracts` some no build, então importar a referência não traz o código do core. Outro bundle despacha com `services.use(CommandsV1).execute(OpenSettingsCommandV1, { path: '/settings/providers' })`; menus e atalhos despacham pelo ID. `commands/v1` existe no `desktopMain` e no `client`, não no `host`. O handler de `onAppReadyHook` e o `execute` do comando repassam o `call` recebido como último argumento de `open`, para que o salto até `doric.windows/v1` herde `scope`, `signal` e `trace`; o `call.caller` desse salto é o core, preenchido pelo dispatcher. Menus e despacho de comandos estão em [menus nativos e atalhos](./menus-and-keybindings.md).

O core usa os próprios serviços básicos (`hooks/v1`, `commands/v1`) e os contratos `doric.*` sem declará-los em `requires`: contratos `doric.*` são da plataforma e sempre existem, e o core só pode declarar `requires` de contratos que a fundação fornece, como `storage.backend/v1` e `secrets.backend/v1`. Em cada ambiente o loader ativa primeiro a fundação, depois o core e por último os demais bundles, em ordem de dependência; veja [bundle core e quarentena](./core.md).

Não há regra de produto em `createWindow` ou `createSettingsWindow`, nem lista de janelas iniciais na [composição](./composition-and-distribution.md): quem decide é o core.

## Campos de `open`

| Campo de `open` | Obrigatório | Regra                                                                                                                                                            |
| --------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`           | Sim         | Identidade estável da janela. Abrir uma chave já aberta foca a janela existente e, se o path for outro, navega nela; chaves diferentes criam janelas diferentes. |
| `path`          | Sim         | Path da [rota](./navigation.md) que a janela mostra, como `/` ou `/settings/providers`                                                                           |
| `appearance`    | Não         | Intenção visual, descrita em [aparência nativa da janela](./window-appearance.md); omitida, usa os padrões da plataforma                                         |

Os dados da janela vão no path, como os parâmetros `:threadId` e `:repository` de `/git/diff/:threadId/:repository`.

## Janela primária

Uma descrição de janela pode marcar `primary: true`. O processo principal aceita uma só janela primária por catálogo, e uma falha do cliente dela é falha do core, não "pronto". Pedir `primary` para uma chave já aberta sem a marca é recusado com `registration_conflict`, antes da regra de uma primária. A marca é fixada na criação, e uma chamada sem a marca não rebaixa uma janela primária aberta. O core marca `workspace` como primária. A plataforma não tem `openSettings()`: o comando `core.open-settings/v1` é um comando comum do core.

## Chaves e paths

A chave também identifica a janela para restaurar posição, tamanho, monitor e estado maximizado, e para reabrir as janelas que estavam abertas. Duas janelas do mesmo tipo de conteúdo usam chaves diferentes, como `diff:<threadId>:<repository>`. O main guarda o último path de cada chave e reabre a janela nele; dentro da janela, a navegação muda o path com a History API, como em [navegação e rotas](./navigation.md).

## `windows/v1`: janelas pedidas por outros bundles

O core decide o que os outros bundles podem fazer com janelas. No core padrão, ele fornece `windows/v1` no `desktopMain`, que prefixa a chave com `call.caller.bundleId` e aplica as políticas do core sobre `doric.windows/v1`. `call.caller` (`{ bundleId: string; version: string; generation: number }`) é sempre o bundle que faz aquela chamada, preenchido pelo dispatcher; numa chamada que sai de uma janela client, o dispatcher também preenche `call.scope.windowKey`. Como `windows/v1` não tem prefixo `doric.`, outro bundle pode fornecê-lo, com o provedor escolhido em `providers` na [composição](./composition-and-distribution.md); `doric.windows/v1` continua da plataforma e não aceita outro provedor. `windows/v1` é um contrato de cardinalidade `one`: quando a composição escolhe outro provedor, o loader não registra a definição `coreWindows` do core no `desktopMain`, e o `services.use(WindowsV1)` do próprio core devolve o provedor escolhido; sem escolha em `providers`, o segundo provedor vai para quarentena com motivo, porque o core ativa antes dele.

A referência `WindowsV1` e o tipo do contrato ficam em `bundle/contracts`, como os dos demais contratos básicos; o core fornece a definição com `execute`, `coreWindows`, escrita com `defineService` e `defineMethod`, como em [serviços e canais](./services-and-channels.md). Passar a referência no lugar do ID faz o compilador conferir os métodos contra o tipo. Como é fornecida no `desktopMain`, partes `client` que declaram `windows/v1` em `requires` a alcançam pela ponte. O mesmo vale para `menus/v1`.

Pseudocódigo da API proposta:

```ts
// core, contracts/windows.ts: schemas do pedido e do resultado de open.
import { z } from 'zod';

// Intenção visual descrita em window-appearance.md.
export const windowAppearanceSchema = z
  .object({
    size: z
      .object({
        width: z.number(),
        height: z.number(),
        minWidth: z.number().optional(),
        minHeight: z.number().optional(),
      })
      .strict()
      .optional(),
    titleBar: z.enum(['native', 'integrated', 'none']).default('integrated'),
    background: z.string().default('window'), // nome de token, não cor
  })
  .strict();

export const openWindowRequestSchema = z
  .object({
    key: z.string(),
    path: z.string(),
    appearance: windowAppearanceSchema.optional(),
  })
  .strict();

export const openWindowResultSchema = z.void();

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
      // Outros bundles ajustam o pedido pelo hook do core; veja hooks.md.
      const coreHooks = services.use(HooksV1).define(CoreHooksV1);
      const adjusted = await coreHooks.onBeforeOpenWindowHook.execute(
        request,
        call,
      );
      return services.use(DoricWindowsV1).open(
        {
          ...applyCorePolicy(adjusted), // políticas do core, função interna
          // call.caller é quem chamou windows/v1, por exemplo o git.
          key: `${call.caller.bundleId}:${request.key}`,
        },
        call, // herda scope, signal e trace; o caller do novo salto é o core
      );
    },
  }),
});

// core, parte desktopMain, dentro de activate({ services }: DesktopContext)
services.provide(coreWindows);

// git, parte client, dentro de activate({ services }: ClientContext)
import { WindowsV1 } from 'bundle/contracts';

// Por exemplo, no execute de um comando client que recebeu call.
await services.use(WindowsV1).open(
  {
    key: `diff:${threadId}:${repository}`,
    path: `/git/diff/${threadId}/${encodeURIComponent(repository)}`,
  },
  call,
);
```

Como o git usa `WindowsV1` com `use`, seu manifesto declara `windows/v1` em `requires`, ao lado dos outros contratos básicos que o código usa (por exemplo `ui/v1` e `commands/v1` no client):

```json
{
  "requires": ["windows/v1@^1.0.0", "ui/v1@^1.0.0", "commands/v1@^1.0.0"]
}
```

Cada stub aceita como último argumento opcional o `call` recebido ou `{ signal, deadline }`. A chamada do git sai de uma janela client, então o dispatcher preenche `call.scope.windowKey`, atravessa a ponte até o `desktopMain` e entrega ao `windows/v1` um `call` cujo `caller` é o git.

`windowAppearanceSchema` representa a intenção visual de [aparência nativa da janela](./window-appearance.md). `open` resolve quando a janela está aberta ou focada, já no path pedido. Um path sem rota não é erro de `open`: a janela abre e o outlet mostra `<core-not-found>`.

A janela de settings também é do core padrão: ele a abre em `/settings` pelo item “Settings” do menu. A página é o `<settings-page>` do bundle `settings`, e os bundles de domínio montam suas seções na região `settings.sections`.

## O que a janela mostra

Na parte `client`, o core fornece `ui/v1`, `navigation/v1` e `regions/v1` e define só `<core-outlet>`, `<core-region>`, `<core-not-found>` e `<core-unavailable>`, descritos em [UI no client](./core.md#ui-no-client). O conteúdo de cada janela é a rota que casa com o seu path:

| Chave        | Path inicial                      | Rota de                 | Elemento             |
| ------------ | --------------------------------- | ----------------------- | -------------------- |
| `workspace`  | `/`                               | [`layout`](./layout.md) | `<layout-workspace>` |
| `settings`   | `/settings`                       | `settings`              | `<settings-page>`    |
| `git:diff:…` | `/git/diff/:threadId/:repository` | `git`                   | `<git-diff>`         |

A chave do diff tem o prefixo `git:` porque `windows/v1` prefixa a chave com o bundle que chamou.

A página de settings mostra os links das seções na região `settings.sections` e a seção ativa no seu `<core-outlet>`. Uma seção é uma rota filha de `/settings` mais um link na região:

```ts
// settings, parte client (requires: ui/v1, regions/v1 e navigation/v1)
import {
  NavigationV1,
  RegionsV1,
  UiV1,
  type ClientContext,
} from 'bundle/contracts';

export const activate = ({ services }: ClientContext) => {
  const ui = services.use(UiV1);
  const navigation = services.use(NavigationV1);
  ui.define('settings-page', SettingsPage); // <core-region name="settings.sections"> e <core-outlet>
  ui.define('settings-link', SettingsLink);
  ui.define('settings-providers', ProvidersSection);

  navigation.register({
    path: '/settings',
    create: () => ui.create('settings-page'),
  });
  navigation.register({
    path: '/settings/providers',
    parent: '/settings',
    create: () => ui.create('settings-providers'),
  });
  services.use(RegionsV1).add('settings.sections', {
    id: 'providers',
    tag: 'settings-link',
    props: { label: 'Providers', path: '/settings/providers' },
    order: 10,
  });
};
```

Itens de região têm IDs sem versão e referenciam elementos pelo nome da tag; o `ui/v1` recusa uma tag que não comece com `<id do bundle chamador>-`. Como `<core-region>` e o outlet criam os elementos com [`ui.create`](./core.md#uicreate-passo-a-passo), cada elemento recebe os serviços do bundle que o definiu. O catálogo client de contribuições está em [UI composta por bundles](./ui-composition.md).

## Shell única e path da janela

Todas as janelas carregam a mesma **shell HTML técnica** e o mesmo bootstrap client, em `doric://app/<path>`. O handler do [protocolo `doric://`](./doric-protocol.md) responde a shell para qualquer path que não seja arquivo de `/platform/` ou `/bundles/`, então recarregar a janela mantém a rota.

A abertura recebe só os campos de `open`, sem arquivo HTML ou preload; o Electron mantém o que já faz hoje. O main vincula a chave ao `webContents` da janela e carrega o path pedido; o renderer lê a rota de `location.pathname`. O preload expõe `describeWindow()` só para a aparência: devolve o `chrome` com a área segura e a altura da barra de título.

## Bootstrap de cada janela no renderer

```ts
// app/doric-renderer, com o runtime client de packages/desktop
import { AppHooksV1, WindowHooksV1 } from 'bundle/contracts';

const { chrome } = await window.doric.desktop.describeWindow();
applyChrome(chrome); // --doric-safe-* e --doric-titlebar-height
let windowHooks;

await activateClientBundles({
  // Chamado logo depois que o provedor de hooks/v1 do client ativa (o core,
  // por padrão, ou o escolhido em providers) e antes dos bundles seguintes.
  onHooksProviderReady: (hooks) => {
    // A plataforma define AppHooksV1 e dispara ali os hooks marcados como
    // "Todos"; os bundles que ativam depois observam onActivateHook.
    hooks.define(AppHooksV1);

    // A plataforma define os hooks da janela no hooks/v1 ativo do client
    // e os executa quando o main pede o fechamento desta janela.
    windowHooks = hooks.define(WindowHooksV1);
  },
});

onCloseRequested(windowHooks);

// A ativação registra serviços, rotas, tags e nodes Lexical antes da UI.
// O outlet de topo mostra a rota que casa com location.pathname.
document.body.replaceChildren(document.createElement('core-outlet'));
await window.doric.desktop.ready();
```

O bootstrap e `activateClientBundles` pertencem a `packages/desktop`, o runtime client do loader usado por `app/doric-renderer`; bundles não importam esse pacote, e componentes, tokens e Tailwind continuam em `desktop/ui`. `applyChrome` aplica os tokens da área segura e da barra de título, de [aparência nativa da janela](./window-appearance.md) e [pacotes compartilhados e tokens do tema](./platform-packages.md).

### `activateClientBundles`

- Importa de `doric://app/bundles/<id>@<versão>/` os artefatos que o main baixou do host e guardou no cache; ver [composição e distribuição](./composition-and-distribution.md).
- Valida dependências, `engines.doric` e conflitos de tag **antes de importar código com efeitos colaterais**.
- Ativa primeiro a fundação do client (os bundles escolhidos em `providers` para contratos que o core fornece ou consome nesse ambiente, como um substituto de `hooks/v1`), depois o core e por último os demais bundles, em ordem de dependência. Logo depois que o provedor de `hooks/v1` ativa (um bundle da fundação ou o core), chama `onHooksProviderReady`, em que o bootstrap faz `define(AppHooksV1)` e `define(WindowHooksV1)`; só então ativa os bundles seguintes, na mesma ordem. Os bundles ativados antes do provedor de `hooks/v1` não observam `onActivateHook`. A escolha em `providers` vale em cada ambiente em que o bundle escolhido fornece o contrato; nos outros, o provedor padrão continua.
- Não cria UI própria da plataforma: depois da ativação, o bootstrap só põe o `<core-outlet>` do core no `body` (ver [UI composta por bundles](./ui-composition.md)).
- Uma parte que falha entra em [quarentena](./core.md) sem impedir as outras.
- Uma ativação falha desfaz registros reversíveis; depois de `customElements.define`, a tag não pode ser removida da janela e uma nova tentativa exige recarga.
- Se o core falhar na ativação da janela principal, a janela informa a falha ao main em vez de `ready()`, e a superfície técnica entra no estado de recuperação, descrito em [splash e recuperação](./splash-and-recovery.md).

### O outlet de topo

O `<core-outlet>` que o bootstrap põe no `body` mostra a rota que casa com `location.pathname` e, seguindo `parent`, a rota filha dentro do outlet do pai, como em [o outlet](./navigation.md#o-outlet-core-outlet). Ele é criado depois da ativação, então todas as rotas já estão registradas. O roteador é o `navigation/v1` do core, e a janela não precisa iniciá-lo: ele lê o path da URL. Um path sem rota mostra `<core-not-found>`, e a URL fica como está.

Uma rota de Thread é validada pelo próprio `<chat-view>` contra o host quando ele estiver disponível; se estiver offline, a janela preserva o path e mostra estado desconectado, sem apagar a seleção.

O elemento de uma rota pode ser React, Web Components puros ou outra tecnologia; ver [React dentro de Web Components](./react-web-components.md).

## Hooks de fechamento

Uma janela tem dois hooks de fechamento, em `WindowHooksV1`, contrato da plataforma. Quem os define é a plataforma no ambiente `client`: o bootstrap de cada janela chama `define(WindowHooksV1)` no `hooks/v1` ativo do client e executa os hooks quando o main pede o fechamento da janela. Qualquer bundle client da janela, não só o dono da rota ativa, registra handlers neles:

| Hook          | Tipo      | Pode vetar | Prazo                                   | Uso                                                             |
| ------------- | --------- | ---------- | --------------------------------------- | --------------------------------------------------------------- |
| `onCloseHook` | `decide`  | Sim        | Sem prazo; espera a resposta do usuário | Confirmar alterações não salvas com um diálogo dentro da janela |
| `onFlushHook` | `observe` | Não        | Fixo, definido pela plataforma          | Gravar o que está pendente, como o autosave de settings         |

O main chama `onCloseHook` primeiro; se ele vetar, a janela continua aberta. Um segundo pedido de fechamento enquanto o primeiro espera, ou o encerramento forçado do app, pula o veto. Depois o main chama `onFlushHook` com prazo, que hoje é `settingsCloseFlushMs = 1_500` em `app/doric/src/main.ts`, e destrói a janela mesmo se o hook falhar ou travar. O flush atual de settings vira o `onFlushHook` dessa janela, com handshake indexado pela chave da janela.

O pedido de fechamento chega do main ao bootstrap da janela, que dispara `execute` no handle de `WindowHooksV1` do seu `hooks/v1`. No client, `hooks.use(WindowHooksV1).onCloseHook(handler)` e `hooks.use(WindowHooksV1).onFlushHook(handler)` registram para a janela do client que chamou, identificada por `call.scope.windowKey`. Como `onCloseHook` é `decide`, o handler devolve `Decision`:

```ts
// parte client de um bundle (requires: hooks/v1)
import { HooksV1, WindowHooksV1 } from 'bundle/contracts';

const windowHooks = services.use(HooksV1).use(WindowHooksV1);

windowHooks.onCloseHook(async (input, call) =>
  !draft.dirty || (await confirmDiscard())
    ? { allow: true }
    : { allow: false, reason: 'unsaved-changes' },
);
windowHooks.onFlushHook(() => settingsStore.flush());
```

## Assinaturas por janela

As assinaturas atuais de Project e Thread também precisam ser indexadas por janela **e** recurso antes de suportar várias instâncias independentes: hoje `app/doric/src/workspace/events.ts` guarda as watches num `Map` indexado só por `threadId`, e um novo watch substitui o de outra janela.

## Relações

- [Bundle core e quarentena](./core.md): o core usa `doric.windows/v1` e fornece `windows/v1`; a fundação ativa antes do core, e partes que falham na ativação entram em quarentena.
- [Hooks e ciclo de vida](./hooks.md): as janelas são abertas dentro de `AppHooksV1`, que a plataforma define no `hooks/v1` do `desktopMain`; `onCloseHook` e `onFlushHook` vêm de `WindowHooksV1`, que a plataforma define no `hooks/v1` do client pelo bootstrap de cada janela.
- [Contratos e a família define\*](./contracts.md): `windows/v1` e o comando `core.open-settings/v1` usam `defineService`, `defineMethod` e `defineCommand`, e suas referências são criadas com `ref`.
- [Serviços entre bundles e canais de mensagens](./services-and-channels.md): outros bundles abrem janelas pelo serviço versionado `windows/v1`, alcançável do client pela ponte; `call.caller` identifica quem pediu, e o `call` repassado propaga `scope`, `signal` e `trace`.
- [Contextos e capacidades](./contexts.md): define o `DesktopContext` e o `ClientContext`, só com `services`, que o core e os outros bundles recebem nos exemplos.
- [Aparência nativa da janela](./window-appearance.md): descreve o campo `appearance` e o `chrome` aplicado no bootstrap.
- [Protocolo doric://](./doric-protocol.md): serve a shell única para qualquer path de rota em `doric://app/<path>` e os bundles, com a CSP.
- [Splash e recuperação](./splash-and-recovery.md): recebe a falha quando o core não ativa na janela principal.
- [Navegação e rotas](./navigation.md): a rota é o path da janela, mostrada pelo `<core-outlet>` que o bootstrap põe no `body`.
- [O bundle layout](./layout.md): a rota `/`, mostrada na janela `workspace`.
- [Composição e distribuição pelo host](./composition-and-distribution.md): fornece os artefatos que `activateClientBundles` importa e a escolha de `providers` por ambiente.
- [Pacotes compartilhados e tokens do tema](./platform-packages.md): `packages/desktop` é o runtime client do loader que executa o bootstrap da janela.
- [UI composta por bundles](./ui-composition.md): elementos de rota e de região são custom elements definidos com `define` de `ui/v1`.
- [React dentro de Web Components](./react-web-components.md): mostra como um elemento React é publicado como custom element.
- [Menus nativos e atalhos](./menus-and-keybindings.md): o item “Settings” do menu dispara o comando que abre a janela de settings.
