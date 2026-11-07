import { defineComponent } from '@openuidev/react-lang';
import { z } from 'zod';

import Button from '../../../src/Button';

export const AppButton = defineComponent({
  name: 'AppButton',
  description: 'The fixture button.',
  props: z.object({ label: z.string() }),
  component: Button,
});
