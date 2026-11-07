/**
 * 監査ログ。IDトークン、LINEユーザーID、チャネル情報は書き込まない。
 */
function appendAudit_(entry) {
  appendRecord_('AuditLogs', {
    log_id: newLogId_(),
    timestamp: formatJstIso_(now_()),
    user_id: entry.userId || '',
    role: entry.role || '',
    action: entry.action,
    target_type: entry.targetType || '',
    target_id: entry.targetId || '',
    before_json: entry.before ? JSON.stringify(entry.before) : '',
    after_json: entry.after ? JSON.stringify(entry.after) : '',
    reason: entry.reason || '',
    request_id: entry.requestId || '',
    result: entry.result
  });
}

/** 監査ログの書き込み失敗で本処理の応答を壊さないためのラッパー（認証失敗の記録用）。 */
function safeAppendAudit_(entry) {
  try {
    appendAudit_(entry);
  } catch (e) {
    console.error('Audit write failed: ' + (e && e.message));
  }
}
