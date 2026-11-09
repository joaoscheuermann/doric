import { Separator } from '../components/separator.js';

/**
 * The vertical rule between the controls of a horizontal bar. It is shorter than
 * the bar it divides, so it separates the controls rather than the surface, and
 * it asks for its own centring because the separator stretches to its container
 * by default.
 *
 * @deprecated No product surface draws it since the UI redesign (phase 3); kept so bundles built before it keep loading (S35).
 */
export function ToolbarDivider() {
  return (
    <Separator
      orientation="vertical"
      className="h-4 data-vertical:self-center!"
    />
  );
}
