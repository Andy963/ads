export const RECONNECT_BUSY_MESSAGE = "请求执行中连接中断，正在重连并同步历史…";

export const RECONNECT_PENDING_RESEND_NOTICE =
  "请求尚未送达后端时连接已断开，重连后将自动重新发送…";

export const RECONNECT_NOTICE_VARIANTS: readonly string[] = [
  RECONNECT_BUSY_MESSAGE,
  RECONNECT_PENDING_RESEND_NOTICE,
];

export function pickReconnectNotice(state: { hasPendingAck: boolean }): string {
  return state.hasPendingAck ? RECONNECT_PENDING_RESEND_NOTICE : RECONNECT_BUSY_MESSAGE;
}

export function isReconnectNotice(content: string): boolean {
  return RECONNECT_NOTICE_VARIANTS.includes(content);
}
