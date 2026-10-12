# Eventos e nodes

**Estado:** proposta. Parte da [arquitetura de bundles](../bundles.md); nada aqui descreve comportamento já implementado, e `GROUNDING.md` continua sendo o contrato da implementação atual.

## Resumo

Eventos duráveis são o log de replay de uma Thread: o protocolo técnico controla identidade, sequência, horário e publicação, e cada bundle declara os tipos de evento que produz, com schema fechado. O host valida cada evento e o persiste e publica como é. O histórico preparado para o provider continua sendo um registro distinto do log de eventos. Sobre esse log trabalham duas famílias de node: nodes de conversa, que transformam eventos em UI, e nodes de execução de workflow, que transformam dados validados em resultado e próxima transição.

## Eventos duráveis

### Quem controla o quê

O protocolo técnico controla identidade do stream, sequência, horário e publicação após persistência. O `runtime` define o envelope semântico Project/Thread/prompt; outros bundles declaram tipos qualificados e schemas fechados.

O catálogo de eventos é o serviço `events/v1`, fornecido pelo core no ambiente `host` e substituível como qualquer contrato sem prefixo `doric.`. A referência `EventsV1` e o tipo do contrato vêm de `bundle/contracts`, como os dos demais contratos básicos; o core fornece a definição com `execute` (`defineService(EventsV1, { ... })`). O `events/v1` do core persiste o log por meio de `storage/v1`, a fachada do core sobre o `storage.backend/v1` que a fundação fornece (`postgres`, por padrão).

Um bundle declara um tipo de evento com `defineEvent`, no entrypoint `contracts/`, e o registra com `services.use(EventsV1).register(definição)` na ativação; durante uma execução, acrescenta eventos com `append(definição, payload, call)`. Como usa `events/v1` com `use`, o bundle declara `events/v1` em `requires` no manifesto. Pseudocódigo da API proposta:

```ts
// git, contracts/events.ts
import { defineEvent } from 'bundle/contracts';
import { z } from 'zod';

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

export type BranchSwitched = z.infer<typeof branchSwitchedEvent.payload>;

// git, host/index.ts: parte host do bundle, na ativação
import { EventsV1, type Call, type HostContext } from 'bundle/contracts';
import {
  branchSwitchedEvent,
  type BranchSwitched,
} from '../contracts/index.js';

export function activate({ services }: HostContext) {
  const events = services.use(EventsV1);
  events.register(branchSwitchedEvent);

  // num handler, que recebe o `call` de quem chamou o git
  async function onSwitched(payload: BranchSwitched, call: Call) {
    await events.append(branchSwitchedEvent, payload, call);
  }
}
```

O manifesto do exemplo declara o contrato que esse código usa. O trecho abaixo é um recorte que mostra só `id` e `requires`; o manifesto completo, com os campos obrigatórios, está em [manifesto](./manifest.md):

```json
{
  "id": "git",
  "requires": ["events/v1@^1.0.0"]
}
```

O `call` repassado a `append` é o `call` pai: o dispatcher da plataforma herda dele `scope` (Project, Thread, prompt e, quando a chamada original saiu de uma janela client, `windowKey`), `signal` e `trace`. O `call.caller` desse novo salto não é herdado: o dispatcher o preenche com o bundle que faz a chamada, `{ bundleId: 'git', version, generation }`. Assim, no `execute(input, call, services)` de `switchBranch` do git, `call.caller` é quem chamou o git, e no `append` que o git faz em seguida o `caller` visto pelo `events/v1` é `git`. É desse `caller` que vêm `bundleId`, `version` e `generation` dos registros de [observabilidade](./observability.md).

O `type` carrega a major (`/v1`); a versão completa vem de `provides` no manifesto, conforme a política de [versionamento](./versioning.md). O `payload` é um schema zod fechado (`.strict()`); o JSON Schema canônico é gerado dele no build e publicado no catálogo, como descrito em [contratos](./contracts.md).

### Sumidouro registrado pelo dono

`events/v1` tem um sumidouro por provedor. O dono o registra com `sink({ scopeKeys, stream })`: `scopeKeys` são as chaves do escopo de chamada que o evento exige, em ordem fixa, e `stream` é um modelo com `{chave}` para cada uma delas.

- Um `append` cuja chamada não traz uma das chaves é recusado com `invalid_scope`. Sem sumidouro registrado, a recusa é a mesma.
- Um segundo sumidouro é recusado com `registration_conflict`. Uma escrita fora do dono é recusada com `not_owner`.
- O `runtime` registra `projectId`, `threadId` e `promptId` com o stream `runtime.thread.events/{threadId}`. O core não conhece essas chaves, e o formato das linhas e os nomes dos streams são os mesmos de antes.

### Validação

O provedor de `events/v1` valida o evento com o schema registrado e o persiste e publica como é. Eventos não carregam valores de segredo, só referências, que quem precisar do valor resolve por `secrets/v1`.

O replay do log reconstrói projeções e UI a partir de eventos já validados; ele não executa efeitos de runtime, por isso os hooks que produziram efeitos na execução original não são reexecutados.

### Eventos sem projetor ou intérprete

- Um evento sem projetor é exibido num bloco genérico com tipo, ID, horário e payload.
- A ausência de seu intérprete pode bloquear a retomada se ele alterar o estado executável.

O comportamento do armazenamento quando falta o bundle que interpreta um evento necessário à retomada está em [armazenamento](./storage.md).

## Histórico do provider

O histórico preparado para o provider e o log de eventos continuam sendo registros distintos durante esta migração. O Direct já persiste histórico parcial para retomada; uma projeção client do log não substitui esse contrato.

Bundles de executor (provedores de `executor/v1`, como o `direct`) recebem operações para ler e salvar seu estado de histórico, vinculadas à versão usada pela execução e obtidas como serviços no escopo da chamada. O `runtime` coordena checkpoints e interrupção sem conhecer o formato desse estado.

## As duas famílias de node

| Família              | Entrada                              | Saída                         | Dono do ciclo        |
| -------------------- | ------------------------------------ | ----------------------------- | -------------------- |
| Conversa             | Eventos e projeções                  | UI, navegação e ações         | Janela/client bundle |
| Execução de workflow | Dados validados e `call` da execução | Resultado e próxima transição | Executor de workflow |

### Nodes de execução de workflow

O Doric ainda não possui um executor de workflows durável. `packages/state-machine` executa transições locais, mas não guarda checkpoints nem decide retomada após reinício.

Um futuro bundle de workflow pode definir esse executor e registrar seus tipos de node; o `runtime` padrão continua responsável por identidade, fila, cancelamento e histórico da Thread. O workflow fixa ID e versão de cada node utilizado, valida entradas/saídas e define o que acontece após uma interrupção de operação com efeitos externos.

Um node de workflow define:

- ID e versão;
- schemas de entrada/saída;
- configuração;
- portas de saída;
- `execute(input, call, services)`, como numa tool: `services` são os serviços do bundle que registrou o node, ligados no registro; o `execute` obtém capacidades por eles e repassa o `call` recebido aos stubs (por exemplo `services.use(EventsV1).append(definição, payload, call)` ou `services.use(ModelsV1, call.scope).resolve(ref)`), em vez de receber um objeto de capacidades. O bundle do node declara em `requires` os contratos que usa assim (`events/v1`, `models/v1`).

O grafo liga portas a próximos nodes; o executor agenda, valida e registra cada transição. Funcionalidades adicionais de um tipo de node, como ações de inspeção, UI de configuração ou hook de lifecycle, são contribuições registradas para aquele ID, sem exigir que o bundle substitua o executor inteiro. Ações com efeitos externos precisam de uma política explícita de idempotência ou retomada antes de serem repetidas.

### Nodes de conversa

Para a conversa, o serviço `chat.views/v1` reduz o stream a blocos de identidade estável e separa sua renderização por Web Component: a parte `client` de um bundle registra cada renderizador com `registerRenderer({ blockType, elementTag })`, em que `elementTag` leva o prefixo do bundle. O adaptador Lexical padrão recebe o catálogo antes de construir o editor; cards comuns usam um `DecoratorNode` genérico, e somente semânticas de edição especiais registram classes próprias. O contrato de view também cobre permissões de edição, seleção, caret, trail e sincronização, hoje codificadas em switches e conjuntos fechados.

Projetores, renderizadores e o exemplo completo do Git estão em [o bundle chat](./chat.md).

## Relações

- [Contratos e a família define\*](./contracts.md): define `defineEvent` e a geração do JSON Schema canônico a partir do zod usada pelo catálogo de eventos.
- [Versionamento semântico](./versioning.md): fixa as regras de minor, major e upcaster para tipos de evento como `git.branch-switched/v1`.
- [Armazenamento genérico e histórico](./storage.md): persiste o log de eventos, trata truncamento, cache local e o bloqueio de retomada quando falta um intérprete.
- [O bundle chat](./chat.md): fornece `chat.views/v1`, com os projetores e renderizadores que formam os nodes de conversa.
- [Contextos e capacidades](./contexts.md): descreve o `HostContext` só com serviços, o `call` recebido por cada handler, a herança de `scope`, `signal` e `trace` com `caller` preenchido a cada salto, e o contrato `events/v1` do core, com `register` e `append(definição, payload, call)`.
- [O bundle core](./core.md): fornece `events/v1` no ambiente `host`, junto com os demais serviços básicos, e ativa depois da fundação que fornece `storage.backend/v1`.
- [Manifesto](./manifest.md): define `requires`, em que um bundle que acrescenta eventos declara `events/v1`.
- [Observabilidade](./observability.md): usa `call.caller` para marcar os registros com `bundleId`, `version` e `generation`.
- [Hooks e ciclo de vida](./hooks.md): define os hooks `onBeforeNodeHook` e `onAfterNodeHook` do executor de workflow e os hooks da conversa, e aponta para este documento para explicar por que o replay de eventos não reexecuta hooks.
- [UI composta por bundles](./ui-composition.md): explica os Web Components que renderizam os blocos de conversa.
- [Migração em entregas verificáveis](./migration.md): descreve as etapas da migração; o `events/v1` do core entra na etapa 2, junto com `storage/v1` e o `postgres` fornecendo `storage.backend/v1`.
