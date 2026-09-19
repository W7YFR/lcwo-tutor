/*
 * Counting helpers. Python's Counter, minus the parts we never used.
 *
 * A "counter" here is a plain object mapping key -> number. Plain objects so
 * they survive structuredClone into IndexedDB and JSON.stringify into a
 * report without a conversion step.
 */
(function (X) {
  'use strict';

  function bump(counter, key, n) {
    counter[key] = (counter[key] || 0) + (n === undefined ? 1 : n);
    return counter;
  }

  /* Add every count in `from` to `into`, in place. Counter.update. */
  function merge(into, from) {
    for (const k in from) bump(into, k, from[k]);
    return into;
  }

  /* Same, one level deeper: key -> counter. */
  function mergeDeep(into, from) {
    for (const k in from) merge(into[k] || (into[k] = {}), from[k]);
    return into;
  }

  function total(counter) {
    let n = 0;
    for (const k in counter) n += counter[k];
    return n;
  }

  /* Worst first, then alphabetical - the order every list we show uses. */
  function ranked(counter) {
    return Object.keys(counter)
      .map(k => [k, counter[k]])
      .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  X.bump = bump;
  X.merge = merge;
  X.mergeDeep = mergeDeep;
  X.total = total;
  X.ranked = ranked;
})(typeof module === 'object' ? module.exports : (self.LCWO.counter = {}));
