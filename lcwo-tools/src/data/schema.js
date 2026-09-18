/*
 * What the database holds, and the contract every backend implements.
 *
 * Records mirror the CLI's SQLite tables so an export from one loads into the
 * other, with two differences: arrays are stored as arrays rather than JSON
 * strings (IndexedDB keeps structure natively), and the `live_*` views become
 * a read-time filter in store.js.
 *
 * A backend is five async methods. Deliberately small: everything
 * interesting lives in store.js as pure logic over plain records, so it can
 * be tested in node where IndexedDB does not exist.
 *
 *   all(store, opts)  -> array of records. opts.index + opts.only to match
 *                        one indexed value.
 *   get(store, key)   -> one record or undefined
 *   put(store, rec)   -> key. Assigns the next id when the record has none.
 *   del(store, key)   -> undefined
 *   clear(store)      -> undefined
 */
(function (X) {
  'use strict';

  const DB_NAME = 'lcwo';
  const DB_VERSION = 1;

  /* The interchange format `lcwo.py export` writes. Bumped only when the
     record shapes change in a way an older reader would get wrong. */
  const EXPORT_FORMAT = 'lcwo-export';
  const EXPORT_VERSION = 1;

  const STORES = {
    operators: {key: 'id', auto: true, indexes: {by_call: 'callsign'}},
    groups:    {key: 'id', auto: true, indexes: {by_operator: 'operator_id',
                                                 by_source: 'source'}},
    sessions:  {key: 'id', auto: true, indexes: {by_group: 'group_id'}},
    runs:      {key: 'id', auto: true, indexes: {by_session: 'session_id'}},
    settings:  {key: 'key', auto: false, indexes: {}},
  };

  /* Stores holding practice records, in dependency order - parents first.
     Import walks this forwards, purge walks it backwards. */
  const RECORD_STORES = ['operators', 'groups', 'sessions', 'runs'];

  X.EXPORT_FORMAT = EXPORT_FORMAT;
  X.EXPORT_VERSION = EXPORT_VERSION;
  X.DB_NAME = DB_NAME;
  X.DB_VERSION = DB_VERSION;
  X.STORES = STORES;
  X.RECORD_STORES = RECORD_STORES;
})(typeof module === 'object' ? module.exports : (self.LCWO.schema = {}));
