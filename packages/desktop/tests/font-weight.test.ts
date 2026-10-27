/**
 * The desktop/ui weight policy: running text is light (300), and every label
 * and every title is normal (400). No component reaches for a heavier weight,
 * so a label or a title stands out by its size and colour, not its weight.
 *
 * The components resolve through the package's export map, so this exercises
 * the artifact the windows load; the source scan covers every component file,
 * including the parts that only render inside an open menu or list.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Alert, AlertTitle } from 'desktop/ui/alert';
import { AlertDialog, AlertDialogTitle } from 'desktop/ui/alert-dialog';
import { Badge } from 'desktop/ui/badge';
import { Button } from 'desktop/ui/button';
import { Dialog, DialogTitle } from 'desktop/ui/dialog';
import { Empty, EmptyTitle } from 'desktop/ui/empty';
import {
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldTitle,
} from 'desktop/ui/field';
import { Input } from 'desktop/ui/input';
import { InputGroupAddon } from 'desktop/ui/input-group';
import { Kbd } from 'desktop/ui/kbd';
import { Label } from 'desktop/ui/label';
import { Popover, PopoverTitle } from 'desktop/ui/popover';
import { Progress, ProgressLabel } from 'desktop/ui/progress';
import { Sheet, SheetTitle } from 'desktop/ui/sheet';
import {
  SidebarGroupLabel,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarScope,
} from 'desktop/ui/sidebar';
import {
  Table,
  TableBody,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from 'desktop/ui/table';
import { Tabs, TabsList, TabsTrigger } from 'desktop/ui/tabs';
import { Toggle } from 'desktop/ui/toggle';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const componentsDir = join(packageRoot, 'src/components');

/** The class names of the element marked `data-slot="<slot>"` in the markup. */
const slotClasses = (element: ReactElement, slot: string): string[] => {
  const markup = renderToStaticMarkup(element);
  const tag = new RegExp(`<[a-z0-9]+[^>]*data-slot="${slot}"[^>]*>`).exec(
    markup,
  )?.[0];
  assert.ok(tag, `no data-slot="${slot}" element in ${markup}`);
  return (/class="([^"]*)"/.exec(tag)?.[1] ?? '').split(' ');
};

/** Asserts that a label or a title is set in the normal weight. */
const assertNormal = (name: string, classes: readonly string[]) => {
  assert.ok(
    classes.includes('font-normal'),
    `${name} should be font-normal: ${classes.join(' ')}`,
  );
  assert.ok(
    !classes.includes('font-medium'),
    `${name} should not be font-medium`,
  );
};

/** Asserts that running text is set in the light weight. */
const assertLight = (name: string, classes: readonly string[]) => {
  assert.ok(
    classes.includes('font-light'),
    `${name} should be font-light: ${classes.join(' ')}`,
  );
  assert.ok(
    !classes.includes('font-normal'),
    `${name} should not be font-normal`,
  );
};

const h = createElement;

describe('desktop/ui font weights', () => {
  test('labels are set in the normal weight', () => {
    const labels: readonly [string, ReactElement, string][] = [
      ['Label', h(Label, null, 'Name'), 'label'],
      ['FieldLabel', h(FieldLabel, null, 'Name'), 'field-label'],
      ['FieldLegend', h(FieldLegend, null, 'Profile'), 'field-legend'],
      ['FieldTitle', h(FieldTitle, null, 'Name'), 'field-label'],
      [
        'TableHead',
        h(
          Table,
          null,
          h(TableHeader, null, h(TableRow, null, h(TableHead, null, 'Name'))),
        ),
        'table-head',
      ],
      [
        'TableFooter',
        h(
          Table,
          null,
          h(TableBody, null),
          h(TableFooter, null, h(TableRow, null)),
        ),
        'table-footer',
      ],
      ['Badge', h(Badge, null, 'New'), 'badge'],
      ['Kbd', h(Kbd, null, '⌘K'), 'kbd'],
      ['InputGroupAddon', h(InputGroupAddon, null, '@'), 'input-group-addon'],
      [
        'SidebarGroupLabel',
        h(SidebarGroupLabel, null, 'Projects'),
        'sidebar-group-label',
      ],
      [
        'SidebarMenuBadge',
        h(SidebarMenuBadge, null, '3'),
        'sidebar-menu-badge',
      ],
      [
        'ProgressLabel',
        h(Progress, { value: 50 }, h(ProgressLabel, null, 'Upload')),
        'progress-label',
      ],
      [
        'TabsTrigger',
        h(
          Tabs,
          { defaultValue: 'one' },
          h(TabsList, null, h(TabsTrigger, { value: 'one' }, 'One')),
        ),
        'tabs-trigger',
      ],
    ];
    for (const [name, element, slot] of labels) {
      assertNormal(name, slotClasses(element, slot));
    }
  });

  test('controls label themselves in the normal weight', () => {
    assertNormal('Button', slotClasses(h(Button, null, 'Save'), 'button'));
    assertNormal('Toggle', slotClasses(h(Toggle, null, 'Bold'), 'toggle'));

    const file = slotClasses(h(Input, { type: 'file' }), 'input');
    assert.ok(file.includes('file:font-normal'), file.join(' '));
    assert.ok(!file.includes('file:font-medium'));
  });

  test('the active sidebar row keeps the normal weight', () => {
    const classes = slotClasses(
      h(SidebarScope, null, h(SidebarMenuButton, { isActive: true }, 'Home')),
      'sidebar-menu-button',
    );
    assert.ok(classes.includes('data-active:font-normal'), classes.join(' '));
    assert.ok(!classes.includes('data-active:font-medium'));
  });

  test('titles are set in the normal weight', () => {
    const titles: readonly [string, ReactElement, string][] = [
      [
        'DialogTitle',
        h(Dialog, { open: true }, h(DialogTitle, null, 'Title')),
        'dialog-title',
      ],
      [
        'AlertDialogTitle',
        h(AlertDialog, { open: true }, h(AlertDialogTitle, null, 'Title')),
        'alert-dialog-title',
      ],
      [
        'SheetTitle',
        h(Sheet, { open: true }, h(SheetTitle, null, 'Title')),
        'sheet-title',
      ],
      [
        'PopoverTitle',
        h(Popover, { open: true }, h(PopoverTitle, null, 'Title')),
        'popover-title',
      ],
      [
        'AlertTitle',
        h(Alert, null, h(AlertTitle, null, 'Title')),
        'alert-title',
      ],
      [
        'EmptyTitle',
        h(Empty, null, h(EmptyTitle, null, 'Title')),
        'empty-title',
      ],
    ];
    for (const [name, element, slot] of titles) {
      assertNormal(name, slotClasses(element, slot));
    }
  });

  test('descriptions and errors are running text, set light', () => {
    assertLight(
      'FieldDescription',
      slotClasses(h(FieldDescription, null, 'Help'), 'field-description'),
    );
    assertLight(
      'FieldError',
      slotClasses(h(FieldError, null, 'Required'), 'field-error'),
    );
  });

  test('the command group heading is set in the normal weight', () => {
    const source = readFileSync(join(componentsDir, 'command.tsx'), 'utf8');
    assert.ok(source.includes('**:[[cmdk-group-heading]]:font-normal'));
    assert.ok(!source.includes('**:[[cmdk-group-heading]]:font-medium'));
  });

  test('no component uses a weight heavier than normal', () => {
    const heavy: string[] = [];
    for (const file of readdirSync(componentsDir)) {
      if (!file.endsWith('.tsx')) continue;
      const source = readFileSync(join(componentsDir, file), 'utf8');
      for (const match of source.matchAll(/\bfont-(medium|semibold|bold)\b/g)) {
        heavy.push(`${file}: ${match[0]}`);
      }
    }
    assert.deepEqual(heavy, []);
  });
});
