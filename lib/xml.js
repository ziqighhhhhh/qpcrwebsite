'use strict';
// ---------------------------------------------------------------------------
// Minimal XML parser (elements/attrs/text, comments/CDATA/declaration, self-closing).
// Namespace prefixes are stripped; matching is done on local names.
// We only need the well-formed subset used by the .lc96p documents.
// ---------------------------------------------------------------------------

function parseXml(str) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let textBuf = '';
  const n = str.length;
  let i = 0;

  function flushText() {
    if (textBuf.length) {
      const t = textBuf.replace(/^\s+|\s+$/g, '');
      if (t) stack[stack.length - 1].text += t;
      textBuf = '';
    }
  }

  while (i < n) {
    const lt = str.indexOf('<', i);
    if (lt < 0) { textBuf += str.slice(i); break; }
    if (lt > i) textBuf += str.slice(i, lt);

    if (str.startsWith('<!--', lt)) {
      const e = str.indexOf('-->', lt + 4);
      if (e < 0) throw new Error('Unterminated comment');
      i = e + 3; continue;
    }
    if (str.startsWith('<![CDATA[', lt)) {
      const e = str.indexOf(']]>', lt + 9);
      if (e < 0) throw new Error('Unterminated CDATA');
      textBuf += str.slice(lt + 9, e);
      i = e + 3; continue;
    }
    if (str.startsWith('<?', lt)) {
      const e = str.indexOf('?>', lt + 2);
      i = (e < 0) ? n : e + 2; continue;
    }
    if (str.startsWith('<!', lt)) {
      // DOCTYPE / other declarations: skip to '>'
      const e = str.indexOf('>', lt);
      i = (e < 0) ? n : e + 1; continue;
    }
    if (str.startsWith('</', lt)) {
      const gt = str.indexOf('>', lt + 2);
      if (gt < 0) throw new Error('Unterminated closing tag');
      const raw = str.slice(lt + 2, gt).trim();
      const name = raw.split(/\s+/)[0].split(':').pop();
      flushText();
      const el = stack.pop();
      if (!el) throw new Error('Unexpected closing tag </' + name + '>');
      if (el.name !== name) throw new Error('Mismatched closing tag: expected </' + el.name + '>, got </' + name + '>');
      i = gt + 1; continue;
    }
    // opening tag
    const gt = str.indexOf('>', lt);
    if (gt < 0) throw new Error('Unterminated tag');
    const inner = str.slice(lt + 1, gt);
    const selfClose = inner.endsWith('/');
    const body = selfClose ? inner.slice(0, -1) : inner;
    const m = /^([^\s/=]+)/.exec(body);
    if (!m) { i = gt + 1; continue; }
    const name = m[1].split(':').pop();
    const attrs = {};
    const attrRe = /([^\s=]+)\s*=\s*("[^"]*"|'[^']*')/g;
    let am;
    while ((am = attrRe.exec(body))) {
      let v = am[2].slice(1, -1);
      v = v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
           .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
           .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
           .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
      attrs[am[1].split(':').pop()] = v;
    }
    flushText();
    const el = { name, attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(el);
    if (!selfClose) stack.push(el);
    i = gt + 1;
  }
  if (stack.length !== 1) throw new Error('Unclosed tags: ' + stack.map(e => e.name).join(', '));
  return root;
}

// helpers: first / all direct children by local name
function child(el, name) { return el.children.find(c => c.name === name); }
function children(el, name) { return el.children.filter(c => c.name === name); }

// helpers: first / all descendants by local name (depth-first)
function find(root, name) {
  const stack = [root];
  while (stack.length) {
    const e = stack.pop();
    if (e.name === name) return e;
    for (let i = e.children.length - 1; i >= 0; i--) stack.push(e.children[i]);
  }
  return null;
}
function findAll(root, name) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const e = stack.pop();
    if (e.name === name) out.push(e);
    for (let i = e.children.length - 1; i >= 0; i--) stack.push(e.children[i]);
  }
  return out;
}
function textOf(el) { return el ? el.text : ''; }
function numOf(el) { const t = textOf(el); return t === '' ? null : parseFloat(t); }

module.exports = { parseXml, child, children, find, findAll, textOf, numOf };