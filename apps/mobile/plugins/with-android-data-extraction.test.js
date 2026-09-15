import { expect, test } from '@jest/globals';

import dataExtractionPlugin from './with-android-data-extraction.cjs';

const { applyDataExtractionRules, DATA_EXTRACTION_RULES_XML } = dataExtractionPlugin;

test('keeps the in-process Tor state out of cloud backup and device transfer', () => {
  for (const section of ['cloud-backup', 'device-transfer']) {
    const block = DATA_EXTRACTION_RULES_XML.split(`<${section}>`)[1]?.split(`</${section}>`)[0] ?? '';
    expect(block).toContain('<exclude domain="root" path="app_TorService/" />');
  }

  const manifest = { manifest: { $: {}, application: [{ $: { 'android:name': '.MainApplication' } }] } };
  applyDataExtractionRules(manifest);
  expect(manifest.manifest.application[0]?.$['android:dataExtractionRules']).toBe('@xml/data_extraction_rules');
});
