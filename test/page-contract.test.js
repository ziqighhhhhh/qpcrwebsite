'use strict';
// Guards the HTML/JS contract of every page: any id a page script reaches for
// through getElementById()/$() must actually exist in that page's markup.
// Catches the classic typo that only shows up as a runtime TypeError in a browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = path.join(__dirname, '..', 'public');

function idsIn(html) {
  return new Set(Array.from(html.matchAll(/id="([^"]+)"/g)).map(m => m[1]));
}
function scriptCode(html) {
  const inline = Array.from(html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)).map(m => m[1]);
  const srcs = Array.from(html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)).map(m => m[1]);
  let code = inline.join('\n');
  for (const s of srcs) {
    const f = path.join(pub, s.replace(/^\/static\//, ''));
    if (fs.existsSync(f)) code += '\n' + fs.readFileSync(f, 'utf8');
  }
  return code;
}
function refsIn(code) {
  const refs = new Set();
  for (const m of code.matchAll(/getElementById\(\s*['"]([^'"]+)['"]/g)) refs.add(m[1]);
  for (const m of code.matchAll(/(?:^|[^\w$])\$\s*\(\s*['"]([^'"]+)['"]/g)) refs.add(m[1]);
  return refs;
}

// Ids created at runtime rather than present in the static markup.
const dynamicIds = new Set([
  'dsGName',        // index.html: 组名输入框按组数动态生成（id="dsGName<i>"）
  'dsTName',        // index.html: 靶基因输入框按组数动态生成（id="dsTName<i>"）
  'dsTFold',        // index.html: 表达倍数输入框动态生成（id="dsTFold<i>"）
  'dsTDir',         // index.html: 表达方向下拉框动态生成（id="dsTDir<i>"）
]);

for (const page of ['index.html', 'analysis.html', 'standard-curve.html']) {
  test(page + ': every referenced element id exists in the markup', () => {
    const html = fs.readFileSync(path.join(pub, page), 'utf8');
    const ids = idsIn(html);
    const missing = [...refsIn(scriptCode(html))].filter(id => !ids.has(id) && !dynamicIds.has(id));
    assert.deepEqual(missing, [], page + ' references missing ids: ' + missing.join(', '));
  });
}

test('nav links point at pages that exist', () => {
  const pages = fs.readdirSync(pub).filter(f => f.endsWith('.html'));
  const problems = [];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(pub, page), 'utf8');
    for (const m of html.matchAll(/href="(\/[A-Za-z0-9_.\-]*\.html)"/g)) {
      const target = m[1].replace(/^\//, '');
      if (!pages.includes(target)) problems.push(page + ' -> ' + m[1]);
    }
  }
  assert.deepEqual(problems, [], 'dead nav links: ' + problems.join(', '));
});
