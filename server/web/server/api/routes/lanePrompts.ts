import { z } from "zod";

import { getStateDatabase } from "../../../../state/database.js";
import {
  createLanePromptStore,
  type LanePromptStore,
} from "../../../../state/lanePromptStore.js";
import { isLaneName, type LaneName } from "../../../../state/lanePromptDefaults.js";
import type { ApiRouteContext } from "../types.js";
import { readJsonBody, sendJson } from "../../http.js";

type LanePromptRouteDeps = {
  lanePromptStore?: LanePromptStore;
};

const updatePromptSchema = z.object({ prompt: z.string() }).passthrough();

function decodeLane(rawLane: string): string {
  try {
    return decodeURIComponent(rawLane).trim().toLowerCase();
  } catch {
    return rawLane.trim().toLowerCase();
  }
}

function getLanePromptStore(deps: LanePromptRouteDeps): LanePromptStore {
  return deps.lanePromptStore ?? createLanePromptStore(getStateDatabase());
}

function validateLane(rawLane: string): LaneName {
  if (!isLaneName(rawLane)) {
    throw new Error(`Unknown lane: ${rawLane || "empty"}`);
  }
  return rawLane;
}

export async function handleLanePromptRoutes(
  ctx: ApiRouteContext,
  deps: LanePromptRouteDeps = {},
): Promise<boolean> {
  const { req, res, pathname } = ctx;

  if (pathname === "/api/lane-prompts" && req.method === "GET") {
    const store = getLanePromptStore(deps);
    sendJson(res, 200, store.listLanePrompts());
    return true;
  }

  const resetMatch = /^\/api\/lane-prompts\/([^/]+)\/reset$/.exec(pathname);
  if (resetMatch && req.method === "POST") {
    try {
      const store = getLanePromptStore(deps);
      sendJson(res, 200, store.resetLanePrompt(validateLane(decodeLane(resetMatch[1] ?? ""))));
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  const laneMatch = /^\/api\/lane-prompts\/([^/]+)$/.exec(pathname);
  if (!laneMatch) {
    return false;
  }

  const lane = decodeLane(laneMatch[1] ?? "");
  if (req.method === "GET" || req.method === "PUT") {
    try {
      const validatedLane = validateLane(lane);
      const store = getLanePromptStore(deps);
      if (req.method === "GET") {
        sendJson(res, 200, store.getLanePrompt(validatedLane));
        return true;
      }

      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return true;
      }
      const parsed = updatePromptSchema.safeParse(body ?? {});
      if (!parsed.success) {
        sendJson(res, 400, { error: "Invalid payload" });
        return true;
      }
      sendJson(res, 200, store.setLanePrompt(validatedLane, parsed.data.prompt));
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  return false;
}
