# O bundle layout

**Estado:** proposta. Parte da [arquitetura de bundles](../bundles.md); nada aqui descreve comportamento já implementado, e `GROUNDING.md` continua sendo o contrato da implementação atual.

## Resumo

O `layout` é o bundle client que desenha o workspace: a moldura que hoje é `app/doric-renderer/src/views/app.tsx`, com sidebar de Projects e Threads, header, painel lateral, abas, rodapé e a área principal. Ele registra a rota `/` e, no template do seu elemento `<layout-workspace>`, põe um `<core-outlet>` onde as rotas filhas aparecem (a conversa, por exemplo) e quatro regiões que outros bundles preenchem. Também fornece `layout.tabs/v1`, para que outros bundles abram abas de arquivo, diff ou terminal. O layout não conhece a conversa, os arquivos nem o terminal: só sabe onde cada coisa fica. Os mecanismos que ele usa (`ui/v1`, `navigation/v1`, `<core-outlet>`, `regions/v1` e `<core-region>`) são do [core](./core.md).

## O que o layout fornece

| Funcionalidade           | Como os outros bundles usam                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Rota `/`                 | Registram rotas filhas com `parent: '/'`, que aparecem na área principal.                                     |
| Sidebar                  | Mostra Projects e Threads; clicar numa Thread navega para `/projects/:projectId/threads/:threadId`.           |
| Header                   | Mostra o Project e a Thread da rota ativa; ações de outros bundles entram na região `layout.header`.          |
| Painel lateral           | Mostra um item da região `layout.panel` por vez, com um seletor entre eles (como Files e Changes hoje).       |
| Rodapé                   | Mostra os itens da região `layout.footer`, como uso e recursos.                                               |
| Grupos extras da sidebar | Panes registrados em `layout.stack/v1`, abaixo da árvore; o layout desenha o painel e o cabeçalho de cada um. |
| Abas                     | `layout.tabs/v1`: `open`, `close` e `focus` de abas, num painel ao lado da área principal.                    |
| Abrir settings           | O botão do rodapé da sidebar despacha o comando `core.open-settings/v1`.                                      |

## Como funciona

### 1. A janela abre em `/`

O core abre a janela principal com `windows.open({ key: 'workspace', path: '/' })`. A janela carrega a shell, ativa as partes client na ordem (core primeiro) e põe um `<core-outlet>` no `body`. O outlet procura a rota de `/` e encontra a do layout.

### 2. O layout registra a rota e define o elemento

```ts
// layout, client/index.ts (pseudocódigo da API proposta)
import { NavigationV1, UiV1, type ClientContext } from 'bundle/contracts';
import { LayoutWorkspace } from './workspace.js';
import { layoutTabs } from './tabs.js';

export function activate({ services }: ClientContext) {
  const ui = services.use(UiV1);
  ui.define('layout-workspace', LayoutWorkspace);

  services.provide(layoutTabs);

  services.use(NavigationV1).register({
    path: '/',
    create: () => ui.create('layout-workspace'),
  });
}
```

`ui.create('layout-workspace')` cria o elemento e entrega a ele os serviços do próprio `layout` (veja [`ui.create` passo a passo](./core.md#uicreate-passo-a-passo)). Dentro do elemento, o layout lê esses serviços em `this.services`.

### 3. O template do workspace

`<layout-workspace>` é escrito em React montado dentro do Web Component, como em [React dentro de Web Components](./react-web-components.md), e reaproveita os componentes atuais (`WorkspaceLayout`, `ProjectSidebar`, `WorkspaceHeader`, `WorkspaceTabs`) e os componentes shadcn dos [pacotes compartilhados](./platform-packages.md). A estrutura que ele monta é esta:

```text
<layout-workspace>
  <aside>                                   sidebar
    árvore de Projects e Threads            (do layout, dados de runtime.threads/v1)
    painéis dos grupos                     panes de `layout.stack/v1`
    (Threads, telas, …)                    o Threads é do próprio layout
    botão Settings                          (despacha core.open-settings/v1)
  <header>
    Project / Thread da rota ativa
    <core-region name="layout.header">      ações
  <main>
    <core-outlet>                           rota filha; vazio em "/"
  <section>                                 abas abertas por layout.tabs/v1
  <aside>
    <core-region name="layout.panel">       painel lateral
  <footer>
    <core-region name="layout.footer">      rodapé
```

Quando a rota ativa é `/`, o `<core-outlet>` de `<main>` fica vazio e o layout mostra o estado vazio atual ("No thread selected").

### 4. A sidebar navega

A seleção de Project e Thread é a rota ativa. A sidebar não guarda seleção própria:

```ts
// dentro de <layout-workspace>
const navigation = this.services.use(NavigationV1);

function openThread(projectId: string, threadId: string) {
  navigation.navigate(`/projects/${projectId}/threads/${threadId}`);
}

// destaque da linha selecionada
// dentro do componente React da sidebar; atualiza a cada navegação
const { params } = useSyncExternalStore(
  navigation.subscribe,
  navigation.current,
);
const selectedThreadId = params.threadId;
```

O destaque acompanha cliques, voltar e avançar porque o componente assina o roteador; veja [elemento React](./navigation.md#elemento-react).

Expansão de linhas e abas abertas continuam sendo estados do layout, independentes da rota.

### 5. A conversa aparece no outlet

O `chat` registra `/projects/:projectId/threads/:threadId` com `parent: '/'`. Navegar para `/projects/p1/threads/t1` faz o outlet de topo manter o `<layout-workspace>` e o outlet de `<main>` mostrar `<chat-view>` com `projectId` e `threadId`. Trocar de Thread só atribui os novos parâmetros ao mesmo `<chat-view>`; veja [o outlet](./navigation.md#o-outlet-core-outlet).

### 6. Outros bundles preenchem as regiões

Uma região é um lugar com nome no template, marcado com `<core-region name="…">`. Um bundle põe um elemento seu nela com `regions.add`:

```ts
// files, client/index.ts
const ui = services.use(UiV1);
ui.define('files-tree', FilesTree);
ui.define('files-toggle', FilesToggle);

const regions = services.use(RegionsV1);
regions.add('layout.panel', { id: 'files', tag: 'files-tree' });
regions.add('layout.header', { id: 'files-toggle', tag: 'files-toggle' });
```

`<core-region>` cria cada item com `ui.create(tag, props)`, na ordem de `order` e depois na ordem de ativação, e o remove quando o bundle dono é desativado. Se o layout não estiver na composição, nenhuma `<core-region name="layout.panel">` existe e os itens simplesmente não aparecem.

Na composição padrão:

| Região          | Bundle      | Elemento                                      |
| --------------- | ----------- | --------------------------------------------- |
| `layout.header` | `files`     | `<files-toggle>`, que abre e fecha o painel   |
| `layout.header` | `terminal`  | `<terminal-new-button>`, que cria um terminal |
| `layout.panel`  | `files`     | `<files-tree>`, a árvore de arquivos          |
| `layout.panel`  | `git`       | `<git-changes>`, a lista de Changes           |
| `layout.footer` | `usage`     | `<usage-summary>`, contexto, tokens e custo   |
| `layout.footer` | `resources` | `<resources-monitor>`, métricas de máquina    |

O composer não é do layout: ele faz parte de `<chat-view>`, no bundle `chat`.

### 7. Abas: `layout.tabs/v1`

Abas mantêm várias views vivas ao mesmo tempo, como o `WorkspaceTabs` atual. O outlet mostra uma rota por vez, então abas não são rotas: são elementos que o layout cria e guarda.

```ts
// layout, client/tabs.ts (pseudocódigo da API proposta)
import { UiV1, defineMethod, defineService } from 'bundle/contracts';
import { z } from 'zod';

// abas abertas e aba em foco; o estado fica no módulo, um por geração
const tabs = new Map<string, { title: string; element: HTMLElement }>();
let focusedId: string | undefined;

export const layoutTabs = defineService('layout.tabs/v1', {
  open: defineMethod({
    input: z.object({
      id: z.string(),
      title: z.string(),
      tag: z.string(),
      props: z.record(z.string(), z.unknown()).optional(),
    }),
    output: z.void(),
    execute: async ({ id, title, tag, props }, call, services) => {
      if (!tabs.has(id)) {
        const element = services.use(UiV1).create(tag, props);
        tabs.set(id, { title, element });
      }
      focusedId = id;
    },
  }),
  close: defineMethod({
    input: z.object({ id: z.string() }),
    output: z.void(),
    execute: async ({ id }, call, services) => {
      const tab = tabs.get(id);
      if (!tab) return;
      services.use(UiV1).dispose(tab.element);
      tabs.delete(id);
      if (focusedId === id) focusedId = undefined;
    },
  }),
  focus: defineMethod({
    input: z.object({ id: z.string() }),
    output: z.void(),
    execute: async ({ id }) => {
      if (tabs.has(id)) focusedId = id;
    },
  }),
});

// layout, contracts/index.ts: só o ID e o tipo
import { ref } from 'bundle/contracts';
import type { layoutTabs } from '../client/tabs.js';
export const LayoutTabsV1 = ref<typeof layoutTabs>('layout.tabs/v1');
```

Cada `execute` recebe `(input, call, services)`, com os serviços do próprio `layout`, ligados no `provide`. Quem abre abas importa só `LayoutTabsV1` de `layout/contracts`.

```ts
// git, client: abrir o diff de um arquivo numa aba
services.whenAvailable(LayoutTabsV1, (tabs) =>
  tabs.open({
    id: `diff:${repository}:${path}`,
    title: path,
    tag: 'git-file-diff',
    props: { threadId, repository, path },
  }),
);
```

- As abas pertencem à Thread da rota ativa, como hoje: trocar de Thread mostra as abas daquela Thread.
- `open` com um `id` já aberto só foca a aba.
- O layout cria o elemento com `ui.create(tag, props)` e o mantém montado enquanto a aba existir, mesmo quando outra aba está em foco; fechar a aba chama `ui.dispose`.
- Quem abre abas usa `whenAvailable`, porque uma composição sem `layout` não tem abas. O mesmo diff continua disponível numa janela própria pelo comando `git.open-comparison/v1`.

## Manifesto

```json
{
  "manifestVersion": 1,
  "id": "layout",
  "version": "1.0.0",
  "engines": { "doric": "^1.0.0" },
  "provides": ["layout.tabs/v1@1.0.0"],
  "requires": [
    "ui/v1@^1.0.0",
    "navigation/v1@^1.0.0",
    "commands/v1@^1.0.0",
    "runtime.threads/v1@^1.0.0"
  ]
}
```

O layout só tem parte `client`. Ele lê Projects e Threads por `runtime.threads/v1`, pela ponte client → host, e despacha `core.open-settings/v1` por `commands/v1`.

## O que acontece sem o layout

- O path `/` fica sem rota e o outlet de topo mostra `<core-not-found>`.
- Uma rota cujo `parent` não está registrado aparece direto no outlet de topo. Sem o layout, `/projects/p1/threads/t1` mostra só o `<chat-view>`, ocupando a janela.
- Itens das regiões `layout.*` não aparecem, e `layout.tabs/v1` não existe para quem o consulta com `whenAvailable`.

Para trocar o layout, a composição tira o `layout` e põe outro bundle que registre `/`. Dois bundles registrando `/` é um conflito de rota, e o segundo vai para quarentena com motivo.

## Relações

- [Bundle core](./core.md): fornece `ui/v1`, `navigation/v1`, `regions/v1`, `<core-outlet>` e `<core-region>`, que o layout usa, e abre a janela principal em `/`.
- [Navegação e rotas](./navigation.md): rotas como paths, `parent` e o funcionamento do outlet.
- [O bundle chat](./chat.md): a rota filha `/projects/:projectId/threads/:threadId` que aparece no outlet do layout.
- [UI composta por bundles](./ui-composition.md): Web Components como fronteira, propriedades, eventos DOM e regiões.
- [React dentro de Web Components](./react-web-components.md): como `<layout-workspace>` monta React dentro do elemento.
- [Divisão das funcionalidades atuais](./feature-split.md): de onde vem cada parte do workspace atual.
- [Janelas abertas pelo core](./windows.md): a janela `workspace` que o core abre em `/`.
