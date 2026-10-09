import { describe, expect, it } from 'vitest';
import { looksLikeContactDetail } from './people';

describe('looksLikeContactDetail', () => {
  it('catches e-mail addresses, phone numbers and links', () => {
    for (const text of [
      'anna@oplane.example',
      'call +46 70 123 45 67',
      'https://linkedin.com/in/anna',
      'www.anna.example',
    ])
      expect(looksLikeContactDetail(text)).toBe(true);
  });

  it('leaves names and titles alone, years and short numbers included', () => {
    for (const text of ['Anna Svensson', 'Co-founder and CEO', 'Head of Sales EMEA', 'CEO since 2021', 'VP, Region 3'])
      expect(looksLikeContactDetail(text)).toBe(false);
  });
});
