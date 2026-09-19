/*
 * The namespace every module hangs off in the browser.
 *
 * Under node each file is a CommonJS module and requires what it needs. In a
 * page, a worker or a content script there is no require, so modules read
 * their dependencies off `self.LCWO` instead - which means this has to be the
 * first script loaded, everywhere.
 */
self.LCWO = self.LCWO || {};
