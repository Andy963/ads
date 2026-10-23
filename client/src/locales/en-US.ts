import type zhCN from "./zh-CN";

const enUS: Record<keyof typeof zhCN, string> = {
  "auth.adminNotInitialized": "Admin is not initialized. Run",
  "auth.signInToContinue": "Sign in to continue.",
  "auth.username": "Username",
  "auth.password": "Password",
  "auth.showPassword": "Show password",
  "auth.hidePassword": "Hide password",
  "auth.signIn": "Sign in",
  "auth.signingIn": "Signing in…",
  "auth.checkingConnection": "Connecting to the server… Cached conversations are temporarily read-only.",
  "auth.offlineCached": "You are offline. Showing cached conversations in read-only mode.",
  "auth.serverUnavailableCached": "The server is unavailable. Showing cached conversations in read-only mode.",
  "auth.serverRequestFailedCached": "The server responded but could not verify this session. Cached conversations remain read-only.",
  "auth.offlineRetry": "You are offline. Restore your network connection and try again.",
  "auth.serverUnavailableRetry": "Unable to connect to the server. Check that it is running, then try again.",
  "auth.serverRequestFailed": "The server could not verify your session. Please try again.",
  "auth.invalidCredentials": "Invalid username or password.",
  "auth.accessDenied": "This account is not allowed to sign in.",
  "auth.retry": "Try again",
  "connection.disconnected": "Disconnected. Reconnecting…",
  "connection.reconnectBusy": "Connection lost while a request was running. Reconnecting and syncing history…",
  "connection.reconnectPendingResend": "The request did not reach the server. It will be resent automatically after reconnecting…",
};

export default enUS;
