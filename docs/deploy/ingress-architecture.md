# Transport-Agnostic Public Ingress Architecture

ADS binds exclusively to loopback (`127.0.0.1:8787` by default) and owns only the application HTTP/WebSocket lifecycle. Public ingress—whether FRP, Cloudflare Tunnel (`cloudflared`), Tailscale Funnel, Nginx, or Caddy—runs as an independent, decoupled process or systemd unit. Switching or running multiple ingress layers concurrently on different hostnames requires zero ADS code changes.

## 1. Reverse-Proxy Header Contract

Any ingress layer fronting `ads-server` should forward standard proxy headers:

| Header | Purpose in `ads-http` | Notes |
| --- | --- | --- |
| `X-Forwarded-Proto` / `Forwarded: proto=...` / `CF-Visitor` | Derives HTTPS status for `CookieSecureMode::Auto` (`Secure` flag on session cookies). | First hop is evaluated. Set `ADS_WEB_COOKIE_SECURE=auto` (default) or `true`. |
| `X-Forwarded-Host` / `Forwarded: host=...` / `Host` | Authoritative public hostname for same-host Origin / CSRF validation on state-changing API routes and WebSocket upgrades. | Required when the proxy rewrites `Host` to `127.0.0.1:8787`. |
| `X-Forwarded-For` / `Forwarded: for=...` / `CF-Connecting-IP` / `X-Real-IP` | Extracts client IP for login rate limiting and session metadata. | Configure `ADS_TRUSTED_PROXIES` (comma-separated IPs/CIDRs, e.g. `127.0.0.1/8,::1/128,172.16.0.0/12`) to strip trusted proxy hops right-to-left and prevent spoofing. |
| `Upgrade` / `Connection` | Required for `GET /ws` WebSocket upgrades. | HTTP/2 and QUIC upstream tunnels (such as `cloudflared`) must permit WebSocket upgrades and disable idle buffering on `/ws`. |

Optional environment variables:
- `ADS_WEB_ALLOWED_ORIGINS`: Comma-separated explicit origin allowlist (e.g. `https://ads.example.com,https://ads-cf.example.com`). When omitted, ADS allows same-host origins matching `X-Forwarded-Host` / `Forwarded` / `Host` plus loopback origins.
- `ADS_TRUSTED_PROXIES`: Optional comma-separated trusted proxy IPs or CIDRs used when selecting the authoritative client IP from `X-Forwarded-For` / `Forwarded`.
- `ADS_WEB_COOKIE_SECURE`: `auto` (default), `true`, or `false`.

## 2. Edge Cache Transparency

- All `/api/*` responses and `/healthz` return `Cache-Control: no-store` so edge CDNs never cache transcripts, credentials, or auth state.
- `index.html` and non-hashed SPA entry files return `Cache-Control: no-cache, no-store, must-revalidate` and `Vary: Accept-Encoding`.
- Hashed assets under `/assets/*` return `Cache-Control: public, max-age=31536000, immutable` with `Vary: Accept-Encoding` on compressible assets.

## 3. Reference Ingress Templates

### Option A: FRP (`frpc.toml` + independent `frpc.service`)

```toml
serverAddr = "vps.example.com"
serverPort = 7000
auth.method = "token"
auth.token = "<FRP_TOKEN>"

[[proxies]]
name = "ads-web"
type = "http"
localIP = "127.0.0.1"
localPort = 8787
customDomains = ["ads.example.com"]
# Terminate TLS on the VPS reverse proxy (Nginx/Caddy) and forward:
#   X-Forwarded-Proto: https
#   X-Forwarded-Host: $host
#   X-Forwarded-For: $proxy_add_x_forwarded_for
#   Upgrade / Connection headers for /ws
```

### Option B: Cloudflare Tunnel (`cloudflared`)

Config-file mode (`/etc/cloudflared/config.yml`):

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: /etc/cloudflared/<TUNNEL_UUID>.json
protocol: quic

ingress:
  - hostname: ads.example.com
    service: http://127.0.0.1:8787
    originRequest:
      noTLSVerify: false
      httpHostHeader: ads.example.com
      connectTimeout: 30s
  - service: http_status:404
```

Token-based systemd unit (`cloudflared.service`):

```ini
[Unit]
Description=Cloudflare Tunnel for ADS
After=network-online.target ads-web.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate run --token <CLOUDFLARE_TUNNEL_TOKEN>
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

Cloudflare Tunnel automatically sets `X-Forwarded-Proto: https`, `CF-Visitor`, `CF-Connecting-IP`, `X-Forwarded-For`, and preserves WebSocket upgrades on `/ws` over QUIC/HTTP2 backhauls.
