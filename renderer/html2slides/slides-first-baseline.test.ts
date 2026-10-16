// Tests for slides-first-baseline.ts, with numbers measured on the complex fixtures (Chrome at
// 1280 x 720, Google Slides thumbnails at 1600 x 900, 2026-10-16). Each case names the fixture
// element, Chrome's measured first baseline, and how far Google drew that text from it before the
// fix. Run: npx tsx --test renderer/html2slides/slides-first-baseline.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { slidesFirstBaselineOffsetPx, topAnchoredTextPlacement } from "./slides-first-baseline.ts";

test("Google's baseline sits 0.9465 x size below the line top at 100 % and above", () => {
  assert.equal(slidesFirstBaselineOffsetPx({ lineSpacingMultiple: 1, firstLineFontSizePx: 48 }), 0.9465 * 48);
  assert.equal(slidesFirstBaselineOffsetPx({ lineSpacingMultiple: 4 / 3, firstLineFontSizePx: 26 }), 0.9465 * 26);
});

test("below 100 % the line shrinks from its top, lifting the baseline with it", () => {
  assert.equal(slidesFirstBaselineOffsetPx({ lineSpacingMultiple: 0.7, firstLineFontSizePx: 20 }), 0.7 * 0.9465 * 20);
});

test("complex slide_06 .quote-text (Playfair italic 26px, line-height 1.6): inset lowers Google's text 6.4 px", () => {
  // Chrome: box top 215.11, first baseline 246.11. Google drew the quote 6.4 px higher (thumbnail
  // shift probe) with no inset, because it puts the 0.4 em of extra leading below the glyphs.
  const placement = topAnchoredTextPlacement({
    boxTopPx: 215.11,
    boxHeightPx: 125,
    chromeFirstBaselinePx: 246.11,
    lineSpacingMultiple: 41.6 / 26 / 1.2,
    firstLineFontSizePx: 26,
  });
  assert.equal(placement.topPx, 215.11);
  assert.equal(placement.heightPx, 125);
  assert.ok(Math.abs(placement.topInsetPx - 6.39) < 0.01, `inset ${placement.topInsetPx}`);
});

test("complex slide_17 .main-title (Playfair 48px, line-height normal): the family's tall ascent needs 6.6 px", () => {
  // Chrome: box top 255, baseline 307 (Playfair's ascent 52 px). Google: 0.9465 x 48 = 45.43. Measured
  // shift on the thumbnail: Google 6.4 px high.
  const placement = topAnchoredTextPlacement({ boxTopPx: 255, boxHeightPx: 64, chromeFirstBaselinePx: 307, lineSpacingMultiple: 1, firstLineFontSizePx: 48 });
  assert.ok(Math.abs(placement.topInsetPx - 6.568) < 0.001, `inset ${placement.topInsetPx}`);
});

test("complex slide_17 .amount (Inter 72px, line-height 1): spacing below 100 % uses the shrunken offset", () => {
  // Chrome: box top 327, baseline 389. Emitted spacing 72 / 72 / 1.2 = 0.8333.
  const placement = topAnchoredTextPlacement({ boxTopPx: 327, boxHeightPx: 72, chromeFirstBaselinePx: 389, lineSpacingMultiple: 1 / 1.2, firstLineFontSizePx: 72 });
  assert.ok(Math.abs(placement.topInsetPx - (62 - (0.9465 * 72) / 1.2)) < 1e-9, `inset ${placement.topInsetPx}`);
});

test("a baseline higher than Google can reach from the box top moves the box up instead of a negative inset", () => {
  // Line-height 0.8 at 50px: Chrome's baseline is 0.4 + (ascent - descent) / 2 em below the line top,
  // above Google's offset, so the box itself must rise; its bottom edge stays where it was.
  const placement = topAnchoredTextPlacement({ boxTopPx: 100, boxHeightPx: 40, chromeFirstBaselinePx: 130, lineSpacingMultiple: 1, firstLineFontSizePx: 50 });
  const rise = 0.9465 * 50 - 30;
  assert.ok(Math.abs(placement.topPx - (100 - rise)) < 1e-9);
  assert.ok(Math.abs(placement.heightPx - (40 + rise)) < 1e-9);
  assert.equal(placement.topInsetPx, 0);
});
