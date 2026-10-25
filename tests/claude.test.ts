import { describe, it, expect } from 'vitest';
import { cleanSchema } from '../src/claude.js';

describe('cleanSchema', () => {
  it('drops keywords structured outputs reject and keeps the rest', () => {
    const out = cleanSchema({
      type: 'object',
      additionalProperties: false,
      required: ['a'],
      properties: {
        a: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', enum: ['x', 'minItems'], maxLength: 3 } },
        n: { type: 'integer', minimum: 0 },
      },
    });
    expect(out).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['a'],
      properties: { a: { type: 'array', items: { type: 'string', enum: ['x', 'minItems'] } }, n: { type: 'integer' } },
    });
  });
});
