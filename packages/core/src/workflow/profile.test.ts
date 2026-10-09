import { describe, expect, it } from 'vitest';
import { mentionsDomain, websiteFromLinks, type LinkCandidate } from './profile';

const link = (url: string, anchorText: string, fromDomain = 'tech.eu', fromSourceId = 's1'): LinkCandidate => ({
  url,
  anchorText,
  fromDomain,
  fromSourceId,
});

describe('websiteFromLinks (rule A)', () => {
  it('takes the site an evidence page links under the company name', () => {
    expect(
      websiteFromLinks('Palette', [
        link('https://www.uglyduckling.ventures/', 'Ugly Duckling Ventures'),
        link('https://palette.team/', 'Palette'),
      ]),
    ).toEqual({ url: 'https://palette.team/', domain: 'palette.team', fromSourceId: 's1' });
  });

  it('matches the name as entity resolution does, legal suffix and case aside', () => {
    expect(websiteFromLinks('Retailgrid Oy', [link('https://retailgrid.io/', 'RETAILGRID')])?.domain).toBe(
      'retailgrid.io',
    );
  });

  it('ignores links under other words, to the page’s own site, and to platforms', () => {
    expect(
      websiteFromLinks('Palette', [
        link('https://palette.team/', 'raises €3 million'),
        link('https://tech.eu/tag/palette', 'Palette'),
        link('https://www.linkedin.com/company/palette', 'Palette'),
      ]),
    ).toBeNull();
  });

  it('skips links without text', () => {
    expect(websiteFromLinks('Palette', [{ ...link('https://palette.team/', ''), anchorText: null }])).toBeNull();
  });

  it('gives no website when two different sites are linked under the name', () => {
    expect(
      websiteFromLinks('Palette', [link('https://palette.team/', 'Palette'), link('https://palette.app/', 'Palette')]),
    ).toBeNull();
  });

  it('counts the same site linked twice once', () => {
    expect(
      websiteFromLinks('Palette', [
        link('https://palette.team/', 'Palette'),
        link('https://palette.team/about', 'Palette', 'sifted.eu', 's2'),
      ])?.url,
    ).toBe('https://palette.team/');
  });
});

describe('mentionsDomain (rule B)', () => {
  it('finds the domain written out, whatever its case', () => {
    expect(mentionsDomain('ESTONIA: Display.dev raises €470,000', 'display.dev')).toBe(true);
    expect(mentionsDomain('Visit www.display.dev/pricing.', 'display.dev')).toBe(true);
  });

  it('does not match a longer name that contains it', () => {
    expect(mentionsDomain('notdisplay.dev launched', 'display.dev')).toBe(false);
    expect(mentionsDomain('display.devices are cheap', 'display.dev')).toBe(false);
  });

  it('treats the dot literally', () => {
    expect(mentionsDomain('displayxdev', 'display.dev')).toBe(false);
  });
});
