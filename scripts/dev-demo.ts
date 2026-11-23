import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

const DEMO_DIR = resolve(import.meta.dir, "../dist/demo");
const PORT = Number(process.env.PORT ?? 4173);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
};

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = resolve(DEMO_DIR, `.${rel}`);
    if (
      !filePath.startsWith(DEMO_DIR + sep) ||
      !existsSync(filePath) ||
      !statSync(filePath).isFile()
    ) {
      return new Response("Not found", { status: 404 });
    }
    const ext = extname(filePath);
    return new Response(readFileSync(filePath), {
      headers: { "Content-Type": MIME[ext] ?? "application/octet-stream" },
    });
  },
});

console.log(`TC39 Signals Demo serving on http://127.0.0.1:${server.port}`);
