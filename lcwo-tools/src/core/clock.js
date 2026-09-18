/*
 * Timestamps.
 *
 * Local time with an offset, to the second - the format the Python CLI
 * writes, so imported and captured records sort together.
 *
 * It has to be local: every day-windowed number we show ("the last two
 * days") comes from slicing the date off the front of a timestamp, and a
 * 9pm session stamped in UTC files itself under tomorrow.
 */
(function (X) {
  'use strict';

  function nowIso(date) {
    const d = date || new Date();
    const off = -d.getTimezoneOffset();  // minutes east of UTC
    const sign = off < 0 ? '-' : '+';
    const p = (n, w) => String(Math.abs(Math.trunc(n))).padStart(w === undefined ? 2 : w, '0');
    return p(d.getFullYear(), 4) + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
      + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
      + sign + p(off / 60) + ':' + p(off % 60);
  }

  /* The practice day a timestamp belongs to. */
  const dayOf = iso => String(iso == null ? '' : iso).slice(0, 10);

  X.nowIso = nowIso;
  X.dayOf = dayOf;
})(typeof module === 'object' ? module.exports : (self.LCWO.clock = {}));
