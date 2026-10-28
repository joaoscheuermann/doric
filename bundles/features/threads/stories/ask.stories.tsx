// Every state of the ask block (`AskQuestions`), as the approved prototype
// (revision 14) shows them, in the order the reader meets them. Each block
// stays interactive: Send answers it, except the failure state, whose Send
// fails again.

import { useState } from 'react';

import { AskQuestions, type AskQuestionsProps } from '../src/client/ask.js';
import { OTHER, type Picks } from '../src/client/domain/ask.js';

type StoryProps = Omit<AskQuestionsProps, 'onSend'>;

/** A block whose Send answers it, or fails when `failed` is set. */
function Ask(props: StoryProps) {
  const [answered, setAnswered] = useState<Picks | undefined>(props.answered);
  const onSend = (picks: Picks): Promise<void> => {
    if (props.failed)
      return Promise.reject(new Error('The Thread did not take the answers.'));
    setAnswered(picks);
    return Promise.resolve();
  };
  return <AskQuestions {...props} answered={answered} onSend={onSend} />;
}

export default {
  title: 'Threads/Molecules/Ask',
  component: AskQuestions,
  parameters: { layout: 'fullscreen' },
};

/** Spec review, after a stage: the EGM checkpoint. One question. */
const checkpoint: StoryProps = {
  context:
    'Comprehension e Critique: 1 Blocker, 3 Major, 2 Nit. O Blocker: a spec não diz o que acontece se a thread fechar com uma pergunta pendente.',
  questions: [
    {
      id: 'next',
      question: 'Como seguimos com os achados deste estágio?',
      options: [
        {
          label: 'Resolver com o agente',
          description: 'O Spec responde cada achado com CONTEST ou FIX.',
          recommended: true,
        },
        {
          label: 'Prosseguir para o próximo estágio',
          description: 'Os achados ficam abertos até o resumo final.',
        },
        { label: 'Vou editar a spec manualmente' },
        { label: 'Pausar a revisão' },
      ],
    },
  ],
};

/** Brainstorm: the idea is not clear yet, several questions in turn. */
const brainstorm: StoryProps = {
  context:
    'Antes de escrever a spec, preciso fechar três pontos que mudam o desenho.',
  questions: [
    {
      id: 'who',
      question: 'Quem pode chamar a ferramenta de perguntas?',
      options: [
        {
          label: 'Só a thread principal',
          description: 'Subagentes devolvem a dúvida ao coordenador.',
          recommended: true,
        },
        { label: 'Qualquer thread' },
      ],
    },
    {
      id: 'scope',
      question: 'O que entra na primeira versão?',
      multiSelect: true,
      options: [
        { label: 'Escolha única', recommended: true },
        { label: 'Múltipla escolha', recommended: true },
        { label: 'Resposta livre', recommended: true },
        { label: 'Várias perguntas por vez' },
        { label: 'Prazo para responder' },
      ],
    },
    {
      id: 'wait',
      question: 'O que o agente faz até a resposta chegar?',
      options: [
        {
          label: 'Para e espera',
          description: 'A resposta acorda a thread.',
          recommended: true,
        },
        { label: 'Continua o que não depende da resposta' },
      ],
    },
  ],
};

/** Triage in doubt: the route, with no free answer. */
const triage: StoryProps = {
  context:
    'A mudança toca só bundles/desktop/chat, mas altera o tipo exportado ComposerItem, usado por 2 bundles.',
  questions: [
    {
      id: 'route',
      question: 'Qual rota seguimos?',
      allowOther: false,
      options: [
        { label: 'Grande — spec revisada antes do código', recommended: true },
        { label: 'Pequena — direto ao Plan' },
      ],
    },
  ],
};

/** Spec approval: the gate before Plan. */
const approval: StoryProps = {
  context:
    'docs/designs/ask.md passou pelos 4 estágios. Resta 1 questão aberta.',
  questions: [
    {
      id: 'approve',
      question: 'Aprova a spec para começar a implementação?',
      options: [
        { label: 'Aprovar' },
        {
          label: 'Pedir mudanças',
          description:
            'Escreva o que mudar na última linha; volta para o Spec.',
        },
      ],
    },
  ],
};

const who = { picked: ['Só a thread principal'] };
const scope = {
  picked: ['Escolha única', 'Múltipla escolha', 'Resposta livre'],
};
const wait = { picked: [OTHER], other: 'Para, mas me avisa por notificação' };

/** Every state of the block, in the order the reader meets them. */
const states: readonly (readonly [string, StoryProps])[] = [
  ['1. Uma pergunta, nada escolhido — Send desabilitado', checkpoint],
  [
    '2. Uma opção escolhida — Send habilitado',
    { ...checkpoint, picked: { next: { picked: ['Resolver com o agente'] } } },
  ],
  [
    '3. Resposta livre digitada no lugar das opções',
    {
      ...approval,
      picked: {
        approve: {
          picked: [OTHER],
          other: 'Aprovo, mas troque o nome do evento para threads.answered/v1',
        },
      },
    },
  ],
  [
    '4. Sem resposta livre, opção escolhida',
    { ...triage, picked: { route: { picked: ['Pequena — direto ao Plan'] } } },
  ],
  ['5. Várias perguntas, 1/3, nada escolhido — Next desabilitado', brainstorm],
  ['6. 1/3 escolhida — Next habilitado', { ...brainstorm, picked: { who } }],
  [
    '7. 2/3, múltipla escolha, nada marcado — Back aparece',
    { ...brainstorm, step: 1, picked: { who } },
  ],
  [
    '8. 2/3, três opções marcadas',
    { ...brainstorm, step: 1, picked: { who, scope } },
  ],
  [
    '9. 3/3, resposta livre — Send habilitado',
    { ...brainstorm, step: 2, picked: { who, scope, wait } },
  ],
  [
    '10. Envio falhou — escolhas mantidas, Send para tentar de novo',
    { ...brainstorm, step: 2, picked: { who, scope, wait }, failed: true },
  ],
  [
    '11. Respondida — resumo',
    { ...brainstorm, answered: { who, scope, wait } },
  ],
  ['12. Substituída por outra pergunta', { ...brainstorm, superseded: true }],
];

/** All the states one after another; each block stays interactive. */
export const AllStates = {
  render: () => (
    <div className="flex flex-col gap-8">
      {states.map(([label, props]) => (
        <div key={label} className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">{label}</p>
          <Ask {...props} />
        </div>
      ))}
    </div>
  ),
};
