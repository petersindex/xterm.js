/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */
import { assert } from 'chai';
import { PLACEHOLDER, PlaceholderRow, readPlaceholder } from './KittyPlaceholders';

// Diacritics for 0, 1 and 2 from the kitty spec's rowcolumn-diacritics.txt.
const D0 = '̅';
const D1 = '̍';
const D2 = '̎';
const P = String.fromCodePoint(PLACEHOLDER);

describe('KittyPlaceholders', () => {
  describe('readPlaceholder', () => {
    it('ignores a cell that is not the placeholder character', () => {
      assert.strictEqual(readPlaceholder('a'), undefined);
      assert.strictEqual(readPlaceholder(''), undefined);
    });

    it('reads row, column and most significant byte from the diacritics', () => {
      assert.deepStrictEqual(readPlaceholder(P + D1 + D0 + D2), { row: 1, col: 0, msb: 2 });
    });

    it('leaves out what the diacritics leave out', () => {
      assert.deepStrictEqual(readPlaceholder(P + D1), { row: 1, col: undefined, msb: undefined });
      assert.deepStrictEqual(readPlaceholder(P), { row: undefined, col: undefined, msb: undefined });
    });
  });

  describe('PlaceholderRow', () => {
    // The 2x2 example from the spec, image id 42 in 256-colour mode.
    it('resolves fully specified cells to image id, row and column', () => {
      const row = new PlaceholderRow();
      assert.deepStrictEqual(row.next(P + D0 + D0, 42, 0), { imageId: 42, placementId: 0, row: 0, col: 0 });
      assert.deepStrictEqual(row.next(P + D0 + D1, 42, 0), { imageId: 42, placementId: 0, row: 0, col: 1 });
    });

    it('adds the most significant byte from the third diacritic', () => {
      const row = new PlaceholderRow();
      assert.deepStrictEqual(row.next(P + D1 + D1 + D2, 42, 0), { imageId: 42 + (2 << 24), placementId: 0, row: 1, col: 1 });
    });

    // The spec's 2 rows by 3 columns example: only the first cell carries a row.
    it('infers the missing column and byte from the cell to the left', () => {
      const row = new PlaceholderRow();
      assert.deepStrictEqual(row.next(P + D1, 42, 0), { imageId: 42, placementId: 0, row: 1, col: 0 });
      assert.deepStrictEqual(row.next(P, 42, 0), { imageId: 42, placementId: 0, row: 1, col: 1 });
      assert.deepStrictEqual(row.next(P, 42, 0), { imageId: 42, placementId: 0, row: 1, col: 2 });
    });

    it('does not infer across a different image or a gap', () => {
      const row = new PlaceholderRow();
      row.next(P + D0 + D0, 42, 0);
      assert.deepStrictEqual(row.next(P, 43, 0), { imageId: 43, placementId: 0, row: 0, col: 0 });
      row.next('x', 0, 0);
      assert.deepStrictEqual(row.next(P, 43, 0), { imageId: 43, placementId: 0, row: 0, col: 0 });
    });
  });
});
