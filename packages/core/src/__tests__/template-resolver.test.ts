import { describe, it, expect } from 'vitest';
import { resolveTemplates, resolveTemplatesInObject } from '../template-resolver.js';

describe('resolveTemplates', () => {
  it('resolves simple dot-path', () => {
    expect(resolveTemplates('Price: {{result.price}}', { result: { price: 9.5 } }))
      .toBe('Price: 9.5');
  });

  it('resolves nested paths', () => {
    expect(resolveTemplates('{{a.b.c}}', { a: { b: { c: 'deep' } } }))
      .toBe('deep');
  });

  it('replaces missing paths with empty string', () => {
    expect(resolveTemplates('{{missing.field}}', { result: {} }))
      .toBe('');
  });

  it('handles null values as empty string', () => {
    expect(resolveTemplates('{{result.val}}', { result: { val: null } }))
      .toBe('');
  });

  it('serializes objects as JSON', () => {
    const ctx = { result: { obj: { a: 1 } } };
    expect(resolveTemplates('{{result.obj}}', ctx))
      .toBe('{"a":1}');
  });

  it('handles multiple placeholders', () => {
    const ctx = { result: { a: 'X', b: 'Y' } };
    expect(resolveTemplates('{{result.a}} and {{result.b}}', ctx))
      .toBe('X and Y');
  });

  it('preserves text without placeholders', () => {
    expect(resolveTemplates('no placeholders here', {}))
      .toBe('no placeholders here');
  });

  it('handles array index access', () => {
    expect(resolveTemplates('{{result.items.0.name}}', { result: { items: [{ name: 'first' }] } }))
      .toBe('first');
  });

  it('handles array length', () => {
    expect(resolveTemplates('{{result.items.length}}', { result: { items: [1, 2, 3] } }))
      .toBe('3');
  });

  it('trims whitespace in paths', () => {
    expect(resolveTemplates('{{ result.x }}', { result: { x: 42 } }))
      .toBe('42');
  });
});

describe('resolveTemplatesInObject', () => {
  it('resolves string values', () => {
    const result = resolveTemplatesInObject(
      { entity: 'switch.{{result.device}}', value: '{{result.state}}' },
      { result: { device: 'wallbox', state: 'on' } },
    );
    expect(result).toEqual({ entity: 'switch.wallbox', value: 'on' });
  });

  it('preserves non-string values', () => {
    const result = resolveTemplatesInObject(
      { count: 5, flag: true, entity: '{{result.name}}' },
      { result: { name: 'test' } },
    );
    expect(result).toEqual({ count: 5, flag: true, entity: 'test' });
  });

  it('resolves nested objects', () => {
    const result = resolveTemplatesInObject(
      { outer: { inner: '{{result.val}}' } },
      { result: { val: 'resolved' } },
    );
    expect(result).toEqual({ outer: { inner: 'resolved' } });
  });

  it('resolves arrays with string elements', () => {
    const result = resolveTemplatesInObject(
      { items: ['{{result.a}}', '{{result.b}}'] },
      { result: { a: 'x', b: 'y' } },
    );
    expect(result).toEqual({ items: ['x', 'y'] });
  });

  it('handles empty object', () => {
    expect(resolveTemplatesInObject({}, { result: {} })).toEqual({});
  });
});
