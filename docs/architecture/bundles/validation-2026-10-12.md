# Validação da integração de bundles — 2026-10-12

## Resultado

A migração e a revisão da fronteira foram integradas, incluindo credenciais
extensíveis, configuração e transporte como bundles instalados, exposição
declarada na ponte, agrupamento dos diretórios e recuperação do sandbox Docker.
Os defeitos encontrados no E2E foram corrigidos e os cenários afetados repetidos.

| Verificação                                                  | Resultado                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Typecheck do workspace                                       | 47 projetos aprovados                                                                             |
| Build do workspace                                           | 48 projetos aprovados                                                                             |
| Testes do workspace com PostgreSQL e Docker                  | 48 projetos verificados; três falhas iniciais corrigidas e os três projetos repetidos com sucesso |
| PostgreSQL real, incluindo migração das credenciais          | 110/110                                                                                           |
| Sandbox Docker, incluindo reanexação e troca de configuração | 60 testes aprovados                                                                               |
| Aplicação Electron, testes unitários após as correções       | 108/108                                                                                           |
| Integração com Electron real                                 | 42/42                                                                                             |
| E2E de API                                                   | 21/21                                                                                             |
| E2E da interface por CDP                                     | 18/18, consolidando a execução completa e as correções pontuais                                   |
| Navegação, janelas, recuperação e composição                 | 8/8                                                                                               |
| Reinício do host com SSH, normal e abrupto                   | Mesmo contêiner, um sandbox por Project, arquivo preservado e terminal operacional                |
| Nx sync, formatação, lint e whitespace do diff               | Aprovados                                                                                         |

A gravação opcional de uma nova fixture do adaptador antigo não foi habilitada
na suíte do workspace. Os testes de banco e sandbox foram executados com suas
flags habilitadas.

## Imagem Docker

Tag: `doric-host:boundary-final`.

Image ID:
`sha256:2799f4c6dfbc543300dbaf81d5b4be12ad5c866a7c83353f986e4388c9094072`.

Build final:

```sh
DOCKER_BUILDKIT=0 docker build --network host -f agents/doric/.Dockerfile --target docker-runtime -t doric-host:boundary-final .
```

A imagem compila e distribui as partes host, desktop e client dos bundles.
A rede do host foi usada após timeouts do registry npm no ambiente Docker.
A imagem final foi iniciada na stack isolada e forneceu os bundles dos
cenários de interface repetidos. A stack de uso normal não foi substituída.

## Defeitos corrigidos durante a validação

- Catálogo distribuído descartava `optional` e `desktopScope`.
- Serviços desktop de notificações e histórico não declaravam exposição.
- Chat não declarava o histórico como dependência opcional.
- Serviço genérico de migração de armazenamento não era anunciado ao processo
  da geração desktop. O teste de regressão falhou antes da correção.
- Saída do app não aguardava a gravação da última rota. A rota anterior podia
  reaparecer ao abrir o app novamente.
- Caminhos de fixtures e provedores de teste ainda refletiam a disposição
  anterior dos pacotes.

O cache de histórico foi observado no disco durante o CDP. Notificações foram
verificadas para Thread observada, Thread não selecionada e janela sem foco.
A seleção e a conversa foram verificadas depois de fechar e reabrir o app.

## Comparação com o baseline

Baseline: `eda9171`, com o ajuste do endereço do host usado pelo harness.

- API: 20 snapshots normalizados idênticos. O restante difere somente pela
  porta do modelo falso, `3310` versus `3313`, dentro de um fragmento de
  argumentos de streaming.
- Interface: os 16 cenários aprovados na execução completa tiveram snapshots
  estruturais idênticos; o de notificações também ficou idêntico após a correção.
- O cenário de persistência passou após a correção. Seu snapshot contém um
  prompt adicional porque o cenário de notificações foi repetido sobre o mesmo
  estado. A diferença está na conversa e na entrada correspondente da trilha;
  os demais campos do snapshot coincidem. O snapshot original foi preservado.
- A comparação de pixels foi inspecionada. Nas capturas comuns, os desvios
  ficaram entre 0% e 0,257%, envolvendo cor aleatória do Project, medições de
  recursos e tooltip. Ela é evidência complementar às verificações de
  conteúdo, papéis acessíveis e interação.
- O probe de terminal passou a observar um sandbox após reinício, contra dois
  no baseline. Esta é a correção de duplicação aprovada pelo usuário.

Foi feita uma execução completa ao final da integração. Depois dela, foram
repetidos apenas os cenários afetados e verificações direcionadas; não foram
enfraquecidas as asserções nem substituído o baseline.

## Evidências locais

O harness e os snapshots estão no scratchpad da sessão:
`d9356596-617b-42da-9431-4460753976c9/scratchpad/e2e-boundary-final`.

- `final-evidence.json`: resultado consolidado, com as fontes dos cenários.
- `snapshots/boundary-final`: execução completa de API, interface e etapa 9.
- `snapshots/boundary-corrections`: notificações e persistência após correção.
- `snapshots/boundary-terminal/probe-term.json`: recuperação com SSH.
- `/tmp/doric-final-docker6.log`: build da imagem final.
- `/tmp/doric-final-tests2.log` e `/tmp/doric-final-tests-fixed.log`: execução
  ampla e repetição dos projetos corrigidos.
- `/tmp/doric-final-electron2.log`: integração Electron.
- `/tmp/doric-final-ui-corrections3.log`: cenários corrigidos.

Instalação externa de bundles e verificação contra versões publicadas continuam
adiadas, conforme decisão anterior do usuário; não faziam parte das
funcionalidades existentes usadas como referência.
