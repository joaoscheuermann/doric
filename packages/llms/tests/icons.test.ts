import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isModelIconName,
  modelIconSvg,
  modelNameIcon,
  openRouterModelIcon,
} from '../src/index.js';

const iconNames = [
  'claude',
  'deepseek',
  'gemini',
  'gemma',
  'meta',
  'openai',
  'openrouter',
  'qwen',
] as const;

void test('an OpenRouter model wears the icon of the lab its id names, and other labs none', () => {
  const cases = [
    ['anthropic/claude-sonnet-4', 'claude'],
    ['openai/gpt-5', 'openai'],
    ['google/gemini-2.5-pro', 'gemini'],
    ['google/gemma-3-27b-it', 'gemma'],
    ['deepseek/deepseek-chat', 'deepseek'],
    ['qwen/qwen3-coder', 'qwen'],
    ['meta-llama/llama-4-maverick', 'meta'],
    ['mistralai/mistral-large', null],
    ['acme/coder-7b', null],
  ] as const;

  for (const [model, icon] of cases) {
    assert.equal(openRouterModelIcon(model), icon, model);
  }
});

void test('a model name wears the first family whose word it contains, and none otherwise', () => {
  const cases = [
    ['Llama3.2', 'meta'],
    ['codellama', 'meta'],
    ['qwen2.5-coder', 'qwen'],
    ['deepseek-r1-distill-qwen', 'deepseek'],
    ['gemini-pro', 'gemini'],
    ['gemma3:12b', 'gemma'],
    ['gpt-oss:20b', 'openai'],
    ['claude-3', 'claude'],
    ['openrouter-auto', null],
    ['phi4', null],
  ] as const;

  for (const [model, icon] of cases) {
    assert.equal(modelNameIcon(model), icon, model);
  }
});

void test('only the eight icon names are icon names', () => {
  for (const name of iconNames) {
    assert.equal(isModelIconName(name), true, name);
  }
  assert.equal(isModelIconName('anthropic'), false);
  assert.equal(isModelIconName('toString'), false);
});

void test('every icon name has SVG markup the icon schema can carry', () => {
  for (const name of iconNames) {
    const svg = modelIconSvg(name);

    assert.ok(svg.startsWith('<svg'), name);
    assert.ok(svg.length <= 16_384, name);
  }
});
