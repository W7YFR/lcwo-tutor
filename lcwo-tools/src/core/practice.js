/*
 * Sending practice built from the characters you miss on receive.
 */
(function (X, rnglib) {
  'use strict';

  const rngFrom = rnglib.rngFrom, randint = rnglib.randint,
        choice = rnglib.choice, weighted = rnglib.weighted, weightedN = rnglib.weightedN;

  const SOLO_SHARE = 0.35;  // groups that drill one character's rhythm alone

  /*
   * It opens with a run of one character on its own - its rhythm with nothing
   * to compare it to - worst first. The rest are drawn weighted by how often
   * you missed them, so the worst come round most, and mixed together so you
   * practice the transitions between them too.
   *
   * At most half the set is solo runs: a ten-character trouble list would
   * otherwise spend the whole drill on single characters. Whatever gets
   * crowded out that way is planted into the mixed groups instead, so
   * everything you are working on still appears.
   */
  function practiceSet(counts, opts) {
    opts = opts || {};
    const n = opts.n === undefined ? 24 : opts.n;
    const minLen = opts.minLen === undefined ? 2 : opts.minLen;
    const maxLen = opts.maxLen === undefined ? 3 : opts.maxLen;
    const rng = opts.rng || rngFrom(opts.seed);

    const chars = Object.keys(counts).sort((a, b) =>
      (counts[b] - counts[a]) || (a < b ? -1 : a > b ? 1 : 0));
    if (!chars.length || n < 1) return [];

    const weights = chars.map(c => counts[c]);
    const solos = chars.slice(0, Math.max(1, Math.min(chars.length, Math.ceil(n / 2))));
    const out = solos.map(c => c.repeat(randint(rng, minLen, maxLen)));
    const pending = chars.slice(solos.length, n);  // owed an appearance

    while (out.length < n) {
      const k = randint(rng, minLen, maxLen);
      if (!pending.length && rng() < SOLO_SHARE) {
        out.push(weighted(rng, chars, weights).repeat(k));
        continue;
      }
      let g = weightedN(rng, chars, weights, k);
      if (pending.length) {
        g[randint(rng, 0, k - 1)] = pending.shift();
      } else if (new Set(g).size === 1 && chars.length > 1) {
        g = weightedN(rng, chars, weights, k);  // that is a solo; draw again
      }
      out.push(g.join(''));
    }
    return out;
  }

  /*
   * For each confused pair, groups that put the two rhythms side by side.
   * Every group holds both characters - a group of one is just the solo drill
   * the main set already covers, and the whole point here is the contrast.
   */
  function pairDrill(pairs, opts) {
    opts = opts || {};
    const per = opts.per === undefined ? 3 : opts.per;
    const minLen = opts.minLen === undefined ? 2 : opts.minLen;
    const maxLen = opts.maxLen === undefined ? 3 : opts.maxLen;
    const rng = opts.rng || rngFrom(opts.seed);

    return pairs.map(p => {
      const a = p.a, b = p.b;
      const groups = [];
      while (groups.length < per) {
        const k = randint(rng, minLen, maxLen);
        const g = Array.from({length: k}, () => choice(rng, [a, b]));
        if (new Set(g).size === 1) g[randint(rng, 0, k - 1)] = g[0] === a ? b : a;
        groups.push(g.join(''));
      }
      return {a: a, b: b, count: p.count, groups: groups};
    });
  }

  X.SOLO_SHARE = SOLO_SHARE;
  X.practiceSet = practiceSet;
  X.pairDrill = pairDrill;
})(typeof module === 'object' ? module.exports : (self.LCWO.practice = {}),
   typeof require === 'function' ? require('./rng.js') : self.LCWO.rng);
