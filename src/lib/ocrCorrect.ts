/**
 * Dictionary-guided repair of the character confusions Windows OCR makes.
 *
 * The recogniser's mistakes are not random. On a real law-textbook run the
 * same few shapes were misread over and over: "in" read as "m" (paymg,
 * determinmg, nonconformmg), "rn" as "m" (retum, Califomia), "rm" as "nn"
 * (Unifonn), "cl" as "d" (daims), and words fused across a space (Ifthe,
 * underthe, Thisfederal, ofwritten, thirdparty).
 *
 * Each repair is only made when the token is NOT a word and the repaired form
 * IS one, so correctly read text — including names and jargon the dictionary
 * lacks — is never rewritten into something else. A misread that happens to
 * land on another real word ("tide" for "title", "he" for "the") is out of
 * reach by design; telling those apart needs context this pass does not have.
 *
 * Pure and synchronous so it can be exercised without the app; the word list
 * is supplied by the caller.
 */

/**
 * OCR output → what the page said, tried one substitution at a time.
 * Order is priority: when two repairs both yield a word, the earlier wins.
 */
const CONFUSIONS: ReadonlyArray<readonly [string, string]> = [
  ['m', 'in'],  // paymg → paying
  ['m', 'rn'],  // retum → return
  ['rn', 'm'],  // rnay → may
  ['nn', 'rm'], // Unifonn → Uniform
  ['d', 'cl'],  // daims → claims
  ['li', 'h'],  // tlie → the
  ['ii', 'u'],
  ['vv', 'w'],
  ['1', 'l'],   // cal1ed → called
  ['0', 'o'],
];

/**
 * Short words that fused tokens usually contain. A fused token is split when
 * one side is one of these — or, failing that, when both sides are substantial
 * words in their own right (thirdparty → third party).
 */
const JOINERS = new Set([
  'the', 'of', 'if', 'in', 'on', 'to', 'for', 'and', 'or', 'nor', 'but',
  'this', 'that', 'these', 'those', 'with', 'under', 'by', 'is', 'it',
  'his', 'her', 'its', 'their', 'from', 'not', 'was', 'were',
]);

/**
 * Two-letter joiners are only trusted on the LEFT of a split ("ofwritten"),
 * or when both halves are joiners ("ofthe"). On the right they cut real words
 * the dictionary lacks: the Latin "emptor" became "empt or".
 */
const isJoinerSplit = (left: string, right: string): boolean =>
  (JOINERS.has(left) && JOINERS.has(right)) ||
  (JOINERS.has(left) && right.length >= (left.length === 2 ? 4 : 3)) ||
  (JOINERS.has(right) && right.length >= 3 && left.length >= 3);

/** Proper nouns the word list lacks but legal and US texts lean on. */
const SUPPLEMENT = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
  'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine',
  'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi',
  'missouri', 'montana', 'nebraska', 'nevada', 'ohio', 'oklahoma', 'oregon',
  'pennsylvania', 'tennessee', 'texas', 'utah', 'vermont', 'virginia',
  'washington', 'wisconsin', 'wyoming', 'american', 'english', 'federal',
  'nonmerchant',
];

/** A Roman numeral read with digit ones or lowercase L: "11.", "111.", "lv.". */
const MISREAD_ROMAN = /^([1lIiVvXx]{2,5})\.(\s+)(\S+)/;
const ROMAN = /^(X{0,3})(IX|IV|V?I{0,3})$/;

export interface Corrector {
  /** Whether `word` (any case) is in the dictionary. */
  isWord(word: string): boolean;
  /** Repair one OCR line. */
  correctLine(text: string): string;
  /** Whether a line still contains a word that is neither known nor a number. */
  hasUnknownWord(text: string): boolean;
}

/** Re-apply the source token's capitalisation to a repaired lowercase word. */
function matchCase(source: string, word: string): string {
  if (source.length > 1 && source === source.toUpperCase()) return word.toUpperCase();
  if (source[0] === source[0].toUpperCase() && source[0] !== source[0].toLowerCase()) {
    return word[0].toUpperCase() + word.slice(1);
  }
  return word;
}

export function createCorrector(words: Iterable<string>): Corrector {
  const dict = new Set<string>();
  for (const w of words) {
    const t = w.trim().toLowerCase();
    if (t) dict.add(t);
  }
  for (const w of SUPPLEMENT) dict.add(w);

  const isWord = (w: string) => dict.has(w.toLowerCase());

  /** Single-substitution repair, or null when nothing yields a word. */
  const substitute = (lower: string): string | null => {
    for (const [from, to] of CONFUSIONS) {
      let idx = lower.indexOf(from);
      while (idx !== -1) {
        const candidate = lower.slice(0, idx) + to + lower.slice(idx + from.length);
        if (dict.has(candidate)) return candidate;
        idx = lower.indexOf(from, idx + 1);
      }
    }
    return null;
  };

  /** Split a fused token into two words, or null. */
  const split = (core: string): string | null => {
    const lower = core.toLowerCase();
    const allCaps = core === core.toUpperCase();
    for (let i = 2; i <= lower.length - 2; i++) {
      const left = lower.slice(0, i);
      const right = lower.slice(i);
      if (!dict.has(left) || !dict.has(right)) continue;
      const viaJoiner = isJoinerSplit(left, right);
      // Two substantial words: 4+ letters each, or 3+ in an all-caps heading
      // ("IMPROVEMENTACT"), where short words like ACT are common.
      const minPart = allCaps ? 3 : 4;
      const twoWords = left.length >= minPart && right.length >= minPart;
      if (viaJoiner || twoWords) {
        return `${core.slice(0, i)} ${core.slice(i)}`;
      }
    }
    return null;
  };

  const correctToken = (token: string): string => {
    const m = token.match(/^([^A-Za-z0-9]*)([A-Za-z01]+?)((?:['’]s)?[^A-Za-z0-9]*)$/);
    if (!m) return token;
    const [, lead, core, trail] = m;

    if (!/[A-Za-z]/.test(core) || core.length < 3 || isWord(core)) return token;

    // Mixed-case inside the word ("MusicMan") is a name, not a misread.
    const plainCase =
      core === core.toLowerCase() ||
      core === core.toUpperCase() ||
      core.slice(1) === core.slice(1).toLowerCase();
    if (!plainCase) return token;

    // Substitutions only on cased words of 4+ letters. OCR rarely confuses
    // these shapes in capitals, acronyms are full of letter runs that are not
    // words, and short names land on real words too easily ("Tom" → "torn").
    if (core !== core.toUpperCase() && core.length >= 4) {
      const repaired = substitute(core.toLowerCase());
      if (repaired) return lead + matchCase(core, repaired) + trail;
    }

    if (/^[A-Za-z]+$/.test(core) && core.length >= 5) {
      const parts = split(core);
      if (parts) return lead + parts + trail;
    }

    return token;
  };

  /** "11. INSURABLE INTEREST" → "II. INSURABLE INTEREST". */
  const fixRomanMarker = (text: string): string => {
    const m = text.match(MISREAD_ROMAN);
    if (!m) return text;
    const [whole, marker, space, firstWord] = m;
    // Only ahead of an all-caps heading word, where a Roman section number is
    // expected and an 11th or 111th numbered item is not.
    if (!/^[A-Z][A-Z'’&-]{2,}$/.test(firstWord)) return text;
    const roman = marker.replace(/[1li]/g, 'I').toUpperCase();
    if (roman === marker || !ROMAN.test(roman)) return text;
    return `${roman}.${space}${firstWord}` + text.slice(whole.length);
  };

  const correctLine = (text: string): string =>
    fixRomanMarker(text.split(' ').map(correctToken).join(' '));

  const hasUnknownWord = (text: string): boolean =>
    text.split(/\s+/).some(token => {
      const core = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/['’]s$/, '');
      if (core.length < 2 || /\d/.test(core)) return false;
      if (ROMAN.test(core.toUpperCase())) return false;
      // Non-ASCII letters in English text ("Råsk") are a misread, not a word.
      if (/[^A-Za-z'’-]/.test(core)) return true;
      return core.split(/[-'’]/).some(part => part.length > 1 && !isWord(part));
    });

  return { isWord, correctLine, hasUnknownWord };
}
