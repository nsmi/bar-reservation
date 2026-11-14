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

  /**
   * 受付開始〜最終受付を step 分刻みで生成（例: 18:00〜翌04:00）。
   * 営業日の切り替え時刻より前の時刻は、来店日の翌日（「翌」）として扱う。
   */
  function buildTimeSlots(start, end, step, cutoffHour) {
    var cut = cutoffHour * 60;
    var rel = function (m) { return (m - cut + 1440) % 1440; };
    var s = rel(toMinutes(start));
    var e = rel(toMinutes(end));
    var slots = [];
    for (var r = s; r <= e; r += step) {
      var mm = (r + cut) % 1440;
      var dayOffset = mm < cut ? 1 : 0;
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
    var slots = buildTimeSlots(c.openTime, c.closeTime, c.timeStepMinutes, c.businessDayCutoffHour);
    // ご来店日は選択式（iPhone の日付入力は枠からはみ出すことがあるため使わない）。満席の日は選べない
    var dateSelect = $('visit-date');
    var previous = dateSelect.value;
    dateSelect.textContent = '';
    var firstOpen = '';
    for (var d = 0; d <= c.maxDaysAhead; d++) {
      var ds = addDays(today, d);
      var full = isDateFull(ds, slots);
      var o = option(ds, formatDateJa(ds).replace(/^\d+年/, '') + (d === 0 ? '（本日）' : d === 1 ? '（明日）' : '') + (full ? '（満席）' : ''));
      o.disabled = full;
      if (!full && !firstOpen) firstOpen = ds;
      dateSelect.appendChild(o);
    }
    var prevOption = previous ? dateSelect.querySelector('option[value="' + previous + '"]') : null;
    dateSelect.value = prevOption && !prevOption.disabled ? previous : (firstOpen || today);
    $('no-availability').hidden = !!firstOpen;
    renderTimeOptions();

    var guests = $('guests');
    guests.textContent = '';
    for (var g = c.minGuests; g <= c.maxGuests; g++) guests.appendChild(option(String(g), g + '名'));

    $('nickname').maxLength = c.nicknameMaxLength;
    $('note').maxLength = c.noteMaxLength;
  }

  function fullHoursOf(date) {
    var a = state.options.availability;
    return (a && a.fullHours && a.fullHours[date]) || [];
  }

  /** その日が満席か（1日の上限に達した日、またはすべての時間帯が満席の日） */
  function isDateFull(date, slots) {
    var a = state.options.availability;
    if (a && a.fullDates && a.fullDates.indexOf(date) >= 0) return true;
    var hours = fullHoursOf(date);
    return hours.length > 0 && slots.every(function (s) { return hours.indexOf(s.time.slice(0, 2)) >= 0; });
  }

  /** 選んだ日の時刻の選択肢。満席の時間帯は選べない */
  function renderTimeOptions() {
    var c = state.options.constraints;
    var timeSelect = $('visit-time');
    var previous = timeSelect.value;
    var hours = fullHoursOf($('visit-date').value);
    timeSelect.textContent = '';
    var pick = '';
    var fallback = '';
    var pastDefault = false;
    // 既定の時刻が満席なら、その後で最初に空いている時刻を選ぶ（なければ最初に空いている時刻）
    buildTimeSlots(c.openTime, c.closeTime, c.timeStepMinutes, c.businessDayCutoffHour).forEach(function (s) {
      if (s.time === c.defaultTime) pastDefault = true;
      var full = hours.indexOf(s.time.slice(0, 2)) >= 0;
      var o = option(s.value, s.label + (full ? '（満席）' : ''));
      o.disabled = full;
      timeSelect.appendChild(o);
      if (full) return;
      if (!fallback) fallback = s.value;
      if (!pick && pastDefault) pick = s.value;
    });
    if (previous && timeSelect.querySelector('option[value="' + previous + '"]') && !timeSelect.querySelector('option[value="' + previous + '"]').disabled) pick = previous;
    timeSelect.value = pick || fallback;
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
      else if (visitDate > addDays(jstBusinessToday(c.businessDayCutoffHour), c.maxDaysAhead)) errors.scheduledAt = c.maxDaysAhead + '日先までご予約いただけます。';
    }

    var note = $('note').value.trim();
    if (Array.from(note).length > c.noteMaxLength) errors.note = c.noteMaxLength + '文字以内で入力してください。';

    return {
      errors: errors,
      draft: {
        payload: {
          nickname: nickname,
          date: actualDate,
          time: time,
          numberOfGuests: Number($('guests').value),
          note: note
        },
        display: {
          datetime: visitDate
            ? formatDateJa(visitDate) + ' ' + (dayOffset ? '翌' + time + '（' + formatDateJa(actualDate) + ' ' + time + '）' : time)
            : ''
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
        setStatus('LINEの認証を確認できませんでした。画面を閉じて、もう一度開き直してください。（' + code + '）', true);
        return;
      case 'FULLY_BOOKED':
        // 入力中に満席になった: 空き状況を取り直して、日時を選び直してもらう
        state.requestId = null;
        callApi('getFormOptions', {}).then(function (res) {
          if (res && res.ok) { state.options = res; renderForm(); }
        }).catch(function () {}).then(function () {
          backToForm(null);
          var onlyGuests = error.fields && error.fields.capacity && error.fields.capacity.length === 1 && error.fields.capacity[0] === 'day_guests';
          setFieldError('scheduledAt', onlyGuests
            ? 'ご希望の人数では、この日は満席です。人数か日にちを変えてお選びください。'
            : '申し訳ありません。選択した日時は満席になりました。別の日時をお選びください。');
        });
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
    $('visit-date').addEventListener('change', renderTimeOptions);
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
