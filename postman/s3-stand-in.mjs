// A tiny stand-in for Amazon S3, for profile photos in tests. Path-style
// only (http://localhost:9997/<bucket>/<key>), kept in memory, and it
// ignores signatures, so a signed link from the API just works.
//
//   npm run s3:stand-in
//
// Test controls:
//   GET /_objects?prefix=avatars/<user_id>/   the stored keys and sizes
import http from "http";

const PORT = Number(process.env.S3_STAND_IN_PORT || 9997);
const objects = new Map(); // "bucket/key" → { body, type, cacheControl }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = decodeURIComponent(url.pathname.slice(1));

  if (path === "_objects") {
    const prefix = url.searchParams.get("prefix") || "";
    const list = [...objects.entries()]
      .map(([k, v]) => ({ key: k.slice(k.indexOf("/") + 1), size: v.body.length }))
      .filter((o) => o.key.startsWith(prefix));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(list));
  }

  if (req.method === "PUT") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      objects.set(path, {
        body: Buffer.concat(chunks),
        type: req.headers["content-type"] || "application/octet-stream",
        cacheControl: req.headers["cache-control"],
      });
      res.writeHead(200, { ETag: '"stand-in"' });
      res.end();
    });
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    const found = objects.get(path);
    if (!found) {
      res.writeHead(404, { "Content-Type": "application/xml" });
      return res.end("<Error><Code>NoSuchKey</Code></Error>");
    }
    res.writeHead(200, {
      "Content-Type": found.type,
      "Content-Length": found.body.length,
      ...(found.cacheControl && { "Cache-Control": found.cacheControl }),
    });
    return res.end(req.method === "HEAD" ? undefined : found.body);
  }

  if (req.method === "DELETE") {
    objects.delete(path);
    res.writeHead(204);
    return res.end();
  }

  res.writeHead(405);
  res.end();
});

server.listen(PORT, () => console.log(`S3 stand-in on http://localhost:${PORT}`));
