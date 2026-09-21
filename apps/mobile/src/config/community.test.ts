import { expect, test } from '@jest/globals';

import { COMMUNITIES, isCommunityUrl } from './community';

test('a Home publica as duas salas da comunidade, as mesmas do site', () => {
  expect(COMMUNITIES.map(space => space.id)).toEqual(['discord', 'whatsapp']);
  for (const space of COMMUNITIES) expect(isCommunityUrl(space.url)).toBe(true);
});

test('so convite publico por https passa', () => {
  expect(isCommunityUrl('http://discord.gg/Kd4yjB24wP')).toBe(false);
  expect(isCommunityUrl('https://discord.gg.exemplo.com/x')).toBe(false);
  expect(isCommunityUrl('https://chat.whatsapp.com/')).toBe(false);
  expect(isCommunityUrl('javascript:alert(1)')).toBe(false);
  expect(isCommunityUrl('https://exemplo.com/sala')).toBe(false);
  expect(isCommunityUrl('cialai://abrir')).toBe(false);
});
