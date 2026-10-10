// The core's structural elements, as the settings page renders them.
import type { DetailedHTMLProps, HTMLAttributes } from 'react';

type CoreElementProps = DetailedHTMLProps<
  HTMLAttributes<HTMLElement>,
  HTMLElement
>;

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'core-outlet': CoreElementProps;
      'core-region': CoreElementProps & { readonly name: string };
    }
  }
}
