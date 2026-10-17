# Splash e recuperação

**Estado:** proposta. Parte da [arquitetura de bundles](../bundles.md); nada aqui descreve comportamento já implementado, e `GROUNDING.md` continua sendo o contrato da implementação atual.

## Resumo

O splash e a recuperação são uma única superfície técnica do app (`app/doric`), sem código de bundle. Ela mostra o carregamento da composição e, quando algo falha, oferece as ações para corrigir a composição. Ela não usa nenhum contrato fornecido por bundles, só contratos `doric.*` da plataforma; por isso não depende de nenhum bundle, nem da fundação, nem do core, e funciona mesmo com a fundação ou o core quebrados. As ações que mudam a composição chamam `doric.catalog/v1` no host.

## Uma superfície, sem código de bundle

O splash e a recuperação são **a mesma superfície técnica do app** (`app/doric`), sem código de bundle. Ela usa só `desktop/ui/theme.css` e os tokens em JSON, e funciona mesmo com a fundação ou o core quebrados.

A superfície funciona sem o core porque não usa nenhum contrato fornecido por bundles. Ela não chama `hooks/v1`, `log/v1`, `settings/v1`, `secrets/v1`, `storage/v1`, `ui/v1`, `navigation/v1`, `regions/v1`, `windows/v1`, `menus/v1` nem outro serviço básico, que o core fornece por padrão e que outro bundle pode substituir pela escolha em `providers`. Também não chama `storage.backend/v1` nem `secrets.backend/v1`, que a fundação fornece (o bundle `postgres`, por padrão). Ela fala só com contratos `doric.*` da plataforma, que não aceitam outro provedor e existem antes de qualquer bundle ativar. O que a superfície registra vai para o log próprio da plataforma, independente do core e do provedor de `log/v1`.

Ela não pertence ao core: catálogo, quarentena e diagnóstico são da plataforma (`doric.catalog/v1` e `doric.diagnostics/v1`), porque a recuperação precisa deles justamente quando o core falha. Como o core vira dependência de quase todos os bundles, a falha do core leva a esta superfície. Veja [bundle core e quarentena](./core.md).

### Ordem de ativação e onde cada falha aparece

Em cada ambiente, o loader ativa primeiro a **fundação**: os bundles escolhidos em `providers` para contratos que o core fornece ou consome (por exemplo `myhooks` para `hooks/v1`, `postgres` para `storage.backend/v1` e `secrets.backend/v1`). Bundles da fundação só declaram `requires` de contratos `doric.*`. Depois vem o core, que só pode declarar `requires` de contratos que a fundação fornece (`storage.backend/v1`, `secrets.backend/v1`), e, por último, os demais bundles, em ordem de dependência.

Essa ordem define o que a superfície mostra:

- se um bundle da fundação falha no `activate`, ele vai para quarentena com motivo, como qualquer bundle; quando ele fornece `storage.backend/v1` ou `secrets.backend/v1`, o core fica sem um contrato que exige e não ativa, e a superfície mostra a falha do core;
- se o core falha, quase todos os outros bundles ficam sem dependências; a superfície mostra a falha do core;
- se um bundle comum falha no `activate`, ele vai para quarentena com motivo; a superfície mostra a falha de bundle;
- se um segundo provedor de um contrato de cardinalidade `one` não foi escolhido em `providers`, ele vai para quarentena com motivo. Como a fundação e o core ativam antes, é o bundle substituto que vai para quarentena, e o provedor padrão continua.

Uma falha de handler de um hook do app, como um handler de `onActivateHook` (`observe`), não leva à quarentena nem a esta superfície: só vai ao diagnóstico.

## Estados e ações

| Estado           | Mostra                                              | Ações                                                                                 |
| ---------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Carregando       | Conexão, catálogo, download, verificação e ativação | Nenhuma                                                                               |
| Host inacessível | URL do host, último erro e tentativas               | Tentar de novo; abrir a última composição conhecida, desconectada                     |
| Falha de bundle  | Bundles em quarentena e o motivo de cada um         | Continuar sem eles; desativar um bundle; tentar de novo                               |
| Falha do core    | Erro do core e versão que falhou                    | Usar o último core que ativou com sucesso; voltar à composição padrão; tentar de novo |

## Quando a superfície entra em recuperação

A superfície entra no estado de recuperação em três casos:

- quando o core falha;
- quando nenhuma janela informa prontidão dentro do prazo depois do `onAppReadyHook`;
- quando o usuário inicia o app com `--recovery`.

O `onAppReadyHook` é um hook do app, declarado pela plataforma em `AppHooksV1` (`doric.app.hooks/v1`, importado de `bundle/contracts`). Depois que o provedor de `hooks/v1` de um ambiente ativa (o core, por padrão, ou o bundle da fundação escolhido em `providers`), a plataforma daquele ambiente chama `define(AppHooksV1)` e passa a disparar `execute` nos pontos do ciclo de vida. Qualquer bundle, não só o core, registra handlers com `services.use(HooksV1).use(AppHooksV1).onAppReadyHook(handler)`, declarando `hooks/v1` em `requires`. O prazo de prontidão das janelas é medido pela plataforma, não por esse provedor: se o provedor de `hooks/v1` falha ou não ativa, a superfície entra em recuperação do mesmo jeito. Veja [hooks e ciclo de vida](./hooks.md).

## Ações que mudam a composição

As ações que mudam a composição chamam `doric.catalog/v1` no host, por rota local.

## O último core que ativou com sucesso

O último core que ativou com sucesso fica no cache local e serve para diagnosticar e corrigir a composição, não para trabalhar sobre dados.

## Relações

- [Bundle core e quarentena](./core.md): a quarentena de bundles e a falha do core são os casos que a superfície mostra no estado de recuperação.
- [Composição e distribuição pelo host](./composition-and-distribution.md): descreve o fluxo de conexão, download e verificação que o estado "Carregando" mostra, e a operação desconectada usada quando o host está inacessível.
- [Hooks e ciclo de vida](./hooks.md): define o `onAppReadyHook`, cujo prazo de prontidão das janelas dispara a recuperação.
- [Pacotes compartilhados e tokens do tema](./platform-packages.md): fornece `desktop/ui/theme.css` e os tokens em JSON, a única dependência visual da superfície.
- [Observabilidade e diagnóstico](./observability.md): o diagnóstico da plataforma (`doric.diagnostics/v1`) sustenta o que a superfície mostra sobre as falhas.
- [Manifesto v1](./manifest.md): a validação do manifesto é uma das fontes de falha que levam um bundle à quarentena.
