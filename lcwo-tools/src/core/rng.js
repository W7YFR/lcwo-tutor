/*
 * A seedable random number generator.
 *
 * Math.random cannot be seeded, and a practice set you cannot reproduce is a
 * practice set you cannot test. mulberry32: small, fast, good enough for
 * shuffling letters.
 */
(function (X) {
  'use strict';

  function rngFrom(seed) {
    // Any string or number seeds it; no seed means genuinely random.
    let a = seed === undefined || seed === null || seed === ''
      ? Math.floor(Math.random() * 4294967296)
      : hash(String(seed));
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  }

  /* Inclusive at both ends, like Python's randint. */
  const randint = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

  const choice = (rng, items) => items[Math.floor(rng() * items.length)];

  /* One weighted draw. Weights need not be normalized. */
  function weighted(rng, items, weights) {
    let total = 0;
    for (const w of weights) total += w;
    if (!(total > 0)) return choice(rng, items);
    let r = rng() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r < 0) return items[i];
    }
    return items[items.length - 1];
  }

  const weightedN = (rng, items, weights, k) =>
    Array.from({length: k}, () => weighted(rng, items, weights));

  X.rngFrom = rngFrom;
  X.randint = randint;
  X.choice = choice;
  X.weighted = weighted;
  X.weightedN = weightedN;
})(typeof module === 'object' ? module.exports : (self.LCWO.rng = {}));
