import assert from "node:assert/strict";
import * as f from "../src/format.ts";

// parseLink
assert.deepEqual(f.parseLink("https://drive.google.com/drive/folders/1AbCdEfGhIjK?usp=sharing"), { provider: "gdrive", id: "1AbCdEfGhIjK", host: null });
assert.deepEqual(f.parseLink("https://my.pcloud.com/publink/show?code=XZabc123"), { provider: "pcloud", id: "XZabc123", host: "api.pcloud.com" });
assert.equal(f.parseLink("https://e.pcloud.link/publink/show?code=EUc0de").host, "eapi.pcloud.com");
assert.equal(f.parseLink("https://pcloud.com/nocode"), null);
assert.equal(f.parseLink("hi"), null);
assert.equal(f.parseLink(""), null);

// cleanFolderName
for (const d of ["..", ".", "", "   "]) assert.equal(f.cleanFolderName(d, "Src"), "Src");
assert.equal(f.cleanFolderName("a\u007fb", "x"), "ab");
assert.equal(f.cleanFolderName("a/b\\c:d", "x"), "a-b-c-d");
assert.equal(f.cleanFolderName("a\u0000b\u001fc\u0007", "x"), "abc");
assert.equal(f.cleanFolderName("\u0000", "x"), "x");
assert.equal(f.cleanFolderName("..", ".."), "Folder");
assert.equal(f.cleanFolderName("..", "a/b"), "a-b");
for (const d of ["/", "../..", "/etc/passwd", "a\\..\\b"]) assert.ok(!f.cleanFolderName(d, "/").includes("/"));

// tildify
assert.equal(f.tildify("/home/kurito/Trawl/x"), "~/Trawl/x");
assert.equal(f.tildify("/Users/a/Trawl"), "~/Trawl");
assert.equal(f.tildify("/mnt/nas/x"), "/mnt/nas/x");

// fmtInterval / fmtTimeLeft
assert.equal(f.fmtInterval(30), "30 min");
assert.equal(f.fmtInterval(60), "1 hr");
assert.equal(f.fmtInterval(120), "2 hr");
assert.equal(f.fmtTimeLeft(0), "");
assert.equal(f.fmtTimeLeft(NaN), "");
assert.equal(f.fmtTimeLeft(59), "less than a minute left");
assert.equal(f.fmtTimeLeft(300), "about 5 minutes left");
assert.equal(f.fmtTimeLeft(7200), "about 2 hours left");

// folderStatus precedence + lines
const ago = new Date(Date.now() - 3600e3).toISOString();
const m = (last_status, auto_sync = true, last_at = ago) => ({ last_status, last_at, auto_sync });
assert.deepEqual(f.folderStatus(m("failed", false), true, 41.6), { tone: "busy", line: "Copying · 42%" });
assert.deepEqual(f.folderStatus(m("failed", false), false, 0), { tone: "problem", line: "Needs attention" });
assert.deepEqual(f.folderStatus(m("cancelled", false), false, 0), { tone: "waiting", line: "Stopped" });
assert.deepEqual(f.folderStatus(m("succeeded", false), false, 0), { tone: "paused", line: "Paused · copied 1h ago" });
assert.deepEqual(f.folderStatus(m("idle", false, null), false, 0), { tone: "paused", line: "Paused · not copied yet" });
assert.deepEqual(f.folderStatus(m("idle", true, null), false, 0), { tone: "waiting", line: "Not copied yet" });
assert.deepEqual(f.folderStatus(m("succeeded"), false, 0), { tone: "ok", line: "Up to date · 1h ago" });

// problemOf
const loop = "Folder loop in source (“X”) — fix or exclude it, then re-sync.";
assert.equal(f.problemOf(loop, false).kind, "skipShortcuts");
assert.equal(f.problemOf(loop, true).kind, "retry");
assert.equal(f.problemOf(loop, false).title, "This folder loops back on itself");
assert.deepEqual(f.problemOf("Quota exceeded.", false), { title: "Couldn't finish copying", body: "Quota exceeded.", kind: "retry" });
assert.equal(f.problemOf(null, false).kind, "retry");

// headline
const r = (tone, name = "N") => ({ tone, name });
assert.equal(f.headline([]), "Everything's up to date.");
assert.equal(f.headline([r("ok"), r("paused")]), "Everything's up to date.");
assert.equal(f.headline([r("problem"), r("busy")]), "1 folder needs you.");
assert.equal(f.headline([r("problem"), r("problem")]), "2 folders need you.");
assert.equal(f.headline([r("busy", "Pip"), r("waiting")]), "Copying Pip");
assert.equal(f.headline([r("busy"), r("busy")]), "Copying 2 folders");
assert.equal(f.headline([r("waiting")]), "1 folder waiting.");
assert.equal(f.headline([r("waiting"), r("waiting"), r("ok")]), "2 folders waiting.");

console.log("check-format: ok");
