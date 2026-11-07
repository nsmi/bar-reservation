/**
 * 顧客。あだ名は一意キーにせず、検証済み LINE ユーザーID ↔ customer_id で照合する。
 * 電話番号・本名などは保存しない。
 */
function findCustomerByLineUserId_(customers, lineUserId) {
  for (var i = 0; i < customers.length; i++) {
    if (customers[i].line_user_id === lineUserId) return customers[i];
  }
  return null;
}

/** ロック取得中に呼び出すこと。 */
function createCustomer_(customers, lineUserId, nickname, nowIso) {
  var customer = {
    customer_id: nextCustomerId_(customers),
    line_user_id: lineUserId,
    nickname: nickname,
    age_group: '',
    identification_note: '',
    favorite_drink: '',
    memo: '',
    active: true,
    created_at: nowIso,
    updated_at: nowIso
  };
  appendRecord_('Customers', customer);
  return customer;
}

/** 監査ログ・画面表示用。LINEユーザーIDを含めない。 */
function toAuditCustomer_(c) {
  return { customer_id: c.customer_id, nickname: c.nickname, created_at: c.created_at };
}
