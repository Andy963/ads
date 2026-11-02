import type { WebPushNotification } from "./service.js";

export function createForegroundAwareWebPushNotifier(args: {
  notifyUser: (userId: string, notification: WebPushNotification) => Promise<void>;
  hasOpenWebClient: (userId: string) => boolean;
}): (userId: string, notification: WebPushNotification) => Promise<void> {
  return async (userId, notification) => {
    if (!args.hasOpenWebClient(userId)) {
      await args.notifyUser(userId, notification);
    }
  };
}
