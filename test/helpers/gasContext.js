'use strict';
/**
 * gas/*.js を Node の vm 上で読み込み、GAS サービスをメモリ上のフェイクで置き換える。
 * フェイクのシートは、先頭 ' の文字列をテキストとして保存し（GASと同じ挙動）、
 * ' なしで数式風の文字列が書き込まれた場合は例外にして数式インジェクションを検出する。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const GAS_DIR = path.join(__dirname, '..', '..', 'gas');

function storeAppendedValue(v) {
  if (typeof v === 'string' && v !== '') {
    if (v.startsWith("'")) return v.slice(1);
    throw new Error('Unescaped string written to sheet: ' + v);
  }
  return v;
}

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const src = this.sheet.rows[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        const v = src[this.col - 1 + c];
        line.push(v === undefined ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    values.forEach((line, r) => {
      const idx = this.row - 1 + r;
      this.sheet.rows[idx] = this.sheet.rows[idx] || [];
      line.forEach((v, c) => { this.sheet.rows[idx][this.col - 1 + c] = v; });
    });
    return this;
  }
  setValue(v) {
    const idx = this.row - 1;
    this.sheet.rows[idx] = this.sheet.rows[idx] || [];
    this.sheet.rows[idx][this.col - 1] = storeAppendedValue(v);
    return this;
  }
  setFontWeight() { return this; }
}

class FakeSheet {
  constructor(name) { this.name = name; this.rows = []; }
  getLastRow() { return this.rows.length; }
  getRange(row, col, numRows = 1, numCols = 1) { return new FakeRange(this, row, col, numRows, numCols); }
  appendRow(row) { this.rows.push(row.map(storeAppendedValue)); return this; }
  setFrozenRows() {}
}

class FakeSpreadsheet {
  constructor() { this.sheets = new Map(); this.timeZone = null; }
  getSheetByName(name) { return this.sheets.get(name) || null; }
  insertSheet(name) { const s = new FakeSheet(name); this.sheets.set(name, s); return s; }
  setSpreadsheetTimeZone(tz) { this.timeZone = tz; }
}

const DEFAULT_NOW = new Date('2026-11-07T12:00:00+09:00');
const CHANNEL_ID = '1234567890';
const STAFF_CHANNEL_ID = '2234567890';

/**
 * LINE の verify エンドポイントのフェイク。tokens: { [idToken]: { sub, exp?, aud?, iss? } }
 */
function makeLineVerifyHandler(tokens, getNow) {
  return (url, opts) => {
    if (url !== 'https://api.line.me/oauth2/v2.1/verify') throw new Error('unexpected url ' + url);
    const t = tokens[opts.payload.id_token];
    if (!t || String(opts.payload.client_id) !== (t.aud || CHANNEL_ID)) {
      // LINE は client_id と aud が一致しないトークンを 400 で拒否する
      return response(400, { error: 'invalid_request', error_description: 'Invalid IdToken.' });
    }
    return response(200, {
      iss: t.iss || 'https://access.line.me',
      sub: t.sub,
      aud: t.aud || CHANNEL_ID,
      exp: t.exp || Math.floor(getNow().getTime() / 1000) + 3600,
      iat: Math.floor(getNow().getTime() / 1000),
      amr: ['linesso']
    });
  };
}

function response(status, body) {
  return { getResponseCode: () => status, getContentText: () => JSON.stringify(body) };
}

function createGasContext(options = {}) {
  let now = options.now || DEFAULT_NOW;
  const getNow = () => new Date(now.getTime());
  const properties = Object.assign({ LINE_CHANNEL_ID: CHANNEL_ID, LINE_STAFF_CHANNEL_ID: STAFF_CHANNEL_ID }, options.properties || {});
  const ss = new FakeSpreadsheet();
  const fetchCalls = [];
  const lockState = { available: true, held: 0 };
  const fetchHandler = options.fetchHandler || makeLineVerifyHandler(options.tokens || {}, getNow);
  const logs = [];

  const sandbox = {
    console: {
      log: (...a) => logs.push(a.join(' ')),
      error: (...a) => logs.push(a.join(' ')),
      warn: (...a) => logs.push(a.join(' '))
    },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => { if (!lockState.available) return false; lockState.held++; return true; },
        waitLock: () => { if (!lockState.available) throw new Error('lock timeout'); lockState.held++; },
        releaseLock: () => { lockState.held = Math.max(0, lockState.held - 1); }
      })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperties: () => Object.assign({}, properties),
        getProperty: (k) => (k in properties ? properties[k] : null)
      })
    },
    UrlFetchApp: {
      fetch: (url, opts) => { fetchCalls.push({ url, opts }); return fetchHandler(url, opts); }
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      // GAS と同じく符号付きバイト配列を返す
      computeDigest: (alg, value) => Array.from(crypto.createHash(alg).update(value, 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b))
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(content) {
        return { content, mime: null, setMimeType(m) { this.mime = m; return this; }, getContent() { return this.content; } };
      }
    }
  };
  vm.createContext(sandbox);
  for (const file of fs.readdirSync(GAS_DIR).filter((f) => f.endsWith('.js')).sort()) {
    vm.runInContext(fs.readFileSync(path.join(GAS_DIR, file), 'utf8'), sandbox, { filename: file });
  }
  sandbox.now_ = getNow;

  return {
    gas: sandbox,
    ss,
    fetchCalls,
    lockState,
    logs,
    properties,
    setNow(d) { now = d; },
    /** doPost を通して呼び出し、JSON をパースして返す */
    post(body) {
      const raw = typeof body === 'string' ? body : JSON.stringify(body);
      const out = sandbox.doPost({ postData: { contents: raw, type: 'text/plain' } });
      return JSON.parse(out.getContent());
    },
    /** シートの中身をヘッダー付きオブジェクト配列で返す */
    rows(name) {
      const sheet = ss.getSheetByName(name);
      const [header, ...data] = sheet.rows;
      return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] === undefined ? '' : r[i]])));
    },
    addUser(user) {
      const schema = sandbox.SCHEMAS.Users;
      ss.getSheetByName('Users').appendRow(schema.map((k) => sandbox.toCellValue_(user[k])));
    }
  };
}

/** vm 内で生成されたオブジェクトを通常のオブジェクトに変換（deepStrictEqual 用） */
const plain = (x) => JSON.parse(JSON.stringify(x));

module.exports = { createGasContext, makeLineVerifyHandler, plain, CHANNEL_ID, STAFF_CHANNEL_ID, DEFAULT_NOW };
