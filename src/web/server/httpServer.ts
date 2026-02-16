import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream";

import { sendJson } from "./http.js";

function serveFile(req: http.IncomingMessage, res: http.ServerResponse, filePath: string): boolean {
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

    const contentType = contentTypeFor(filePath);
    const headers: Record<string, string | number> = {
      "Content-Type": contentType,
      "Cache-Control": filePath.endsWith(".html") ? "no-store" : "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*",
    };

    // Check for compression eligibility
    const acceptEncoding = req.headers["accept-encoding"];
    const canCompress = /\.(html|js|css|json|svg|map|txt)$/i.test(filePath);
    const useGzip = canCompress && /\bgzip\b/.test(String(acceptEncoding || ""));

    if (useGzip) {
      headers["Content-Encoding"] = "gzip";
      headers["Vary"] = "Accept-Encoding";
      res.writeHead(200, headers);

      const source = fs.createReadStream(filePath);
      const gzip = zlib.createGzip();

      pipeline(source, gzip, res, (err) => {
        if (err) {
          // If stream fails, try to close connection cleanly if possible
          try {
            if (!res.headersSent) {
               // Should not happen as we wrote headers above
               res.writeHead(500);
               res.end();
            } else {
               res.destroy();
            }
          } catch {
            // ignore
          }
        }
      });
    } else {
      headers["Content-Length"] = stat.size;
      res.writeHead(200, headers);
      fs.createReadStream(filePath).pipe(res);
    }
    return true;
  } catch {
    return false;
  }
}

export function createHttpServer(options: {
  handleApiRequest?: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
}): http.Server {
  const distWebDir = path.join(process.cwd(), "dist", "web");

  const serveTasksUi = (req: http.IncomingMessage, res: http.ServerResponse, url: string): boolean => {
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
      return serveFile(req, res, path.join(distWebDir, "index.html"));
    }

    if (serveFile(req, res, resolved)) {
      return true;
    }

    if (!path.posix.basename(safeRel).includes(".")) {
      return serveFile(req, res, path.join(distWebDir, "index.html"));
    }

    res.writeHead(404).end("Not Found");
    return true;
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
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
      serveTasksUi(req, res, url);
      return;
    }
    res.writeHead(404).end("Not Found");
  });
  return server;
}
