# React dentro de Web Components

**Estado:** proposta. Parte da [arquitetura de bundles](../bundles.md); nada aqui descreve comportamento já implementado, e `GROUNDING.md` continua sendo o contrato da implementação atual.

## Resumo

Um bundle pode escrever sua UI em React e publicá-la como um Web Component, que é a fronteira pública e estável entre bundles. O elemento recebe propriedades JavaScript do loader e monta uma raiz React própria, com os serviços e o `queryClient` do bundle dono. Quem consome a UI, inclusive outro elemento escrito em React, não importa a classe: obtém `ui/v1` com `services.use(UiV1)`, cria o elemento pela tag com `ui.create` e o libera com `ui.dispose`. Na maior parte dos casos nem isso é preciso, porque o `<core-outlet>` e as regiões criam e descartam os elementos das rotas e dos itens.

**Estado dos exemplos:** pseudocódigo de uma API futura. Os trechos ilustram contratos e ordem de ativação; não são exports já implementados no Doric.

## Ponto de partida atual

Hoje `app/doric-renderer/src/main.tsx` e `settings.tsx` montam duas raízes React fixas. `app/doric-renderer/webpack.config.js` gera duas páginas, enquanto `app/doric/src/main.ts` abre janelas distintas. A seleção de Thread, as abas e as seções de settings vivem em stores ou estado React, sem um roteador.

## Um componente React publicado como Web Component

O bundle `chat` pode continuar escrevendo sua UI em React e publicar `<chat-view>` como fronteira estável. A tag começa com o ID do bundle dono (`chat-`), convenção do `ui/v1` que evita colisão de nomes entre bundles. A classe recebe propriedades JavaScript do loader, inclusive os serviços do bundle dono atribuídos por `ui.create`, e monta uma raiz React própria em Light DOM. Os imports de `react`, `react-dom/client` e `@tanstack/react-query` são resolvidos pelo import map da plataforma (ver [pacotes compartilhados](./platform-packages.md)), então todos os bundles usam a mesma instância de React.

Pseudocódigo da API proposta:

```tsx
import { createContext, useContext } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';
import {
  NavigationV1,
  UiV1,
  type ClientContext,
  type Services,
} from 'bundle/contracts';

// Estado client do bundle `chat`: store, envio de prompt por
// `runtime.threads/v1` e `queryClient`, montados a partir dos serviços
// do próprio bundle.
const ChatState = createContext<ChatClientState | null>(null);

function ChatView(props: { projectId: string; threadId: string }) {
  const state = useContext(ChatState);
  if (state === null) throw new Error('Chat state unavailable');

  return (
    <section aria-label="Conversa">
      <Transcript threadId={props.threadId} store={state.store} />
      <Composer
        projectId={props.projectId}
        threadId={props.threadId}
        threads={state.threads}
      />
    </section>
  );
}

class ChatViewElement extends HTMLElement {
  #root?: Root;
  #state?: ChatClientState;
  #projectId?: string;
  #threadId?: string;

  // Atribuído por `ui.create` antes de o elemento ser conectado.
  set services(value: Services) {
    this.#state = chatClientState(value);
    this.#render();
  }

  set projectId(value: string) {
    this.#projectId = value;
    this.#render();
  }

  set threadId(value: string) {
    this.#threadId = value;
    this.#render();
  }

  connectedCallback() {
    this.#root ??= createRoot(this);
    this.#render();
  }

  disconnectedCallback() {
    queueMicrotask(() => {
      if (!this.isConnected) this.dispose();
    });
  }

  dispose() {
    this.#root?.unmount();
    this.#root = undefined;
  }

  #render() {
    if (!this.#root || !this.#state || !this.#projectId || !this.#threadId) {
      return;
    }

    this.#root.render(
      <QueryClientProvider client={this.#state.queryClient}>
        <ChatState.Provider value={this.#state}>
          <ChatView projectId={this.#projectId} threadId={this.#threadId} />
        </ChatState.Provider>
      </QueryClientProvider>,
    );
  }
}

export function activate({ services }: ClientContext) {
  const ui = services.use(UiV1);
  // A definição e a rota são rastreadas pelo loader e descartadas na
  // desativação.
  ui.define('chat-view', ChatViewElement);

  services.use(NavigationV1).register({
    path: '/projects/:projectId/threads/:threadId',
    parent: '/',
    create: (params) => ui.create('chat-view', params),
  });
}
```

`UiV1`, `NavigationV1` e os tipos `ClientContext` e `Services` vêm de `bundle/contracts`, que exporta as referências e os tipos dos contratos básicos `ui/v1` e `navigation/v1`; o core fornece por padrão as definições com `execute`. A parte client do `chat` declara no manifesto `requires: ['hooks/v1', 'ui/v1', 'navigation/v1', 'commands/v1', 'runtime.threads/v1']`, isto é, todo contrato que o próprio código da parte obtém com `use`, inclusive os básicos `hooks/v1`, `ui/v1`, `navigation/v1` e `commands/v1` (este porque a conversa despacha comandos como `git.open-comparison/v1`), e `provides: ['chat.views/v1', 'chat.lexical/v1', 'chat.hooks/v1']` (o manifesto completo está em [chat](./chat.md)). Contratos `doric.*` não entram em `requires`.

Quando a rota casa, o [`<core-outlet>`](./navigation.md#o-outlet-core-outlet) chama `create` com os parâmetros do path. `ui.create` atribui `services` e depois `projectId` e `threadId` ao elemento, e só então o outlet o conecta ao DOM; por isso os setters acima chegam antes de `connectedCallback`.

### Regras da raiz React do bundle

- `ChatClientState` e seu `queryClient` pertencem ao bundle `chat`, não ao bootstrap. `chatClientState(services)` os monta a partir dos serviços que `ui.create` atribui ao elemento. O dispatcher preenche `call.caller` com o `chat` em cada chamada feita por esses stubs, e `scope.windowKey` com a janela client de onde ela sai.
- Um provider React de outro elemento, como o `<layout-workspace>` em volta, não atravessa esta nova raiz.
- Navegar para outra Thread faz o outlet atribuir o novo `threadId` ao mesmo elemento, que chama `root.render` com a mesma árvore; o bundle decide como manter ou trocar o estado do rascunho por Thread.
- `root.unmount()` limpa os efeitos e assinaturas da árvore.
- O teste `isConnected` evita desmontagem por uma movimentação síncrona no DOM.
- Abas com editor ou terminal ficam montadas e só escondidas quando não estão em foco; quem garante isso são as [abas do layout](./layout.md#7-abas-layouttabsv1).

Referências: [React: `createRoot`](https://react.dev/reference/react-dom/client/createRoot), [MDN: lifecycle de custom elements](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_custom_elements).

## Um elemento React criando o elemento de outro bundle

Rotas e regiões cobrem a maior parte dos casos: o outlet e o `<core-region>` criam os elementos. Quando um componente React precisa pôr o elemento de outro bundle num lugar próprio, ele o cria pela tag com `ui.create`, sem importar a classe. O `div` vazio é um lugar que React deixa para o elemento do outro bundle.

Pseudocódigo da API proposta:

```tsx
import { useEffect, useRef } from 'react';
import { UiV1, type Services } from 'bundle/contracts';

// `services` é o do bundle que escreve este componente, lido em
// `this.services` pelo seu Web Component. O bundle declara `ui/v1` em
// `requires`.
function ChatSlot(props: {
  services: Services;
  projectId: string;
  threadId: string;
}) {
  const region = useRef<HTMLDivElement>(null);
  const element = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const ui = props.services.use(UiV1);
    const view = ui.create('chat-view');
    element.current = view;
    region.current?.replaceChildren(view);
    return () => {
      element.current = null;
      ui.dispose(view);
    };
  }, [props.services]);

  useEffect(() => {
    if (element.current === null) return;
    Object.assign(element.current, {
      projectId: props.projectId,
      threadId: props.threadId,
    });
  }, [props.services, props.projectId, props.threadId]);

  return <div ref={region} />;
}
```

## `ui.create` e `ui.dispose`

- `ui.create(tag, props?)` cria o elemento pela tag e lhe entrega os serviços do bundle dono antes de devolvê-lo sem conectar; os passos estão em [`ui.create` passo a passo](./core.md#uicreate-passo-a-passo). O consumidor não repassa os próprios serviços, e uma tag sem bundle ativo vira `<core-unavailable>`.
- `ui/v1` é fornecido pelo core no client por padrão e pode ser substituído por outro bundle escolhido em `providers`; nesse caso o loader não registra a implementação do core para `ui/v1` no ambiente `client`, em todas as janelas, e o `services.use(UiV1)` do próprio core devolve o provedor escolhido.
- Para trocar a conversa, a composição substitui o bundle `chat` por outro que registre o mesmo path com o próprio elemento (ver [chat](./chat.md)). Quem precisa funcionar com qualquer conversa navega para o path. Como a tag começa com o ID do dono, `ui.create('chat-view', …)` só continua funcionando se o substituto usar o ID `chat`; com outro ID, devolve `<core-unavailable>`.
- `ui.dispose` remove a view, chama seu descarte uma vez e descarta o que ela registrou pelos serviços. A remoção por si só desmontaria React, mas não liberaria necessariamente o que foi registrado pelos serviços.
- O React 19 também pode renderizar custom elements diretamente, mas usar `ui.create` garante os serviços do bundle dono e evita depender das regras de conversão de props JSX em propriedades de custom elements. [React: custom elements](https://react.dev/reference/react-dom/components#custom-html-elements).

## Relações

- [UI composta por bundles](./ui-composition.md): define Web Components como fronteira pública, o catálogo client de contribuições e as regiões.
- [Pacotes compartilhados e tokens do tema](./platform-packages.md): o import map que garante uma única instância de `react`, `react-dom/client` e `@tanstack/react-query`, e o subpath `bundle/contracts` com a referência `UiV1` e os tipos `ClientContext` e `Services`. `packages/desktop-client` é o runtime client do loader usado por `app/doric-renderer`; bundles não o importam.
- [O bundle chat](./chat.md): dono de `<chat-view>`, de `ChatClientState` e da rota `/projects/:projectId/threads/:threadId`.
- [Bundle core e quarentena](./core.md#ui-no-client): o core fornece `ui/v1`, `navigation/v1`, `<core-outlet>` e `<core-region>` no client.
- [O bundle layout](./layout.md): `<layout-workspace>`, escrito em React do mesmo jeito, com o outlet onde `<chat-view>` aparece.
- [Contextos e capacidades](./contexts.md): o contexto client, só com `services`, e os serviços do bundle dono que `ui.create` atribui e `ui.dispose` revoga.
- [Navegação e rotas](./navigation.md): a rota ativa substitui a seleção por stores atual, e o outlet atribui os parâmetros do path ao elemento.
- [Janelas abertas pelo core](./windows.md): o bootstrap de cada janela no renderer, que substitui as raízes fixas de `main.tsx` e `settings.tsx`.
- [Contratos e a família define\*](./contracts.md): referência da API `define*` para os contratos que a UI consome, como comandos e serviços.
