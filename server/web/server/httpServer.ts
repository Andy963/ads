import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream";

import { sendJson, setSecurityHeaders } from "./http.js";
import { PROJECT_ROOT } from "../../utils/projectRoot.js";

interface Logger {
  error(message: string, ...args: unknown[]): void;
}

function resolveContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
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
}

function destroyResponse(res: http.ServerResponse): void {
  try {
    res.destroy();
  } catch {
    // ignore
  }
}

function serveFile(req: http.IncomingMessage, res: http.ServerResponse, filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
    setSecurityHeaders(res);

    const contentType = resolveContentType(filePath);
    const headers: http.OutgoingHttpHeaders = {
      "Content-Type": contentType,
      "Cache-Control": filePath.endsWith(".html") ? "no-store" : "public, max-age=31536000, immutable",
    };

    // Check for compression eligibility
    const acceptEncoding = req.headers["accept-encoding"];
    const canCompress = /\.(html|js|css|json|svg|map|txt)$/i.test(filePath);
    const useGzip = canCompress && /\bgzip\b/.test(String(acceptEncoding ?? ""));

    if (useGzip) {
      headers["Content-Encoding"] = "gzip";
      headers["Vary"] = "Accept-Encoding";
      res.writeHead(200, headers);

      const source = fs.createReadStream(filePath);
      const gzip = zlib.createGzip();

      pipeline(source, gzip, res, (err) => {
        if (err) {
          destroyResponse(res);
        }
      });
      return true;
    } else {
      headers["Content-Length"] = stat.size;
      res.writeHead(200, headers);
      const source = fs.createReadStream(filePath);
      pipeline(source, res, (err) => {
        if (err) {
          destroyResponse(res);
        }
      });
    }
    return true;
  } catch {
    return false;
  }
}

export function createHttpServer(options: {
  handleApiRequest?: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
  logger?: Logger;
}): http.Server {
  const distClientDir = fs.existsSync(path.join(PROJECT_ROOT, "server", "cli.js"))
    ? path.join(PROJECT_ROOT, "client")
    : path.join(PROJECT_ROOT, "dist", "client");
  const distClientIndexPath = path.join(distClientDir, "index.html");
  let distClientReady = false;

  const isDistClientReady = (): boolean => {
    if (distClientReady) return true;
    distClientReady = fs.existsSync(distClientIndexPath);
    return distClientReady;
  };

  const serveTasksUi = (req: http.IncomingMessage, res: http.ServerResponse, url: string): boolean => {
    if (!isDistClientReady()) {
      setSecurityHeaders(res);
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Web app not built. Run: npm run build:web\n");
      return true;
    }

    let raw = (url.split("?")[0] ?? "/").trim();
    try {
      raw = decodeURIComponent(raw);
    } catch {
      setSecurityHeaders(res);
      res.writeHead(400).end("Bad Request");
      return true;
    }

    const rel = raw.startsWith("/") ? raw : `/${raw}`;
    const normalized = path.posix.normalize(rel);
    const safeRel = normalized.startsWith("/") ? normalized : `/${normalized}`;
    const resolved = path.resolve(distClientDir, "." + safeRel);
    if (!resolved.startsWith(distClientDir)) {
      setSecurityHeaders(res);
      res.writeHead(403).end("Forbidden");
      return true;
    }

    if (safeRel === "/" || safeRel === "") {
      if (serveFile(req, res, distClientIndexPath)) {
        return true;
      }
      distClientReady = false;
      setSecurityHeaders(res);
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Web app not built. Run: npm run build:web\n");
      return true;
    }

    if (serveFile(req, res, resolved)) {
      return true;
    }

    if (!path.posix.basename(safeRel).includes(".")) {
      if (serveFile(req, res, distClientIndexPath)) {
        return true;
      }
      distClientReady = false;
      setSecurityHeaders(res);
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Web app not built. Run: npm run build:web\n");
      return true;
    }

    setSecurityHeaders(res);
    res.writeHead(404).end("Not Found");
    return true;
  };

  const server = http.createServer((req, res) => {
    setSecurityHeaders(res);

    const url = req.url ?? "";
    if (url.startsWith("/api/")) {
      const handler = options.handleApiRequest;
      if (!handler) {
        sendJson(res, 404, { error: "Not Found" });
        return;
      }
      void handler(req, res).catch((error) => {
        // Log the full error, but sanitize the response
        if (options.logger) {
          options.logger.error("API Error", error);
        } else {
          console.error("API Error", error);
        }

        if (!res.headersSent) {
          sendJson(res, 500, { error: "Internal Server Error" });
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
        setSecurityHeaders(res);
        res.writeHead(200).end("ok");
        return;
      }
      serveTasksUi(req, res, url);
      return;
    }
    setSecurityHeaders(res);
    res.writeHead(404).end("Not Found");
  });
  return server;
}
