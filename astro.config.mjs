import { defineConfig } from 'astro/config';
import { mkdir, rm, writeFile } from 'node:fs/promises';

// Dev-only endpoint — `?inspect` POSTs a diff of everything changed in DevTools
// since the page settled. It lands in .inspect/ (gitignored) as both JSON and a
// readable summary, so a change tried in the inspector can be ported into the
// source without anyone having to describe it in prose.
const inspectSave = () => ({
  name: 'inspect-save',
  configureServer(server) {
    server.middlewares.use('/__inspect-save', (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.end();
        return;
      }
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', async () => {
        try {
          const { url, viewport, diff } = JSON.parse(body);
          const dir = new URL('./.inspect/', import.meta.url);
          await mkdir(dir, { recursive: true });

          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const head = [
            `# DevTools capture`,
            ``,
            `- ${new Date().toISOString()}`,
            `- ${url}`,
            `- viewport ${viewport[0]}x${viewport[1]}`,
            ``,
          ];

          const md = [...head];
          if (diff.css.length) {
            md.push('## CSS', '');
            for (const c of diff.css) {
              // A rule inside @media is written NESTED, so the block can be
              // pasted into the stylesheet as-is rather than re-assembled.
              const ind = c.context ? '    ' : '  ';
              const open = c.context ? [`${c.context} {`, `  ${c.selector} {`] : [`${c.selector} {`];
              const close = c.context ? ['  }', '}'] : ['}'];

              if (c.kind === 'changed') {
                md.push('```css', ...open);
                for (const d of c.decls) {
                  md.push(d.to === null ? `${ind}/* removed: ${d.prop}: ${d.from} */` : `${ind}${d.prop}: ${d.to};`);
                }
                md.push(...close, '```', '');
                /*
                 * A shorthand carrying var() serializes its longhands as EMPTY,
                 * so the block above can print `background-image: ;` and drop
                 * the only value the edit was about. When that happens the rule
                 * arrives with its raw cssText attached; print it verbatim.
                 */
                if (c.raw) {
                  md.push('**as written (longhands above serialized empty):**', '```css', ...open, `${ind}${c.raw}`, ...close, '```', '');
                }
              } else if (c.kind === 'added') {
                md.push(`**added rule**`, '```css', ...open, `${ind}${c.cssText}`, ...close, '```', '');
              } else {
                md.push(`**removed rule** \`${c.context ? c.context + ' › ' : ''}${c.selector}\``, '');
              }
            }
          }
          if (diff.dom.length) {
            md.push('## Markup', '');
            for (const n of diff.dom) {
              md.push(`### ${n.kind} — \`${n.path}\``);
              // A changed node's attrs are an array of {name, from, to}; an
              // added node's are the whole attribute map. Same field, two shapes.
              if (Array.isArray(n.attrs)) {
                for (const a of n.attrs) {
                  md.push(a.to === null ? `- removed \`${a.name}\` (was \`${a.from}\`)` : `- \`${a.name}\` → \`${a.to}\``);
                }
              } else if (n.attrs) {
                for (const [k, v] of Object.entries(n.attrs)) md.push(`- \`${k}\` = \`${v}\``);
              }
              if (n.text) md.push(`- text → ${JSON.stringify(typeof n.text === 'string' ? n.text : n.text.to)}`);
              if (n.html) md.push('', '```html', n.html, '```');
              if (n.note) md.push('', n.note);
              md.push('');
            }
          }
          if (!diff.css.length && !diff.dom.length) md.push('_nothing changed_');

          // Latest is what gets read; the stamped copy means a second capture
          // doesn't destroy the first.
          const text = md.join('\n') + '\n';
          await writeFile(new URL(`./latest.md`, dir), text);
          await writeFile(new URL(`./${stamp}.md`, dir), text);
          await writeFile(new URL(`./latest.json`, dir), JSON.stringify({ url, viewport, diff }, null, 2) + '\n');
          res.end('.inspect/latest.md');
        } catch (err) {
          res.statusCode = 400;
          res.end(String(err));
        }
      });
    });
  },
});

/*
 * Everything in `public/` ships verbatim, including the things that only exist
 * for making the site. `inspect-capture.js` is loaded under `import.meta.env.DEV`
 * so no built page ever references it — but it was still being copied into
 * `dist/js/`, which puts a dev tool on the live site for nobody to fetch.
 *
 * Removed after the build rather than moved out of `public/`, because the dev
 * server needs it at a stable URL.
 */
const stripDevAssets = () => ({
  name: 'strip-dev-assets',
  hooks: {
    'astro:build:done': async ({ dir, logger }) => {
      await rm(new URL('./js/inspect-capture.js', dir), { force: true });
      logger.info('stripped js/inspect-capture.js from the build');
    },
  },
});

/*
 * PORTED FROM vinton.land, verbatim apart from the comments. The three
 * storefronts share one Shopify store and this hook is the same in all three;
 * fix a bug here and it wants fixing in the siblings too.
 */
const SHOP_IMG_DIR = 'img/shop/';
const shopImageMirror = () => ({
  name: 'shop-image-mirror',
  hooks: {
    'astro:build:done': async ({ dir, logger }) => {
      const { readdir, readFile, writeFile, mkdir } = await import('node:fs/promises');
      const { createHash } = await import('node:crypto');

      // Every built text file that could carry a CDN URL.
      const walk = async (root) => {
        const out = [];
        for (const entry of await readdir(root, { withFileTypes: true })) {
          const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), root);
          if (entry.isDirectory()) out.push(...(await walk(child)));
          else if (/\.(html|css|js|json|xml)$/.test(entry.name)) out.push(child);
        }
        return out;
      };

      const files = await walk(dir);
      const RE = /https:\/\/cdn\.shopify\.com\/[^"'\s\\)]+/g;

      /*
       * The matched text is HTML, so its `&` are `&amp;` — and a Shopify URL
       * carries two parameters, `?v=…&width=…`. Fetching the escaped string
       * asks for a parameter literally named `amp;width`, which Shopify
       * ignores: the first run of this mirrored FIVE COPIES OF THE FULL-SIZE
       * ORIGINAL per product, 117KB each, instead of the 16–51KB variants.
       *
       * So: fetch and hash the DECODED url, replace the ESCAPED one.
       */
      const decode = (u) => u.replace(/&amp;/g, '&').replace(/&#38;/g, '&');

      // One pass to collect, so each distinct URL is fetched exactly once even
      // when it appears in a dozen srcsets.
      const wanted = new Map();   // matched text -> canonical url
      const canon = new Map();    // canonical url -> { name }
      const sources = new Map();
      for (const file of files) {
        const text = await readFile(file, 'utf8');
        const hits = text.match(RE);
        if (!hits) continue;
        sources.set(file, text);
        for (const match of hits) {
          if (wanted.has(match)) continue;
          const url = decode(match);
          wanted.set(match, url);
          if (!canon.has(url)) canon.set(url, { name: null, url });
        }
      }
      if (!canon.size) return;

      const outDir = new URL(SHOP_IMG_DIR, dir);
      await mkdir(outDir, { recursive: true });

      let bytes = 0;
      const jobs = [...canon.values()];
      // A small pool: a dozen images should not open a dozen sockets at once,
      // and a Netlify build that was cut to ~15s should not grow by much.
      const POOL = 4;
      let cursor = 0;
      const EXT = { 'image/webp': 'webp', 'image/avif': 'avif', 'image/png': 'png',
                    'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/svg+xml': 'svg' };
      const worker = async () => {
        while (cursor < jobs.length) {
          const job = jobs[cursor++];
          const res = await fetch(job.url, { headers: { Accept: 'image/webp,image/avif,image/*' } });
          if (!res.ok) throw new Error(`shop-image-mirror: ${res.status} for ${job.url}`);
          const buf = Buffer.from(await res.arrayBuffer());
          // Extension from what came BACK, not from the URL: Shopify answers a
          // `.png` url with WebP when the Accept header allows it, and naming
          // that file .png would ship the right bytes under a lying name.
          const type = (res.headers.get('content-type') || '').split(';')[0].trim();
          const ext = EXT[type] || 'bin';
          job.name = createHash('sha256').update(job.url).digest('hex').slice(0, 16) + '.' + ext;
          await writeFile(new URL(job.name, outDir), buf);
          bytes += buf.length;
        }
      };
      await Promise.all(Array.from({ length: POOL }, worker));

      /*
       * Longest URL first. A srcset holds `…?width=320` and `…?width=3200`, and
       * replacing the short one first would corrupt the long one — the classic
       * substring-replacement bug, and it would only show up as a broken image
       * at one breakpoint.
       */
      const ordered = [...wanted].sort((a, b) => b[0].length - a[0].length);
      for (const [file, text] of sources) {
        let out = text;
        for (const [match, url] of ordered) {
          out = out.split(match).join('/' + SHOP_IMG_DIR + canon.get(url).name);
        }
        /*
         * The preconnect goes too. A layout may emit one for the LCP image's
         * origin, which was the whole point while that origin was Shopify's —
         * now it would open a TLS connection to a host the page never calls,
         * which is both a wasted handshake and exactly the third-party contact
         * this hook exists to remove. Its href has no path, so the URL regex
         * above does not see it.
         */
        out = out.replace(/<link\b[^>]*rel="preconnect"[^>]*cdn\.shopify\.com[^>]*>/g, '');
        await writeFile(file, out);
      }

      logger.info(
        `mirrored ${canon.size} Shopify images (${(bytes / 1024).toFixed(0)}KB) into /${SHOP_IMG_DIR} — no third-party image origin remains`
      );
    },
  },
});

/*
 * The share card and the structured data have to carry ABSOLUTE urls, and by
 * the time this runs they do not.
 *
 * The layout builds `og:image` absolute — and then `shopImageMirror()` rewrites
 * that Shopify CDN url to a local `/img/shop/…` path, because it rewrites every
 * occurrence in the output and cannot tell a `<meta>` from an `<img>`. Each
 * half is right on its own; the pair ships a relative og:image, which no
 * scraper will fetch. The same goes for the `image` array in the JSON-LD.
 *
 * It only shows on PRODUCT pages — the rest of the site has no mirrored image
 * in its head — which is exactly why it went unnoticed on all three sites.
 *
 * So: after the mirror, absolutise. Meta by attribute and name, and the JSON-LD
 * by PARSING it and walking every string: a regex over a graph that nests
 * offers inside products inside a list would be guesswork.
 *
 * SHARED WITH THE SIBLINGS, like the mirror it repairs. This is identical in
 * vinton.land, mmmornings and glizzy apart from the site it is passed; fix a
 * bug here and it wants fixing in the other two.
 */
const ABSOLUTE_META = [
  ['property', 'og:image'],
  ['property', 'og:url'],
  ['name', 'twitter:image'],
  ['itemprop', 'image'],
];
const absolutiseSocialUrls = (site) => ({
  name: 'absolutise-social-urls',
  hooks: {
    'astro:build:done': async ({ dir, logger }) => {
      const { readdir, readFile, writeFile } = await import('node:fs/promises');

      const origin = new URL(site).origin;
      const abs = (v) =>
        typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? origin + v : v;
      const walk = (node) =>
        Array.isArray(node)
          ? node.map(walk)
          : node && typeof node === 'object'
            ? Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]))
            : abs(node);

      const pages = [];
      const collect = async (d) => {
        for (const e of await readdir(d, { withFileTypes: true })) {
          const next = new URL(`./${e.name}${e.isDirectory() ? '/' : ''}`, d);
          if (e.isDirectory()) await collect(next);
          else if (e.name.endsWith('.html')) pages.push(next);
        }
      };
      await collect(dir);

      let fixed = 0;
      for (const file of pages) {
        const before = await readFile(file, 'utf8');
        let out = before;

        for (const [attr, name] of ABSOLUTE_META) {
          out = out.replace(
            new RegExp(`(<meta ${attr}="${name}" content=")(/[^"]*)(")`, 'g'),
            (_m, a, url, z) => a + origin + url + z
          );
        }

        out = out.replace(
          /(<script type="application\/ld\+json">)(.*?)(<\/script>)/gs,
          (m, open, json, close) => {
            try {
              return open + JSON.stringify(walk(JSON.parse(json))) + close;
            } catch {
              return m; // never trade valid markup for a failed parse
            }
          }
        );

        if (out !== before) {
          await writeFile(file, out);
          fixed++;
        }
      }
      logger.info(`absolutised share-card and JSON-LD urls on ${fixed} page(s)`);
    },
  },
});

/*
 * sitemap.xml and robots.txt, written from what actually got BUILT rather than
 * from a list of routes kept by hand — a sitemap that names a page that no
 * longer exists is worse than no sitemap.
 *
 * A page opts out by carrying `noindex` (the Layout prop), which is the same
 * switch that keeps it out of results. One decision, stated once: /thanks is
 * only reached by a form redirect and /type is a specimen sheet.
 *
 * Hand-rolled rather than @astrojs/sitemap on purpose — Netlify builds with
 * NODE_ENV=production and installs no devDependencies, so an integration has
 * to sit in `dependencies` to survive CI. This is 20 lines and no dependency.
 */
const sitemap = (site) => ({
  name: 'sitemap',
  hooks: {
    'astro:build:done': async ({ dir, logger }) => {
      const { readdir, readFile, writeFile } = await import('node:fs/promises');

      const origin = new URL(site).origin;
      const urls = [];
      const collect = async (d, path = '') => {
        for (const e of await readdir(d, { withFileTypes: true })) {
          if (e.isDirectory()) await collect(new URL(`./${e.name}/`, d), `${path}${e.name}/`);
          else if (e.name === 'index.html') {
            const html = await readFile(new URL(`./${e.name}`, d), 'utf8');
            if (!/name="robots"[^>]*noindex/.test(html)) urls.push(`${origin}/${path}`);
          }
        }
      };
      await collect(dir);
      urls.sort();

      await writeFile(
        new URL('./sitemap.xml', dir),
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
          urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n') +
          '\n</urlset>\n'
      );
      await writeFile(
        new URL('./robots.txt', dir),
        `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`
      );
      logger.info(`sitemap.xml with ${urls.length} url(s), and robots.txt`);
    },
  },
});

const SITE = 'https://glizzy.store';

export default defineConfig({
  site: SITE,
  output: 'static',
  /*
   * Order is load-bearing. After stripDevAssets: no point mirroring an image
   * only a stripped page used. absolutiseSocialUrls AFTER the mirror, because
   * it exists to repair what the mirror does to og:image. sitemap last, so it
   * reads the finished pages.
   */
  integrations: [stripDevAssets(), shopImageMirror(), absolutiseSocialUrls(SITE), sitemap(SITE)],
  server: { port: 3334 },
  /*
   * Astro 7 defaults this to 'jsx', which strips whitespace by JSX rules
   * rather than HTML ones — it deletes the space before an inline element
   * written on its own line. These are hand-authored HTML templates, and
   * vinton.land was bitten by exactly that ("while\n<code>--color-*</code>"
   * came out as "while--color-*"). Pinned here so the three sibling repos
   * can't drift.
   */
  compressHTML: true,
  build: { inlineStylesheets: 'auto' },
  vite: {
    plugins: [inspectSave()],
    build: {
      /*
       * Name the browsers, because the CSS minifier collapses vendor prefixes
       * against them and its default guess is wrong here.
       *
       * `.window` declares `backdrop-filter` and then `-webkit-backdrop-filter`.
       * Under Vite's default target esbuild decided the -webkit- one covered
       * everything and DELETED the standard property — and Chrome has since
       * removed the -webkit- alias, so the built page had no blur at all while
       * the source still plainly asked for one. Nothing warned; the stylesheet
       * was valid, just missing a line.
       *
       * safari15 keeps the prefixed copy (iOS needs it below 18), chrome111
       * keeps the standard one. Both survive because both are asked for.
       */
      cssTarget: ['chrome111', 'safari15'],
    },
  },
});
