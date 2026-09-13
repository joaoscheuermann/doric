# BenchFlow local

Infraestrutura compartilhada por [Direct](../direct/README.md) e pelo
[MOSAIC atual](../mosaic/README.md). Os runners importam os fluxos dos scripts;
não há dependência do motor antigo de `packages/mosaic`.

## Instalação

Requisitos: Node 22.20+, npm, Git, uv e Docker em execução. Execute na raiz:

```sh
npm ci
npx nx run direct-benchmark:run -- setup
```

O setup instala BenchFlow **0.6.6**, com dependências Python fixadas, em
`benchmarks/harness/.venv`, e baixa SkillsBench no commit
`b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af`. A instalação é compartilhada;
não precisa repeti-la para MOSAIC. Os builds empacotam o agente e as ferramentas
locais para containers Linux x64/arm64. Não há publicação nem conta BenchFlow
necessária. Imagens oficiais podem ter requisitos próprios de CPU, memória e rede.

## Executar algumas tasks

```sh
npx nx run direct-benchmark:run -- list
npx nx run direct-benchmark:run -- oracle --task jax-computing-basics
npx nx run direct-benchmark:run -- prepare --task jax-computing-basics
npx nx run direct-benchmark:run -- run --task jax-computing-basics --yes-paid-run
npx nx run mosaic-benchmark:run -- run --task jax-computing-basics --yes-paid-run
```

`oracle` executa a solução oficial e o verificador; `prepare` monta os assets e
o catálogo. Ambos dispensam modelo. `run` usa `OPENROUTER_API_KEY` do ambiente
ou do `.env` da raiz. Repita `--task` para um subconjunto, por exemplo
`--task jax-computing-basics --task organize-messy-files`. A concorrência é 1.

No macOS, o container acessa o host por `host.docker.internal`; no Linux, o
padrão é `172.17.0.1`. Use `--host-address HOST` se sua rede Docker for diferente.
O gateway abre uma porta efêmera acessível pelos containers; mantenha o comando
rodando durante toda a avaliação.

## Skills e configuração

O catálogo reúne os pacotes de skills de **todas as 87 tasks**, deduplicados por
nome e hash de todos os recursos. Os arquivos ficam em caminhos neutros dentro
do container. A associação task → skills fica somente no manifesto do host.
BenchFlow roda com `no-skill`, desativando a injeção das skills específicas da
task; cada fluxo usa seu retrieval e gating sobre o catálogo global, com as
skills opcionais de core. Este tratamento mede retrieval; não equivale ao
tratamento oficial de skills fornecidas nem reproduz SkillComposer.

Copie [config.json](src/config.json), ajuste e passe `--config CAMINHO` para
ambos os agentes. O arquivo deve conter o perfil completo. Os padrões preservam
os diagnósticos atuais: `retrievalK: 20`, `topK: 10`, `maxTurns: 20`,
`maxAttempts: 2`. Para comparar top 3 e top 5, altere apenas `topK` entre runs
com as mesmas tasks e modelos. `topK` limita cada ranking rerankeado; a união
entre objetivos pode conter mais skills. O Direct pode buscar novamente durante
a execução. Não interprete esse valor como um limite global de skills por run.

## Resultados e custos

Embeddings são reutilizados automaticamente pelo gateway em
`benchmarks/harness/.cache/embeddings/`, compartilhado por Direct, MOSAIC, tasks
e novas tentativas. A primeira consulta a cada texto usa o provider; as seguintes
reutilizam o vetor salvo. Modelo, dimensões, texto exato e demais parâmetros
fazem parte da chave. Nenhuma chave de API ou texto original entra no arquivo de
cache. Somente embeddings válidos são armazenados; completions e reranking
continuam usando o provider.

Acertos aparecem como `cache: "hit"` no `provider-usage.json`, com zero tokens
e custo novo. O `summary.json` separa `embeddingCacheHits` de `providerCalls`.
O custo original continua no run que preencheu o cache. Arquivos corrompidos
são recalculados. Para forçar atualização, remova o diretório de cache antes
do próximo run, por exemplo se o provider atualizar o modelo mantendo o mesmo
nome. Runs simultâneos com cache frio ainda podem duplicar chamadas.

Isso evita reembeddar o catálogo; consultas com texto novo ainda são cobradas.
Não reduz o custo de gating ou execução e não recupera vetores de runs antigos,
que não foram salvos. Não exige nenhuma flag nova.

Cada aplicação grava `results/<uuid>/`, preservando runs anteriores:

- `manifest.json`: tasks, perfil, catálogo e hash do agente nos runs pagos.
- `catalog-manifest.json`: pacotes, hashes e associações de referência no host.
- `assets/`: agente, ferramentas e catálogo efetivamente preparados.
- `direct/` ou `mosaic/`: resultados oficiais, configuração e `health.json`
  gerados pelo BenchFlow; verifique reward e erros por task.
- `provider-usage.json`: uso bruto retornado pelo provider por chamada.
- `events.jsonl`: eventos persistidos diretamente no host, incluindo rankings,
  decisões de gating, inputs dos estágios, observações, uso e resultado final.
- `summary.json`: status do processo e quantidade de chamadas; não é o score.

`events.jsonl` é a fonte de evidência dos estágios; a exportação ACP do BenchFlow
não preserva os status de retrieval/gating. Cada linha possui `runId`, `agent`,
`sequence`, `at`, `stage` e `data`. `run.started` registra a solicitação para
associar o prompt à task; `run.finished` registra o resultado e as skills
selecionadas. Ausência do evento final indica evidência incompleta.

Nos estágios `retrieval.p0.*` do Direct e `retrieval.p0` do MOSAIC,
`data.ranked` preserva a ordem pós-reranking: o primeiro item é rank 1.
`gate.*`/`gate` registram decisões `keep`/`drop` e justificativas.
Buscas adicionais e routing por nó também são preservados. Cruze os nomes com
`goldSkillIds` no `catalog-manifest.json` para medir cobertura das referências.
O agente aguarda a confirmação de escrita do host em cada evento; uma falha
interrompe a execução. Não há recuperação dos rankings de runs antigos.

O gateway suporta completions, embeddings e
reranking porque os fluxos usam múltiplos modelos. A chave real permanece no
host; o BenchFlow recebe apenas uma credencial efêmera. Seu proxy LiteLLM
obrigatório não recebe a chave real e não é usado pelos fluxos.

A contabilidade do LiteLLM está desligada. Use o arquivo de uso do gateway e os
eventos dos estágios para inspecionar custos; campos ausentes significam
**desconhecido**, nunca custo zero. Estes artefatos ainda não são um relatório
estatístico de comparação. Oracle valida a infraestrutura, não a qualidade dos
agentes. Falhas operacionais e do verificador devem ser separadas de reward zero.

## Validação do adaptador

```sh
npx nx run benchmark-harness:test
```

Os testes não fazem chamadas pagas. Cobrem ACP, gateway, cancelamento e execução
dos fluxos atuais com provider simulado. Resultados históricos do benchmark
antigo foram preservados, mas seu código, campanhas, releases e testes foram
removidos. Não há mecanismo de resume ou migração desses resultados.

Referências: [agentes externos do BenchFlow](https://www.benchflow.ai/docs/benchflow/external-agents)
e [SkillsBench local](https://hub.benchflow.ai/docs/skillsbench/getting-started).
