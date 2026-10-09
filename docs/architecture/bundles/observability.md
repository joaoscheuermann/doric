# Observabilidade e diagnóstico

**Estado:** proposta. Parte da [arquitetura de bundles](../bundles.md); nada aqui descreve comportamento já implementado, e `GROUNDING.md` continua sendo o contrato da implementação atual.

## Resumo

Com dezenas de bundles em três ambientes, um erro precisa apontar o bundle, a versão, a geração e a chamada que o causou. A plataforma oferece cinco mecanismos para isso: log estruturado por bundle, rastreio W3C propagado pelo envelope de serviço, métricas de ativação, contratos, hooks e cache, o serviço de diagnóstico `doric.diagnostics/v1` e saída em arquivos de log rotativos. Cada etapa da migração entrega a observabilidade do que extrai.

## Mecanismos

### Log estruturado

O log de um bundle é o contrato `log/v1`, de cardinalidade `one`, fornecido pelo core por padrão e substituível como qualquer contrato sem prefixo `doric.`: a composição escolhe outro provedor em `providers`, e a escolha vale em cada ambiente em que esse bundle fornece `log/v1`; nos outros ambientes o core continua como provedor (ver [composição e distribuição](./composition-and-distribution.md)). A referência `LogV1` vem de `bundle/contracts`, como as dos outros contratos básicos, o provedor escolhido fornece a definição com `execute`, e o bundle que usa o log declara `log/v1` em `requires` (ver [manifesto](./manifest.md)).

O bundle obtém o logger com `const log = services.use(LogV1)` na ativação; um `execute` (de método, comando ou tool) ou um handler de hook usa `services.use(LogV1, call.scope)` para que cada linha leve o escopo da chamada (ver [hooks](./hooks.md) e [contextos](./contexts.md)).

```ts
import { LogV1, type HostContext } from 'bundle/contracts';

export const activate = ({ services }: HostContext) => {
  const log = services.use(LogV1);
  log.info('ativado');
};
```

Os campos `bundleId`, `version` e `generation` vêm de `call.caller`, que o dispatcher da plataforma preenche, nunca o bundle. `call.caller` é sempre o bundle que faz aquele salto e nunca é herdado do `call` pai: quando o git, no `execute` de `switchBranch`, grava um evento repassando `call`, a linha de log de `events/v1` registra `git` como chamador, enquanto `scope`, `signal` e `trace` vêm do pai (ver [contextos](./contexts.md)). O campo `environment` vem do processo em que roda o provedor de `log/v1`; os IDs de escopo (Project, Thread, prompt, janela) vêm de `call.scope`, e o dispatcher preenche `scope.windowKey` em toda chamada que sai de uma janela client. A redação de segredos é aplicada na fronteira, como hoje: a fachada `secrets/v1` do core aplica a redação antes de qualquer linha chegar ao log e nunca lista credenciais (ver [armazenamento](./storage.md)).

### Log da plataforma

A plataforma tem log próprio, independente do core e do provedor de `log/v1`, para registrar o que acontece antes de existir um provedor de `log/v1` ou sem ele, já que catálogo, diagnóstico, splash e recuperação precisam funcionar sem o core (ver [bundle core e quarentena](./core.md)). O que a superfície de splash e recuperação registra vai para esse log (ver [splash e recuperação](./splash-and-recovery.md)).

### Rastreio

O envelope de serviço carrega `traceparent` no formato W3C, propagado entre renderer, main, host e processos de geração (ver [serviços e canais](./services-and-channels.md) e o envelope RPC em [isolamento por processo](./process-isolation.md)). Cada chamada carrega o trace em `call.trace`. Um evento durável gravado com `services.use(EventsV1).append(definição, payload, call)` guarda em `causedBy` o ID do trace dessa chamada.

### Métricas

As métricas cobrem:

- duração de ativação por bundle, separada por fase (fundação, core, demais bundles);
- contagem, latência e erros por método de contrato (cada método definido com `defineMethod` dentro de um `defineService`; ver [contratos](./contracts.md)), inclusive os contratos básicos, como `hooks/v1`, `settings/v1` e `storage/v1`, e os contratos da fundação, como `storage.backend/v1` e `secrets.backend/v1`, qualquer que seja o provedor escolhido;
- duração e estouro de prazo de hooks, isto é, do prazo padrão do provedor de `hooks/v1`;
- quarentenas;
- acertos do cache, inclusive o uso do diretório por bundle que `doric.cache/v1` entrega no `desktopMain`;
- bytes baixados no splash.

### Diagnóstico

`doric.diagnostics/v1` é um serviço da plataforma, não de um bundle, e não aceita outro provedor. Ele funciona sem o core, porque o diagnóstico precisa explicar justamente uma falha do core. Ele expõe:

- o catálogo e a geração ativos;
- bundles em quarentena, com motivo, inclusive a falha do `activate` e o segundo provedor de um contrato de cardinalidade `one` quando a composição não escolheu nenhum em `providers`; como a fundação e o core ativam antes, o bundle que aparece em quarentena nesse caso é o substituto (ver [core e quarentena](./core.md));
- Threads bloqueadas, com motivo;
- erros recentes por bundle.

A superfície de recuperação do app mostra esses dados (ver [splash e recuperação](./splash-and-recovery.md)). Como os outros serviços do host, `doric.diagnostics/v1` não vira rota de rede automaticamente.

Um handler de hook que falha ou passa do prazo padrão do provedor de `hooks/v1` é ignorado, a cadeia segue como se ele não existisse e a falha vai ao diagnóstico; a regra vale para os três `kind` (ver [hooks](./hooks.md)). Isso inclui os handlers de `onActivateHook` de `AppHooksV1`, que a plataforma de cada ambiente define e dispara depois que o provedor de `hooks/v1` ativa: uma falha desse handler só vai ao diagnóstico, enquanto uma falha do `activate` de um bundle leva à quarentena.

### Saída

Os logs são gravados em arquivos rotativos no diretório do host e em `userData` no desktop. Um exportador OpenTelemetry fica como evolução opcional.

## Entrega durante a migração

Cada etapa da migração entrega a observabilidade do que extrai: a primeira traz o log da plataforma, o log estruturado por `log/v1` (que o core passa a fornecer nessa etapa, junto com `hooks/v1`, `tools/v1` e `skills/v1`), o rastreio no dispatcher e o diagnóstico do catálogo; a segunda acrescenta as métricas de `settings/v1`, `secrets/v1`, `storage/v1` e `events/v1` do core e dos backends do `postgres`; e as seguintes acrescentam as métricas das partes extraídas. As etapas estão em [migração](./migration.md).

## Relações

- [Contextos e capacidades](./contexts.md): define o contexto só com `services`, o `call` com `caller` e `scope` que o log acrescenta, a propagação de `call` entre saltos e o contrato `log/v1`.
- [Serviços entre bundles e canais de mensagens](./services-and-channels.md): o envelope de serviço carrega o `traceparent`.
- [Isolamento por processo](./process-isolation.md): o rastreio atravessa os processos de geração pelo envelope RPC descrito ali.
- [Hooks e ciclo de vida](./hooks.md): o prazo padrão do provedor de `hooks/v1` produz as métricas de prazo, e os handlers ignorados por falha ou prazo geram os registros no diagnóstico.
- [Contratos e a família define\*](./contracts.md): os métodos e hooks medidos são os definidos com `defineMethod` e `defineHook`.
- [Bundle core e quarentena](./core.md): o core fornece `log/v1` por padrão; a ordem fundação, core e demais bundles define as fases de ativação medidas; as quarentenas aparecem nas métricas e no diagnóstico com motivo.
- [Composição e distribuição](./composition-and-distribution.md): `providers` escolhe por ambiente o provedor de `log/v1` e dos contratos da fundação.
- [Armazenamento](./storage.md): a fachada `secrets/v1` aplica a redação antes do log.
- [Splash e recuperação](./splash-and-recovery.md): a superfície de recuperação mostra os dados de `doric.diagnostics/v1` e o splash gera a métrica de bytes baixados.
- [Migração em entregas verificáveis](./migration.md): cada etapa entrega a observabilidade da parte que extrai.
