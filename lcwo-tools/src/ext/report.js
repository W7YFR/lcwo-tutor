/*
 * lcwo-tools - the report page.
 *
 * Builds the payload out of IndexedDB and then hands it to app.js, which is
 * the same file the CLI inlines into its generated report. app.js reads
 * LCWO_DATA if it is there, so it has to be set before that script loads -
 * which is why app.js is appended here rather than listed in the markup:
 * reading IndexedDB is async and a <script> tag cannot wait for it.
 *
 * Unlike the CLI, this does not scope to the current operator. Everyone on
 * file goes in and the Operator filter does the narrowing, because here the
 * control is right there on the page.
 */

const {store, idb, rollup, payload, clock} = LCWO;

function fail(msg) {
  document.getElementById('app').innerHTML =
    '<p class="note">' + msg.replace(/[&<>]/g, c => ({'&': '&amp;', '<': '&lt;',
                                                      '>': '&gt;'}[c])) + '</p>';
}

(async () => {
  let db;
  try {
    db = await idb.open();
  } catch (e) {
    return fail('Could not open the database: ' + e.message);
  }

  const views = (await store.loadAll(db)).map(rollup.groupView);
  const operators = await store.listOperators(db);

  if (!views.length) {
    return fail('Nothing recorded yet. Import an export on the '
                + 'data page, or record a session.');
  }

  // one operator on file: name the report after them, as the CLI does
  if (operators.length === 1) {
    const title = 'LCWO progress — ' + operators[0].callsign;
    document.getElementById('title').textContent = title;
    document.title = title;
  }

  window.LCWO_DATA = payload.buildPayload(views, operators,
                                          {generated: clock.nowIso()});

  const tag = document.createElement('script');
  tag.src = '../report/app.js';
  tag.onerror = () => fail('Could not load the report code.');
  document.body.appendChild(tag);
})();
