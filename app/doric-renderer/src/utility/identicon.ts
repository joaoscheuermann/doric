import { toSvg } from 'jdenticon';

/**
 * How large an identicon is drawn. The mark scales to whatever box holds it, so
 * this only has to be big enough to stay crisp.
 */
const IDENTICON_PX = 24;

/**
 * The mark an identity carries: the same name always draws the same jdenticon,
 * so a reader can recognise their own turns and their prompt by sight.
 */
export const identiconSvg = (name: string): string => toSvg(name, IDENTICON_PX);
