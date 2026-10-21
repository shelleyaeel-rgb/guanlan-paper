const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { CompanyDocumentParser, documentCheckpoint } = require('../core/company-document-parser.cjs');

const hash = value => createHash('sha256').update(value).digest('hex');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name));
const legacyOcr = page => {
  const text = 'Previously completed OCR remains available until the original native text is verified.';
  return { page, text, method: 'ocr', confidence: 96, complete: true, numericEligible: false,
    tableLike: false, characters: text.length, textHash: hash(text),
    issues: ['text-layer-replaced: text-garbled: original private-use checkbox could not be decoded'],
    nativeReauditFromVersion: '3' };
};

test('legacy completed OCR is promoted only after the current native parser verifies the real source page', async () => {
  const bytes = fixture('company-native-embedded-checkboxes.pdf'), progress = [];
  let calls = 0;
  const parser = new CompanyDocumentParser({ recognize: () => { calls++; throw Error('completed OCR must not repeat'); } });
  try {
    const baseline = await parser.parse(bytes), rows = [legacyOcr(1), legacyOcr(2)];
    const resume = documentCheckpoint(hash(bytes), 2, rows, 'parse-retry');
    const result = await parser.parse(bytes, { resume, maxChars: baseline.pageTexts.reduce((sum, row) => sum + row.characters, 0),
      onProgress: value => progress.push(value) });
    assert.equal(result.complete, true); assert.equal(result.numericEligible, true); assert.equal(calls, 0);
    assert.deepEqual(result.pageTexts, baseline.pageTexts);
    assert.ok(result.pageTexts.every(row => !row.nativeReauditFromVersion && row.method === 'pdf-text'));
    assert.ok(progress.every(value => value.completed === undefined || value.completed <= 2));
    assert.equal(result.pageTexts.flatMap(row => row.verifiedCheckboxes).length, 7);
  } finally { await parser.destroy(); }
});

test('an unvisited legacy native re-audit marker survives checkpoint serialization and resumes exactly once', async () => {
  const bytes = fixture('company-native-embedded-checkboxes.pdf');
  const parser = new CompanyDocumentParser({ recognize: () => { throw Error('completed OCR must not repeat'); } });
  try {
    const baseline = await parser.parse(bytes), rows = [legacyOcr(1), legacyOcr(2)];
    const resume = documentCheckpoint(hash(bytes), 2, rows, 'parse-retry');
    const limited = await parser.parse(bytes, { resume, maxChars: baseline.pageTexts[0].characters + rows[1].characters });
    assert.equal(limited.complete, false); assert.equal(limited.numericEligible, false);
    assert.equal(limited.pageTexts[0].method, 'pdf-text');
    assert.equal(limited.pageTexts[1].nativeReauditFromVersion, '3');
    const saved = JSON.parse(JSON.stringify(documentCheckpoint(hash(bytes), 2, limited.pageTexts, 'parse-timeout')));
    assert.equal(saved.complete, false); assert.deepEqual(saved.missingPages, []);
    assert.equal(saved.pageTexts[1].nativeReauditFromVersion, '3');
    const parsed = [], result = await parser.parse(bytes, { resume: saved, onProgress: value => {
      if (value.stage === 'parsed') parsed.push(value.page);
    } });
    assert.equal(result.complete, true); assert.deepEqual(result.pageTexts, baseline.pageTexts);
    assert.deepEqual(parsed, [2]);
  } finally { await parser.destroy(); }
});

test('native re-audit keeps completed OCR when a genuine scanned body still needs it and never repeats recognition', async () => {
  const bytes = fixture('company-mixed-audit-pages.pdf'); let calls = 0;
  const parser = new CompanyDocumentParser({ recognize: () => { calls++; return { data: {
    text: 'The original scanned audit page was previously recognized and still requires human verification.', confidence: 96 } }; } });
  try {
    const baseline = await parser.parse(bytes); assert.equal(calls, 2);
    const rows = structuredClone(baseline.pageTexts);
    rows[1].nativeReauditFromVersion = '3';
    rows[1].issues.push('text-layer-replaced: text-garbled: original native layer was unusable');
    const expected = structuredClone(rows); delete expected[1].nativeReauditFromVersion;
    const parsed = [], resume = documentCheckpoint(hash(bytes), 4, rows, 'parse-retry');
    const result = await parser.parse(bytes, { resume, onProgress: value => {
      if (value.stage === 'parsed') parsed.push(value.page);
    } });
    assert.equal(calls, 2); assert.equal(result.complete, true); assert.equal(result.numericEligible, false);
    assert.deepEqual(result.pageTexts, expected); assert.deepEqual(parsed, [2]);
  } finally { await parser.destroy(); }
});

test('native re-audit markers cannot authorize invalid version, native-page, confidence or reason combinations', async () => {
  const bytes = fixture('company-native-embedded-checkboxes.pdf');
  const parser = new CompanyDocumentParser({ recognize: () => { throw Error('invalid metadata must not invoke OCR'); } });
  try {
    const baseline = await parser.parse(bytes), valid = documentCheckpoint(hash(bytes), 2, [legacyOcr(1), legacyOcr(2)], 'parse-retry');
    for (const mutate of [
      value => { value.pageTexts[0].nativeReauditFromVersion = '4'; },
      value => { value.pageTexts[0].nativeReauditFromVersion = true; },
      value => { value.pageTexts[0].issues = ['text-layer-replaced: text-insufficient: scanned source']; },
      value => { value.pageTexts[0].confidence = 30; },
      value => { value.pageTexts[0] = { ...baseline.pageTexts[0], nativeReauditFromVersion: '3' };
        value.text = value.pageTexts.map(row => row.text).join('\n\n'); }
    ]) {
      const invalid = structuredClone(valid); mutate(invalid);
      await assert.rejects(parser.parse(bytes, { resume: invalid }), error => error.code === 'invalid-checkpoint');
    }
    const unmarked = structuredClone(valid); unmarked.pageTexts.forEach(row => { delete row.nativeReauditFromVersion; });
    const parsed = [], result = await parser.parse(bytes, { resume: unmarked, onProgress: value => {
      if (value.stage === 'parsed') parsed.push(value.page);
    } });
    assert.equal(result.complete, true); assert.equal(result.numericEligible, false);
    assert.deepEqual(result.pageTexts, unmarked.pageTexts); assert.deepEqual(parsed, []);
  } finally { await parser.destroy(); }
});
