// netlify/functions/sync.mjs
// Синхронизация шкал: GET /api/sync — отдать данные, POST /api/sync — слить и сохранить.
// Пароль (по желанию) — переменная окружения SYNC_PASSWORD (Netlify → Project configuration → Environment variables).
import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";

export const config = { path: "/api/sync" };

var MAX = 10;
var KEY = "state";
var MAX_BODY = 256 * 1024;

  /* ===== Слияние данных. Этот блок одинаковый на сервере и в странице ===== */
  var KEEP_DELETED = 365 * 24 * 3600 * 1000;      // метки удаления живут год

  function num(v) { v = Number(v); return isFinite(v) && v > 0 ? Math.floor(v) : 0; }
  function idTime(id) { var t = parseInt(String(id).slice(0, 8), 36); return t > 1e12 ? t : 0; }

  function cleanItem(x) {
    if (!x || typeof x !== "object") return null;
    if (typeof x.id !== "string" || !x.id || x.id.length > 64) return null;
    var lvl = parseInt(x.level, 10);
    return {
      id: x.id,
      title: typeof x.title === "string" ? x.title.slice(0, 500) : "",
      level: lvl >= 0 && lvl <= MAX ? lvl : 0,
      locked: x.locked === true,
      created: num(x.created) || idTime(x.id),
      updatedAt: num(x.updatedAt)
    };
  }

  function cleanState(s) {
    var out = { items: [], deleted: [] };
    if (!s || typeof s !== "object") return out;
    if (Array.isArray(s.items)) s.items.slice(0, 500).forEach(function (x) {
      var c = cleanItem(x); if (c) out.items.push(c);
    });
    if (Array.isArray(s.deleted)) s.deleted.slice(0, 2000).forEach(function (d) {
      if (d && typeof d.id === "string" && d.id && d.id.length <= 64) out.deleted.push({ id: d.id, deletedAt: num(d.deletedAt) });
    });
    return out;
  }

  // Для каждой шкалы побеждает более поздняя метка (правка или удаление).
  // При равенстве: удаление сильнее правки, а между двумя правками побеждает b.
  function mergeStates(a, b) {
    var best = Object.create(null);
    function take(id, t, del, obj) {
      var c = best[id];
      if (!c || t > c.t || (t === c.t && (del || !c.del))) best[id] = { t: t, del: del, obj: obj };
    }
    [a, b].forEach(function (s) {
      s.items.forEach(function (x) { take(x.id, x.updatedAt, false, x); });
      s.deleted.forEach(function (d) { take(d.id, d.deletedAt, true, d); });
    });
    var limit = Date.now() - KEEP_DELETED, items = [], deleted = [];
    Object.keys(best).forEach(function (id) {
      var c = best[id];
      if (c.del) { if (c.obj.deletedAt >= limit) deleted.push(c.obj); }
      else items.push(c.obj);
    });
    items.sort(function (x, y) { return (x.created - y.created) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0); });
    deleted.sort(function (x, y) { return x.id < y.id ? -1 : x.id > y.id ? 1 : 0; });
    return { items: items, deleted: deleted };
  }

  var EMPTY = { items: [], deleted: [] };
  function canonJSON(s) { return JSON.stringify(mergeStates(cleanState(s), EMPTY)); }


function sha(s) { return createHash("sha256").update(String(s)).digest(); }
function samePassword(given, secret) { return timingSafeEqual(sha(given), sha(secret)); }

function readGiven(req) {
  var raw = req.headers.get("x-sync-password") || "";
  try { raw = decodeURIComponent(raw); } catch (e) {}
  return raw.trim();
}

export default async (req) => {
  var headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  var reply = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: headers });

  // Пароль необязателен: если SYNC_PASSWORD не задан, доступ открыт всем, кто знает адрес сайта.
  var secret = (process.env.SYNC_PASSWORD || "").trim();
  if (secret && !samePassword(readGiven(req), secret)) return reply({ error: "unauthorized" }, 401);
  if (req.method !== "GET" && req.method !== "POST") return reply({ error: "method" }, 405);

  var store = getStore({ name: "hate-scales", consistency: "strong" });

  try {
    if (req.method === "GET") {
      var cur = await store.get(KEY, { type: "json" });
      return reply(mergeStates(cleanState(cur), EMPTY));
    }

    var text = await req.text();
    if (text.length > MAX_BODY) return reply({ error: "too-large" }, 413);
    var body;
    try { body = JSON.parse(text); } catch (e) { return reply({ error: "bad-json" }, 400); }
    var incoming = cleanState(body);

    // Читаем → сливаем → пишем только если что-то изменилось.
    // Если за это время кто-то успел записать раньше, повторяем (до 5 раз).
    for (var attempt = 0; attempt < 5; attempt++) {
      var entry = await store.getWithMetadata(KEY, { type: "json" });
      var stored = cleanState(entry && entry.data);
      var merged = mergeStates(incoming, stored);          // при равенстве побеждает то, что уже на сервере
      if (JSON.stringify(merged) === canonJSON(stored)) return reply(merged);
      var res = await store.setJSON(KEY, merged, entry ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
      if (res && res.modified) return reply(merged);
    }
    return reply({ error: "busy" }, 503);
  } catch (e) {
    console.error("sync failed:", e && e.message);
    return reply({ error: "server" }, 500);
  }
};
