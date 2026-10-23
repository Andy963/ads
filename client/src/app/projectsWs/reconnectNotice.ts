import { t } from "../../lib/i18n";

export const RECONNECT_BUSY_MESSAGE = t("connection.reconnectBusy");

export const RECONNECT_PENDING_RESEND_NOTICE = t("connection.reconnectPendingResend");

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
