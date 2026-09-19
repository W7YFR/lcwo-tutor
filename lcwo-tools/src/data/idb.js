/*
 * The IndexedDB backend: the five methods from schema.js and nothing else.
 *
 * Kept deliberately dumb. Every decision worth testing lives in store.js,
 * which runs under node against an in-memory backend; this file is the part
 * that can only be exercised in a browser, so there is as little of it as
 * possible.
 */
(function (X, schema) {
  'use strict';

  const wrap = req => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  function openDb(name, version) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name || schema.DB_NAME, version || schema.DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const store in schema.STORES) {
          const spec = schema.STORES[store];
          const os = db.objectStoreNames.contains(store)
            ? req.transaction.objectStore(store)
            : db.createObjectStore(store, {keyPath: spec.key, autoIncrement: !!spec.auto});
          for (const index in spec.indexes) {
            if (!os.indexNames.contains(index)) os.createIndex(index, spec.indexes[index]);
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('another tab is holding the database open'));
    });
  }

  /* A backend over one open connection. */
  function backend(db) {
    const run = (store, mode, fn) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      let out;
      Promise.resolve(fn(tx.objectStore(store))).then(v => { out = v; }, reject);
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    });

    return {
      all(store, opts) {
        return run(store, 'readonly', os => {
          if (opts && opts.index && opts.only !== undefined) {
            return wrap(os.index(opts.index).getAll(opts.only));
          }
          return wrap(os.getAll());
        });
      },
      get(store, key) { return run(store, 'readonly', os => wrap(os.get(key))); },
      put(store, rec) { return run(store, 'readwrite', os => wrap(os.put(rec))); },
      del(store, key) { return run(store, 'readwrite', os => wrap(os.delete(key))); },
      clear(store) { return run(store, 'readwrite', os => wrap(os.clear())); },
      close() { db.close(); },
    };
  }

  const open = async (name, version) => backend(await openDb(name, version));

  X.open = open;
  X.backend = backend;
  X.openDb = openDb;
})(typeof module === 'object' ? module.exports : (self.LCWO.idb = {}),
   typeof require === 'function' ? require('./schema.js') : self.LCWO.schema);
