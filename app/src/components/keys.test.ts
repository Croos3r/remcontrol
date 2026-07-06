import { describe, expect, it } from 'vitest';
import { F_KEYS, MODIFIERS, TAP_KEYS } from './keys';

describe('key constants', () => {
  it('exposes the expected modifier set', () => {
    expect(MODIFIERS).toEqual(['ctrl', 'alt', 'shift', 'super']);
  });

  it('exposes 14 tap keys and 12 F keys with stable ids', () => {
    expect(TAP_KEYS).toHaveLength(14);
    expect(F_KEYS).toHaveLength(12);
    expect(F_KEYS.map((k) => k.id)).toEqual(Array.from({ length: 12 }, (_, i) => `f${i + 1}`));
  });

  it('F key ids cover F1..F12 with no duplicates', () => {
    const ids = F_KEYS.map((k) => k.id);
    expect(new Set(ids).size).toBe(12);
  });

  it('tap key ids are unique', () => {
    const ids = TAP_KEYS.map((k) => k.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
