# Reddit Discord Fix

Discord-friendly Reddit embed proxy, like FixupX but for Reddit links.

## What it does

Discord often shows weak Reddit embeds. This app turns Reddit post URLs into pages with clean OpenGraph/Twitter metadata so Discord can embed title, text, image, video, gallery preview, upvotes, comments.

## Usage

Deploy this app, set `BASE_URL`, then share links like:

```txt
https://your-domain.example/r/pics/comments/abc123/title/
```

Or:

```txt
https://your-domain.example/?url=https://www.reddit.com/r/pics/comments/abc123/title/
```

Browsers redirect/open the Reddit post. Bots receive metadata.

## Install

```bash
pnpm install
```

## Run

```bash
pnpm start
```

Dev mode:

```bash
pnpm dev
```

## Config

Copy `.env.example` values into your host env.

| Env | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | bind host |
| `BASE_URL` | `http://localhost:3000` | public app origin |
| `REDIRECT_BROWSERS` | `true` | redirect non-bot browsers |
| `CACHE_TTL_MS` | `300000` | Reddit cache TTL |
| `FETCH_TIMEOUT_MS` | `8000` | Reddit fetch timeout |
| `RATE_LIMIT_MAX` | `120` | requests/window |
| `RATE_LIMIT_WINDOW` | `1 minute` | Fastify rate limit window |
| `MOCK_REDDIT` | `false` | use built-in mock Reddit response for local/offline tests |
| `REDDIT_COOKIES` | empty | optional Reddit cookies for hosts/IPs that get `403`; accepts raw `Cookie` header, cookie file path, JSON, Netscape cookies, or URL |

## Reddit 403 / API limits

Public Reddit JSON endpoints may return `403` from some hosts/IPs. This app uses Reddit's unauthenticated JSON endpoints with a descriptive `User-Agent`.

If Reddit still returns `403`, set `REDDIT_COOKIES`.

Raw browser `Cookie` header:

```bash
REDDIT_COOKIES="loid=...; session_tracker=...; reddit_session=..."
pnpm start
```

Cookie file path:

```bash
REDDIT_COOKIES="./cookies.txt"
pnpm start
```

Supported `REDDIT_COOKIES` inputs:

- raw `Cookie` header: `a=b; c=d`
- plain cookie file
- Netscape cookie export
- JSON object: `{"a":"b"}`
- JSON array: `[{"name":"a","value":"b"}]`
- `http(s)` URL returning any supported cookie format

Security: Reddit cookies grant account access. Do not commit them, paste them in logs, or expose them in hosting dashboards.

## Supported Reddit URLs

- `/r/:sub/comments/:id/:slug?`
- `/user/:user/comments/:id/:slug?`
- `/u/:user/comments/:id/:slug?`
- `/?url=https://www.reddit.com/...`
- `redd.it/:id` via `url=` mode

## Test

Real Reddit fetch:

```bash
curl -A "Discordbot/2.0" "http://localhost:3000/r/pics/comments/abc123/title/"
```

Offline/local mock mode, useful if Reddit is blocked by ISP/VPN:

```bash
MOCK_REDDIT=true pnpm start
curl -A "Discordbot/2.0" "http://localhost:3000/r/test/comments/mock123/title/"
```

Windows `cmd.exe`:

```cmd
set MOCK_REDDIT=true&& pnpm start
```

Docker mock mode:

```bash
docker run --rm -p 3000:3000 -e MOCK_REDDIT=true reddit-discord-fix
```

Expected: HTML containing `og:title`, `og:description`, `og:image` or `og:video`.

## Notes

- No DB.
- In-memory cache only.
- SSRF blocked by allowing only Reddit hosts in `url=` mode.
- Reddit API/network failures return embeddable error pages.