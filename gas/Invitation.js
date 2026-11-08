/**
 * 呼び判定（引き継ぎ資料 6. / 確定ルールは docs/business-rules.md）。
 * 判定はすべてサーバー時刻と、サーバーで記録した予約情報だけで行う。
 */
var INVITATION_TYPE = {
  CAST_INVITED: 'cast_invited',
  STORE_CUSTOMER: 'store_customer',
  REVIEW_REQUIRED: 'review_required'
};

/**
 * @param {Object} p
 *   reservation: 来店に紐づける予約（なければ null）
 *   checkedInBy: 来店登録した店舗ユーザー
 *   checkedInAt: 来店登録時刻（サーバー時刻）
 *   users: Users 全件
 *   thresholdMinutes: 直前予約とみなす分数
 * @return {{type: string, castId: string, reason: string}}
 */
function determineInvitation_(p) {
  var r = p.reservation;
  if (!r) return result_(INVITATION_TYPE.STORE_CUSTOMER, '', 'no_reservation');

  if (r.source === 'line_customer') {
    // 顧客が選んだ希望キャストは呼びの根拠にしない
    return result_(INVITATION_TYPE.STORE_CUSTOMER, '', 'customer_line_reservation');
  }
  if (r.source !== 'cast') {
    return result_(INVITATION_TYPE.STORE_CUSTOMER, '', 'store_reservation');
  }

  var castId = r.assigned_cast_id;
  var createdAt = parseIsoDate_(r.created_at);
  if (!castId || !createdAt) return result_(INVITATION_TYPE.REVIEW_REQUIRED, castId || '', 'reservation_incomplete');

  if (createdAt.getTime() >= p.checkedInAt.getTime()) {
    return result_(INVITATION_TYPE.STORE_CUSTOMER, '', 'reserved_after_checkin');
  }
  if (String(r.version) !== '1') {
    return result_(INVITATION_TYPE.REVIEW_REQUIRED, castId, 'reservation_modified');
  }
  if (r.created_by_user_id !== castId) {
    return result_(INVITATION_TYPE.REVIEW_REQUIRED, castId, 'registered_by_other');
  }

  var cast = null;
  for (var i = 0; i < p.users.length; i++) {
    if (p.users[i].user_id === castId) { cast = p.users[i]; break; }
  }
  if (!cast || cast.role !== 'cast' || !isTruthyCell_(cast.active)) {
    return result_(INVITATION_TYPE.REVIEW_REQUIRED, castId, 'cast_inactive');
  }
  if (p.checkedInBy.user_id === castId) {
    return result_(INVITATION_TYPE.REVIEW_REQUIRED, castId, 'self_checkin');
  }
  if (p.checkedInAt.getTime() - createdAt.getTime() < p.thresholdMinutes * 60 * 1000) {
    return result_(INVITATION_TYPE.REVIEW_REQUIRED, castId, 'registered_shortly_before');
  }
  return result_(INVITATION_TYPE.CAST_INVITED, castId, 'cast_reservation');
}

function result_(type, castId, reason) {
  return { type: type, castId: castId, reason: reason };
}

/**
 * 日次集計。呼び売上は総売上の内訳（別売上として加算しない）。
 * 日払い = キャストごとに Σ(会計総額 × 日払い率%) ÷ 100 を1円未満切り捨て。
 * 会計総額にはキャストドリンク代を含む。要確認の来店はオーナー判定まで日払い対象外。
 */
function computeDailySummary_(visits, transactions, users, customers, businessDate) {
  var visitById = {};
  var dayVisits = visits.filter(function (v) { return v.business_date === businessDate; });
  dayVisits.forEach(function (v) { visitById[v.visit_id] = v; });
  var userById = indexBy_(users, 'user_id');
  var customerById = indexBy_(customers, 'customer_id');

  var totals = { totalSales: 0, invitedSales: 0, storeSales: 0, reviewSales: 0, transactionCount: 0 };
  var perCast = {};
  var reviewList = [];
  var paidVisitIds = {};

  transactions.forEach(function (t) {
    if (t.business_date !== businessDate || t.status === 'void') return;
    var amount = Number(t.total_amount);
    var v = visitById[t.visit_id];
    paidVisitIds[t.visit_id] = true;
    totals.totalSales += amount;
    totals.transactionCount += 1;
    var type = v ? v.invitation_type : INVITATION_TYPE.STORE_CUSTOMER;

    if (type === INVITATION_TYPE.CAST_INVITED) {
      totals.invitedSales += amount;
      var c = perCast[v.attributed_cast_id] || (perCast[v.attributed_cast_id] = {
        castId: v.attributed_cast_id,
        castName: userById[v.attributed_cast_id] ? userById[v.attributed_cast_id].display_name : '',
        invitedSales: 0,
        payoutNumerator: 0,
        visitCount: 0
      });
      c.invitedSales += amount;
      c.payoutNumerator += amount * Number(t.payout_rate);
      c.visitCount += 1;
    } else if (type === INVITATION_TYPE.REVIEW_REQUIRED) {
      totals.reviewSales += amount;
      reviewList.push({
        visitId: v.visit_id,
        nickname: customerById[v.customer_id] ? customerById[v.customer_id].nickname : '',
        castId: v.attributed_cast_id,
        castName: userById[v.attributed_cast_id] ? userById[v.attributed_cast_id].display_name : '',
        amount: amount,
        reason: v.determination_reason
      });
    } else {
      totals.storeSales += amount;
    }
  });

  // 会計前の要確認来店も一覧に出す（金額 0 として）
  dayVisits.forEach(function (v) {
    if (v.invitation_type === INVITATION_TYPE.REVIEW_REQUIRED && !paidVisitIds[v.visit_id]) {
      reviewList.push({
        visitId: v.visit_id,
        nickname: customerById[v.customer_id] ? customerById[v.customer_id].nickname : '',
        castId: v.attributed_cast_id,
        castName: userById[v.attributed_cast_id] ? userById[v.attributed_cast_id].display_name : '',
        amount: null,
        reason: v.determination_reason
      });
    }
  });

  var casts = Object.keys(perCast).map(function (id) {
    var c = perCast[id];
    return {
      castId: c.castId,
      castName: c.castName,
      invitedSales: c.invitedSales,
      payout: Math.floor(c.payoutNumerator / 100),
      visitCount: c.visitCount
    };
  });

  return {
    businessDate: businessDate,
    totalSales: totals.totalSales,
    invitedSales: totals.invitedSales,
    storeSales: totals.storeSales,
    reviewSales: totals.reviewSales,
    transactionCount: totals.transactionCount,
    visitCount: dayVisits.length,
    unpaidVisitCount: dayVisits.filter(function (v) { return !paidVisitIds[v.visit_id]; }).length,
    casts: casts,
    reviewList: reviewList
  };
}
