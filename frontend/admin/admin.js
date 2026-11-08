/**
 * 店舗用画面（LINEミニアプリ：店舗用チャネル）。
 * - 権限はサーバーが毎回判定する。ここでのタブ出し分けは表示上の都合のみ。
 * - 表示は textContent のみ（innerHTML は使わない）。
 * - 書き込み操作は requestId を付け、通信失敗時は同じ requestId で再送する（二重登録防止）。
 */
(function () {
  'use strict';

  var cfg = window.ADMIN_CONFIG || {};
  var JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  var REQUEST_TIMEOUT_MS = 25000;

  var LABELS = {
    role: { owner: 'オーナー', staff: 'スタッフ', cast: 'キャスト' },
    source: { line_customer: 'LINE予約', cast: '呼び予約', owner: '店舗受付', staff: '店舗受付' },
    status: { reserved: '予約中', visited: '来店済', cancelled: 'キャンセル', no_show: '来店なし' },
    type: { cast_invited: '呼び', store_customer: '店客', review_required: '要確認' },
    typeClass: { cast_invited: 'invited', store_customer: 'store', review_required: 'review' },
    reason: {
      no_reservation: '予約なし',
      customer_line_reservation: 'お客様のLINE予約',
      store_reservation: '店舗受付の予約',
      reserved_after_checkin: '来店後に予約登録',
      reservation_modified: '予約が変更されている',
      registered_by_other: '担当キャスト以外が登録',
      cast_inactive: '担当キャストが無効',
      self_checkin: '担当キャスト本人が来店登録',
      registered_shortly_before: '来店直前に予約登録',
      reservation_incomplete: '予約情報が不完全',
      cast_reservation: 'キャストの事前予約',
      owner_override: 'オーナーが判定を変更'
    },
    payment: { cash: '現金', card: 'カード', qr: 'QR決済', other: 'その他' }
  };

  var ERROR_MESSAGES = {
    FORBIDDEN: 'この操作の権限がありません。',
    NOT_FOUND: '対象が見つかりません。画面を更新してください。',
    BUSY: '混み合っています。少し待ってからもう一度お試しください。',
    RESERVATION_NOT_AVAILABLE: 'この予約はすでに来店登録済みか、キャンセルされています。',
    RESERVATION_NOT_TODAY: '本日（現在の営業日）の予約ではありません。',
    ALREADY_PAID: 'この来店はすでに会計登録済みです。',
    VERSION_CONFLICT: '他の人が先に変更しました。画面を更新してください。',
    REQUEST_ID_CONFLICT: 'もう一度お試しください。',
    INVITE_INVALID: '招待コードが正しくないか、有効期限切れ・使用済みです。オーナーに再発行を依頼してください。',
    ALREADY_LINKED: 'このLINEアカウントは別のユーザーとして登録済みです。'
  };

  var state = {
    me: null,
    constraints: null,
    currentBusinessDate: null,
    date: null,
    tab: null,
    customers: null
  };

  // ---------- 汎用 ----------

  function $(id) { return document.getElementById(id); }

  /** h('div', {className: 'x', onclick: fn}, child1, 'text', ...) */
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === undefined || v === null || v === false) return;
        if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
        else if (k === 'className' || k === 'textContent' || k === 'value' || k === 'hidden' || k === 'disabled' || k === 'selected' || k === 'checked') el[k] = v;
        else el.setAttribute(k, v);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) el.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); });
      else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return el;
  }

  function showView(id) {
    ['view-loading', 'view-error', 'view-register', 'view-app'].forEach(function (v) { $(v).hidden = v !== id; });
  }

  function fatal(message) {
    $('error-message').textContent = message;
    showView('view-error');
  }

  var toastTimer = null;
  function toast(message, isError) {
    var el = $('toast');
    el.textContent = message;
    el.classList.toggle('error', !!isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, isError ? 8000 : 4000);
  }

  function uuidv4() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    var b = new Uint8Array(16);
    window.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var x = Array.prototype.map.call(b, function (n) { return (n + 0x100).toString(16).slice(1); }).join('');
    return x.slice(0, 8) + '-' + x.slice(8, 12) + '-' + x.slice(12, 16) + '-' + x.slice(16, 20) + '-' + x.slice(20);
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function yen(n) { return Number(n).toLocaleString('ja-JP') + '円'; }
  function timeOf(iso) { return iso ? iso.slice(11, 16) : ''; }
  function dateOf(iso) { return iso ? iso.slice(0, 10) : ''; }

  function addDays(dateStr, n) {
    var p = dateStr.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
  }

  function formatDateJa(dateStr) {
    var p = dateStr.split('-').map(Number);
    var w = '日月火水木金土'.charAt(new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay());
    return p[1] + '/' + p[2] + '(' + w + ')';
  }

  /** 営業日表示用: 営業日の翌日の時刻は「翌」を付ける */
  function timeLabel(iso, businessDate) {
    return (dateOf(iso) > businessDate ? '翌' : '') + timeOf(iso);
  }

  function buildTimeSlots(step) {
    var toMin = function (s) { var p = s.split(':').map(Number); return p[0] * 60 + p[1]; };
    var s = toMin(cfg.TIME_SLOT_START || '18:00');
    var e = toMin(cfg.TIME_SLOT_END || '04:00');
    if (e <= s) e += 1440;
    var out = [];
    for (var m = s; m <= e; m += step) {
      var off = m >= 1440 ? 1 : 0;
      var mm = m % 1440;
      var t = pad2(Math.floor(mm / 60)) + ':' + pad2(mm % 60);
      out.push({ value: off + '|' + t, label: (off ? '翌' : '') + t, time: t, off: off });
    }
    return out;
  }

  function isPlaceholder(v) { return !v || /^REPLACE_WITH_/.test(v); }

  // ---------- API ----------

  function rawCall(action, payload) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
    var body = Object.assign({ action: action, idToken: liff.getIDToken() }, payload || {});
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
    }).finally(function () { clearTimeout(timer); });
  }

  /**
   * API 呼び出し。認証エラーは画面全体のエラーにする。
   * @return Promise<object|null> 成功時は結果、業務エラー時は null（メッセージ表示済み）
   */
  function api(action, payload, opts) {
    opts = opts || {};
    return rawCall(action, payload).then(function (res) {
      if (res && res.ok) return res;
      var code = res && res.error && res.error.code;
      if (code === 'AUTH_INVALID' || code === 'AUTH_REQUIRED') {
        fatal('LINEの認証を確認できませんでした。画面を閉じて、もう一度開き直してください。（' + code + '）');
        return null;
      }
      if (code === 'NOT_REGISTERED') { showView('view-register'); return null; }
      if (opts.onError && opts.onError(res.error)) return null;
      var msg = ERROR_MESSAGES[code];
      if (!msg && code === 'VALIDATION_ERROR') msg = '入力内容を確認してください。';
      toast((msg || 'エラーが発生しました。') + '（' + (code || 'UNKNOWN') + '）', true);
      return null;
    }, function () {
      toast('通信を確認できませんでした。電波の良い場所でもう一度お試しください（二重には登録されません）。', true);
      return null;
    });
  }

  /** 書き込み用: ボタンを処理中にし、成功するまで同じ requestId を使う */
  function submitWrite(button, holder, action, payloadFn, onSuccess, opts) {
    if (button.disabled) return;
    holder.requestId = holder.requestId || uuidv4();
    var label = button.textContent;
    button.disabled = true;
    button.textContent = '送信中…';
    api(action, Object.assign({ requestId: holder.requestId }, payloadFn()), opts).then(function (res) {
      if (res) {
        holder.requestId = null;
        onSuccess(res);
      }
    }).finally(function () {
      button.disabled = false;
      button.textContent = label;
    });
  }

  // ---------- 共通部品 ----------

  function badge(text, cls) { return h('span', { className: 'badge ' + (cls || '') }, text); }

  function typeBadge(type) { return badge(LABELS.type[type] || type, LABELS.typeClass[type]); }

  function card(title, children, action) {
    return h('section', { className: 'card' }, h('h2', null, h('span', null, title), action || null), children);
  }

  function fieldEl(label, input, hint) {
    return h('div', { className: 'field' }, h('label', null, label), input, hint ? h('p', { className: 'hint' }, hint) : null);
  }

  function selectEl(options, selected) {
    var s = h('select');
    options.forEach(function (o) {
      s.appendChild(h('option', { value: o.value, selected: o.value === selected }, o.label));
    });
    return s;
  }

  function loadCustomers(force) {
    if (state.customers && !force) return Promise.resolve(state.customers);
    return api('staff.listCustomers').then(function (res) {
      if (res) state.customers = res.customers;
      return state.customers || [];
    });
  }

  /** 顧客選択（既存から選ぶ / 新規あだ名）。getValue() で {customerId} か {newCustomerNickname} を返す */
  function customerPicker() {
    var mode = selectEl([{ value: 'existing', label: '登録済みのお客様から選ぶ' }, { value: 'new', label: '新しいお客様（あだ名を入力）' }], 'existing');
    var filter = h('input', { type: 'search', placeholder: 'あだ名で絞り込み' });
    var list = h('select');
    var nick = h('input', { type: 'text', maxlength: String(state.constraints.nicknameMaxLength), placeholder: 'あだ名' });
    var existingBox = h('div', null, filter, h('div', { style: 'height:8px' }), list);
    var newBox = h('div', { hidden: true }, nick);

    function fill() {
      var q = filter.value.trim();
      list.textContent = '';
      (state.customers || []).filter(function (c) { return !q || c.nickname.indexOf(q) >= 0; }).slice(0, 200)
        .forEach(function (c) { list.appendChild(h('option', { value: c.customerId }, c.nickname + '（' + c.customerId + '）')); });
      if (!list.options.length) list.appendChild(h('option', { value: '' }, '該当なし'));
    }
    filter.addEventListener('input', fill);
    mode.addEventListener('change', function () {
      existingBox.hidden = mode.value !== 'existing';
      newBox.hidden = mode.value !== 'new';
    });
    loadCustomers().then(function (cs) {
      fill();
      if (!cs.length) { mode.value = 'new'; mode.dispatchEvent(new Event('change')); }
    });

    return {
      el: h('div', null, fieldEl('お客様', mode), existingBox, newBox),
      getValue: function () {
        if (mode.value === 'new') return { newCustomerNickname: nick.value.trim() };
        return { customerId: list.value };
      },
      validate: function () {
        if (mode.value === 'new' ? !nick.value.trim() : !list.value) {
          toast('お客様を選択するか、あだ名を入力してください。', true);
          return false;
        }
        return true;
      }
    };
  }

  // ---------- タブ ----------

  var TABS = [
    { id: 'reservations', label: '予約', roles: ['owner', 'staff', 'cast'], render: renderReservations },
    { id: 'visits', label: '来店', roles: ['owner', 'staff', 'cast'], render: renderVisits },
    { id: 'payments', label: '会計', roles: ['owner', 'staff'], render: renderPayments },
    { id: 'summary', label: '集計', roles: ['owner', 'staff', 'cast'], render: renderSummary },
    { id: 'users', label: 'ユーザー', roles: ['owner'], render: renderUsers }
  ];

  function renderTabs() {
    var nav = $('tabs');
    nav.textContent = '';
    TABS.filter(function (t) { return t.roles.indexOf(state.me.role) >= 0; }).forEach(function (t) {
      nav.appendChild(h('button', {
        type: 'button', role: 'tab', 'aria-selected': String(state.tab === t.id),
        onclick: function () { state.tab = t.id; renderTabs(); renderPanel(); }
      }, t.label));
    });
  }

  function renderPanel() {
    var tab = TABS.filter(function (t) { return t.id === state.tab; })[0];
    var panel = $('panel');
    panel.textContent = '';
    panel.appendChild(h('div', { className: 'card center' }, h('div', { className: 'spinner' })));
    tab.render(panel);
  }

  function replacePanel(panel, nodes) {
    panel.textContent = '';
    nodes.forEach(function (n) { if (n) panel.appendChild(n); });
  }

  // ---------- 予約 ----------

  function renderReservations(panel) {
    api('staff.listReservations', { businessDate: state.date }).then(function (res) {
      if (!res) return;
      var items = res.reservations.map(function (r) {
        var cast = r.castName ? (r.castKind === 'assigned' ? '担当: ' : '希望: ') + r.castName : '';
        return h('li', null,
          h('div', { className: 'row' },
            h('strong', null, timeLabel(r.scheduledAt, state.date) + '  ' + r.nickname + '（' + r.numberOfGuests + '名）'),
            badge(LABELS.status[r.status] || r.status, r.status === 'reserved' ? '' : 'muted')),
          h('div', { className: 'meta' }, [LABELS.source[r.source] || r.source, cast, r.createdByName ? '登録: ' + r.createdByName : ''].filter(Boolean).join(' / ')),
          r.note ? h('div', { className: 'meta pre' }, r.note) : null);
      });
      var title = (state.me.role === 'cast' ? 'あなたの予約' : '予約一覧') + '（' + formatDateJa(state.date) + '）';
      replacePanel(panel, [
        reservationForm(),
        card(title, items.length ? h('ul', { className: 'list' }, items) : h('p', { className: 'empty' }, '予約はありません。'))
      ]);
    });
  }

  function reservationForm() {
    var c = state.constraints;
    var holder = {};
    var isCast = state.me.role === 'cast';
    var body = h('div', { hidden: true });
    var toggle = h('button', { type: 'button', className: 'btn small' }, '＋ 登録');
    toggle.addEventListener('click', function () { body.hidden = !body.hidden; });

    var picker = customerPicker();
    var date = h('input', { type: 'date', value: state.date < state.currentBusinessDate ? state.currentBusinessDate : state.date, min: state.currentBusinessDate, max: addDays(state.currentBusinessDate, c.maxDaysAhead) });
    var time = selectEl(buildTimeSlots(c.timeStepMinutes), '0|' + (cfg.DEFAULT_TIME || '21:00'));
    var guestOpts = [];
    for (var g = c.minGuests; g <= c.maxGuests; g++) guestOpts.push({ value: String(g), label: g + '名' });
    var guests = selectEl(guestOpts, '1');
    var note = h('textarea', { rows: '2', maxlength: String(c.noteMaxLength) });
    var submit = h('button', { type: 'button', className: 'btn primary' }, '予約を登録する');

    submit.addEventListener('click', function () {
      if (!picker.validate()) return;
      if (!date.value) { toast('来店日を選択してください。', true); return; }
      var slot = time.value.split('|');
      var payload = function () {
        return {
          reservation: Object.assign(picker.getValue(), {
            date: addDays(date.value, Number(slot[0])),
            time: slot[1],
            numberOfGuests: Number(guests.value),
            note: note.value
          })
        };
      };
      submitWrite(submit, holder, 'staff.createReservation', payload, function () {
        toast('予約を登録しました。');
        state.customers = null;
        renderPanel();
      }, {
        onError: function (err) {
          if (err.code === 'VALIDATION_ERROR' && err.fields && err.fields.scheduledAt) {
            toast('日時を確認してください（過去の日時は登録できません）。', true);
            holder.requestId = null;
            return true;
          }
          return false;
        }
      });
    });

    body.appendChild(picker.el);
    body.appendChild(fieldEl('来店日（営業日）', date));
    body.appendChild(fieldEl('来店時刻', time, '「翌」は来店日の深夜です。'));
    body.appendChild(fieldEl('人数', guests));
    body.appendChild(fieldEl('備考', note));
    body.appendChild(submit);

    var hint = isCast
      ? 'あなたの担当（呼び予約）として登録されます。来店前に登録してください。'
      : '店舗受付の予約として登録されます（呼びにはなりません）。';
    return card(isCast ? '呼び予約の登録' : '予約の登録', [h('p', { className: 'hint' }, hint), body], toggle);
  }

  // ---------- 来店 ----------

  function renderVisits(panel) {
    var isToday = state.date === state.currentBusinessDate;
    Promise.all([
      api('staff.listVisits', { businessDate: state.date }),
      isToday ? api('staff.listReservations', { businessDate: state.currentBusinessDate }) : Promise.resolve(null),
      state.me.role === 'owner' ? api('staff.listUsers') : Promise.resolve(null)
    ]).then(function (r) {
      var visitsRes = r[0];
      if (!visitsRes) return;
      var casts = r[2] ? r[2].users.filter(function (u) { return u.role === 'cast'; }) : [];
      var nodes = [];
      if (isToday) {
        var reserved = r[1] ? r[1].reservations.filter(function (x) { return x.status === 'reserved'; }) : [];
        nodes.push(checkInFromReservations(reserved));
        nodes.push(walkInForm());
      } else {
        nodes.push(h('p', { className: 'hint' }, '来店登録は現在の営業日（' + formatDateJa(state.currentBusinessDate) + '）のみ行えます。'));
      }
      nodes.push(visitList(visitsRes.visits, casts));
      replacePanel(panel, nodes);
    });
  }

  function checkInFromReservations(reserved) {
    var items = reserved.map(function (r) {
      var holder = {};
      var btn = h('button', { type: 'button', className: 'btn small primary' }, '来店');
      btn.addEventListener('click', function () {
        if (!window.confirm(r.nickname + ' 様の来店を登録しますか？')) return;
        submitWrite(btn, holder, 'staff.checkIn', function () { return { reservationId: r.reservationId }; }, function (res) {
          toast('来店登録しました：' + (LABELS.type[res.visit.invitationType] || '') + '（' + (LABELS.reason[res.visit.reason] || res.visit.reason) + '）');
          renderPanel();
        });
      });
      return h('li', null, h('div', { className: 'row' },
        h('span', null, h('strong', null, timeLabel(r.scheduledAt, state.date) + '  ' + r.nickname),
          h('span', { className: 'meta' }, '  ' + (LABELS.source[r.source] || '') + (r.castName ? ' / ' + r.castName : ''))),
        btn));
    });
    return card('予約から来店登録',
      items.length ? h('ul', { className: 'list' }, items) : h('p', { className: 'empty' }, '来店待ちの予約はありません。'));
  }

  function walkInForm() {
    var holder = {};
    var body = h('div', { hidden: true });
    var toggle = h('button', { type: 'button', className: 'btn small' }, '開く');
    toggle.addEventListener('click', function () { body.hidden = !body.hidden; });
    var picker = customerPicker();
    var submit = h('button', { type: 'button', className: 'btn primary' }, '来店を登録する');
    submit.addEventListener('click', function () {
      if (!picker.validate()) return;
      submitWrite(submit, holder, 'staff.checkIn', picker.getValue, function () {
        toast('来店登録しました：店客');
        state.customers = null;
        renderPanel();
      });
    });
    body.appendChild(picker.el);
    body.appendChild(submit);
    return card('予約なしで来店', body, toggle);
  }

  function visitList(visits, casts) {
    var isOwner = state.me.role === 'owner';
    var items = visits.map(function (v) {
      var li = h('li', null,
        h('div', { className: 'row' },
          h('strong', null, timeLabel(v.checkedInAt, state.date) + '  ' + v.nickname),
          typeBadge(v.invitationType)),
        h('div', { className: 'meta' }, [
          LABELS.reason[v.reason] || v.reason,
          v.attributedCastName ? 'キャスト: ' + v.attributedCastName : '',
          '登録: ' + v.checkedInByName,
          v.paid ? (v.transaction ? '会計 ' + yen(v.transaction.totalAmount) : '会計済') : '未会計'
        ].filter(Boolean).join(' / ')));
      if (isOwner) li.appendChild(overrideControl(v, casts));
      return li;
    });
    return card('来店一覧（' + formatDateJa(state.date) + '）',
      items.length ? h('ul', { className: 'list' }, items) : h('p', { className: 'empty' }, '来店はありません。'));
  }

  function overrideControl(v, casts) {
    var wrap = h('div');
    var open = h('button', { type: 'button', className: 'btn small' }, '判定を変更');
    var form = h('div', { className: 'inline-form', hidden: true });
    open.addEventListener('click', function () { form.hidden = !form.hidden; });

    var type = selectEl([{ value: 'cast_invited', label: '呼び' }, { value: 'store_customer', label: '店客' }],
      v.invitationType === 'store_customer' ? 'store_customer' : 'cast_invited');
    var cast = selectEl(casts.map(function (c) { return { value: c.userId, label: c.displayName + (c.active ? '' : '（無効）') }; }), v.attributedCastId);
    var castField = fieldEl('担当キャスト', cast);
    var reason = h('textarea', { rows: '2', maxlength: '200', placeholder: '変更理由（必須）' });
    var submit = h('button', { type: 'button', className: 'btn primary' }, '変更する');
    type.addEventListener('change', function () { castField.hidden = type.value !== 'cast_invited'; });
    castField.hidden = type.value !== 'cast_invited';

    submit.addEventListener('click', function () {
      if (!reason.value.trim()) { toast('変更理由を入力してください。', true); return; }
      if (type.value === 'cast_invited' && !cast.value) { toast('担当キャストを選択してください。', true); return; }
      submit.disabled = true;
      api('staff.overrideInvitation', {
        visitId: v.visitId,
        invitationType: type.value,
        attributedCastId: type.value === 'cast_invited' ? cast.value : '',
        reason: reason.value,
        expectedVersion: v.version
      }).then(function (res) {
        submit.disabled = false;
        if (res) { toast('判定を変更しました。'); renderPanel(); }
      });
    });

    form.appendChild(fieldEl('判定', type));
    form.appendChild(castField);
    form.appendChild(fieldEl('理由', reason));
    form.appendChild(submit);
    wrap.appendChild(open);
    wrap.appendChild(form);
    return wrap;
  }

  // ---------- 会計 ----------

  function renderPayments(panel) {
    api('staff.listVisits', { businessDate: state.date }).then(function (res) {
      if (!res) return;
      var unpaid = res.visits.filter(function (v) { return !v.paid; });
      var paid = res.visits.filter(function (v) { return v.paid; });
      var paidItems = paid.map(function (v) {
        var t = v.transaction;
        return h('li', null, h('div', { className: 'row' },
          h('span', null, v.nickname + ' ', typeBadge(v.invitationType)),
          h('strong', { className: 'amount' }, yen(t.totalAmount))),
          h('div', { className: 'meta' }, 'うちキャストドリンク ' + yen(t.castDrinkAmount) + ' / ' + (LABELS.payment[t.paymentMethod] || t.paymentMethod)));
      });
      replacePanel(panel, [
        paymentForm(unpaid),
        card('会計済み（' + formatDateJa(state.date) + '）',
          paidItems.length ? h('ul', { className: 'list' }, paidItems) : h('p', { className: 'empty' }, 'まだありません。'))
      ]);
    });
  }

  function paymentForm(unpaid) {
    if (!unpaid.length) return card('会計登録', h('p', { className: 'empty' }, '未会計の来店はありません。'));
    var holder = {};
    var visit = selectEl(unpaid.map(function (v) {
      return { value: v.visitId, label: timeLabel(v.checkedInAt, state.date) + ' ' + v.nickname + '（' + (LABELS.type[v.invitationType] || '') + '）' };
    }), unpaid[0].visitId);
    visit.addEventListener('change', function () { holder.requestId = null; });
    var total = h('input', { type: 'number', inputmode: 'numeric', min: '0', step: '1', placeholder: '例: 12000' });
    var drink = h('input', { type: 'number', inputmode: 'numeric', min: '0', step: '1', value: '0' });
    var method = selectEl(Object.keys(LABELS.payment).map(function (k) { return { value: k, label: LABELS.payment[k] }; }), 'cash');
    var note = h('textarea', { rows: '2', maxlength: '200' });
    var submit = h('button', { type: 'button', className: 'btn primary' }, '会計を登録する');

    submit.addEventListener('click', function () {
      var t = Number(total.value);
      var d = Number(drink.value || 0);
      if (!total.value || !Number.isInteger(t) || t < 0) { toast('会計総額を整数（円）で入力してください。', true); return; }
      if (!Number.isInteger(d) || d < 0 || d > t) { toast('キャストドリンク金額は0以上、会計総額以下で入力してください。', true); return; }
      if (!window.confirm('会計 ' + yen(t) + '（うちキャストドリンク ' + yen(d) + '）を登録しますか？')) return;
      submitWrite(submit, holder, 'staff.createTransaction', function () {
        return { visitId: visit.value, totalAmount: t, castDrinkAmount: d, paymentMethod: method.value, note: note.value };
      }, function () {
        toast('会計を登録しました。');
        renderPanel();
      });
    });

    return card('会計登録', [
      fieldEl('来店', visit),
      fieldEl('会計総額（円）', total, 'キャストドリンク代を含めた総額'),
      fieldEl('うちキャストドリンク（円）', drink),
      fieldEl('決済方法', method),
      fieldEl('備考', note),
      submit
    ]);
  }

  // ---------- 集計 ----------

  function stat(label, value, wide) {
    return h('div', { className: 'stat' + (wide ? ' wide' : '') }, h('div', { className: 'label' }, label), h('div', { className: 'value' }, value));
  }

  function renderSummary(panel) {
    api('staff.dailySummary', { businessDate: state.date }).then(function (res) {
      if (!res) return;
      var s = res.summary;
      var title = '集計（' + formatDateJa(state.date) + '）';
      if (state.me.role === 'cast') {
        replacePanel(panel, [card(title, [
          h('div', { className: 'stats' },
            stat('あなたの呼び売上', yen(s.invitedSales)),
            stat('日払い予定', yen(s.payout)),
            stat('呼び来店数', s.visitCount + '件'),
            stat('確認中', s.reviewPendingCount + '件')),
          h('p', { className: 'hint' }, '「確認中」はオーナーの確認後に日払い対象になる場合があります。')
        ])]);
        return;
      }
      var castItems = s.casts.map(function (c) {
        return h('li', null, h('div', { className: 'row' }, h('strong', null, c.castName || c.castId), h('span', { className: 'meta' }, c.visitCount + '件')),
          h('div', { className: 'row' }, h('span', null, '呼び売上 ' + yen(c.invitedSales)), h('strong', { className: 'amount' }, '日払い ' + yen(c.payout))));
      });
      var reviewItems = s.reviewList.map(function (r) {
        return h('li', null, h('div', { className: 'row' }, h('strong', null, r.nickname || r.visitId), h('span', { className: 'amount' }, r.amount === null ? '未会計' : yen(r.amount))),
          h('div', { className: 'meta' }, [r.castName ? 'キャスト: ' + r.castName : '', LABELS.reason[r.reason] || r.reason].filter(Boolean).join(' / ')));
      });
      replacePanel(panel, [
        card(title, [
          h('div', { className: 'stats' },
            stat('店舗総売上', yen(s.totalSales), true),
            stat('呼び売上', yen(s.invitedSales)),
            stat('店客売上', yen(s.storeSales)),
            stat('要確認', yen(s.reviewSales)),
            stat('未会計', s.unpaidVisitCount + '件')),
          h('p', { className: 'hint' }, '呼び売上・店客売上・要確認は店舗総売上の内訳です。日払いは会計総額（キャストドリンク代込み）の' + state.constraints.payoutRatePercent + '%（1円未満切り捨て）。')
        ]),
        card('キャスト別', castItems.length ? h('ul', { className: 'list' }, castItems) : h('p', { className: 'empty' }, '呼び売上はありません。')),
        card('要確認一覧', reviewItems.length
          ? [h('ul', { className: 'list' }, reviewItems), state.me.role === 'owner' ? h('p', { className: 'hint' }, '「来店」タブの「判定を変更」で確定してください。') : null]
          : h('p', { className: 'empty' }, '要確認の来店はありません。'))
      ]);
    });
  }

  // ---------- ユーザー管理 ----------

  function inviteBox(name, invite) {
    return card('招待コード：' + name, [
      h('div', { className: 'code-box' }, invite.code),
      h('p', { className: 'hint' }, 'このコードを本人にLINEで送ってください。本人が店舗用画面を開いて入力すると登録されます。'
        + '有効期限: ' + formatDateJa(dateOf(invite.expiresAt)) + ' ' + timeOf(invite.expiresAt) + '（1回のみ使用可）')
    ]);
  }

  function renderUsers(panel, inviteNode) {
    api('staff.listUsers').then(function (res) {
      if (!res) return;
      var items = res.users.map(function (u) {
        var actions = h('div', { className: 'row' });
        if (u.userId !== state.me.userId) {
          var toggle = h('button', { type: 'button', className: 'btn small' }, u.active ? '無効にする' : '有効にする');
          toggle.addEventListener('click', function () {
            if (!window.confirm(u.displayName + ' を' + (u.active ? '無効' : '有効') + 'にしますか？')) return;
            toggle.disabled = true;
            api('staff.setUserActive', { userId: u.userId, active: !u.active }).then(function (r) {
              toggle.disabled = false;
              if (r) { toast('更新しました。'); renderPanel(); }
            });
          });
          actions.appendChild(toggle);
        }
        if (u.active) {
          var inv = h('button', { type: 'button', className: 'btn small' }, '招待コード発行');
          inv.addEventListener('click', function () {
            if (u.linked && !window.confirm(u.displayName + ' は登録済みです。LINEアカウントを紐づけ直すための招待コードを発行しますか？')) return;
            inv.disabled = true;
            api('staff.issueInvite', { userId: u.userId }).then(function (r) {
              inv.disabled = false;
              if (r) renderUsersWithInvite(u.displayName, r.invite);
            });
          });
          actions.appendChild(inv);
        }
        return h('li', null,
          h('div', { className: 'row' }, h('strong', null, u.displayName), h('span', null,
            badge(LABELS.role[u.role] || u.role), ' ',
            u.active ? (u.linked ? badge('登録済', 'invited') : badge('未登録', 'review')) : badge('無効', 'muted'))),
          h('div', { className: 'meta' }, u.userId),
          actions);
      });
      replacePanel(panel, [inviteNode || null, newUserForm(), card('ユーザー一覧', h('ul', { className: 'list' }, items))]);
    });
  }

  function renderUsersWithInvite(name, invite) {
    renderUsers($('panel'), inviteBox(name, invite));
    window.scrollTo(0, 0);
  }

  function newUserForm() {
    var name = h('input', { type: 'text', maxlength: String(state.constraints.displayNameMaxLength), placeholder: '表示名（例: あや）' });
    var role = selectEl([{ value: 'cast', label: 'キャスト' }, { value: 'staff', label: 'スタッフ' }, { value: 'owner', label: 'オーナー' }], 'cast');
    var submit = h('button', { type: 'button', className: 'btn primary' }, '追加して招待コードを発行');
    submit.addEventListener('click', function () {
      if (!name.value.trim()) { toast('表示名を入力してください。', true); return; }
      if (role.value === 'owner' && !window.confirm('オーナー権限（全操作が可能）で追加しますか？')) return;
      submit.disabled = true;
      api('staff.createUser', { displayName: name.value, role: role.value }).then(function (r) {
        submit.disabled = false;
        if (r) renderUsersWithInvite(r.user.displayName, r.invite);
      });
    });
    return card('ユーザーを追加', [fieldEl('表示名', name), fieldEl('権限', role), submit]);
  }

  // ---------- 起動 ----------

  function startApp(me) {
    state.me = me.user;
    state.constraints = me.constraints;
    state.currentBusinessDate = me.businessDate;
    state.date = me.businessDate;
    state.tab = state.tab || (state.me.role === 'cast' ? 'reservations' : 'visits');
    $('whoami').textContent = state.me.displayName + '（' + (LABELS.role[state.me.role] || state.me.role) + '）';
    var dateInput = $('business-date');
    dateInput.value = state.date;
    showView('view-app');
    renderTabs();
    renderPanel();
  }

  function loadMe() {
    return api('staff.me').then(function (me) { if (me) startApp(me); });
  }

  function init() {
    $('shop-name').textContent = cfg.SHOP_NAME || '';
    if (isPlaceholder(cfg.STAFF_LIFF_ID) || isPlaceholder(cfg.API_URL)) {
      fatal('設定が完了していません（admin/config.js）。');
      return;
    }
    if (typeof liff === 'undefined') {
      fatal('LINEの読み込みに失敗しました。LINEアプリから開き直してください。');
      return;
    }

    $('business-date').addEventListener('change', function (e) {
      if (!e.target.value) return;
      state.date = e.target.value;
      renderPanel();
    });
    $('btn-today').addEventListener('click', function () {
      state.date = state.currentBusinessDate;
      $('business-date').value = state.date;
      renderPanel();
    });

    $('register-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var btn = ev.target.querySelector('button');
      var errEl = document.querySelector('#register-form .field-error');
      var code = $('invite-code').value;
      errEl.textContent = '';
      if (!code.trim()) { errEl.textContent = '招待コードを入力してください。'; return; }
      btn.disabled = true;
      api('staff.redeemInvite', { code: code }, {
        onError: function (err) {
          errEl.textContent = ERROR_MESSAGES[err.code] || ('登録できませんでした。（' + err.code + '）');
          return true;
        }
      }).then(function (r) {
        btn.disabled = false;
        if (r) { showView('view-loading'); loadMe(); }
      });
    });

    liff.init({ liffId: cfg.STAFF_LIFF_ID })
      .then(function () {
        if (!liff.isLoggedIn()) {
          liff.login({ redirectUri: window.location.href });
          return null;
        }
        return loadMe();
      })
      .catch(function () {
        fatal('読み込みに失敗しました。時間をおいて、LINEアプリから開き直してください。');
      });
  }

  init();
})();
