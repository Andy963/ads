import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { sendJson } from "./http.js";

function serveFile(res: http.ServerResponse, filePath: string): boolean {
  const contentTypeFor = (resolvedPath: string): string => {
    const ext = path.extname(resolvedPath).toLowerCase();
    switch (ext) {
      case ".html":
        return "text/html; charset=utf-8";
      case ".js":
        return "text/javascript; charset=utf-8";
      case ".css":
        return "text/css; charset=utf-8";
      case ".json":
        return "application/json; charset=utf-8";
      case ".svg":
        return "image/svg+xml";
      case ".png":
        return "image/png";
      case ".jpg":
      case ".jpeg":
        return "image/jpeg";
      case ".ico":
        return "image/x-icon";
      case ".woff2":
        return "font/woff2";
      case ".map":
        return "application/json; charset=utf-8";
      default:
        return "application/octet-stream";
    }
  };
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
    res.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      "Cache-Control": filePath.endsWith(".html") ? "no-store" : "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*",
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  } catch {
    return false;
  }
}

export function createHttpServer(options: {
  handleApiRequest?: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
  handleMcpRequest?: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
}): http.Server {
  const distWebDir = path.join(process.cwd(), "dist", "web");

  const serveTasksUi = (res: http.ServerResponse, url: string): boolean => {
    if (!fs.existsSync(distWebDir)) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Web app not built. Run: npm run build:web\n");
      return true;
    }

    const raw = (url.split("?")[0] ?? "/").trim();
    const rel = raw.startsWith("/") ? raw : `/${raw}`;
    const normalized = path.posix.normalize(rel);
    const safeRel = normalized.startsWith("/") ? normalized : `/${normalized}`;
    const resolved = path.resolve(distWebDir, "." + safeRel);
    if (!resolved.startsWith(distWebDir)) {
      res.writeHead(403).end("Forbidden");
      return true;
    }

    if (safeRel === "/" || safeRel === "") {
      return serveFile(res, path.join(distWebDir, "index.html"));
    }

    if (serveFile(res, resolved)) {
      return true;
    }

    if (!path.posix.basename(safeRel).includes(".")) {
      return serveFile(res, path.join(distWebDir, "index.html"));
    }

    res.writeHead(404).end("Not Found");
    return true;
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/mcp" || url.startsWith("/mcp/")) {
      const handler = options.handleMcpRequest;
      if (!handler) {
        sendJson(res, 404, { error: "Not Found" });
        return;
      }
      void handler(req, res).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!res.headersSent) {
          sendJson(res, 500, { error: message });
        } else {
          try {
            res.end();
          } catch {
            // ignore
          }
        }
      });
      return;
    }
    if (url.startsWith("/api/")) {
      const handler = options.handleApiRequest;
      if (!handler) {
        sendJson(res, 404, { error: "Not Found" });
        return;
      }
      void handler(req, res).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!res.headersSent) {
          sendJson(res, 500, { error: message });
        } else {
          try {
            res.end();
          } catch {
            // ignore
          }
        }
      });
      return;
    }

    if (req.method === "GET") {
      if (url.startsWith("/healthz")) {
        res.writeHead(200).end("ok");
        return;
      }
      serveTasksUi(res, url);
      return;
    }
    res.writeHead(404).end("Not Found");
  });
  return server;
}
