# Armazenamento genérico e histórico

**Estado:** proposta. Parte da [arquitetura de bundles](../bundles.md); nada aqui descreve comportamento já implementado, e `GROUNDING.md` continua sendo o contrato da implementação atual.

## Resumo

O armazenamento durável do Doric passa a ser dois contratos de serviço. `storage.backend/v1` é o backend, um contrato de cardinalidade `one` fornecido pelo bundle `postgres` por padrão e ativado com a fundação, antes do core, e oferece objetos versionados, streams ordenados e transações sem conhecer Project, Thread ou seus eventos. `storage/v1`, fornecido pelo core por padrão, é a fachada sobre esse backend, que valida os valores com os schemas declarados. Segredos seguem o mesmo molde: `secrets.backend/v1`, também do `postgres` por padrão, guarda envelopes cifrados, e `secrets/v1` do core é a fachada. Os bundles de domínio registram os próprios tipos, com schema zod, índices e migrações, por meio de `defineStorageType`, e continuam donos das operações que interpretam esses dados. O histórico deixa de ser uma coisa só e é dividido entre log autoritativo, estado do provider, contabilidade, projeção da conversa e um cache local descartável. O contrato é desenhado para caber em PostgreSQL, SQLite ou num banco de documentos sem que os bundles saibam qual backend está ativo.

## Os contratos `storage.backend/v1` e `storage/v1`

O antigo papel exclusivo `durableState` passa a ser um contrato de cardinalidade `one`, declarada nas opções de `defineService`: `storage.backend/v1` (`StorageBackendV1`). `bundle/contracts` exporta a referência e o tipo do contrato, como nos demais contratos básicos, e qualquer bundle pode fornecer uma definição com `execute`. O bundle `postgres` a fornece por padrão: escreve `postgresStorage = defineService(StorageBackendV1, { ... })`, com um `defineMethod` por operação, e na ativação chama `services.provide(postgresStorage)`, no lugar de `ctx.roles.provide('durableState', backend)`. Ele implementa um contrato de **objetos versionados, streams ordenados e transações**, sem conhecer o formato de Project, Thread ou seus eventos.

### Fundação e ordem de ativação

No host, o loader ativa primeiro a **fundação**: os bundles escolhidos em `providers` para contratos que o core fornece ou consome. `postgres`, como provedor de `storage.backend/v1` e de `secrets.backend/v1`, é fundação. Bundles da fundação só podem depender de contratos `doric.*`, que são da plataforma, sempre existem e por isso nem precisam entrar em `requires`; assim `postgres` não usa `storage/v1`, `settings/v1`, `log/v1` nem nenhum outro serviço do core. Depois ativa o core, que declara em `requires` apenas `storage.backend/v1` e `secrets.backend/v1`, os contratos que a fundação fornece, e por último os demais bundles, em ordem de dependência.

Se dois bundles habilitados fornecem `storage.backend/v1`, a composição escolhe em `providers` (por exemplo `"providers": { "storage.backend/v1": "postgres" }`), e a escolha vale em cada ambiente em que o bundle escolhido fornece o contrato. Sem escolha, o segundo provedor vai para quarentena com motivo; como a fundação ativa antes, é o backend substituto que vai para quarentena quando a composição não o escolhe.

Os bundles não usam o backend diretamente. O core fornece `storage/v1` (`StorageV1`, cuja referência também vem de `bundle/contracts`, com a definição e os `execute` no core), que substitui o antigo membro `ctx.storage`: uma fachada sobre o `storage.backend/v1` escolhido que identifica tipos e streams pelo ID qualificado e valida os valores com os schemas declarados. Como qualquer contrato sem prefixo `doric.`, `storage/v1` também pode ser fornecido por outro bundle, e a plataforma o lê pelo contrato sem conhecer a implementação. Quando a composição escolhe outro provedor de `storage/v1`, o loader não registra a implementação do core para esse contrato naquele ambiente, e o `services.use(StorageV1)` do próprio core devolve o provedor escolhido. Todo bundle que usa `storage/v1` com `use` o declara em `requires`.

Bundles de domínio registram tipos, schemas, versões, índices de consulta e migrações; também são donos das operações que interpretam esses dados. O `runtime` padrão define Project e Thread no mesmo agregado, pois filiação, terminação, delegação, fila e lease se cruzam. Não há obrigação de um bundle por entidade.

O contexto só com serviços, a escolha de provedores e o objeto `call` estão descritos em [contextos e capacidades](./contexts.md); o que o core fornece está em [core](./core.md).

## Primitivas

| Primitiva do armazenamento        | Garantia necessária para o Doric                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Objeto por tipo e ID qualificados | `get`, `put` e `delete` com revisão esperada; dados desconhecidos permanecem preservados quando o bundle dono está ausente.                   |
| Índice declarado pelo bundle      | Leitura paginada e unicidade onde exigida; recuperação e árvore de Threads não dependem de varrer todos os objetos em memória.                |
| Stream por ID qualificado         | Append com sequência monotônica, leitura por cursor e marca de controle de truncamento; apagar uma cauda não reutiliza sequências.            |
| Transação                         | Atualiza vários objetos, índices e streams de modo atômico, com conflito de escrita detectável; só publica mudanças depois do commit durável. |
| Saúde e admissão de escrita       | Informa indisponibilidade ou pressão de armazenamento antes de iniciar trabalho que não conseguiria registrar.                                |

### Limites do contrato

O backend pode usar JSONB e tabelas auxiliares no PostgreSQL, mas o contrato público não é um `get/put/list` irrestrito nem uma linguagem de consultas SQL disfarçada. O bundle declara apenas as buscas que suas operações precisam. Relações e cascatas, hoje fornecidas pelo esquema relacional, passam a ser invariantes transacionais do domínio ou restrições declaradas ao backend.

Transações não chamam modelo, tool, sandbox ou rede: resultados externos entram em uma segunda operação durável.

## Contrato independente de backend

O contrato precisa caber em PostgreSQL e num banco de documentos, como MongoDB, sem que bundles saibam qual está ativo. Sugestões:

### 1. Commit declarativo em lote

Em vez de uma transação interativa, o bundle lê, calcula e envia um lote com as revisões esperadas. O backend aplica tudo ou nada:

```ts
// dentro de um execute(input, call, services) do runtime:
const storage = services.use(StorageV1);
const { position } = await storage.commit(
  {
    expect: [{ type: 'runtime.thread/v1', id: threadId, revision: 7 }],
    put: [{ type: 'runtime.thread/v1', id: threadId, value: nextThread }],
    append: [
      {
        stream: `runtime.thread.events/${threadId}`,
        expectedSequence: 41,
        events: [event],
      },
    ],
  },
  call,
);
```

O `call` é o último argumento opcional de todo stub: o `call` recebido pela operação em curso ou `{ signal, deadline }`. O dispatcher herda dele `scope`, `signal` e `trace`, mas preenche `call.caller` do salto novo com o bundle que faz a chamada, `{ bundleId, version, generation }`, sem herdá-lo; no exemplo, o `caller` que chega ao `storage/v1` é `runtime`, mesmo que a operação tenha sido pedida por outro bundle. O `caller` serve a diagnóstico e log; a fachada valida o lote e o repassa ao `storage.backend/v1`.

Um conflito de revisão ou de sequência devolve erro tipado, e o dono decide se lê de novo e tenta outra vez. O lote corresponde a uma transação PostgreSQL, a uma transação multi-documento do MongoDB ou a uma transação SQLite. Por construção, nenhum modelo, tool ou rede é chamado dentro da transação, e o lote atravessa fronteiras de processo, o que a opção B de [isolamento por processo](./process-isolation.md) exige. A execução serial por Thread que já existe mantém a contenção baixa.

### 2. Tipos e índices declarados com `defineStorageType`

Cada tipo é definido no entrypoint `contracts/` do bundle dono com `defineStorageType`, do subpath `bundle/contracts`, no mesmo molde das demais funções `define*` descritas em [contratos](./contracts.md). O schema do tipo é escrito em zod; não há JSON Schema escrito à mão nem `$ref` para `schemas/*.json`. Na ativação, o bundle registra cada tipo com `services.use(StorageV1).defineType(...)`; o registro é rastreado pelo loader e desfeito em ordem inversa na desativação.

Pseudocódigo da API proposta:

```ts
// runtime, contracts/storage.ts
import { defineStorageType } from 'bundle/contracts';
import { z } from 'zod';

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

// runtime, na ativação (manifesto com "requires": ["storage/v1@^1.0.0"])
import type { HostContext } from 'bundle/contracts';
import { StorageV1 } from 'bundle/contracts';
import { threadType } from '../contracts/index.js';

export function activate({ services }: HostContext) {
  services.use(StorageV1).defineType(threadType);
}
```

Cada índice tem igualdade nos primeiros campos e intervalo no último, unicidade opcional e paginação por cursor. Os campos de índice são caminhos de propriedade do schema; o backend os converte em JSON Pointer (`/projectId`, `/createdAt`).

Não existe consulta livre. O backend cria a estrutura adequada: índice de expressão sobre JSONB no PostgreSQL ou índice composto no MongoDB.

### 3. Feed de commits

Cada commit recebe uma posição monotônica. A publicação lê o feed depois do commit, o que preserva a regra “commit antes de publicar” e permite retomar do último ponto publicado após uma queda. No PostgreSQL, isso é uma tabela outbox gravada na mesma transação, com `LISTEN/NOTIFY` para acordar o publicador; no MongoDB, change streams.

### 4. Blobs por hash

Saídas grandes de tools e conteúdos de arquivo vão para uma primitiva `blob.put/get`, endereçada por hash e referenciada pelos documentos. Isso mantém documentos e eventos pequenos, o que importa para limites como os 16 MB por documento do MongoDB.

### 5. Capacidades declaradas pelo backend

O backend informa limites como tamanho máximo do lote, do documento e do append. Um kit de conformidade em `packages/storage` roda contra cada backend: concorrência, conflitos, paginação, lacunas de sequência, truncamento, feed e falha de commit.

### 6. Formato canônico de exportação

NDJSON com documentos e revisões, streams com sequências e marcadores de truncamento, e blobs. Trocar de backend passa a ser exportar, importar e verificar contagens e hashes, com execuções paradas.

### 7. Ordem de backends

PostgreSQL com JSONB primeiro, porque já é o backend atual. O segundo backend que prova o contrato genérico deveria ser SQLite, que é embutido e barato de testar, antes de um banco de documentos. MongoDB entra quando houver necessidade real; ele exige replica set para transações e change streams. Bancos com limites rígidos de transação, como os 100 itens do DynamoDB, ficam fora até haver motivo.

### Schemas e versionamento dos tipos

O schema de cada tipo é escrito em zod na definição do tipo; o JSON Schema canônico é gerado dele no build e publicado no catálogo. Os schemas seguem a política de [versionamento semântico](./versioning.md), e a verificação de semver, suspensa até a etapa 11, vai comparar os JSON Schemas gerados. Uma major nova de um tipo exige migração explícita registrada pelo bundle dono.

## Divisão do histórico

O histórico deixa de ser uma coisa só:

| Parte                                                          | Dono na composição padrão                                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Log autoritativo, cursor, fila, rewind e recuperação da Thread | `runtime`, persistido pelos streams e objetos do `storage.backend/v1` de `postgres`, por meio de `storage/v1`       |
| Mensagens preparadas para o provider e checkpoints             | `direct`, como estado opaco e versionado salvo no mesmo backend; o host não conhece `ProviderMessage[]`             |
| Contabilidade que sobrevive ao rewind                          | `usage`, com atualização síncrona na transação do evento ou, até existir essa extensão, co-localizada com o runtime |
| Projeção e renderização da conversa                            | `chat`, que uma conversa alternativa pode substituir na composição                                                  |
| Snapshot local para abertura rápida                            | `history`, opcional e descartável, nunca fonte de verdade; chave por host, geração do storage e Thread              |

A projeção e a renderização da conversa estão em [o bundle chat](./chat.md); a distinção entre histórico do provider e log de eventos está em [eventos e nodes](./events-and-nodes.md).

## Atomicidade atual

Hoje `Thread.messages`, `Thread.checkpoints`, `Thread.usage` e `ThreadEvent` são gravados no mesmo PostgreSQL. `writeEvent` já une sequência, evento, pausa da fila e uso em uma transação; `rewind` também remove a cauda, corta o histórico do provider e checkpoints, preserva a cobrança e grava `history.truncated` de modo atômico. Outras escritas, como o resultado materializado após `prompt.finished`, ainda ocorrem separadamente.

O novo contrato preserva as atomicidades existentes e permite fechar essas lacunas; não pressupõe que toda a execução atual já seja uma transação única. Uma entrega de resultado entre duas Threads requer transação conjunta ou uma outbox durável e idempotente.

## Truncamento e replay

O controle de truncamento pertence ao protocolo de stream: a operação remove a cauda, preserva o contador máximo e grava um marcador com `afterSequence` no mesmo commit. O `runtime` decide quando pode fazer rewind. O leitor antigo de `history.truncated` permanece compatível durante a migração.

Replay combina snapshot e cursor com a assinatura ao vivo sem perder commits concorrentes; lacunas após rewind são válidas. Se faltar o bundle que interpreta um evento necessário à retomada, novas execuções daquela Thread ficam bloqueadas com diagnóstico, embora um cliente ainda possa mostrar o bloco genérico do evento, com tipo, ID, horário e payload.

## Cache local do histórico

Hoje `app/doric/src/workspace/thread-history.ts` grava um JSON por `threadId`, sem saber de qual host ou de qual storage os eventos vieram. Com o host como fonte de verdade e a possibilidade de trocar de backend, `history` usa a chave `<hostId>/<storageGeneration>/<threadId>`.

- `hostId` é um ID estável que o host gera no primeiro boot, guarda no storage e publica no catálogo.
- `storageGeneration` muda quando o backend é migrado ou recriado.
- Um marcador de truncamento com `afterSequence` menor que a última sequência em cache descarta a cauda.
- Um evento cuja major de schema o client não conhece descarta a entrada inteira, que volta a ser preenchida pelo stream.

O `history` roda em `desktopMain` e grava esse cache no diretório de cache próprio que obtém de `doric.cache/v1` (`DoricCacheV1`, de `bundle/contracts`), contrato da plataforma no `desktopMain` que entrega um diretório por bundle. É nesse diretório que ele grava `<hostId>/<storageGeneration>/<threadId>`. O antigo `DesktopContext` entregava esse diretório diretamente; com o contexto reduzido a `services`, ele passa a vir desse contrato (ver [contextos](./contexts.md)). Como `doric.cache/v1` é da plataforma, sempre existe e não entra em `requires`.

O host como fonte de verdade está descrito em [composição e distribuição pelo host](./composition-and-distribution.md).

## Bootstrap, configuração e troca de backend

O provedor de `storage.backend/v1` escolhido é aberto antes da leitura da configuração persistida e antes da recuperação. Uma configuração mínima de bootstrap seleciona esse bundle (a entrada de `providers` da composição), que ativa como fundação antes do core. Valores e schemas do produto podem então ser definidos por bundles, com `defineSettings` (ver [contratos](./contracts.md)), registrados com `services.use(SettingsV1).register(definição)` e guardados nele pelo `settings/v1` do core. Segredos passam por dois contratos, no mesmo molde do storage. `secrets.backend/v1` (`SecretsBackendV1`), de cardinalidade `one`, é fornecido pelo `postgres` por padrão e guarda cada segredo como envelope AES-256-GCM sob `DORIC_CREDENTIAL_KEY`, como o credential store atual do host. `secrets/v1` (`SecretsV1`) do core é a fachada: resolve referências e aplica redação antes do log, como hoje. Para trocar o armazenamento de segredos, outro bundle fornece `secrets.backend/v1`, entra na fundação e é escolhido em `providers` (`"secrets.backend/v1": "<bundle>"`); um bundle também pode substituir a fachada inteira fornecendo `secrets/v1`.

Sem backend ou schema compatível, o host não substitui dados por um histórico vazio. Trocar de backend requer exportação, migração e validação explícitas com execuções paradas.

## Relações

- [Contratos e a família `define*`](./contracts.md): define `defineStorageType`, `defineSettings` e a geração do JSON Schema canônico a partir do zod usados aqui.
- [Contextos e capacidades](./contexts.md): descreve o contexto só com serviços, o objeto `call` e sua propagação, a fundação, a escolha de provedor em `providers` para `storage.backend/v1`, o `storage/v1` pelo qual os bundles registram seus tipos e o `doric.cache/v1` usado pelo `history`.
- [Core](./core.md): fornece `storage/v1`, `settings/v1` e `secrets/v1` como fachadas sobre os backends escolhidos e declara em `requires` só `storage.backend/v1` e `secrets.backend/v1`, fornecidos pela fundação.
- [Versionamento semântico](./versioning.md): fixa as regras de major e migração que os schemas dos tipos de storage seguem.
- [Eventos e nodes](./events-and-nodes.md): define os eventos duráveis gravados nos streams e a separação entre histórico do provider e log de eventos.
- [O bundle chat](./chat.md): é o dono da projeção e da renderização da conversa na divisão do histórico.
- [Isolamento por processo](./process-isolation.md): explica por que o commit em lote precisa atravessar fronteiras de processo.
- [Composição e distribuição pelo host](./composition-and-distribution.md): estabelece o host como fonte de verdade, que motiva a chave do cache local.
- [Divisão das funcionalidades atuais](./feature-split.md): lista `postgres`, `runtime`, `usage` e `history` entre os bundles de destino.
- [Migração em entregas verificáveis](./migration.md): na etapa 2 entram `settings/v1`, `secrets/v1`, `storage/v1` e `events/v1` do core, junto com `postgres` fornecendo `storage.backend/v1` e `secrets.backend/v1` sobre o Prisma atual; a etapa 3 entrega o protocolo genérico de armazenamento e a etapa 7 migra os dados.
