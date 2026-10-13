# Context compaction

**Estado:** implementado em `feat/context-compaction`. Este documento descreve o comportamento implementado e o plano que o guiou; `GROUNDING.md` segue sendo o contrato de validade, e a seção "Critérios de feature completa" lista o que "completa" significa nesta landing.

## Resumo

Context compaction é a condensação do histórico antigo de uma Thread em uma única mensagem-resumo: o histórico provider-ready (`direct.history/v1`) é reescrito para manter o resumo no lugar do trecho antigo, a cauda recente fica intacta, e a conversa continua como se o resumo sempre estivesse lá. O conteúdo condensado não se perde: os eventos da Thread permanecem no log e a conversa na UI continua renderizando o feed completo, agora com uma marcação do ponto de compactação.

O plano usa o contrato `dsh-compaction` do DeepSeek (`deepseek-ai/deepseek-harness`, `packages/compaction`) como referência de vocabulário e garantias — bracket log-only, superfície mutada uma única vez, bordas seguras de tool-pairing, marker estável — traduzido para as peças que o doric já tem.

## Tradução do modelo DeepSeek para o doric

O DeepSeek descreve um *seam* (`ctx.compaction`) sobre uma sessão cuja superfície visível ao modelo é derivada por replay de um log de eventos. No doric a relação é invertida e mais simples:

- o **log de eventos** da Thread (stream `runtime.thread.events/<threadId>`) é o registro completo — é o que a UI renderiza;
- a **superfície do modelo** é o histórico provider-ready armazenado, `direct.history/v1` (partes `messages` + `meta`), opaco ao `runtime` e propriedade do executor `direct`.

Logo, o equivalente doric do `surfaceOp: replace` é a **reescrita da parte `messages`** (mais o re-base da parte `meta`), gravada através da mesma `PromptSession` que todo o resto do executor usa — que já garante commit-antes-de-publicar, redação, e o retry de storage-pause.

| DeepSeek `dsh-compaction` | doric |
|---|---|
| `CompactionEngine` (seam abstrato em `ctx.compaction`) | método `compact` do seam `executor/v1`; a política vive no executor `direct` |
| Log de sessão + `deriveMessages()` | log de eventos da Thread (UI) + parte `messages` de `direct.history/v1` (modelo) |
| `compaction/start` log-only (o bracket é a trava) | evento `compaction.started` gravado **antes** de qualquer reescrita; o par `started`/`finished` é o bracket |
| `compaction/summary` log-only + um `user/message` com `surfaceOp` | evento `compaction.finished` (com resultado) no mesmo `record()` que grava o patch de histórico |
| `compaction/end` libera a trava | incluído no `compaction.finished` (um evento, um commit) |
| `compaction/summary-error` + `ManualCompactionError` com `code` fechado | falha pós-bracket grava `compaction.failed` com `code` de conjunto fechado; recusas pré-bracket (`busy`, `disabled`, `nothing_to_compact`) não gravam nada |
| `toolPairingBalancedBefore/After(session, seq)` | `safeBoundary(messages, index)`: nenhuma chamada de tool do assistente sem resposta cruzando o corte |
| Marker de checkpoint exportado de subpath Cordis-free | `isCompactionCheckpoint(message)` + constante `checkpointMarker`, sem dependências além de tipos |
| `compactIfNeeded` (pressure/overflow), `compactNow`, `compactRegion` | `maybeCompact` (automático), `compactThread` (on-demand, condensa tudo condensável), sem `compactRegion` explícito (deferido) |
| `tokenMeter` serviço separado | `UsageMetadata` dos eventos de provider + `contextWindow` de `response.started`/catálogo; projeção estimada, sem serviço novo |
| `/compact` (comando humano) | `POST /threads/:id/compact` (transport) → `runtime` service → executor; recusa `busy` |
| backend `compaction-basic` (sumário escrito pelo modelo) | summarizer do `direct`: mesmo `models/v1` da execução, signal propagado, saída em Markdown legível |
| tool-result pruner, image offload | **não** nesta landing (limitações conhecidas) |

Diferenças deliberadas:

- **Trava por estado do runner, não por inspeção do log.** O DeepSeek detecta bracket órfão reescaneando o log; no doric, um prompt run por Thread já é serializado pelo runner (queue + `thread.active`), e o compact on-demand exige Thread ociosa sob o lock de mutação do projeto. O bracket no log continua existindo, como evidência e marca de UI, e uma `compaction.started` sem `finished` no log é sinal legível de execução interrompida.
- **Ordem de gravação.** DeepSeek grava `start` → resumo → superfície → `end`. O doric grava `compaction.started` (evento), depois **um único** `record()` com o patch de histórico + `compaction.finished`. Um crash entre os dois deixa o bracket aberto no log e o histórico **intacto** — mesma garantia do DeepSeek, com o histórico como documento único e não replay.
- **Rewind.** O DeepSeek não tem rewind; o doric tem. Checkpoints de prompts cuja fronteira caiu dentro do trecho condensado são descartados: rewind para esses prompts passa a responder `unknown_prompt` (o resumo não se des-faz). Checkpoints sobreviventes são re-baseados pelo delta de mensagens removidas.

## Contrato implementado

### Marker de checkpoint

A mensagem-resumo é uma mensagem de papel `user` cujo conteúdo começa com a linha estável `checkpointMarker` (constante exportada, `isCompactionCheckpoint` reconhece). O marker é texto, sobrevive a persistência, serialização e providers, e segue as regras de prompt humano-legível (HC-010).

### Eventos (log-only para a superfície)

- `compaction.started` — payload `{ trigger: 'automatic' | 'manual' }`.
- `compaction.finished` — payload `{ summaryId, condensedMessages, retainedMessages, tokensFreed, summaryChars }`.
- `compaction.failed` — payload `{ code }`, apenas para falha **após** o bracket abrir.

Códigos fechados: `summarizer_failed`, `unsafe_boundary` (falha inesperada pós-seleção). Recusas pré-bracket não gravam evento: `busy`, `disabled`, `nothing_to_compact`, `missing_history`.

### Bordas seguras

Um corte entre mensagens `i` e `i+1` é seguro quando nenhuma chamada de tool do assistente fica com o pedido de um lado e a resposta do outro. O fim do trecho condensado é a maior borda segura que respeita a cauda mínima (`tailMinMessages`); se a cauda exigida não encontra borda segura, não se condensa (limitação herdada do DeepSeek: unidade indivisível não se divide).

### Gatilho automático

Depois de cada `response.finished`/`usage` de um run, o executor projeta a próxima chamada:

- `contextWindow` conhecido (evento `response.started` ou catálogo): `projected = últimoInputTokens + últimoOutputTokens + promptPendenteEstimado`; pressão quando `projected / contextWindow ≥ pressurePercent` (default 80).
- `contextWindow` desconhecido: projeção por caracteres (`≈ tokens = chars/4`) contra `pressurePercent` do teto configurável `charBudget` (default 200_000).

Em ambos os casos `tokensFreed` é estimativa e o resultado o diz. Quando a projeção indica pressão mas não há trecho condensável que libere o suficiente, a compactação não roda (limitação conhecida: overflow de unidade única fora de contrato, como no DeepSeek).

### Gatilho manual

`POST /threads/:id/compact`: Thread ociosa → `executor.compact` condensa todo o trecho condensável até a maior borda segura acima da cauda mínima. Thread com run ativo ou jobs na fila → recusa `busy` sem gravar nada (espelha o `rewind`). Delegated threads usam o mesmo caminho, porque compartilham o executor.

### Overflow do provider

Quando o provider falha com erro classificado como estouro de contexto (heurística textual documentada em `isContextOverflow`, via evento `error` do stream ou a exceção da run), o executor roda a compactação de emergência do histórico — `force: true`, sem depender da projeção — para que a próxima retomada comece condensada, e deixa o erro do run se propagar como hoje. O retry do turno dentro da mesma run ainda não existe (limitação declarada).

## Fases implementadas

1. **Núcleo puro** (`bundles/runtime/direct/src/host/compaction/`): `markers`, `boundaries`, `rewrite` (seleção de span, re-base de checkpoints, meta), `project` (projeção de pressão), `summarize` (backend), `compact` (orquestração com bracket e códigos). Testes unitários para cada uma.
2. **Contrato** (`bundles/runtime/runtime/src/contracts/executor.ts`): método `compact` do `Executor` (entrada: `thread`, `session`, `policy`; saída fechada) — o `runtime` continua sem conhecer `llms`.
3. **Executor automático** (`bundles/runtime/direct/src/host/executor.ts`): captura de `usage`/`contextWindow` no stream, verificação de pressão após gravar o estado do turno, compactação entre turnos, e interceptação de overflow.
4. **On-demand** (`runtime` services/runner/domain + `transport`): rota `POST /threads/:id/compact`, recusa `busy`, sessão sintética com `promptId` próprio, publicação dos eventos.
5. **Configuração** (`bundles/foundation/host-config`): seção opcional `contextCompaction` com defaults; leitura pelo executor.
6. **UI** (`bundles/desktop/chat`): projeção do bracket como um turno `compaction` próprio (linha discreta, estilo lifecycle), read-only e indeletável.
7. **Documentação e validade**: este documento, `GROUNDING.md` (seções de eventos e persistência de sessão), e testes.

## Critérios de feature completa nesta landing

A feature está completa quando **todos** estes itens são verificáveis no repositório:

1. Compactação automática condensa o histórico entre turnos de um run quando a pressão projetada cruza o limiar, gravando bracket + patch em dois `session.record()` no padrão do executor.
2. `POST /threads/:id/compact` condensa on-demand em Thread ociosa e recusa `busy`/`missing`/`inactive` sem gravar eventos.
3. O resumo é reconhecível por marker estável e nunca divide um par tool-call/result.
4. Checkpoints são re-baseados; rewind para prompt cuja fronteira foi condensada responde `unknown_prompt`.
5. Os três tipos de evento existem no log com payloads fechados e a UI renderiza o bracket como turno próprio.
6. Config `contextCompaction` (enabled, pressurePercent, tailMinMessages, summaryMaxChars, charBudget) com defaults seguros; desabilitada, nada compacta.
7. Testes: núcleo puro, re-base/rewind, marker, bordas, projeção, summarizer (fake provider), executor automático (stream fake), service/runner (recusas), UI projector.
8. `GROUNDING.md` e este documento coerentes com o código; lint e testes dos pacotes afetados passando.

## Limitações conhecidas (herdadas e declaradas)

- Comando humano via surface de settings/slash não existe; o gatilho manual é a rota HTTP do workspace (a arquitetura de slash-commands está fora do escopo atual do repositório).
- Sem `compactRegion` com faixa explícita (DeepSeek também o mantém fora do comando humano).
- Sem tool-result pruner nem image offload; unidade indivisível maior que a janela não é condensável.
- Sem retry in-run do turno após overflow; a compactação de emergência prepara a próxima retomada.
- O envelope que sozinho se aproxima da janela (system prompt, tools) não é trabalho de compactação de superfície — igual ao DeepSeek.
