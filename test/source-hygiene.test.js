'use strict';
/**
 * GAS のパーサーは文字列中の生の U+2028/U+2029（行区切り文字）を構文エラーにする（Node は許容する）。
 * clasp push で初めて失敗しないよう、ソースに生の制御的な文字が含まれていないことを確認する。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['gas', 'frontend', path.join('frontend', 'admin')];
const FORBIDDEN_CODES = [0x2028, 0x2029, 0xfeff, 0x0b, 0x0c];
for (let c = 0; c <= 0x1f; c++) if (c !== 0x09 && c !== 0x0a && c !== 0x0d) FORBIDDEN_CODES.push(c);
const FORBIDDEN = new RegExp('[' + FORBIDDEN_CODES.map((c) => String.fromCharCode(c)).join('') + ']');

test('ソースに生の行区切り文字・制御文字・BOM が含まれない', () => {
  for (const dir of DIRS) {
    for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((n) => /\.(js|json|html|css)$/.test(n))) {
      const text = fs.readFileSync(path.join(ROOT, dir, f), 'utf8');
      assert.ok(!FORBIDDEN.test(text), path.join(dir, f) + ' contains a raw control/line-separator character');
    }
  }
});

test('画面側の JS が構文エラーなく読み込める', () => {
  for (const f of ['frontend/app.js', 'frontend/config.js', 'frontend/admin/admin.js', 'frontend/admin/config.js']) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotThrow(() => new Function(text), f);
  }
});
