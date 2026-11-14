/**
 * 予約の受付上限（2026-11-15 追加）。オーナーが「設定」タブで決める。0 は上限なし。
 *   RESERVATION_MAX_GROUPS_PER_DAY   1営業日あたりの組数
 *   RESERVATION_MAX_GUESTS_PER_DAY   1営業日あたりの人数
 *   RESERVATION_MAX_GROUPS_PER_HOUR  同じ時間帯（21:00〜21:59 など、時の部分が同じ）の組数
 * 数えるのは「予約中」「来店済み」の予約（どの経路で登録されたかは問わない）。キャンセル・来店なしは数えない。
 * - お客様の LINE 予約は、上限を超えるなら受け付けない（FULLY_BOOKED）。
 * - 店舗用画面からの登録は止めない（電話・店頭での調整を優先）。超えた場合は警告を返す。
 */
var CAPACITY_STATUSES = ['reserved', 'visited'];

/** 営業日ごとの予約数 { 'YYYY-MM-DD': { groups, guests, hours: { 'HH': groups } } } */
function capacityCounts_(reservations, cutoffHour) {
  var map = {};
  reservations.forEach(function (r) {
    if (CAPACITY_STATUSES.indexOf(r.status) < 0) return;
    var at = parseIsoDate_(r.scheduled_at);
    if (!at) return;
    var date = businessDateOf_(at, cutoffHour);
    var hour = formatJstIso_(at).slice(11, 13);
    var c = map[date] = map[date] || { groups: 0, guests: 0, hours: {} };
    c.groups++;
    c.guests += Number(r.number_of_guests) || 0;
    c.hours[hour] = (c.hours[hour] || 0) + 1;
  });
  return map;
}

function hasCapacityLimits_(config) {
  return config.RESERVATION_MAX_GROUPS_PER_DAY > 0 || config.RESERVATION_MAX_GUESTS_PER_DAY > 0 ||
    config.RESERVATION_MAX_GROUPS_PER_HOUR > 0;
}

/**
 * この予約を1件加えると超える上限の一覧。空なら受け付けられる。
 * @return {string[]} 'day_groups' | 'day_guests' | 'hour_groups'
 */
function capacityProblems_(counts, scheduledAt, numberOfGuests, config) {
  var date = businessDateOf_(scheduledAt, config.BUSINESS_DAY_CUTOFF_HOUR);
  var hour = formatJstIso_(scheduledAt).slice(11, 13);
  var c = counts[date] || { groups: 0, guests: 0, hours: {} };
  var out = [];
  if (config.RESERVATION_MAX_GROUPS_PER_DAY > 0 && c.groups + 1 > config.RESERVATION_MAX_GROUPS_PER_DAY) out.push('day_groups');
  if (config.RESERVATION_MAX_GUESTS_PER_DAY > 0 && c.guests + numberOfGuests > config.RESERVATION_MAX_GUESTS_PER_DAY) out.push('day_guests');
  if (config.RESERVATION_MAX_GROUPS_PER_HOUR > 0 && (c.hours[hour] || 0) + 1 > config.RESERVATION_MAX_GROUPS_PER_HOUR) out.push('hour_groups');
  return out;
}

/**
 * お客様の予約画面向けの空き状況。件数そのものは返さず、「満席」だけを返す。
 *   fullDates: 最少人数でも予約できない営業日
 *   fullHours: { 'YYYY-MM-DD': ['21', '22'] } 組数が上限に達した時間帯
 */
function publicAvailability_(reservations, config, now) {
  var out = { fullDates: [], fullHours: {} };
  if (!hasCapacityLimits_(config)) return out;
  var cutoff = config.BUSINESS_DAY_CUTOFF_HOUR;
  var today = businessDateOf_(now, cutoff);
  var counts = capacityCounts_(reservations, cutoff);
  Object.keys(counts).sort().forEach(function (date) {
    if (date < today) return;
    var c = counts[date];
    if ((config.RESERVATION_MAX_GROUPS_PER_DAY > 0 && c.groups >= config.RESERVATION_MAX_GROUPS_PER_DAY) ||
        (config.RESERVATION_MAX_GUESTS_PER_DAY > 0 && c.guests + config.RESERVATION_MIN_GUESTS > config.RESERVATION_MAX_GUESTS_PER_DAY)) {
      out.fullDates.push(date);
      return;
    }
    if (config.RESERVATION_MAX_GROUPS_PER_HOUR > 0) {
      var hours = Object.keys(c.hours).filter(function (h) { return c.hours[h] >= config.RESERVATION_MAX_GROUPS_PER_HOUR; }).sort();
      if (hours.length) out.fullHours[date] = hours;
    }
  });
  return out;
}

/** 店舗用画面向け: 営業日の予約数と上限 */
function dayCapacitySummary_(reservations, date, config) {
  var c = capacityCounts_(reservations, config.BUSINESS_DAY_CUTOFF_HOUR)[date] || { groups: 0, guests: 0 };
  return {
    groups: c.groups,
    guests: c.guests,
    maxGroups: config.RESERVATION_MAX_GROUPS_PER_DAY,
    maxGuests: config.RESERVATION_MAX_GUESTS_PER_DAY,
    maxGroupsPerHour: config.RESERVATION_MAX_GROUPS_PER_HOUR
  };
}
