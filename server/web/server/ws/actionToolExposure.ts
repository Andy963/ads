import { WEB_ACTIONS_NAMESPACE } from "../start/webLaneResources.js";

export function shouldExposeInteractiveActionTools(input: {
  isConnector: boolean;
  laneNamespace: string;
  factoryAvailable: boolean;
}): boolean {
  return input.factoryAvailable
    && !input.isConnector
    && input.laneNamespace === WEB_ACTIONS_NAMESPACE;
}
