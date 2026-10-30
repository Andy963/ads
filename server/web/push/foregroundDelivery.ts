export function createForegroundAwareWebPushNotifier(args: {
  notifyUser: (userId: string) => Promise<void>;
  hasOpenWebClient: (userId: string) => boolean;
}): (userId: string) => Promise<void> {
  return async (userId) => {
    if (!args.hasOpenWebClient(userId)) {
      await args.notifyUser(userId);
    }
  };
}
