/**
 * Recovers a page's *structure* from OCR geometry: which lines are chapter
 * titles, which are headings, which are body prose, and which are page
 * furniture (folios and running heads) that should not appear in a transcript
 * at all.
 *
 * WHY GEOMETRY AND NOT WORDING: "A Question of Timing" and "He had arrived
 * early" are indistinguishable as strings — both are ordinary English. What
 * separates them is that one is set 45% larger than the surrounding text. Every
 * distinction this module draws is therefore a measurement, never a guess from
 * vocabulary or capitalisation.
 *
 * This consumes the per-word boxes returned by `windows_ocr.rs`. Frames
 * answered by the vision-model fallback carry no geometry and cannot be
 * analysed here; the pipeline keeps their plain text instead.
 *
 * ASSUMES A CONSTANT CAPTURE SCALE. Body height is measured once across the
 * whole document rather than per page, which is what lets a chapter-opening
 * page — where the title may be the only line present — still be recognised as
 * a title rather than as the page's own idea of "normal size". That trade is
 * correct for a screen recording of a reader at a fixed zoom, and wrong if the
 * zoom level changes mid-recording.
 */

import type { OcrLineBox, OcrPageGeometry } from './ocr';

/**
 * What a line turned out to be.
 *
 *   subheading — a numbered/lettered heading set at body size ("2. Buyer's Breach")
 *   callout    — emphasised text set slightly larger than body (a boxed rule)
 *   listItem   — one entry of a numbered, lettered or bulleted list
 *   sideText   — stray words beside the prose, e.g. text inside a figure
 *   tocEntry   — a table-of-contents line ending in a page reference
 */
export type LineRole =
  | 'title'
  | 'heading'
  | 'subheading'
  | 'body'
  | 'callout'
  | 'listItem'
  | 'tocEntry'
  | 'pageNumber'
  | 'runningHead'
  | 'sideText';

export interface ClassifiedLine extends OcrLineBox {
  role: LineRole;
}

export interface PageStructure {
  lines: ClassifiedLine[];
  /** Folio recovered from this page, if one was found. */
  pageNumber: string | null;
}

/**
 * Height ratios, measured against the document's body height.
 *
 * Calibrated against real output rather than chosen: on a 1000x1400 page the
 * engine returned body at 22px, a section heading at 32px (1.45x) and a
 * chapter title at 40px (1.82x). The thresholds sit in the empty space between
 * those clusters, well clear of both.
 */
const TITLE_RATIO = 1.6;
export const HEADING_RATIO = 1.2;

/**
 * Fraction of page height at the top and bottom treated as margin, where
 * folios and running heads live.
 *
 * The measured folio sat at y=1329 of 1400 — inside the bottom 5%. 8% leaves
 * room for looser layouts without reaching into the text block.
 */
const MARGIN_BAND = 0.08;

/** Longest a margin line can be and still be furniture rather than stray body text. */
const MAX_FURNITURE_WORDS = 8;

/**
 * How far from the page's horizontal centre a line may sit and still count as
 * centred, as a fraction of page width.
 *
 * The measured title spanned 278..720 on a 1000px page — centre 499 against a
 * page centre of 500, so real centring lands well inside this.
 */
const CENTRE_TOLERANCE = 0.06;

/**
 * A new paragraph starts when the vertical gap exceeds this multiple of body
 * height.
 *
 * Measured: consecutive lines within a paragraph were separated by 3–4px
 * against a 22px body height (0.15x), while the gap across a paragraph break
 * was 51px (2.3x). Anything in between is comfortably separated.
 */
const PARAGRAPH_GAP_RATIO = 0.6;

/** Indent, in multiples of body height, that marks a first line even without a gap. */
const INDENT_RATIO = 0.8;

const ROMAN_NUMERAL = /^m*(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i;

/**
 * Height ratio at which a body-width line counts as a callout.
 *
 * Measured on a law textbook: body lines 21px, the italic boxed rule
 * statements 24px (1.14x), bold-italic subheadings 22px (1.05x). The threshold
 * sits between the subheadings and the callouts, and below HEADING_RATIO.
 *
 * A callout's last line can measure at body height when it happens to have no
 * descenders ("Code § 1790.3]." came back at 21px), so the renderer keeps a
 * callout paragraph going across such a line rather than relying on this
 * ratio for every line.
 */
const CALLOUT_RATIO = 1.1;

/**
 * Outline markers that open a subheading: "II.", "A.", "3.".
 *
 * Needed because size alone misses them. In the measured textbook, numbered
 * subheadings are set bold-italic at body size (22px against 21px), so no
 * height threshold separates them from prose without also catching callouts.
 */
const OUTLINE_MARKER = /^(?:[IVXLC]+|[A-Za-z]|\d{1,2})\.\s+\S/;

/**
 * A table-of-contents entry: ends in a page reference, "(p. 441)" or a dot
 * leader run to a number. On a real chapter outline these were merged into
 * run-on paragraphs ("… (p. 441) 4. No Movement of Goods Required (p. 442)")
 * because consecutive entries sit as close together as lines of prose.
 */
const TOC_ENTRY = /(?:\(p{1,2}\.?\s*\d{1,4}(?:\s*[-–]\s*\d{1,4})?\)|\.{3,}\s*\d{1,4})\s*$/;

/** Splits a line holding several entries, after each page reference. */
const TOC_SPLIT = /(?<=\(p{1,2}\.?\s*\d{1,4}(?:\s*[-–]\s*\d{1,4})?\))\s+(?=\S)/;

/** Longest line, in words, still treated as a subheading. */
const SUBHEADING_MAX_WORDS = 12;

/** Widest a subheading may be, as a fraction of the page's widest body line. */
const SUBHEADING_MAX_WIDTH = 0.75;

/** List markers: "1." "1)" "a." "a)" and common bullet glyphs. */
const LIST_MARKER = /^(\d{1,2}[.)]|[A-Za-z][.)]|[•●▪◦·*–-])\s+\S/;

/**
 * Side text: at most this many words, sitting beside (not within) a line of
 * prose, separated from it by at least `SIDE_TEXT_MIN_GAP_RATIO` body heights.
 *
 * This is what text wrapped around a picture looks like when the picture
 * itself contains words. Measured: a word-cloud image beside a wrapped
 * paragraph yielded "uctEA", "customari" and "*3days", each level with a prose
 * line ending 230px to their left.
 *
 * Kept to short fragments next to real prose so a second text column (long
 * lines) is never mistaken for it.
 */
const SIDE_TEXT_MAX_WORDS = 3;
const SIDE_TEXT_NEIGHBOUR_MIN_WORDS = 6;
const SIDE_TEXT_MIN_GAP_RATIO = 2;

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/**
 * Median of `values`, each weighted by the matching entry in `weights`.
 *
 * Weighting matters here. A plain median over line heights is pulled around by
 * how many headings a page happens to carry; weighting by word count lets body
 * prose — which is most of the words on any page — decide what "normal size"
 * means, even on a page that is mostly headings.
 */
function weightedMedian(values: number[], weights: number[]): number {
  if (values.length === 0) return 0;

  const pairs = values
    .map((value, i) => ({ value, weight: weights[i] }))
    .sort((a, b) => a.value - b.value);

  const total = pairs.reduce((sum, p) => sum + p.weight, 0);
  if (total === 0) return pairs[Math.floor(pairs.length / 2)].value;

  let seen = 0;
  for (const p of pairs) {
    seen += p.weight;
    if (seen >= total / 2) return p.value;
  }
  return pairs[pairs.length - 1].value;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Strip surrounding punctuation so `[142]` and `— 142 —` read as folios. */
function folioCandidate(text: string): string | null {
  const bare = text.trim().replace(/^[^\w]+|[^\w]+$/g, '');
  if (!bare) return null;
  if (/^\d{1,4}$/.test(bare)) return bare;
  if (ROMAN_NUMERAL.test(bare) && bare.length <= 7) return bare;
  return null;
}

/**
 * Document-wide facts a single page cannot establish on its own.
 */
export interface StructureContext {
  bodyHeight: number;
  /** Normalised margin-line texts that recur across pages — running heads. */
  runningHeads: Set<string>;
}

/**
 * Normalise a margin line for cross-page comparison.
 *
 * Digits are stripped because the folio is exactly the part that changes:
 * "142 THE SILENT GLAIVE" and "143 THE SILENT GLAIVE" are the same running
 * head, and comparing them literally would never match.
 */
function normaliseMarginLine(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\d]+/g, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fraction of pages a margin line must appear on to count as a running head.
 *
 * Running heads repeat on nearly every page by definition; a heading that
 * happens to sit high on one chapter-opening page does not.
 */
const RUNNING_HEAD_FREQUENCY = 0.4;

/**
 * Find running heads by looking across the whole document.
 *
 * NEEDED BECAUSE POSITION IS NOT ENOUGH. Measured on real output: a running
 * head sat at y=74 and a genuine `CHAPTER SEVEN` label at y=96 on a page of
 * the same height — 22px apart. No margin-band threshold separates those two
 * reliably. What does separate them is that one recurs on every page and the
 * other appears once.
 *
 * A running head carrying a folio ("143 THE SILENT GLAIVE") is caught by the
 * folio test instead and does not need to reach this frequency.
 */
function collectRunningHeads(pages: OcrPageGeometry[], marginBand: number): Set<string> {
  const counts = new Map<string, number>();

  for (const page of pages) {
    const topBand = page.imageHeight * marginBand;
    const bottomBand = page.imageHeight * (1 - marginBand);
    const edges = edgeLines(page.lines);
    const seen = new Set<string>();

    for (const line of page.lines) {
      const inMargin = line.top < topBand || line.top + line.height > bottomBand;
      if (!inMargin && !edges.has(line)) continue;
      const key = normaliseMarginLine(line.text);
      // An all-digit line normalises to nothing; it is a folio, handled by
      // pattern rather than by repetition.
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const minPages = Math.max(2, Math.ceil(pages.length * RUNNING_HEAD_FREQUENCY));
  return new Set([...counts].filter(([, n]) => n >= minPages).map(([key]) => key));
}

/**
 * The topmost and bottommost lines of a page.
 *
 * NEEDED BECAUSE THE MARGIN BAND ASSUMES A TIGHT CROP. On a real run the crop
 * left enough space above the page that "CHAPTER 14" and "SALES LAW: RISK OF
 * LOSS AND WARRANTIES" sat below the top 8% on most frames, so neither was
 * ever considered, and both were printed once per page. Whatever the crop,
 * a running head is still the first line on its page.
 *
 * Being an edge line only makes a line a *candidate*; it still has to recur
 * across the document, or read as a bare page number, to be dropped.
 */
function edgeLines<T extends OcrLineBox>(lines: T[]): Set<T> {
  if (lines.length === 0) return new Set();
  let top = lines[0];
  let bottom = lines[0];
  for (const line of lines) {
    if (line.top < top.top) top = line;
    if (line.top + line.height > bottom.top + bottom.height) bottom = line;
  }
  return new Set([top, bottom]);
}

/**
 * Body text height for the whole document.
 *
 * Returns 0 when there is no geometry at all, which callers treat as "cannot
 * analyse" rather than as a measurement.
 */
export function documentBodyHeight(pages: OcrPageGeometry[]): number {
  const heights: number[] = [];
  const weights: number[] = [];

  for (const page of pages) {
    for (const line of page.lines) {
      const wordCount = words(line.text).length;
      if (wordCount === 0 || line.height <= 0) continue;
      heights.push(line.height);
      weights.push(wordCount);
    }
  }

  return weightedMedian(heights, weights);
}

/**
 * Classify every line on one page.
 *
 * `bodyHeight` comes from `documentBodyHeight` so the answer does not depend
 * on what happens to be on this particular page.
 */
export function analysePage(page: OcrPageGeometry, context: StructureContext): PageStructure {
  const { bodyHeight, runningHeads } = context;
  if (page.lines.length === 0 || bodyHeight <= 0) {
    return { lines: [], pageNumber: null };
  }

  const pageCentre = page.imageWidth / 2;
  const topBand = page.imageHeight * MARGIN_BAND;
  const bottomBand = page.imageHeight * (1 - MARGIN_BAND);

  // Where the text block starts. Taken from body-sized lines only, so a
  // centred title cannot drag the margin leftward.
  const bodyLefts = page.lines
    .filter(l => l.height <= bodyHeight * HEADING_RATIO)
    .map(l => l.left);
  const bodyLeft = bodyLefts.length > 0 ? median(bodyLefts) : median(page.lines.map(l => l.left));

  let pageNumber: string | null = null;
  const edges = edgeLines(page.lines);

  const lines: ClassifiedLine[] = page.lines.map(line => {
    const lineWords = words(line.text);
    const inMargin = line.top < topBand || line.top + line.height > bottomBand;
    const atEdge = edges.has(line);
    const ratio = line.height / bodyHeight;
    const centre = line.left + line.width / 2;
    const isCentred =
      Math.abs(centre - pageCentre) < page.imageWidth * CENTRE_TOLERANCE &&
      line.width < page.imageWidth * 0.75;

    // ── Page furniture ───────────────────────────────────────────────────────
    // Sitting in the margin band is necessary but NOT sufficient: a chapter
    // label can legitimately sit as high on the page as a running head does.
    // A margin line is only furniture if it also either reads as a folio or
    // recurs across the document. Everything else falls through and is judged
    // on its typography like any other line.
    if ((inMargin || atEdge) && lineWords.length <= MAX_FURNITURE_WORDS) {
      const wholeLine = folioCandidate(line.text);
      if (wholeLine !== null) {
        pageNumber ??= wholeLine;
        return { ...line, role: 'pageNumber' };
      }

      // Running heads commonly carry the folio at one end: "142  THE SILENT
      // GLAIVE". Recover the number, then drop the whole line as furniture.
      // Margin band only: an edge line outside it is just as likely to be a
      // numbered subheading ("4. No Movement of Goods Required") that happens
      // to open the frame, and this test would throw it away.
      const edgeFolio = inMargin
        ? folioCandidate(lineWords[0]) ?? folioCandidate(lineWords[lineWords.length - 1])
        : null;
      if (edgeFolio !== null) {
        pageNumber ??= edgeFolio;
        return { ...line, role: 'runningHead' };
      }

      if (runningHeads.has(normaliseMarginLine(line.text))) {
        return { ...line, role: 'runningHead' };
      }
    }

    // ── Table of contents ────────────────────────────────────────────────────
    // Ahead of the size tests: an outline entry set in capitals ("VI. TERMS
    // (p. 461)") measures as a heading, and was rendered as one.
    if (TOC_ENTRY.test(line.text)) return { ...line, role: 'tocEntry' };

    // ── Headings, by measurement ─────────────────────────────────────────────
    // A heading never starts in lowercase. Without this guard a paragraph's
    // last word, alone on its line ("not.", "buyer."), was promoted to a
    // heading on a real run.
    const startsLowercase = /^[a-z]/.test(line.text.trim());
    if (!startsLowercase) {
      if (ratio >= TITLE_RATIO) return { ...line, role: 'title' };
      if (ratio >= HEADING_RATIO) return { ...line, role: 'heading' };

      // A short centred line sitting outside the body margin is a heading even
      // when it is not set larger — small-caps chapter labels ("CHAPTER SEVEN")
      // are typically set at or below body size and would otherwise read as a
      // stray sentence in the middle of the prose.
      if (isCentred && lineWords.length <= MAX_FURNITURE_WORDS && line.left > bodyLeft + bodyHeight) {
        return { ...line, role: 'heading' };
      }
    }

    return { ...line, role: 'body' };
  });

  refineBodyLines(lines, bodyHeight);

  return { lines, pageNumber };
}

/** Vertical gap between the bottom of `above` and the top of `below`. */
function gapBetween(above: OcrLineBox, below: OcrLineBox): number {
  return below.top - (above.top + above.height);
}

/** Position of a list marker in its sequence (1, 2, 3 / a, b, c), or null for bullets. */
function markerOrdinal(text: string): number | null {
  const marker = text.trim().split(/\s+/)[0].replace(/[.)]$/, '');
  if (/^\d+$/.test(marker)) return parseInt(marker, 10);
  if (/^[a-z]$/i.test(marker)) return marker.toLowerCase().charCodeAt(0) - 96;
  return null;
}

/**
 * Mark the list items in one run of adjacent body lines.
 *
 * Requires two or more marker lines sharing a left edge and, for numbered or
 * lettered markers, counting up by one. Prose wrapping so that two lines both
 * happen to start with "2)" and "3)" is possible; prose doing that in sequence
 * at the same indent is not something real paragraphs do.
 */
function markListItems(run: ClassifiedLine[], bodyHeight: number): void {
  const markers = run.filter(l => LIST_MARKER.test(l.text.trim()));
  if (markers.length < 2) return;

  const aligned = markers.every(l => Math.abs(l.left - markers[0].left) <= bodyHeight * 0.5);
  if (!aligned) return;

  const ordinals = markers.map(l => markerOrdinal(l.text));

  // A "1." read as "I." or "l." — the letter ordinal would be 9 or 12. When
  // the next marker is 2 it can only have been a 1; repair the text as well,
  // or the list renders as "I. … / 2. …".
  if (ordinals.length >= 2 && ordinals[1] === 2 && /^[Il][.)]\s/.test(markers[0].text.trim())) {
    ordinals[0] = 1;
    markers[0].text = markers[0].text.trim().replace(/^[Il]/, '1');
  }

  const allBullets = ordinals.every(o => o === null);
  const sequential = ordinals.every((o, i) => o !== null && (i === 0 || o === ordinals[i - 1]! + 1));
  if (!allBullets && !sequential) return;

  for (const line of markers) line.role = 'listItem';
}

/**
 * Second pass over a classified page: the distinctions that need a line's
 * neighbours, not just its own measurements.
 *
 * Order matters. Side text goes first so a figure fragment cannot split a
 * list run or count as the line before a subheading; lists go before
 * subheadings because "1. Good title," inside a list also looks like an
 * outline marker.
 */
function refineBodyLines(lines: ClassifiedLine[], bodyHeight: number): void {
  // ── Table of contents ──────────────────────────────────────────────────────
  // One line ending in "(p. 12)" is a cross-reference in prose; a contents
  // page has them line after line. The last page of a contents list can carry
  // as few as two entries, so two is the bar.
  if (lines.filter(l => l.role === 'tocEntry').length < 2) {
    for (const line of lines) if (line.role === 'tocEntry') line.role = 'body';
  }

  // ── Side text ──────────────────────────────────────────────────────────────
  const isProse = (l: ClassifiedLine) =>
    l.role === 'body' && words(l.text).length >= SIDE_TEXT_NEIGHBOUR_MIN_WORDS;

  for (const line of lines) {
    if (line.role !== 'body' || words(line.text).length > SIDE_TEXT_MAX_WORDS) continue;
    const besideProse = lines.some(other => {
      if (other === line || !isProse(other)) return false;
      const overlapsVertically =
        line.top < other.top + other.height && other.top < line.top + line.height;
      const horizontalGap = Math.max(
        line.left - (other.left + other.width),
        other.left - (line.left + line.width)
      );
      return overlapsVertically && horizontalGap >= bodyHeight * SIDE_TEXT_MIN_GAP_RATIO;
    });
    if (besideProse) line.role = 'sideText';
  }

  // Lines in reading order that actually render.
  const flow = lines.filter(
    l => l.role !== 'pageNumber' && l.role !== 'runningHead' && l.role !== 'sideText'
  );
  const paragraphGap = bodyHeight * PARAGRAPH_GAP_RATIO;

  // ── Lists ──────────────────────────────────────────────────────────────────
  let runStart = 0;
  for (let i = 1; i <= flow.length; i++) {
    const runEnds =
      i === flow.length ||
      flow[i].role !== 'body' ||
      flow[i - 1].role !== 'body' ||
      gapBetween(flow[i - 1], flow[i]) > paragraphGap;
    if (!runEnds) continue;
    markListItems(flow.slice(runStart, i), bodyHeight);
    runStart = i;
  }

  // ── Subheadings ────────────────────────────────────────────────────────────
  const widestBody = Math.max(0, ...flow.filter(l => l.role === 'body').map(l => l.width));

  flow.forEach((line, i) => {
    if (line.role !== 'body') return;
    const text = line.text.trim();
    if (!OUTLINE_MARKER.test(text)) return;
    if (words(text).length > SUBHEADING_MAX_WORDS) return;
    // A heading does not end mid-sentence or as a question; a list entry,
    // prose line or numbered study question ("1. Who is a consignor?") does.
    if (/[.,;:?!]$/.test(text)) return;
    if (line.width > widestBody * SUBHEADING_MAX_WIDTH) return;

    const previous = flow[i - 1];
    const setApart =
      previous === undefined ||
      previous.role === 'title' ||
      previous.role === 'heading' ||
      previous.role === 'subheading' ||
      gapBetween(previous, line) > paragraphGap;
    if (setApart) line.role = 'subheading';
  });

  // ── Callouts ───────────────────────────────────────────────────────────────
  for (const line of flow) {
    if (line.role === 'body' && line.height / bodyHeight >= CALLOUT_RATIO) line.role = 'callout';
  }
}

/**
 * Join body lines into a paragraph, repairing words broken across a line end.
 *
 * Printed text hyphenates at the margin, and OCR faithfully returns the hyphen.
 * Joining naively yields "recog- nise"; this rejoins it. The lowercase test is
 * what keeps a genuine compound ("self-" / "Evident") from being welded shut.
 */
function joinBodyLines(lineTexts: string[]): string {
  let out = '';
  for (let i = 0; i < lineTexts.length; i++) {
    const current = lineTexts[i];
    const next = lineTexts[i + 1];
    const hyphenated = /[-‐]$/.test(current) && next !== undefined && /^[a-z]/.test(next);

    if (hyphenated) {
      out += current.replace(/[-‐]$/, '');
    } else {
      out += current + (next !== undefined ? ' ' : '');
    }
  }
  return out.trim();
}

/**
 * Render one analysed page as Markdown.
 *
 * Furniture is dropped: a folio and a running head repeat on every page of a
 * recording and are exactly the kind of interleaved noise that survives text
 * dedup, for the same reason `cropFrames` exists.
 */
export function renderPageMarkdown(structure: PageStructure, bodyHeight: number): string {
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let paragraphKind: 'body' | 'callout' = 'body';
  // Each entry is one list item's lines, so a wrapped item can be rejoined.
  let listItems: string[][] = [];
  let itemLeft = 0;
  let previous: ClassifiedLine | null = null;
  // Index in `blocks` of a heading that a following line may continue.
  let openHeading = -1;

  // Contents entries: indent level from where each entry starts, so the
  // outline's nesting survives (I. → A. → 1. → a.).
  const tocLefts = clusterLefts(
    structure.lines.filter(l => l.role === 'tocEntry').map(l => l.left),
    bodyHeight * 0.7
  );
  let tocBlock: string[] = [];
  const flushToc = () => {
    if (tocBlock.length > 0) {
      blocks.push(tocBlock.join('\n'));
      tocBlock = [];
    }
  };

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      const text = joinBodyLines(paragraph);
      blocks.push(paragraphKind === 'callout' ? `> ${text}` : text);
      paragraph = [];
    }
  };

  // Items joined by single newlines so Markdown renders one list, not several.
  const flushList = () => {
    if (listItems.length > 0) {
      blocks.push(listItems.map(item => formatListItem(joinBodyLines(item))).join('\n'));
      listItems = [];
    }
  };

  for (const line of structure.lines) {
    if (line.role === 'pageNumber' || line.role === 'runningHead' || line.role === 'sideText') continue;
    const text = line.text.trim();

    if (line.role === 'tocEntry') {
      flushParagraph();
      flushList();
      openHeading = -1;
      const level = tocLefts.findIndex(left => Math.abs(left - line.left) <= bodyHeight * 0.7);
      for (const entry of text.split(TOC_SPLIT)) {
        tocBlock.push(`${'  '.repeat(Math.max(0, level))}- ${entry.trim()}`);
      }
      previous = line;
      continue;
    }
    flushToc();

    if (line.role === 'title' || line.role === 'heading' || line.role === 'subheading') {
      flushParagraph();
      flushList();

      // A title set over several lines ("Sales Law: / Risk of Loss and /
      // Warranties") is one heading, not three. Continue the open heading
      // when this line has the same role and follows within a line's height.
      const continuesHeading =
        openHeading >= 0 &&
        previous !== null &&
        previous.role === line.role &&
        line.role !== 'subheading' &&
        line.top - (previous.top + previous.height) <= previous.height;

      if (continuesHeading) {
        blocks[openHeading] += ` ${text}`;
      } else {
        blocks.push(`${headingPrefix(line)} ${text}`);
        openHeading = blocks.length - 1;
      }
      previous = line;
      continue;
    }
    openHeading = -1;

    const adjacent =
      previous !== null && line.top - (previous.top + previous.height) <= bodyHeight * PARAGRAPH_GAP_RATIO;

    if (line.role === 'listItem') {
      flushParagraph();
      listItems.push([text]);
      itemLeft = line.left;
      previous = line;
      continue;
    }

    // A wrapped list item continues under its text, to the right of the marker.
    if (listItems.length > 0 && line.role === 'body' && adjacent &&
        line.left > itemLeft + bodyHeight * 0.5) {
      listItems[listItems.length - 1].push(text);
      previous = line;
      continue;
    }
    flushList();

    // Body or callout: continue the current paragraph, or start a new one.
    // Prose running straight into a callout is a break even without a gap —
    // in the measured textbook the rule statement sat 11px under the prose,
    // inside the normal paragraph spacing. The reverse is NOT a break on its
    // own, because a callout's final line can measure at body height.
    // A callout also opens a sentence, so a tall line starting in lowercase is
    // the tail of the paragraph before it ("…at that time or" / "not."), not
    // the start of a rule statement.
    const indented = previous !== null && line.left > previous.left + bodyHeight * INDENT_RATIO;
    const entersCallout =
      line.role === 'callout' && paragraphKind !== 'callout' && !/^[a-z]/.test(text);
    const continues = paragraph.length > 0 && adjacent && !indented && !entersCallout;

    if (!continues) {
      flushParagraph();
      paragraphKind = line.role === 'callout' ? 'callout' : 'body';
    }

    paragraph.push(text);
    previous = line;
  }

  flushParagraph();
  flushList();
  flushToc();
  return blocks.join('\n\n');
}

/**
 * Distinct left edges, ascending, with values within `tolerance` of each
 * other merged. Each cluster's position is one indent level.
 */
function clusterLefts(lefts: number[], tolerance: number): number[] {
  const clusters: number[] = [];
  for (const left of [...lefts].sort((a, b) => a - b)) {
    if (clusters.length === 0 || left - clusters[clusters.length - 1] > tolerance) {
      clusters.push(left);
    }
  }
  return clusters;
}

/**
 * Markdown heading level for a heading line.
 *
 * Size-detected lines keep the levels they always had. Subheadings take their
 * level from the outline marker, following the usual textbook hierarchy:
 * "II." above "A." above "1.".
 */
function headingPrefix(line: ClassifiedLine): string {
  if (line.role === 'title') return '#';
  if (line.role === 'heading') return '##';
  const marker = line.text.trim().split(/\s+/)[0];
  if (/^[IVXLC]{2,}\.$/.test(marker)) return '##';
  if (/^[A-Z]\.$/.test(marker)) return '###';
  if (/^[a-z]\.$/.test(marker)) return '#####';
  return '####';
}

/**
 * Render one list item as Markdown.
 *
 * Numbered markers ("1." "1)") are already Markdown list syntax. Bullet glyphs
 * become "-". Lettered markers have no Markdown equivalent, so they are kept
 * as text inside a bullet — otherwise consecutive "a. …" / "b. …" lines would
 * collapse into a single paragraph.
 */
function formatListItem(text: string): string {
  if (/^\d{1,2}[.)]\s/.test(text)) return text;
  const bullet = text.match(/^[•●▪◦·*–-]\s+(.*)$/);
  if (bullet) return `- ${bullet[1]}`;
  return `- ${text}`;
}

/**
 * Analyse every frame and render each to Markdown.
 *
 * Returns one string per input page, aligned with `pages`, so the caller can
 * run the existing frame-level dedup over the result exactly as it does over
 * plain text. A page with no geometry yields `''`; the caller substitutes that
 * frame's plain OCR text.
 */
export function structurePages(pages: OcrPageGeometry[]): string[] {
  const bodyHeight = documentBodyHeight(pages);
  if (bodyHeight <= 0) return pages.map(() => '');

  const context: StructureContext = {
    bodyHeight,
    runningHeads: collectRunningHeads(pages, MARGIN_BAND),
  };

  return pages.map(page => renderPageMarkdown(analysePage(page, context), bodyHeight));
}
