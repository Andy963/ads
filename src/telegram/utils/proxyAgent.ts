import net from "node:net";
import tls, { type ConnectionOptions } from "node:tls";
import { Agent, type AgentOptions } from "node:https";
import { Buffer } from "node:buffer";

export class HttpsProxyAgent extends Agent {
  private readonly proxy: URL;

  constructor(proxyUrl: string, options?: AgentOptions) {
    super(options);
    this.proxy = new URL(proxyUrl);
  }

  override createConnection(
    options: ConnectionOptions,
    callback?: (err: Error | null, socket: net.Socket) => void,
  ): net.Socket {
    const host = options.host ?? "localhost";
    const port = Number(options.port ?? 443);
    const proxyPort = Number(this.proxy.port || 80);

    const socket = net.connect({
      host: this.proxy.hostname,
      port: proxyPort,
    });

    const safeCallback = (error: Error | null, sock?: net.Socket) => {
      if (callback) {
        callback(error, sock ?? socket);
      } else if (error) {
        socket.destroy(error);
      }
    };

    const onError = (error: Error) => {
      cleanup();
      safeCallback(error, socket);
    };

    const cleanup = () => {
      socket.removeListener("error", onError);
      socket.removeListener("timeout", onTimeout);
      socket.removeListener("data", onData);
    };

    const onTimeout = () => {
      cleanup();
      safeCallback(new Error("Proxy connection timed out"), socket);
      socket.destroy();
    };

    socket.once("error", onError);
    socket.setTimeout(30_000, onTimeout);

    socket.once("connect", () => {
      const connectLines = [
        `CONNECT ${host}:${port} HTTP/1.1`,
        `Host: ${host}:${port}`,
        "Connection: keep-alive",
      ];
      const authLine = this.buildProxyAuthHeader();
      if (authLine) {
        connectLines.push(authLine);
      }
      connectLines.push("\r\n");
      socket.write(connectLines.join("\r\n"));
    });

    const buffers: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      buffers.push(chunk);
      const combined = Buffer.concat(buffers);
      const headerEnd = combined.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      const header = combined.slice(0, headerEnd).toString("utf8");
      const statusMatch = header.match(/HTTP\/1\.[01]\s+(\d{3})/);
      if (!statusMatch || statusMatch[1] !== "200") {
        cleanup();
        safeCallback(new Error(`Proxy CONNECT failed: ${header.split("\r\n")[0]}`), socket);
        socket.destroy();
        return;
      }

      const leftover = combined.slice(headerEnd + 4);
      socket.removeListener("data", onData);
      cleanup();

      const tlsSocket = tls.connect({
        ...options,
        socket,
        servername: typeof options.servername === "string" ? options.servername : host,
      });

      if (leftover.length > 0) {
        tlsSocket.once("secureConnect", () => {
          tlsSocket.unshift(leftover);
        });
      }

      safeCallback(null, tlsSocket);
    };

    socket.on("data", onData);

    return socket;
  }

  private buildProxyAuthHeader(): string | null {
    const user = this.proxy.username ? decodeURIComponent(this.proxy.username) : "";
    const pass = this.proxy.password ? decodeURIComponent(this.proxy.password) : "";
    if (!user && !pass) {
      return null;
    }
    const token = Buffer.from(`${user}:${pass}`).toString("base64");
    return `Proxy-Authorization: Basic ${token}`;
  }
}
