'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isVerifiedNonContentPage } = require('../core/company-document-parser.cjs');

test('YTO annual report exemption is limited to the three visually reviewed pages of the exact original', () => {
  const sourceHash = 'd14fd26f26fff7967b381b808190da9e98f1a7d79dc93f7f56c0929d550a2ed7';
  const document = { sourceHash, pages: 305 };
  const proof = (page, source = document) => ({
    page, text: '', method: 'page-audit', complete: true, numericEligible: false, contentRole: 'non-content',
    classification: { kind: 'decorative-cover', verified: true, basis: 'exact-source-page-audit', ...source,
      page, auditId: 'yto-2025-annual-decorative-20261014' }
  });
  for (let page = 1; page <= document.pages; page++) {
    assert.equal(isVerifiedNonContentPage(proof(page), document), [1, 4, 94].includes(page), `page ${page}`);
  }
  for (const changed of [{ sourceHash: '0'.repeat(64), pages: 305 }, { sourceHash, pages: 304 }]) {
    assert.equal(isVerifiedNonContentPage(proof(1, changed), changed), false);
  }
  assert.equal(isVerifiedNonContentPage({ ...proof(1), numericEligible: true }, document), false);
  const coal = { sourceHash: '63f2a34ff83a7f9e47c654d4f8e27086c3c8b65ccc66789465f722bd329881b2', pages: 283 };
  for (const page of [74, 75, 76, 77, 78, 79]) {
    assert.equal(isVerifiedNonContentPage(proof(page, coal), coal), false, 'scanned audit body cannot inherit cover exemption');
  }
});
