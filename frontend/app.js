/**
 * LINEミニアプリ 予約画面。
 * - 本人確認は LIFF の IDトークンをサーバーへ送り、サーバー側で検証する。
 *   LINE ユーザーIDをこちらから送ることはしない。
 * - 画面側の入力チェックは使い勝手のためだけで、確定的な検証はサーバーで行う。
 * - 表示はすべて textContent で行い、innerHTML は使わない（XSS 対策）。
 */
(function () {
  'use strict';

  var cfg = window.APP_CONFIG || {};
  var JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  var REQUEST_TIMEOUT_MS = 25000;
  var VIEWS = ['view-loading', 'view-error', 'view-form', 'view-confirm', 'view-done'];

  var state = {
    options: null,   // getFormOptions の結果
    draft: null,     // 確認画面に表示中の入力内容
    requestId: null, // 確認画面に入った時点で発行。再送時は同じ値を使う
    submitting: false
  };

  function $(id) { return document.getElementById(id); }

  function show(viewId) {
    VIEWS.forEach(function (id) { $(id).hidden = id !== viewId; });
    window.scrollTo(0, 0);
  }

  function showFatal(message) {
    $('error-message').textContent = message;
    show('view-error');
  }

  function isPlaceholder(v) { return !v || /^REPLACE_WITH_/.test(v); }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function uuidv4() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    var b = new Uint8Array(16);
    window.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 0x100).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  // ---------- 日付（日本時間） ----------

  /** 現在の営業日（切り替え時刻より前なら前日） */
  function jstBusinessToday(cutoffHour) {
    return new Date(Date.now() + JST_OFFSET_MS - cutoffHour * 3600000).toISOString().slice(0, 10);
  }

  function addDays(dateStr, n) {
    var p = dateStr.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
  }

  function formatDateJa(dateStr) {
    var p = dateStr.split('-').map(Number);
    var w = '日月火水木金土'.charAt(new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay());
    return p[0] + '年' + p[1] + '月' + p[2] + '日(' + w + ')';
  }

  function toMinutes(hhmm) {
    var p = hhmm.split(':').map(Number);
    return p[0] * 60 + p[1];
  }

  /** 例: 18:00〜翌04:00 を step 分刻みで生成 */
  function buildTimeSlots(start, end, step) {
    var s = toMinutes(start);
    var e = toMinutes(end);
    if (e <= s) e += 1440;
    var slots = [];
    for (var m = s; m <= e; m += step) {
      var dayOffset = m >= 1440 ? 1 : 0;
      var mm = m % 1440;
      var time = pad2(Math.floor(mm / 60)) + ':' + pad2(mm % 60);
      slots.push({ value: dayOffset + '|' + time, time: time, dayOffset: dayOffset, label: (dayOffset ? '翌' : '') + time });
    }
    return slots;
  }

  /** サーバーが返す '2026-11-10T21:00:00+09:00' を表示用に整形 */
  function formatScheduledAt(iso) {
    return formatDateJa(iso.slice(0, 10)) + ' ' + iso.slice(11, 16);
  }

  // ---------- API ----------

  function callApi(action, payload) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
    var body = Object.assign({ action: action }, payload);
    // text/plain にすることで CORS プリフライトを発生させない（GAS は OPTIONS に応答できない）
    return fetch(cfg.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).finally(function () {
      clearTimeout(timer);
    });
  }

  // ---------- 入力画面 ----------

  function option(value, label) {
    var o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    return o;
  }

  function renderForm() {
    var c = state.options.constraints;

    var today = jstBusinessToday(c.businessDayCutoffHour);
    var dateInput = $('visit-date');
    dateInput.min = today;
    dateInput.max = addDays(today, c.maxDaysAhead);
    if (!dateInput.value) dateInput.value = today;

    var timeSelect = $('visit-time');
    timeSelect.textContent = '';
    buildTimeSlots(cfg.TIME_SLOT_START || '18:00', cfg.TIME_SLOT_END || '04:00', c.timeStepMinutes)
      .forEach(function (s) {
        var o = option(s.value, s.label);
        if (s.time === cfg.DEFAULT_TIME && s.dayOffset === 0) o.selected = true;
        timeSelect.appendChild(o);
      });

    var guests = $('guests');
    guests.textContent = '';
    for (var g = c.minGuests; g <= c.maxGuests; g++) guests.appendChild(option(String(g), g + '名'));

    var castSelect = $('requested-cast');
    castSelect.textContent = '';
    castSelect.appendChild(option('', '指定なし'));
    state.options.casts.forEach(function (cast) { castSelect.appendChild(option(cast.castId, cast.displayName)); });
    $('cast-field').hidden = state.options.casts.length === 0;

    $('nickname').maxLength = c.nicknameMaxLength;
    $('note').maxLength = c.noteMaxLength;
  }

  function clearFieldErrors() {
    Array.prototype.forEach.call(document.querySelectorAll('.field-error'), function (el) {
      el.textContent = '';
      el.parentElement.classList.remove('has-error');
    });
  }

  function setFieldError(field, message) {
    var el = document.querySelector('.field-error[data-for="' + field + '"]');
    if (!el) return false;
    el.textContent = message;
    el.parentElement.classList.add('has-error');
    return true;
  }

  var SERVER_FIELD_MESSAGES = {
    nickname: 'お名前を確認してください。',
    scheduledAt: '日時を確認してください（過去の日時や受付期間外は選べません）。',
    numberOfGuests: '人数を確認してください。',
    requestedCastId: '選択したキャストは現在お選びいただけません。',
    note: '備考を確認してください。'
  };

  function collectDraft() {
    var c = state.options.constraints;
    var errors = {};
    var nickname = $('nickname').value.trim();
    if (!nickname) errors.nickname = 'お名前を入力してください。';
    else if (Array.from(nickname).length > c.nicknameMaxLength) errors.nickname = c.nicknameMaxLength + '文字以内で入力してください。';

    var visitDate = $('visit-date').value;
    var slot = $('visit-time').value.split('|');
    var dayOffset = Number(slot[0]);
    var time = slot[1];
    var actualDate = visitDate ? addDays(visitDate, dayOffset) : '';
    if (!visitDate) {
      errors.scheduledAt = 'ご来店日を選択してください。';
    } else {
      var p = actualDate.split('-').map(Number);
      var t = time.split(':').map(Number);
      var at = Date.UTC(p[0], p[1] - 1, p[2], t[0], t[1]) - JST_OFFSET_MS;
      if (at <= Date.now()) errors.scheduledAt = '過去の日時は選択できません。';
      else if (visitDate > $('visit-date').max) errors.scheduledAt = c.maxDaysAhead + '日先までご予約いただけます。';
    }

    var note = $('note').value.trim();
    if (Array.from(note).length > c.noteMaxLength) errors.note = c.noteMaxLength + '文字以内で入力してください。';

    var castId = $('requested-cast').value;
    var castName = castId ? $('requested-cast').selectedOptions[0].textContent : '';

    return {
      errors: errors,
      draft: {
        payload: {
          nickname: nickname,
          date: actualDate,
          time: time,
          numberOfGuests: Number($('guests').value),
          requestedCastId: castId,
          note: note
        },
        display: {
          datetime: visitDate
            ? formatDateJa(visitDate) + ' ' + (dayOffset ? '翌' + time + '（' + formatDateJa(actualDate) + ' ' + time + '）' : time)
            : '',
          castName: castName || '指定なし'
        }
      }
    };
  }

  function onFormSubmit(ev) {
    ev.preventDefault();
    clearFieldErrors();
    var result = collectDraft();
    var fields = Object.keys(result.errors);
    if (fields.length) {
      fields.forEach(function (f) { setFieldError(f, result.errors[f]); });
      return;
    }
    state.draft = result.draft;
    state.requestId = uuidv4();
    renderConfirm();
    show('view-confirm');
  }

  // ---------- 確認・送信 ----------

  function renderConfirm() {
    var d = state.draft;
    $('confirm-nickname').textContent = d.payload.nickname;
    $('confirm-datetime').textContent = d.display.datetime;
    $('confirm-guests').textContent = d.payload.numberOfGuests + '名';
    $('confirm-cast').textContent = d.display.castName;
    $('confirm-note').textContent = d.payload.note || 'なし';
    setStatus('');
  }

  function setStatus(message, isError) {
    var el = $('submit-status');
    el.textContent = message;
    el.classList.toggle('error', !!isError);
  }

  function setBusy(busy) {
    $('btn-submit').disabled = busy;
    $('btn-back').disabled = busy;
    $('btn-submit').textContent = busy ? '送信中…' : '予約を確定する';
  }

  function backToForm(fieldErrors) {
    state.requestId = null; // 内容を変えて送り直すときは新しいリクエストとして扱う
    clearFieldErrors();
    if (fieldErrors) {
      Object.keys(fieldErrors).forEach(function (f) {
        setFieldError(f, SERVER_FIELD_MESSAGES[f] || '入力内容を確認してください。');
      });
    }
    show('view-form');
  }

  function handleApiError(error) {
    var code = error && error.code;
    switch (code) {
      case 'VALIDATION_ERROR':
        backToForm(error.fields);
        return;
      case 'AUTH_REQUIRED':
      case 'AUTH_INVALID':
        setStatus('LINEの認証の有効期限が切れました。画面を閉じて、もう一度開き直してください。', true);
        return;
      case 'LIMIT_EXCEEDED':
        setStatus('ご予約中の件数が上限に達しています。変更はLINEのトークで店舗へご連絡ください。', true);
        return;
      case 'CUSTOMER_INACTIVE':
        setStatus('ご予約を受け付けできませんでした。LINEのトークで店舗へお問い合わせください。', true);
        return;
      case 'REQUEST_ID_CONFLICT':
        state.requestId = uuidv4();
        setStatus('もう一度「予約を確定する」を押してください。', true);
        return;
      default: // BUSY, AUTH_UNAVAILABLE, INTERNAL など: 同じ requestId で再送してよい
        setStatus('ただいま混み合っています。少し待ってから「予約を確定する」をもう一度押してください（二重には登録されません）。', true);
    }
  }

  function submitReservation() {
    if (state.submitting || !state.draft || !state.requestId) return;
    var idToken = liff.getIDToken();
    if (!idToken) {
      setStatus('LINEの認証情報を取得できませんでした。画面を閉じて、もう一度開き直してください。', true);
      return;
    }
    state.submitting = true;
    setBusy(true);
    setStatus('送信しています…');

    callApi('createReservation', {
      requestId: state.requestId,
      idToken: idToken,
      reservation: state.draft.payload
    }).then(function (res) {
      if (res && res.ok) {
        renderDone(res.reservation);
        state.requestId = null;
        state.draft = null;
        $('reservation-form').reset();
        show('view-done');
      } else {
        handleApiError(res && res.error);
      }
    }).catch(function () {
      // タイムアウト・通信断: 登録済みの可能性があるため、同じ requestId のまま再送してもらう
      setStatus('通信を確認できませんでした。電波の良い場所で「予約を確定する」をもう一度押してください（二重には登録されません）。', true);
    }).finally(function () {
      state.submitting = false;
      setBusy(false);
    });
  }

  // ---------- 完了 ----------

  function renderDone(r) {
    $('done-id').textContent = r.reservationId;
    $('done-datetime').textContent = formatScheduledAt(r.scheduledAt);
    $('done-guests').textContent = r.numberOfGuests + '名';
    $('done-nickname').textContent = r.nickname;
  }

  // ---------- 起動 ----------

  function init() {
    $('shop-name').textContent = cfg.SHOP_NAME || '';
    if (isPlaceholder(cfg.LIFF_ID) || isPlaceholder(cfg.API_URL)) {
      showFatal('設定が完了していません（config.js）。店舗へお問い合わせください。');
      return;
    }
    if (typeof liff === 'undefined') {
      showFatal('LINEの読み込みに失敗しました。LINEアプリから開き直してください。');
      return;
    }

    $('reservation-form').addEventListener('submit', onFormSubmit);
    $('btn-submit').addEventListener('click', submitReservation);
    $('btn-back').addEventListener('click', function () { backToForm(null); });
    $('btn-close').addEventListener('click', function () {
      if (liff.isInClient()) liff.closeWindow();
      else window.location.reload();
    });

    liff.init({ liffId: cfg.LIFF_ID })
      .then(function () {
        if (!liff.isLoggedIn()) {
          liff.login({ redirectUri: window.location.href });
          return null;
        }
        return callApi('getFormOptions', {});
      })
      .then(function (res) {
        if (res === null) return;
        if (!res || !res.ok) throw new Error('options');
        state.options = res;
        renderForm();
        show('view-form');
      })
      .catch(function () {
        showFatal('読み込みに失敗しました。時間をおいて、LINEアプリから開き直してください。');
      });
  }

  init();
})();
