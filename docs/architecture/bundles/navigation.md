# Navegação e rotas

**Estado:** proposta. Parte da [arquitetura de bundles](../bundles.md); nada aqui descreve comportamento já implementado, e `GROUNDING.md` continua sendo o contrato da implementação atual.

## Resumo

Uma rota é um path de URL. Hoje cada janela já é um path (`index.html`, `settings.html`); na proposta, toda janela carrega a mesma shell em `doric://app` e o path da URL, como `/projects/p1/threads/t1`, escolhe o que aparece. Bundles registram padrões de path com uma função que cria o elemento da rota. O core fornece o roteador (`navigation/v1`) e o elemento `<core-outlet>`, que funciona como o `<Outlet>` do React Router: mostra o elemento da rota ativa e, numa rota filha, mostra o filho dentro do outlet do pai. Navegar muda a URL da janela com a History API, então voltar, avançar e recarregar funcionam como num site. Abrir uma janela é abrir um path numa chave de janela, com `windows/v1`.

## Rota é um path

Pseudocódigo da API proposta:

```ts
// chat, client/index.ts
import { NavigationV1, UiV1, type ClientContext } from 'bundle/contracts';

export function activate({ services }: ClientContext) {
  const ui = services.use(UiV1);
  ui.define('chat-view', ChatView);

  services.use(NavigationV1).register({
    path: '/projects/:projectId/threads/:threadId',
    parent: '/',
    create: (params) => ui.create('chat-view', params),
  });
}
```

Uma rota tem três propriedades:

| Propriedade | Obrigatória | O que é                                                                                                                        |
| ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `path`      | Sim         | Padrão de path. Segmentos `:nome` viram parâmetros, sempre strings.                                                            |
| `create`    | Sim         | Função que recebe os parâmetros e devolve o elemento da rota, normalmente com [`ui.create`](./core.md#uicreate-passo-a-passo). |
| `parent`    | Não         | Path de outra rota registrada. A rota passa a ser mostrada dentro do `<core-outlet>` do elemento do pai.                       |

O roteador casa o path segmento a segmento sobre `location.pathname` e entrega cada parâmetro já decodificado com `decodeURIComponent`; quem monta o path codifica cada parâmetro com `encodeURIComponent`.

Não há ID versionado nem schema de parâmetros: o path é a identidade da rota. Quem quer validar um parâmetro faz isso no próprio elemento. Dois bundles que registram o mesmo `path` produzem um conflito, e o segundo vai para quarentena com motivo.

Os paths da composição padrão:

| Path                                     | Bundle     | Pai         | Elemento               |
| ---------------------------------------- | ---------- | ----------- | ---------------------- |
| `/`                                      | `layout`   | —           | `<layout-workspace>`   |
| `/projects/:projectId/threads/:threadId` | `chat`     | `/`         | `<chat-view>`          |
| `/git/diff/:threadId/:repository`        | `git`      | —           | `<git-diff>`           |
| `/settings`                              | `settings` | —           | `<settings-page>`      |
| `/settings/providers`                    | `settings` | `/settings` | `<settings-providers>` |
| `/settings/git`                          | `git`      | `/settings` | `<git-settings>`       |

`parent` é explícito, e não deduzido do prefixo do path, porque `/settings` começa com `/` mas não deve aparecer dentro do workspace.

## O roteador: `navigation/v1`

O core fornece `navigation/v1` no `client`, um por janela. A referência `NavigationV1` vem de `bundle/contracts`, como as dos demais contratos básicos; o core fornece a definição com `execute`, e outro bundle pode fornecer a sua quando a composição o escolhe em `providers`. Como `create` é uma função, o serviço só funciona no mesmo processo.

| Método                | O que faz                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `register(rota)`      | Registra a rota; o registro some quando o bundle é desativado.                                   |
| `navigate(path)`      | Vai para o path com `history.pushState`; `navigate(path, { replace: true })` usa `replaceState`. |
| `back()`              | `history.back()`.                                                                                |
| `current()`           | Devolve `{ path, pattern, params }` da rota ativa, a mesma referência até a próxima navegação.   |
| `subscribe(listener)` | Avisa a cada navegação, inclusive voltar e avançar (`popstate`); devolve a função de cancelar.   |

Em `current()`, `path` é o path concreto, o `location.pathname` (`/projects/p1/threads/t1`); `pattern` é o `path` registrado da rota casada (`/projects/:projectId/threads/:threadId`); `params` são os valores dos segmentos (`{ projectId: 'p1', threadId: 't1' }`). A cada navegação, a parte `client` do core informa `current().pattern` aos [menus e atalhos](./menus-and-keybindings.md) por `setContext`, na chave `path` da condição `when` (por exemplo `{ key: 'path', value: '/projects/:projectId/threads/:threadId' }`). Num path sem rota, `pattern` é `null` e `params` é `{}`.

Um clique num `<a href="/projects/p1/threads/t1">` dentro da janela também navega: o core intercepta links da própria origem e chama `navigate`, como o `<Link>` do React Router. Links para outras origens seguem a política atual do Electron.

```ts
const navigation = services.use(NavigationV1);

navigation.navigate(`/projects/${projectId}/threads/${threadId}`);
navigation.navigate('/', { replace: true });
navigation.back();
```

## O outlet: `<core-outlet>`

Sim, existe outlet, e ele é um Web Component do core, não um componente React. Ele faz o papel do `<Outlet>` do React Router:

1. O bootstrap da janela põe um `<core-outlet>` como conteúdo do `body`. Esse é o outlet de topo.
2. O roteador encontra a rota cujo `path` casa com `location.pathname`. Segmentos fixos vencem parâmetros, então `/settings/git` casa com a rota `/settings/git` antes de qualquer `/:x/:y`.
3. Seguindo `parent`, o roteador monta a cadeia da raiz até a rota casada. Para `/projects/p1/threads/t1`, a cadeia é `/` → `/projects/:projectId/threads/:threadId`. Se o pai não estiver registrado (o bundle dele não está na composição), a cadeia começa na própria rota, que aparece direto no outlet de topo.
4. O outlet de topo mostra o elemento da primeira rota da cadeia (`<layout-workspace>`). Dentro dele, o `<core-outlet>` que o layout pôs no seu template mostra o elemento da rota seguinte (`<chat-view>`), e assim por diante. Cada `<core-outlet>`, ao conectar, procura o `<core-outlet>` ancestral mais próximo, atravessando shadow roots (sobe por `getRootNode().host` quando chega à raiz de um shadow root), então o outlet também funciona dentro de Shadow DOM. Se não houver, ele é o de topo e mostra a primeira rota da cadeia. Se houver, mostra a rota seguinte à que o ancestral mostra. Um outlet sem rota seguinte fica vazio.
5. Quando a rota ativa é o próprio pai (path `/`), o outlet de dentro dele fica vazio. O pai decide o que mostrar nesse caso, como o "No thread selected" do workspace atual.

```text
URL: doric://app/projects/p1/threads/t1

<body>
  <core-outlet>                                  ← outlet de topo, criado pelo bootstrap
    <layout-workspace>                           ← rota "/" (layout)
      … sidebar, header, regiões …
      <core-outlet>                              ← outlet que o layout pôs no template
        <chat-view> (projectId="p1", threadId="t1")   ← rota filha (chat)
```

A cada navegação, cada outlet compara a rota que mostra com a nova:

- **mesma rota, parâmetros diferentes** (outra Thread): o outlet faz `Object.assign(elemento, params)` no elemento existente, sem recriá-lo, e o elemento reage à mudança das propriedades. Por isso as props do elemento de rota têm os mesmos nomes dos segmentos `:nome`;
- **outra rota**: o outlet chama `ui.dispose` no elemento antigo e `create` da nova rota;
- **path sem rota**: o outlet mostra `<core-not-found>` com o path. Se o bundle dono da rota estiver em quarentena, a rota não está registrada e o outlet também mostra `<core-not-found>`. A URL fica como está, para que a janela volte ao lugar certo quando o bundle voltar.

O outlet mostra uma view por vez. Manter várias views vivas, como abas, é decisão do elemento pai: o [layout](./layout.md) guarda os elementos das abas que cria, e o outlet não participa disso.

## Abrir um path numa janela

Uma janela é uma chave mais um path. O core abre as suas janelas e outros bundles pedem janelas por `windows/v1` ([janelas abertas pelo core](./windows.md)):

```ts
// git, client/commands.ts
import { z } from 'zod';
import { defineCommand, WindowsV1 } from 'bundle/contracts';

export const openComparisonCommand = defineCommand({
  id: 'git.open-comparison/v1',
  input: z.object({ threadId: z.string(), repository: z.string() }).strict(),
  execute: async ({ threadId, repository }, call, services) => {
    await services.use(WindowsV1).open(
      {
        key: `diff:${threadId}:${repository}`,
        path: `/git/diff/${threadId}/${encodeURIComponent(repository)}`,
      },
      call,
    );
  },
});
```

- O main carrega `doric://app` com o path pedido. O handler do [protocolo `doric://`](./doric-protocol.md) responde a shell para qualquer path que não seja arquivo de `/platform/`, `/bundles/` ou `/schemas/`, então recarregar a janela mantém a rota.
- Se a chave já estiver aberta, `open` foca a janela e, quando o path é outro, navega nela.
- O main guarda o último path de cada chave e reabre a janela nele.
- Os dados da janela vão no path. Não há `input` separado.

## Elemento React

Um elemento escrito em React observa a rota com `useSyncExternalStore`, porque `current` devolve a mesma referência até a próxima navegação:

```tsx
import { useSyncExternalStore } from 'react';

// navigation = this.services.use(NavigationV1), lido pelo Web Component e passado ao React
type Navigation = {
  current(): { params: Record<string, string> };
  subscribe(listener: () => void): () => void;
};

function ThreadTitle({ navigation }: { navigation: Navigation }) {
  const route = useSyncExternalStore(navigation.subscribe, navigation.current);
  return <span>{route.params.threadId ?? 'No thread selected'}</span>;
}
```

Nenhum bundle precisa importar o React Router. Referência: [React: `useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore).

## Hooks de fechamento

A janela continua com `onCloseHook`, que pode vetar o fechamento, e `onFlushHook`, com prazo fixo definido pela plataforma, de `WindowHooksV1`. A navegação não muda isso; veja [janelas abertas pelo core](./windows.md#hooks-de-fechamento) e [hooks](./hooks.md).

## Relações

- [Bundle core](./core.md): fornece `navigation/v1`, `<core-outlet>`, `ui/v1` e `regions/v1` no client, e explica `ui.create` passo a passo.
- [O bundle layout](./layout.md): registra a rota `/`, o workspace, e põe o `<core-outlet>` onde as rotas filhas aparecem.
- [Janelas abertas pelo core](./windows.md): `open({ key, path })`, a restauração do último path e os hooks de fechamento.
- [Protocolo `doric://`](./doric-protocol.md): a shell servida para qualquer path de rota.
- [O bundle chat](./chat.md): registra `/projects/:projectId/threads/:threadId`.
- [React dentro de Web Components](./react-web-components.md): como um elemento React reage às propriedades que o outlet atribui.
- [Menus nativos e atalhos](./menus-and-keybindings.md): a condição `when` usa o padrão de path da rota ativa.
- [Migração](./migration.md): a seleção antiga persistida vira path uma vez.
