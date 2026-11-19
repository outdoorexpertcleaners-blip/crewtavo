/**
 * A showcase link's preview (lib/showcaseTags.ts): /s/<token> is answered with the app's page plus
 * Open Graph and Twitter card tags for that showcase, so a link pasted into Facebook, Nextdoor or a
 * text shows its title, write-up and first photo. Only a showcase that's there to be seen gets
 * them; what the office wrote can't break out of the tags; and the page stays out of search engines.
 */
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { previewOf, previewTags, showcasePage, withPreview, type ShowcasePreview } from "../src/lib/showcaseTags";

const TOKEN = "0123456789abcdef0123456789abcdef";
const INDEX = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>The app</title></head><body><div id="root"></div><script type="module" src="/assets/index-abc.js"></script></body></html>';
/** What GET /api/public/showcases/<token> answers. */
const page = {
  company: { name: "Sketchy Gutters", phone: "(540) 555-0100", website: null, logo: null, color: "#225588" },
  title: "Driveway resealed",
  description: "Cracks filled and two coats down.\n\nIt had been ten years.",
  town: "Springfield, IL",
  published_at: "2026-11-13T12:00:00Z",
  photos: [{ role: "before", src: `/api/public/showcases/${TOKEN}/7.jpg` }, { role: "after", src: `/api/public/showcases/${TOKEN}/8.jpg` }],
  book_url: "/book/sketchy/spring",
};

const content = (html: string, key: string) => new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`).exec(html)?.[1];

describe("a showcase's preview tags", () => {
  it("carry its title, the start of its write-up, its first photo and its own address", () => {
    const preview = previewOf(page, "https://crew.example.com/", TOKEN)!;
    expect(preview).toEqual({
      title: "Driveway resealed",
      description: "Cracks filled and two coats down. It had been ten years.",
      company: "Sketchy Gutters",
      image: `https://crew.example.com/api/public/showcases/${TOKEN}/7.jpg`,
      url: `https://crew.example.com/s/${TOKEN}`,
    });
    const html = withPreview(INDEX, previewTags(preview));
    expect(content(html, "og:title")).toBe("Driveway resealed");
    expect(content(html, "og:description")).toBe("Cracks filled and two coats down. It had been ten years.");
    expect(content(html, "og:image")).toBe(`https://crew.example.com/api/public/showcases/${TOKEN}/7.jpg`);
    expect(content(html, "og:url")).toBe(`https://crew.example.com/s/${TOKEN}`);
    expect(content(html, "og:site_name")).toBe("Sketchy Gutters");
    expect(content(html, "twitter:card")).toBe("summary_large_image");
    expect(content(html, "twitter:image")).toBe(content(html, "og:image"));
    // In the head, and the app's own page is all still there.
    expect(html.indexOf("og:title")).toBeLessThan(html.indexOf("</head>"));
    expect(html.replace(previewTags(preview), "")).toBe(INDEX);
  });

  it("stay out of search engines, as the page's data and photos do", () => {
    expect(previewTags(previewOf(page, "https://crew.example.com", TOKEN)!)).toContain('<meta name="robots" content="noindex">');
  });

  it("can't be broken out of by what the office wrote", () => {
    const nasty = { ...page, title: `Roof "done" <script>alert(1)</script>`, description: `It's fine"><img src=x onerror=alert(1)> & more`, company: { name: `O'Neil & Sons "Roofing"` } };
    const html = withPreview(INDEX, previewTags(previewOf(nasty, "https://crew.example.com", TOKEN)!));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(content(html, "og:title")).toBe("Roof &quot;done&quot; &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(content(html, "og:site_name")).toBe("O&#39;Neil &amp; Sons &quot;Roofing&quot;");
    // The only tags added are meta tags.
    const added = html.slice(INDEX.indexOf("</head>"), html.indexOf("</head>"));
    expect(added.replace(/<meta (?:property|name)="[a-z:_]+" content="[^"<>]*">/g, "")).toBe("");
  });

  it("make do without a photo or a write-up, and keep a long write-up short", () => {
    const bare = previewOf({ ...page, description: "", photos: [] }, "https://crew.example.com", TOKEN)!;
    expect(bare).toMatchObject({ image: null, description: "A job by Sketchy Gutters." });
    const tags = previewTags(bare);
    expect(tags).not.toContain("og:image");
    expect(content(tags, "twitter:card")).toBe("summary");
    const long = previewOf({ ...page, description: "word ".repeat(200) }, "https://crew.example.com", TOKEN)!;
    expect(long.description.length).toBeLessThanOrEqual(200);
    expect(long.description.endsWith("…")).toBe(true);
    // A photo address that isn't one of the page's own isn't used.
    expect(previewOf({ ...page, photos: [{ src: "https://elsewhere.example.com/x.jpg" }] }, "https://crew.example.com", TOKEN)!.image).toBeNull();
    expect(previewOf({ error: "This showcase isn't available" }, "https://crew.example.com", TOKEN)).toBeNull();
  });
});

describe("/s/:token", () => {
  const serve = (lookup: (token: string) => Promise<ShowcasePreview | null>, clock = { now: 0 }) => {
    const server = new Hono();
    server.get("/s/:token", showcasePage({ indexHtml: INDEX, lookup, now: () => clock.now }));
    server.get("*", (c) => c.html(INDEX));
    return server;
  };
  const preview = previewOf(page, "https://crew.example.com", TOKEN)!;

  it("answers a published showcase's link with its tags, marked noindex", async () => {
    const res = await serve(async () => preview).request(`/s/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    const html = await res.text();
    expect(content(html, "og:title")).toBe("Driveway resealed");
    expect(html).toContain('<div id="root"></div>');
  });

  it("answers the plain page, with no tags, for a showcase that isn't published or a link that isn't one", async () => {
    const lookup = vi.fn(async () => null);
    const server = serve(lookup);
    const gone = await server.request(`/s/${TOKEN}`);
    expect(await gone.text()).toBe(INDEX);
    const bad = await server.request("/s/not-a-token");
    expect(await bad.text()).toBe(INDEX);
    expect(lookup).toHaveBeenCalledTimes(1);
    // Trouble reading it is no reason to break the page.
    const broken = await serve(async () => { throw new Error("database is away"); }).request(`/s/${TOKEN}`);
    expect(await broken.text()).toBe(INDEX);
  });

  it("reads a showcase once a minute however often its link is fetched, and notices within the minute when it comes down", async () => {
    const clock = { now: 1_000_000 };
    let published = true;
    const lookup = vi.fn(async () => (published ? preview : null));
    const server = serve(lookup, clock);
    for (let i = 0; i < 5; i++) expect(content(await (await server.request(`/s/${TOKEN}`)).text(), "og:title")).toBe("Driveway resealed");
    expect(lookup).toHaveBeenCalledTimes(1);
    published = false;
    clock.now += 61_000;
    expect(await (await server.request(`/s/${TOKEN}`)).text()).toBe(INDEX);
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
