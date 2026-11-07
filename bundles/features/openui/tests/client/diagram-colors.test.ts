// FT16 (openui-diagrams.md F7; G3 a): every color of a diagram is a Doric
// token or an sRGB mix of `--foreground` over `--background`, so it is
// computed exactly from the tokens of each variant. Text reads at 4.5 : 1 on
// every fill it sits on; node strokes and edges stand out at 3 : 1 on the
// background and on every group fill, in light and in dark. A token that
// stops being hex fails the test.

import './support/dom.js';

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { resolvedVariables, tokens } from 'desktop/ui';

import {
  type ColorRole,
  type ColorValue,
  cssColor,
  DIAGRAM_COLORS,
} from '../../src/client/diagram/colors.js';
import { closeWindow } from './support/dom.js';

after(closeWindow);

type Rgb = readonly [number, number, number];

const HEX = /^#([0-9a-f]{6})$/i;

const hex = (
  variables: Readonly<Record<string, string>>,
  token: string,
): Rgb => {
  const value = variables[`--${token}`];
  const match = HEX.exec(value ?? '');
  assert.ok(match !== null, `--${token} is a 6-digit hex color: ${value}`);
  const digits = match[1] as string;
  return [0, 2, 4].map((at) =>
    Number.parseInt(digits.slice(at, at + 2), 16),
  ) as unknown as Rgb;
};

/** The color a value resolves to: a token, or foreground mixed over background in gamma-encoded sRGB. */
const resolve = (
  variables: Readonly<Record<string, string>>,
  value: ColorValue,
): Rgb => {
  if ('token' in value) return hex(variables, value.token);
  assert.ok(value.mix >= 0 && value.mix <= 100, `mix ${value.mix}`);
  const foreground = hex(variables, 'foreground');
  const background = hex(variables, 'background');
  const p = value.mix / 100;
  return foreground.map(
    (channel, i) => channel * p + (background[i] as number) * (1 - p),
  ) as unknown as Rgb;
};

/** WCAG 2 relative luminance of an 8-bit sRGB color. */
const luminance = (color: Rgb): number => {
  const [r, g, b] = color.map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as unknown as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a: Rgb, b: Rgb): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
};

const ROLES: readonly ColorRole[] = [
  'nodeFill',
  'nodeStroke',
  'nodeText',
  'edge',
  'edgeText',
  'labelPlate',
  'group1',
  'group2',
  'group3',
  'group4',
  'groupStroke',
  'groupText',
];
const GROUP_FILLS: readonly ColorRole[] = [
  'group1',
  'group2',
  'group3',
  'group4',
];

test('every role is a token or a mix, written as its CSS color', () => {
  for (const role of ROLES) {
    const value = DIAGRAM_COLORS[role];
    assert.ok(value !== undefined, role);
    assert.equal(
      cssColor(value),
      'token' in value
        ? `var(--${value.token})`
        : `color-mix(in srgb, var(--foreground) ${value.mix}%, var(--background))`,
      role,
    );
  }
});

for (const variant of ['light', 'dark'] as const) {
  test(`${variant}: every role resolves to a hex token or an sRGB mix of two`, () => {
    const variables = resolvedVariables(tokens, variant);
    for (const role of ROLES) {
      const color = resolve(variables, DIAGRAM_COLORS[role]);
      assert.ok(
        color.every((channel) => channel >= 0 && channel <= 255),
        role,
      );
    }
  });

  test(`${variant}: node, edge and group text read at 4.5 : 1 on every fill they sit on`, () => {
    const variables = resolvedVariables(tokens, variant);
    const color = (role: ColorRole) => resolve(variables, DIAGRAM_COLORS[role]);
    const pairs: [ColorRole, ColorRole][] = [
      ['nodeText', 'nodeFill'],
      ['edgeText', 'labelPlate'],
      ...GROUP_FILLS.map((fill): [ColorRole, ColorRole] => ['groupText', fill]),
    ];

    for (const [text, fill] of pairs) {
      const ratio = contrast(color(text), color(fill));
      assert.ok(ratio >= 4.5, `${text} on ${fill}: ${ratio.toFixed(2)} : 1`);
    }
  });

  test(`${variant}: node strokes and edges stand out at 3 : 1 on the background and every group fill`, () => {
    const variables = resolvedVariables(tokens, variant);
    const color = (role: ColorRole) => resolve(variables, DIAGRAM_COLORS[role]);
    const background = hex(variables, 'background');

    for (const line of ['nodeStroke', 'edge'] as const) {
      const onBackground = contrast(color(line), background);
      assert.ok(
        onBackground >= 3,
        `${line} on the background: ${onBackground.toFixed(2)} : 1`,
      );
      for (const fill of GROUP_FILLS) {
        const ratio = contrast(color(line), color(fill));
        assert.ok(ratio >= 3, `${line} on ${fill}: ${ratio.toFixed(2)} : 1`);
      }
    }
  });
}
