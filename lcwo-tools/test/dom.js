/*
 * A small HTML parser and DOM, so page-side code can be tested in node
 * against the real LCWO markup rather than against a hand-written mock.
 *
 * Only what the capture functions actually use: querySelector(All) for tag,
 * tag[attr=value], #id and descendant chains; textContent; getAttribute;
 * value. Anything a page function reaches for that is not here shows up as
 * a TypeError in the test, which is the point - a shim that silently returns
 * nothing lets broken selectors pass.
 */
'use strict';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
                      'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style']);

function decode(s) {
  return s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g,
    m => ({'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
           '&#39;': "'", '&nbsp;': ' '}[m]));
}

function parseAttrs(text) {
  const attrs = {};
  for (const m of text.matchAll(/([\w:-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)) {
    const raw = m[2];
    attrs[m[1].toLowerCase()] = raw === undefined ? ''
      : decode(raw.replace(/^["']|["']$/g, ''));
  }
  return attrs;
}

class Text {
  constructor(data) { this.data = data; }
  get textContent() { return this.data; }
}

class El {
  constructor(tag, attrs, parent) {
    this.tag = tag;
    this.attrs = attrs || {};
    this.parent = parent || null;
    this.nodes = [];          // elements and text, in document order
  }
  /* Text and elements interleave. Concatenating an element's own text before
     its children's turns "Speed = <b>30 WPM</b>, Tone" into "Speed = , Tone
     30 WPM", which reads fine until a regex has to span the boundary. */
  get textContent() { return this.nodes.map(n => n.textContent).join(''); }
  get children() { return this.nodes.filter(n => n instanceof El); }
  set text(v) { this.nodes.push(new Text(v)); }
  get text() { return this.nodes.filter(n => n instanceof Text)
                        .map(n => n.data).join(''); }
  getAttribute(name) {
    const v = this.attrs[name.toLowerCase()];
    return v === undefined ? null : v;
  }
  hasAttribute(name) { return this.attrs[name.toLowerCase()] !== undefined; }
  get id() { return this.attrs.id || ''; }
  set id(v) { this.attrs.id = v; }
  setAttribute(name, value) { this.attrs[name.toLowerCase()] = String(value); }
  removeAttribute(name) { delete this.attrs[name.toLowerCase()]; }

  /*
   * Which form owns this control.
   *
   * A `form` attribute wins, then the nearest ancestor. Worth reproducing
   * faithfully: on LCWO's settings page the parser closes </form> before the
   * cell holding the character boxes, so they are owned by nothing and a
   * submit leaves them out - which is the whole reason submitInPage adopts
   * them.
   */
  get form() {
    const named = this.attrs.form;
    if (named !== undefined) {
      let root = this;
      while (root.parent) root = root.parent;
      return root.querySelector('form#' + named) || null;
    }
    let up = this.parent;
    while (up && up.tag !== 'form') up = up.parent;
    return up || null;
  }

  get checked() { return this.attrs.checked !== undefined; }
  set checked(on) {
    if (on) this.attrs.checked = '';
    else delete this.attrs.checked;
  }

  set value(v) { this.attrs.value = String(v); }
  focus() { this.focused = (this.focused || 0) + 1; }

  dispatchEvent(event) {
    (this.events || (this.events = [])).push(event.type);
    return true;
  }
  click() { this.clicked = (this.clicked || 0) + 1; }
  get name() { return this.attrs.name || ''; }
  get value() {
    if (this.tag === 'textarea') {
      return this.attrs.value === undefined ? this.textContent : this.attrs.value;
    }
    if (this.tag === 'select') {
      const opts = this.querySelectorAll('option');
      const on = opts.filter(o => o.hasAttribute('selected'))[0] || opts[0];
      return on ? (on.hasAttribute('value') ? on.attrs.value : on.textContent.trim()) : '';
    }
    return this.attrs.value === undefined ? '' : this.attrs.value;
  }
  get style() { return {cssText: this.attrs.style || ''}; }

  /* Depth-first, self excluded - as the DOM does it. */
  descendants() {
    const out = [];
    const walk = el => { for (const c of el.children) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelectorAll(selector) {
    return selector.split(',').map(s => s.trim()).filter(Boolean)
      .reduce((acc, sel) => acc.concat(this._match(sel)), []);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  _match(selector) {
    // descendant chain: each step narrows the set below the previous match
    const steps = selector.trim().split(/\s+/);
    let pool = this.descendants();
    for (let i = 0; i < steps.length; i++) {
      const hits = pool.filter(el => matches(el, steps[i]));
      pool = i === steps.length - 1 ? hits
        : hits.reduce((a, el) => a.concat(el.descendants()), []);
    }
    return pool;
  }
}

function matches(el, step) {
  const m = /^([a-zA-Z0-9]+)?(#[\w-]+)?((?:\[[^\]]+\])*)$/.exec(step);
  if (!m) throw new Error('selector not supported by the shim: ' + step);
  if (m[1] && el.tag !== m[1].toLowerCase()) return false;
  if (m[2] && el.id !== m[2].slice(1)) return false;
  for (const a of (m[3] || '').matchAll(/\[([\w:-]+)(?:([~^$*|]?=)"?([^\]"]*)"?)?\]/g)) {
    const have = el.attrs[a[1].toLowerCase()];
    if (have === undefined) return false;
    if (a[2] === '=' && have !== a[3]) return false;
    if (a[2] === '^=' && !have.startsWith(a[3])) return false;
    if (a[2] === '*=' && !have.includes(a[3])) return false;
  }
  return true;
}

function parse(html) {
  const root = new El('#document', {}, null);
  let node = root;
  const re = /<!--[\s\S]*?-->|<!\[CDATA[\s\S]*?\]\]>|<!\w+[^>]*>|<\/([\w:-]+)\s*>|<([\w:-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let last = 0, m;
  while ((m = re.exec(html))) {
    if (m.index > last) node.text = decode(html.slice(last, m.index));
    last = re.lastIndex;
    if (m[1]) {                                   // closing tag
      const tag = m[1].toLowerCase();
      let up = node;
      while (up !== root && up.tag !== tag) up = up.parent;
      if (up !== root) node = up.parent;
    } else if (m[2]) {                            // opening tag
      const tag = m[2].toLowerCase();
      const el = new El(tag, parseAttrs(m[3] || ''), node);
      node.nodes.push(el);
      if (VOID.has(tag) || m[4]) continue;
      if (RAW.has(tag)) {                         // skip to the matching close
        const end = html.toLowerCase().indexOf('</' + tag, last);
        if (end > -1) { el.text = html.slice(last, end); re.lastIndex = last = end; }
        continue;
      }
      node = el;
    }
  }
  if (html.length > last) node.text = decode(html.slice(last));
  return root;
}

/* A document good enough for the page functions under test. */
function documentFrom(html) {
  const root = parse(html);
  const body = root.querySelector('body') || root;
  return {
    body: body,
    querySelector: sel => root.querySelector(sel),
    querySelectorAll: sel => root.querySelectorAll(sel),
    getElementById: id => root.querySelector('#' + id),
    getElementsByTagName: tag => root.querySelectorAll(tag),
  };
}

module.exports = {parse, documentFrom, El, Text};
