/*
 * An in-memory backend, for tests.
 *
 * It copies records in and out, because IndexedDB does too: code that gets
 * away with mutating a record it read would pass here and fail in the
 * browser.
 */
'use strict';

const schema = require('../src/data/schema.js');

const clone = typeof structuredClone === 'function'
  ? structuredClone : (v => JSON.parse(JSON.stringify(v)));

function memoryBackend(seed) {
  const data = {};
  const next = {};
  for (const name in schema.STORES) { data[name] = new Map(); next[name] = 1; }
  if (seed) for (const name in seed) for (const rec of seed[name]) put(name, rec);

  function keyOf(name, rec) {
    const spec = schema.STORES[name];
    if (!spec) throw new Error('no such store: ' + name);
    if (!spec.auto) return rec[spec.key];
    if (rec[spec.key] == null) return next[name]++;
    const id = Number(rec[spec.key]);
    if (id >= next[name]) next[name] = id + 1;  // keep ids handed out unique
    return id;
  }

  function put(name, rec) {
    const key = keyOf(name, rec);
    const spec = schema.STORES[name];
    const stored = Object.assign({}, clone(rec));
    stored[spec.key] = key;
    data[name].set(key, stored);
    return key;
  }

  return {
    async all(name, opts) {
      const rows = Array.from(data[name].values()).map(r => clone(r));
      if (!opts || !opts.index) return rows;
      const field = schema.STORES[name].indexes[opts.index];
      if (!field) throw new Error('no such index: ' + name + '.' + opts.index);
      return opts.only === undefined ? rows : rows.filter(r => r[field] === opts.only);
    },
    async get(name, key) {
      const rec = data[name].get(key);
      return rec === undefined ? undefined : clone(rec);
    },
    async put(name, rec) { return put(name, rec); },
    async del(name, key) { data[name].delete(key); },
    async clear(name) { data[name].clear(); next[name] = 1; },
    /* tests only */
    raw: data,
  };
}

module.exports = {memoryBackend};
