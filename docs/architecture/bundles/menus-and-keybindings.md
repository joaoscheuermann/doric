# Menus nativos e atalhos

**Estado:** proposta. Parte da [arquitetura de bundles](../bundles.md); nada aqui descreve comportamento já implementado, e `GROUNDING.md` continua sendo o contrato da implementação atual.

## Resumo

O menu nativo da aplicação e os atalhos de teclado passam a ser registrados por código, não deixados ao menu padrão do Electron. O core usa o contrato nativo da plataforma `doric.menus/v1`; os outros bundles pedem itens, atalhos e mudanças de contexto ao serviço `menus/v1`, que o core fornece por padrão no `desktopMain` sobre `doric.menus/v1` com suas políticas. Partes `client` que declaram `menus/v1` em `requires` o alcançam pela ponte. Cada item ou atalho aponta para um comando definido com `defineCommand` e registrado em `commands/v1`, que existe no `desktopMain` e no `client`, e pode ter uma condição `when` de vocabulário fixo. Um clique ou atalho resolve o comando, que é despachado à janela em foco ou ao registro do `desktopMain`, e conflitos de tecla são recusados com erro.

## Situação atual

Hoje `app/doric` não define `Menu`, então o Electron mostra o menu padrão. Menus e atalhos passam a ser registrados por código.

## Quem registra

O contexto de ativação só entrega `services`; não existem `ctx.menus` nem `ctx.keybindings`. Partes `desktopMain` recebem `DesktopContext` e partes `client` recebem `ClientContext`, ambos só com `services`. A API nativa de menus e atalhos é o contrato de plataforma `doric.menus/v1`, usado pelo core. O core usa esse contrato e fornece `menus/v1` (itens, atalhos e `setContext`), que os outros bundles usam.

A referência `MenusV1` não é do core: ela fica em `bundle/contracts`, junto com as outras referências e tipos dos contratos básicos (`CommandsV1`, `HooksV1`, `WindowsV1` etc.), porque qualquer bundle pode fornecê-los; o core fornece a definição com `execute` (`coreMenus`). `menus/v1` não tem prefixo `doric.` e tem cardinalidade `one` (o padrão), então outro bundle pode fornecê-lo no lugar do core, escolhido em `providers` da composição para o `desktopMain`; nesse caso o loader não registra a definição `coreMenus` para `menus/v1` nesse ambiente, e o `services.use(MenusV1)` do próprio core devolve o provedor escolhido. De `core/contracts` vem só o que é do core, como `CoreHooksV1` e `OpenSettingsCommandV1`, a referência do comando `core.open-settings/v1`. O bundle que contribui um item define o comando que o item dispara com `defineCommand`.

Pseudocódigo da API proposta:

```ts
// bundle/contracts: referência e tipo do contrato básico, fornecido pelo core por padrão
import { ref } from './define.js';

export type MenuWhen = { path?: string; focus?: string }; // path: padrão de path da rota ativa

export interface Menus {
  addItem(item: {
    id: string;
    location: string; // 'app/<menu>' ou 'dock'
    command: string;
    label: string;
    when?: MenuWhen;
    order?: number;
  }): Promise<void>;
  addKeybinding(binding: {
    command: string;
    key: string;
    when?: MenuWhen;
  }): Promise<void>;
  setContext(entry: {
    key: 'path' | 'focus';
    value: string | null;
  }): Promise<void>;
}

export const MenusV1 = ref<Menus>('menus/v1');
```

```ts
// git, client/commands.js
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
```

```ts
// core, desktopMain/menus.ts: definição de menus/v1 com execute
import {
  defineMethod,
  defineService,
  DoricMenusV1,
  MenusV1,
} from 'bundle/contracts';
import { z } from 'zod';

const when = z
  .object({
    path: z.string().optional(), // padrão de path da rota ativa
    focus: z.string().optional(),
  })
  .strict();

// call.caller é quem chamou menus/v1; no salto para doric.menus/v1 o caller passa a ser o core,
// então o dono do registro vai explícito na entrada. call.scope.windowKey é herdado do call pai.
export const coreMenus = defineService(MenusV1, {
  addItem: defineMethod({
    input: z
      .object({
        id: z.string(),
        location: z.string(), // 'app/<menu>' ou 'dock'
        command: z.string(),
        label: z.string(),
        when: when.optional(),
        order: z.number().optional(),
      })
      .strict(),
    output: z.void(),
    execute: (item, call, services) =>
      services.use(DoricMenusV1).add({ ...item, owner: call.caller }, call),
  }),
  addKeybinding: defineMethod({
    input: z
      .object({
        command: z.string(),
        key: z.string(),
        when: when.optional(),
      })
      .strict(),
    output: z.void(),
    execute: (binding, call, services) =>
      services
        .use(DoricMenusV1)
        .addKeybinding({ ...binding, owner: call.caller }, call),
  }),
  setContext: defineMethod({
    input: z
      .object({
        key: z.enum(['path', 'focus']),
        value: z.string().nullable(),
      })
      .strict(),
    output: z.void(),
    execute: (entry, call, services) =>
      services
        .use(DoricMenusV1)
        .setContext({ windowKey: call.scope?.windowKey, ...entry }, call),
  }),
});
```

```ts
// core, parte desktopMain
import {
  AppHooksV1,
  type DesktopContext,
  DoricMenusV1,
  HooksV1,
} from 'bundle/contracts';
import { coreMenus } from './menus.js';
import { defaultMenuSkeleton } from './menu.js';

export const activate = ({ services }: DesktopContext) => {
  services.provide(coreMenus);

  // O esqueleto do menu é montado no onAppReadyHook, não direto no activate.
  services
    .use(HooksV1)
    .use(AppHooksV1)
    .onAppReadyHook(async (_input, call) => {
      await services.use(DoricMenusV1).setSkeleton(defaultMenuSkeleton, call);
    });
};
```

```ts
// git, parte client: o comando entra no registro de comandos da janela, e o item e o atalho
// vão a menus/v1 pela ponte client → desktopMain
import { type ClientContext, CommandsV1, MenusV1 } from 'bundle/contracts';
import { switchBranchCommand } from './commands.js';

export const activate = async ({ services }: ClientContext) => {
  services.use(CommandsV1).register(switchBranchCommand);

  const menus = services.use(MenusV1);
  await menus.addItem({
    id: 'git.menu.switch-branch',
    location: 'app/view',
    command: 'git.switch-branch/v1',
    label: 'Trocar branch…',
    when: { path: '/projects/:projectId/threads/:threadId' },
  });
  await menus.addKeybinding({
    command: 'git.switch-branch/v1',
    key: 'CmdOrCtrl+Shift+B',
    when: { path: '/projects/:projectId/threads/:threadId' },
  });
};
```

O manifesto do `git` declara em `requires` da parte `client` os contratos que esse código usa com `use`: `commands/v1`, `menus/v1` e `git.commands/v1`, que o `execute` de `switchBranchCommand` usa para chamar o host pela ponte. `doric.menus/v1` é da plataforma, sempre existe e nunca entra em `requires`; o core o usa sem declará-lo. O core também não declara `hooks/v1` nem `menus/v1`, que ele mesmo fornece; o core só pode declarar `requires` de contratos que a fundação fornece. A ordem de ativação (fundação, core e demais bundles) está em [serviços e canais](./services-and-channels.md).

Como alternativa, um bundle que já tenha parte `desktopMain` pode registrar o item e o atalho nela, com `activate({ services }: DesktopContext)` chamando o mesmo `services.use(MenusV1)` sem passar pela ponte; nesse caso `menus/v1` entra no `requires` da parte `desktopMain`. O `git` desta proposta não tem parte `desktopMain` e faz o registro na parte `client`.

O `execute` de cada método de `menus/v1` recebe `(input, call, services)`, com `call.caller` (`{ bundleId, version, generation }`) preenchido pelo dispatcher da plataforma: é o bundle que chamou `menus/v1`, como `git`. Quando o core repassa `call` a `doric.menus/v1`, o dispatcher herda `scope`, `signal` e `trace`, mas o `caller` desse salto novo é o próprio core, nunca herdado; por isso o `execute` do core passa o dono na entrada (`owner: call.caller`) para atribuir cada item e atalho ao bundle que o pediu. `setContext` sabe a qual janela o contexto pertence por `call.scope.windowKey`, que o dispatcher preenche em toda chamada que sai de uma janela client. O loader rastreia o que cada bundle registrou por meio de serviços (o fornecimento de `menus/v1`, o comando em `commands/v1` e os itens e atalhos pedidos) e descarta em ordem inversa na desativação, então o menu é reconstruído sem os itens de um bundle desativado sem que ele precise de `onDispose`.

A definição do comando tem `execute`, então ela fica em `client/commands.js` de `git`; se outros bundles quiserem despachá-lo com a entrada tipada, `git/contracts` exporta só a referência, `ref<typeof switchBranchCommand>('git.switch-branch/v1')`. O item e o atalho não carregam a função do comando: menus e atalhos o despacham pelo ID `git.switch-branch/v1`. Comandos de UI e de menu são definidos e registrados na parte `client` (ou `desktopMain`); a parte `host` nunca registra comando, porque `commands/v1` não existe no `host`.

O dispatcher valida a entrada de `addItem`, `addKeybinding` e `setContext` com o zod da definição fornecida no mesmo processo e com o JSON Schema gerado quando a chamada atravessa processos, inclusive na ponte client → desktopMain; os detalhes do diretório de serviços estão em [serviços e canais](./services-and-channels.md), e a família `define*` em [contratos](./contracts.md).

## Esqueleto do menu

O core define o esqueleto do menu da aplicação:

- App: Sobre, Settings (comando `core.open-settings/v1`), Sair.
- Editar: desfazer, refazer, recortar, copiar, colar, selecionar tudo, com os papéis nativos que o macOS exige para os atalhos de área de transferência.
- Visualizar.
- Janela.
- Ajuda.

O core monta esse esqueleto e registra os atalhos básicos por `doric.menus/v1` no handler do `onAppReadyHook` que registrou com `hooks.use(AppHooksV1).onAppReadyHook(handler)`, não direto no `activate`. Depois que o provedor de `hooks/v1` do `desktopMain` ativa (o core, por padrão, ou o escolhido em `providers`), a plataforma chama `define(AppHooksV1)` e dispara o `onAppReadyHook` quando todos os bundles do desktop ativaram; os handlers registrados antes do `define` não se perdem (veja [hooks](./hooks.md)). Itens entram em `app/<menu>` ou `dock`. O comando `core.open-settings/v1` é registrado no `desktopMain` do core, e `core/contracts` exporta a referência `OpenSettingsCommandV1`.

## Montagem pelo main

O main monta o menu com `Menu.buildFromTemplate` a partir dos registros feitos em `doric.menus/v1` e o reconstrói quando a janela em foco, a geração ou o contexto mudam.

## Condição `when`

`when` usa um vocabulário fixo e pequeno (`path`, `focus`), nunca JavaScript. `path` é o padrão de path da rota ativa, como `'/projects/:projectId/threads/:threadId'`, e não o path concreto com os valores dos parâmetros; assim um item vale para qualquer Thread aberta. A janela informa seu contexto ao main por `services.use(MenusV1).setContext({ key, value })`, chamado pela parte `client` pela ponte client → desktopMain, que substitui o antigo `DesktopContextV1.set`; o dispatcher preenche `call.scope.windowKey` com a janela que chamou, e o core repassa a `doric.menus/v1` com essa janela. Por exemplo, a parte `client` do core acompanha o [roteador](./navigation.md#o-roteador-navigationv1) com `subscribe` e, a cada navegação para uma Thread, informa `{ key: 'path', value: '/projects/:projectId/threads/:threadId' }`. Os contextos do desktop estão descritos em [contextos e capacidades](./contexts.md).

## Despacho de comandos

Um clique ou atalho resolve o comando:

- um comando client é entregue à janela em foco e despachado ao registro de `commands/v1` dela, onde o `execute` definido por `defineCommand` roda com a entrada validada pelo zod e recebe `(input, call, services)`, com `call.scope.windowKey` da janela e os serviços do bundle que registrou o comando;
- um comando registrado no `desktopMain`, como `core.open-settings/v1`, é despachado ao registro de `commands/v1` do `desktopMain`.

`commands/v1` não existe no `host`, então não há comando host. Quando a ação precisa do host, o `execute` do comando obtém o stub do serviço correspondente com `services.use` e repassa o `call` recebido como último argumento; o dispatcher herda `scope`, `signal` e `trace`, e o `call.caller` desse salto é o bundle dono do comando.

## Escopo dos atalhos

Todo atalho vale para a janela em foco e é tratado por um único listener de teclado no shell, para que bundles não registrem listeners concorrentes. Atalhos globais (`globalShortcut`) ficam fora até haver um consumidor real.

## Conflitos

Dois atalhos com a mesma tecla e a mesma condição são conflito. O registro que chega depois é recusado com erro e aparece no diagnóstico, salvo uma precedência explícita na composição.

## Relações

- [Contratos e a família define\*](./contracts.md): `defineCommand`, `defineService` e `defineMethod` definem o comando do item e o serviço `menus/v1`; as referências `MenusV1`, `CommandsV1` e `DoricMenusV1` vêm de `bundle/contracts`, e a propagação de `call` está descrita ali.
- [Bundle core e quarentena](./core.md): o core usa `doric.menus/v1`, fornece `menus/v1` e `commands/v1` (alcançável pelo client no caso de `menus/v1`) e é dono do esqueleto do menu e dos atalhos básicos, montados no `onAppReadyHook`.
- [Hooks e ciclo de vida](./hooks.md): a plataforma define `AppHooksV1` no provedor ativo de `hooks/v1` e dispara o `onAppReadyHook`, no qual o core monta o esqueleto do menu.
- [Serviços entre bundles e canais de mensagens](./services-and-channels.md): outros bundles pedem itens pelo stub tipado de `menus/v1`, a ponte client → desktopMain leva a `menus/v1` quando a parte `client` o declara em `requires`, a execução de um comando chama stubs de serviços do host repassando `call`, e `providers` da composição escolhe outro provedor de `menus/v1` no `desktopMain`.
- [Contextos e capacidades](./contexts.md): `DesktopContext` e `ClientContext` só entregam `services`; `doric.menus/v1`, `menus/v1` e `commands/v1` são obtidos por `services.use`.
- [Janelas abertas pelo core](./windows.md): o menu é reconstruído conforme a janela em foco, que recebe os comandos client.
- [Navegação e rotas](./navigation.md): a condição `when` usa o padrão de path da rota ativa, que a parte `client` do core informa por `setContext` a cada navegação.
- [Observabilidade e diagnóstico](./observability.md): conflitos de atalho recusados aparecem no diagnóstico.
- [Manifesto](./manifest.md): o `git` declara `menus/v1` e `commands/v1` em `requires` da parte `client`; `doric.menus/v1` nunca entra.
- [Composição e distribuição pelo host](./composition-and-distribution.md): a composição nomeia o core, escolhe provedores em `providers` e pode declarar a precedência explícita que resolve um conflito de atalho.
