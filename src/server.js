import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const BASE_URL = (process.env.BASE_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
const REDIRECT_BROWSERS = process.env.REDIRECT_BROWSERS !== 'false';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS ?? 5 * 60 * 1000);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 8000);
const MOCK_REDDIT = process.env.MOCK_REDDIT === 'true';

const DISCORD_UA = /Discordbot|Twitterbot|facebookexternalhit|Slackbot|TelegramBot|WhatsApp/i;
const cache = new Map();

export const app = Fastify({
  logger: true,
  trustProxy: true,
});

await app.register(rateLimit, {
  max: Number(process.env.RATE_LIMIT_MAX ?? 120),
  timeWindow: process.env.RATE_LIMIT_WINDOW ?? '1 minute',
});

app.get('/health', async () => ({ ok: true }));

app.get('/', async (req, reply) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  if (!url) return renderHome(reply);
  return handleRedditPath(req, reply, normalizeRedditUrlToPath(url));
});

app.get('/*', async (req, reply) => {
  return handleRedditPath(req, reply, req.url);
});

async function handleRedditPath(req, reply, inputPath) {
  const parsed = parseRedditPath(inputPath);
  if (!parsed.ok) return renderError(reply, 400, 'Invalid Reddit URL', 'Use a reddit.com post/comment URL.');

  const originalUrl = `https://www.reddit.com${parsed.path}`;
  const isBot = DISCORD_UA.test(req.headers['user-agent'] ?? '');

  try {
    const post = await getCachedPost(parsed.path);
    const embed = buildEmbed(post, originalUrl);

    reply.type('text/html; charset=utf-8');
    reply.header('Cache-Control', `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`);

    if (!isBot && REDIRECT_BROWSERS) {
      return reply.send(renderEmbedPage(embed, originalUrl, 0));
    }

    return reply.send(renderEmbedPage(embed, originalUrl, null));
  } catch (err) {
    req.log.error(err);
    return renderError(reply, 502, 'Reddit fetch failed', 'Could not load this Reddit post.');
  }
}

function parseRedditPath(input) {
  const path = String(input ?? '').split('#')[0].split('?')[0];
  const clean = path.startsWith('/') ? path : `/${path}`;

  const match = clean.match(/^\/(?:comments\/[A-Za-z0-9]+|r\/[A-Za-z0-9_]+\/comments\/[A-Za-z0-9]+(?:\/[^/?#]*)?|user\/[A-Za-z0-9_-]+\/comments\/[A-Za-z0-9]+(?:\/[^/?#]*)?|u\/[A-Za-z0-9_-]+\/comments\/[A-Za-z0-9]+(?:\/[^/?#]*)?)\/?$/);
  if (!match) return { ok: false };

  return { ok: true, path: clean.endsWith('/') ? clean : `${clean}/` };
}

function normalizeRedditUrlToPath(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return '';
  }

  const host = url.hostname.toLowerCase();
  if (!['reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com', 'redd.it'].includes(host)) return '';

  if (host === 'redd.it') {
    const id = url.pathname.replace(/^\/+/, '').split('/')[0];
    return id ? `/comments/${id}/` : '';
  }

  return url.pathname;
}

async function getCachedPost(path) {
  const key = path;
  const now = Date.now();
  const hit = cache.get(key);

  if (hit && hit.expiresAt > now) return hit.value;
  if (hit) cache.delete(key);

  const value = await fetchRedditPost(path);
  cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });

  if (cache.size > 500) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }

  return value;
}

async function fetchRedditPost(path) {
  if (MOCK_REDDIT) return mockRedditPost(path);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const url = `https://www.reddit.com${path}.json?raw_json=1`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'reddit-discord-fix/1.0 (+https://github.com/local/reddit-discord-fix)',
        Accept: 'application/json',
      },
    });

    if (!res.ok) throw new Error(`Reddit HTTP ${res.status}`);
    const json = await res.json();
    const post = json?.[0]?.data?.children?.[0]?.data;
    if (!post) throw new Error('Missing Reddit post payload');
    return post;
  } finally {
    clearTimeout(timeout);
  }
}

function mockRedditPost(path) {
  const id = path.match(/comments\/([A-Za-z0-9]+)/)?.[1] ?? 'localtest';
  return {
    title: `Mock Reddit post ${id}`,
    author: 'local_tester',
    subreddit_name_prefixed: 'r/test',
    ups: 1234,
    num_comments: 56,
    selftext: 'Local mock mode is enabled. This tests Discord embed HTML without reaching reddit.com.',
    url_overridden_by_dest: 'https://placehold.co/1200x630/png?text=Reddit+Discord+Fix+Mock',
    preview: {
      images: [{
        source: { url: 'https://placehold.co/1200x630/png?text=Reddit+Discord+Fix+Mock' },
        resolutions: [],
      }],
    },
  };
}

function buildEmbed(post, originalUrl) {
  const title = clean(post.title || 'Reddit post');
  const author = post.author ? `u/${post.author}` : 'Reddit';
  const subreddit = post.subreddit_name_prefixed || 'Reddit';
  const ups = Number.isFinite(post.ups) ? `${post.ups} upvotes` : '';
  const comments = Number.isFinite(post.num_comments) ? `${post.num_comments} comments` : '';
  const description = clean([subreddit, author, ups, comments].filter(Boolean).join(' • '));
  const text = clean(post.selftext || post.media_metadata?.caption || '');
  const media = extractMedia(post);

  return {
    title,
    description: text ? truncate(text, 280) : description,
    siteName: 'Reddit',
    url: originalUrl,
    image: media.image,
    video: media.video,
    type: media.video ? 'video.other' : 'article',
    card: media.video ? 'player' : 'summary_large_image',
  };
}

function extractMedia(post) {
  const redditVideo = post.secure_media?.reddit_video || post.media?.reddit_video;
  if (redditVideo?.fallback_url) {
    return {
      video: htmlDecode(redditVideo.fallback_url),
      image: bestPreviewImage(post),
    };
  }

  if (post.is_gallery && post.gallery_data?.items?.length && post.media_metadata) {
    const first = post.gallery_data.items[0]?.media_id;
    const meta = post.media_metadata[first];
    const img = meta?.s?.u || meta?.p?.at(-1)?.u;
    if (img) return { image: htmlDecode(img), video: null };
  }

  if (post.url_overridden_by_dest && /\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(post.url_overridden_by_dest)) {
    return { image: htmlDecode(post.url_overridden_by_dest), video: null };
  }

  return { image: bestPreviewImage(post), video: null };
}

function bestPreviewImage(post) {
  const images = post.preview?.images;
  const image = images?.[0];
  const source = image?.source?.url;
  const largest = image?.resolutions?.at(-1)?.url;
  return htmlDecode(source || largest || '');
}

function renderEmbedPage(embed, originalUrl, redirectSeconds) {
  const redirect = redirectSeconds === null
    ? ''
    : `<meta http-equiv="refresh" content="${redirectSeconds}; url=${escapeAttr(originalUrl)}">`;

  const mediaTags = [
    embed.image ? `<meta property="og:image" content="${escapeAttr(embed.image)}">` : '',
    embed.image ? `<meta name="twitter:image" content="${escapeAttr(embed.image)}">` : '',
    embed.video ? `<meta property="og:video" content="${escapeAttr(embed.video)}">` : '',
    embed.video ? `<meta property="og:video:secure_url" content="${escapeAttr(embed.video)}">` : '',
    embed.video ? '<meta property="og:video:type" content="video/mp4">' : '',
  ].join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(embed.title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
${redirect}
<link rel="canonical" href="${escapeAttr(originalUrl)}">
<meta property="og:type" content="${escapeAttr(embed.type)}">
<meta property="og:site_name" content="${escapeAttr(embed.siteName)}">
<meta property="og:title" content="${escapeAttr(embed.title)}">
<meta property="og:description" content="${escapeAttr(embed.description)}">
<meta property="og:url" content="${escapeAttr(BASE_URL + new URL(originalUrl).pathname)}">
<meta name="twitter:card" content="${escapeAttr(embed.card)}">
<meta name="twitter:title" content="${escapeAttr(embed.title)}">
<meta name="twitter:description" content="${escapeAttr(embed.description)}">
${mediaTags}
<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:2rem;line-height:1.5;color:#111;background:#fafafa}
main{max-width:720px;margin:auto}
a{color:#d93900}
img,video{max-width:100%;border-radius:12px}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(embed.title)}</h1>
<p>${escapeHtml(embed.description)}</p>
${embed.video ? `<video controls src="${escapeAttr(embed.video)}"></video>` : ''}
${!embed.video && embed.image ? `<img src="${escapeAttr(embed.image)}" alt="">` : ''}
<p><a href="${escapeAttr(originalUrl)}">Open on Reddit</a></p>
</main>
</body>
</html>`;
}

function renderHome(reply) {
  reply.type('text/html; charset=utf-8');
  return reply.send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Reddit Discord Fix</title></head>
<body>
<h1>Reddit Discord Fix</h1>
<p>Paste a Reddit post URL after <code>/?url=</code>, or replace <code>reddit.com</code> with this domain.</p>
<pre>${escapeHtml(BASE_URL)}/?url=https://www.reddit.com/r/pics/comments/example/title/</pre>
</body>
</html>`);
}

function renderError(reply, code, title, message) {
  reply.code(code).type('text/html; charset=utf-8');
  return reply.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta property="og:title" content="${escapeAttr(title)}">
<meta property="og:description" content="${escapeAttr(message)}">
<meta name="twitter:card" content="summary">
</head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body>
</html>`);
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function truncate(value, max) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function htmlDecode(value) {
  return String(value ?? '').replace(/&/g, '\u0026');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('\u0026', '\u0026amp;')
    .replaceAll('<', '\u0026lt;')
    .replaceAll('>', '\u0026gt;')
    .replaceAll('"', '\u0026quot;')
    .replaceAll("'", '\u0026#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

app.setNotFoundHandler(async (req, reply) => {
  return handleRedditPath(req, reply, req.url);
});

export async function start() {
  try {
    await app.listen({ port: PORT, host: HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await start();
}
