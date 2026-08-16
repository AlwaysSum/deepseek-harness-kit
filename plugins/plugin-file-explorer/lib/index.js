// @dsh-kit/plugin-file-explorer — host half.
// Registers same-origin JSON routes under /dshkit-fs/* that back the sidebar
//「文件」tab: list a session's workspace directory tree, read, and write files.
// Broken out of the browser client so the browser never touches the fs directly.
//
// Uses the dsh fs service (`ctx.fs` → `listDir` / `readText` / `writeText`) with a
// raw node:fs/promises fallback, so a file tree can show FILES (the built-in
// `host.listDirectory` wire method only returns directories).

import {
  readdir as fsReaddir,
  stat as fsStat,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  realpath,
  mkdir as fsMkdir,
  rename as fsRename,
  rm as fsRm,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, relative, resolve, sep } from "node:path";

export const name = "plugin-file-explorer";
export const inject = ["webServer"];

const ROUTE_PREFIX = "/dshkit-fs";

/** 文本读取大小上限（字节）。媒体文件走 /media 流式读取，不受此限制。 */
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const IMAGE_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
};
const VIDEO_MIME = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  ogg: "video/ogg",
  mov: "video/quicktime",
};
/** /media 支持的媒体类型（图片 + 视频），供 webview 内 <img>/<video> 直接引用。 */
const MEDIA_MIME = { ...IMAGE_MIME, ...VIDEO_MIME };

/** Loopback / trusted-host guard (mirrors the /plugin-market fence). */
function isTrustedRequest(req) {
  const host = String(req.headers?.host ?? "").toLowerCase();
  const hostname = host.split(":")[0];
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024 * 8) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data.length > 0 ? JSON.parse(data) : {});
      } catch {
        reject(new Error("无效的 JSON 请求体"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Resolve a session's working directory to a canonical path.
 * Priority: session.header.cwd (validated by dsh-session) → workspace registry
 * record whose sessionIds includes it → null. Services are looked up lazily via
 * ctx.get so they need not be mounted during apply.
 */
async function resolveSessionDir(ctx, sessionId) {
  if (!sessionId) return null;
  const sessions = ctx.get?.("sessions");
  if (sessions && typeof sessions.get === "function") {
    try {
      const s = await sessions.get(sessionId);
      const cwd = s?.header?.cwd;
      if (cwd) {
        try {
          return await realpath(String(cwd));
        } catch {
          return String(cwd);
        }
      }
    } catch {}
  }
  try {
    const reg = ctx.get?.("workspaceRegistry");
    if (reg && typeof reg.list === "function") {
      const workspaces = await reg.list();
      for (const w of workspaces || []) {
        if (Array.isArray(w?.sessionIds) && w.sessionIds.includes(sessionId) && w?.path) {
          try {
            return await realpath(String(w.path));
          } catch {
            return String(w.path);
          }
        }
      }
    }
  } catch {}
  return null;
}

/** Reject any rel path that escapes the workspace root. */
function safeResolve(root, rel) {
  const target = resolve(root, rel || ".");
  const relCheck = relative(root, target);
  if (relCheck.startsWith("..") || resolve(root, relCheck) !== target) return null;
  return target;
}

/**
 * Read one directory's children using ctx.fs (listDir) when available, else
 * raw node:fs. Returns [{ name, type: 'dir'|'file', size }...].
 */
async function listDirWithFallback(ctx, target) {
  const fs = ctx.get?.("fs");
  if (fs && typeof fs.listDir === "function" && typeof fs.resolve === "function") {
    try {
      const fr = await fs.resolve(String(target), { cwd: String(target) });
      const entries = await fs.listDir(fr, undefined);
      return entries.map((e) => ({
        name: e.name,
        type: e.type === "directory" ? "dir" : e.type === "file" ? "file" : "other",
        size: e.size,
      }));
    } catch {
      // fall through to node:fs
    }
  }
  const dirents = await fsReaddir(target, { withFileTypes: true });
  return dirents.map((d) => ({
    name: d.name,
    type: d.isDirectory() ? "dir" : d.isFile() ? "file" : "other",
    size: undefined,
  }));
}

async function buildTree(ctx, root, relDir, depth) {
  if (depth > 12) return { name: "", type: "dir", path: "", children: [] };
  const target = safeResolve(root, relDir);
  if (!target) return { name: relDir.split(sep).pop(), type: "dir", path: relDir, children: [] };
  let entries;
  try {
    entries = await listDirWithFallback(ctx, target);
  } catch {
    return { name: relDir.split(sep).pop(), type: "dir", path: relDir, children: [] };
  }
  entries.sort((a, b) => {
    if (a.type === "dir" !== (b.type === "dir")) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const children = [];
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const childRel = relDir ? `${relDir}/${e.name}` : e.name;
    if (!safeResolve(root, childRel)) continue;
    if (e.type === "dir") {
      const sub = await buildTree(ctx, root, childRel, depth + 1);
      children.push({ name: e.name, type: "dir", path: childRel, children: sub.children || [] });
    } else {
      children.push({ name: e.name, type: e.type === "file" ? "file" : "other", path: childRel, size: e.size });
    }
  }
  return { name: relDir.split(sep).pop() || "/", type: "dir", path: relDir, children };
}

async function readFileWithFallback(ctx, target) {
  const fs = ctx.get?.("fs");
  if (fs && typeof fs.readText === "function" && typeof fs.resolve === "function") {
    try {
      const fr = await fs.resolve(String(target), { cwd: String(target) });
      return await fs.readText(fr, undefined);
    } catch {
      // fall through
    }
  }
  return await fsReadFile(target, "utf8");
}

async function writeFileWithFallback(ctx, target, content) {
  const fs = ctx.get?.("fs");
  if (fs && typeof fs.writeText === "function" && typeof fs.resolve === "function") {
    try {
      const fr = await fs.resolve(String(target), { cwd: String(target) });
      return await fs.writeText(fr, content, { kind: "replaceIfVersion", version: undefined }, undefined, undefined);
    } catch {
      // fall through
    }
  }
  await fsWriteFile(target, content, "utf8");
}

/** 名称合法性：非空、不含路径分隔符与 NUL。 */
function isValidName(name) {
  return typeof name === "string" && name.length > 0 && name !== "." && name !== ".." && !/[\\/\0]/.test(name);
}

/** 在 root 下 dir 内新建文件/文件夹；返回 {ok, path?, error?}。 */
async function createEntry(ctx, root, dir, name, kind, content) {
  if (!isValidName(name)) return { ok: false, error: "invalid name" };
  const parent = safeResolve(root, dir || ".");
  if (!parent) return { ok: false, error: "invalid path" };
  const target = resolve(parent, name);
  const relCheck = relative(root, target);
  if (relCheck.startsWith("..")) return { ok: false, error: "invalid path" };
  try {
    await fsStat(target);
    return { ok: false, error: "exists" };
  } catch {
    /* not exist, proceed */
  }
  if (kind === "dir") {
    await fsMkdir(target, { recursive: false });
  } else {
    await writeFileWithFallback(ctx, target, content ?? "");
  }
  return { ok: true, path: relCheck.split(sep).join("/") };
}

/** 重命名 root 下的文件/目录；返回 {ok, path?, error?}。 */
async function renameEntry(ctx, root, path, name) {
  if (!isValidName(name)) return { ok: false, error: "invalid name" };
  const target = safeResolve(root, path);
  if (!target) return { ok: false, error: "invalid path" };
  let st;
  try {
    st = await fsStat(target);
  } catch {
    return { ok: false, error: "not found" };
  }
  const newTarget = resolve(dirname(target), name);
  const relCheck = relative(root, newTarget);
  if (relCheck.startsWith("..")) return { ok: false, error: "invalid path" };
  try {
    await fsStat(newTarget);
    return { ok: false, error: "exists" };
  } catch {
    /* target name free */
  }
  await fsRename(target, newTarget);
  return { ok: true, path: relCheck.split(sep).join("/") };
}

/** 删除 root 下的文件/目录（目录递归）；返回 {ok, error?}。 */
async function deleteEntry(root, path) {
  const target = safeResolve(root, path);
  if (!target) return { ok: false, error: "invalid path" };
  if (relative(root, target) === "") return { ok: false, error: "invalid path" };
  let st;
  try {
    st = await fsStat(target);
  } catch {
    return { ok: false, error: "not found" };
  }
  await fsRm(target, { recursive: st.isDirectory(), force: false });
  return { ok: true };
}

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: `${ROUTE_PREFIX}/tree`,
        handler: async (req, res) => {
          if (!isTrustedRequest(req)) return sendJson(res, 403, { error: "forbidden" });
          if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
          const url = new URL(req.url ?? "/", "http://x");
          const session = url.searchParams.get("session") ?? "";
          const dir = url.searchParams.get("dir") ?? "";
          try {
            const root = await resolveSessionDir(ctx, session);
            if (!root) return sendJson(res, 200, { ok: true, root: null, tree: null });
            const tree = await buildTree(ctx, root, dir, 0);
            sendJson(res, 200, { ok: true, root, tree });
          } catch (error) {
            sendJson(res, 200, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }),
    "plugin-file-explorer: route /tree"
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: `${ROUTE_PREFIX}/read`,
        handler: async (req, res) => {
          if (!isTrustedRequest(req)) return sendJson(res, 403, { error: "forbidden" });
          if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
          const url = new URL(req.url ?? "/", "http://x");
          const session = url.searchParams.get("session") ?? "";
          const rel = url.searchParams.get("path") ?? "";
          try {
            const root = await resolveSessionDir(ctx, session);
            if (!root) return sendJson(res, 200, { ok: false, error: "no session dir" });
            const target = safeResolve(root, rel);
            if (!target) return sendJson(res, 200, { ok: false, error: "invalid path" });
            const st = await fsStat(target).catch(() => null);
            if (!st || !st.isFile()) return sendJson(res, 200, { ok: false, error: "not found" });
            // 文本：大小上限 + NUL 字节二进制嗅探。
            if (st.size > MAX_TEXT_BYTES) return sendJson(res, 200, { ok: false, error: "too large" });
            const content = await readFileWithFallback(ctx, target);
            if (content.includes("\0")) return sendJson(res, 200, { ok: false, error: "binary" });
            sendJson(res, 200, { ok: true, content });
          } catch (error) {
            sendJson(res, 200, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }),
    "plugin-file-explorer: route /read"
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: `${ROUTE_PREFIX}/write`,
        handler: async (req, res) => {
          if (!isTrustedRequest(req)) return sendJson(res, 403, { error: "forbidden" });
          if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
          let body;
          try {
            body = await readBody(req);
          } catch (error) {
            return sendJson(res, 400, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          const session = typeof body?.session === "string" ? body.session : "";
          const rel = typeof body?.path === "string" ? body.path : "";
          const content = typeof body?.content === "string" ? body.content : "";
          try {
            const root = await resolveSessionDir(ctx, session);
            if (!root) return sendJson(res, 200, { ok: false, error: "no session dir" });
            const target = safeResolve(root, rel);
            if (!target) return sendJson(res, 200, { ok: false, error: "invalid path" });
            await writeFileWithFallback(ctx, target, content);
            sendJson(res, 200, { ok: true });
          } catch (error) {
            sendJson(res, 200, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }),
    "plugin-file-explorer: route /write"
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: `${ROUTE_PREFIX}/create`,
        handler: async (req, res) => {
          if (!isTrustedRequest(req)) return sendJson(res, 403, { error: "forbidden" });
          if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
          let body;
          try {
            body = await readBody(req);
          } catch (error) {
            return sendJson(res, 400, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          const session = typeof body?.session === "string" ? body.session : "";
          const dir = typeof body?.dir === "string" ? body.dir : "";
          const name = typeof body?.name === "string" ? body.name : "";
          const kind = body?.kind === "dir" ? "dir" : "file";
          const content = typeof body?.content === "string" ? body.content : "";
          try {
            const root = await resolveSessionDir(ctx, session);
            if (!root) return sendJson(res, 200, { ok: false, error: "no session dir" });
            const result = await createEntry(ctx, root, dir, name, kind, content);
            sendJson(res, 200, result);
          } catch (error) {
            sendJson(res, 200, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }),
    "plugin-file-explorer: route /create"
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: `${ROUTE_PREFIX}/rename`,
        handler: async (req, res) => {
          if (!isTrustedRequest(req)) return sendJson(res, 403, { error: "forbidden" });
          if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
          let body;
          try {
            body = await readBody(req);
          } catch (error) {
            return sendJson(res, 400, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          const session = typeof body?.session === "string" ? body.session : "";
          const rel = typeof body?.path === "string" ? body.path : "";
          const name = typeof body?.name === "string" ? body.name : "";
          try {
            const root = await resolveSessionDir(ctx, session);
            if (!root) return sendJson(res, 200, { ok: false, error: "no session dir" });
            const result = await renameEntry(ctx, root, rel, name);
            sendJson(res, 200, result);
          } catch (error) {
            sendJson(res, 200, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }),
    "plugin-file-explorer: route /rename"
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: `${ROUTE_PREFIX}/delete`,
        handler: async (req, res) => {
          if (!isTrustedRequest(req)) return sendJson(res, 403, { error: "forbidden" });
          if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
          let body;
          try {
            body = await readBody(req);
          } catch (error) {
            return sendJson(res, 400, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          const session = typeof body?.session === "string" ? body.session : "";
          const rel = typeof body?.path === "string" ? body.path : "";
          try {
            const root = await resolveSessionDir(ctx, session);
            if (!root) return sendJson(res, 200, { ok: false, error: "no session dir" });
            const result = await deleteEntry(root, rel);
            sendJson(res, 200, result);
          } catch (error) {
            sendJson(res, 200, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }),
    "plugin-file-explorer: route /delete"
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: `${ROUTE_PREFIX}/media`,
        handler: async (req, res) => {
          if (!isTrustedRequest(req)) return sendJson(res, 403, { error: "forbidden" });
          if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
          const url = new URL(req.url ?? "/", "http://x");
          const session = url.searchParams.get("session") ?? "";
          const rel = url.searchParams.get("path") ?? "";
          try {
            const root = await resolveSessionDir(ctx, session);
            if (!root) return sendJson(res, 200, { ok: false, error: "no session dir" });
            const target = safeResolve(root, rel);
            if (!target) return sendJson(res, 200, { ok: false, error: "invalid path" });
            const st = await fsStat(target).catch(() => null);
            if (!st || !st.isFile()) return sendJson(res, 200, { ok: false, error: "not found" });
            const ext = String(target).toLowerCase().split(".").pop() ?? "";
            const mime = MEDIA_MIME[ext];
            if (!mime) return sendJson(res, 200, { ok: false, error: "unsupported" });
            // 支持 Range 以便 <video> 拖动进度 / seek。
            const range = req.headers.range;
            if (range) {
              const m = /bytes=(\d*)-(\d*)/.exec(range);
              if (m) {
                const start = m[1] ? parseInt(m[1], 10) : 0;
                const end = m[2] ? Math.min(parseInt(m[2], 10), st.size - 1) : st.size - 1;
                if (start <= end && start < st.size) {
                  res.writeHead(206, {
                    "content-type": mime,
                    "content-length": end - start + 1,
                    "content-range": `bytes ${start}-${end}/${st.size}`,
                    "accept-ranges": "bytes",
                    "cache-control": "no-store",
                  });
                  createReadStream(target, { start, end }).pipe(res);
                  return;
                }
              }
            }
            res.writeHead(200, {
              "content-type": mime,
              "content-length": st.size,
              "accept-ranges": "bytes",
              "cache-control": "no-store",
            });
            createReadStream(target).pipe(res);
          } catch (error) {
            sendJson(res, 200, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }),
    "plugin-file-explorer: route /media"
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: `${ROUTE_PREFIX}/open`,
        handler: async (req, res) => {
          if (!isTrustedRequest(req)) return sendJson(res, 403, { error: "forbidden" });
          if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
          let body;
          try {
            body = await readBody(req);
          } catch (error) {
            return sendJson(res, 400, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          const session = typeof body?.session === "string" ? body.session : "";
          const rel = typeof body?.path === "string" ? body.path : "";
          try {
            const root = await resolveSessionDir(ctx, session);
            if (!root) return sendJson(res, 200, { ok: false, error: "no session dir" });
            const target = safeResolve(root, rel);
            if (!target) return sendJson(res, 200, { ok: false, error: "invalid path" });
            const st = await fsStat(target).catch(() => null);
            if (!st || !st.isFile()) return sendJson(res, 200, { ok: false, error: "not found" });
            // 调用系统默认应用打开（Windows: explorer 关联；macOS: open；Linux: xdg-open）。
            const cmd =
              process.platform === "win32"
                ? ["explorer.exe", String(target)]
                : process.platform === "darwin"
                  ? ["open", String(target)]
                  : ["xdg-open", String(target)];
            let sent = false;
            const child = spawn(cmd[0], cmd.slice(1), { detached: true, stdio: "ignore" });
            child.on("error", () => {
              if (sent) return;
              sent = true;
              sendJson(res, 200, { ok: false, error: "无法调用系统默认应用" });
            });
            child.on("spawn", () => {
              if (sent) return;
              sent = true;
              sendJson(res, 200, { ok: true });
            });
            child.unref();
          } catch (error) {
            sendJson(res, 200, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }),
    "plugin-file-explorer: route /open"
  );
}
