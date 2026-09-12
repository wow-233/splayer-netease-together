/**
 * smoke.mjs — 用 node:vm 模拟宿主沙箱，加载真实构建产物并驱动菜单点击。
 *
 * 这是插件产物的「真实表面」验证：证明打包后的 .js 能在无 DOM、只有 splayer 全局的
 * 沙箱里正常注册能力并响应交互，而不是只验证源码类型。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = resolve(here, "..", "dist", "netease-listen-together.js");
const code = readFileSync(bundlePath, "utf-8");

/** 断言打包产物不依赖 CJS/Node 模块（沙箱里没有 require/module/exports） */
for (const forbidden of ["require(", "module.exports", "exports."]) {
  assert.ok(!code.includes(forbidden), `打包产物不应包含 ${forbidden}`);
}

// 宿主从第一个块注释解析 manifest，产物必须保留它
const header = code.match(/^\s*\/\*[\s\S]*?\*\//)?.[0] ?? "";
for (const field of ["@name", "@id", "@version", "@type", "@apiLevel", "@grant"]) {
  assert.ok(header.includes(field), `产物头部应包含 ${field}`);
}
assert.ok(header.includes("@type") && header.includes("control"), "头部应声明 control 类型");
assert.ok(header.includes("netease"), "头部应声明 netease 权限");
assert.ok(header.includes("@apiLevel") && header.includes("4"), "头部应声明 apiLevel 4");

const registered = [];
const handlers = new Map();
const settings = { roomLink: "", autoJoin: false, pinAfterPush: false };
const neteaseCalls = [];
const playerCalls = [];

const splayer = {
  pluginId: "splayer.netease-together",
  locale: "zh-CN",
  appVersion: "1.1.0",
  register: (args) => registered.push(args),
  on: (action, handler) => handlers.set(action, handler),
  getSetting: (key) => settings[key],
  onSettingChange: () => {},
  log: { debug() {}, info() {}, warn() {}, error() {} },
  player: {
    play: () => playerCalls.push(["play"]),
    pause: () => playerCalls.push(["pause"]),
    next() {},
    prev() {},
    seek: (ms) => playerCalls.push(["seek", ms]),
    setVolume() {},
    getPosition: async () => 0,
    playTrack: (track) => playerCalls.push(["playTrack", track]),
    on() {},
  },
  netease: {
    call: async (name, params) => {
      neteaseCalls.push({ name, params });
      if (name === "listentogether_sync_playlist_get") {
        return {
          status: 200,
          body: {
            code: 200,
            data: {
              playCommand: { targetSongId: "123", clientSeq: 1, playStatus: "PLAY", progress: 0 },
              playlist: {
                version: [{ userId: "1", version: 1 }],
                displayList: { result: [{ songId: "123" }] },
              },
            },
          },
        };
      }
      if (name === "user_account") {
        return { status: 200, body: { code: 200, profile: { userId: "1" } } };
      }
      if (name === "song_detail") {
        return {
          status: 200,
          body: {
            code: 200,
            songs: [
              {
                id: 123,
                name: "歌",
                ar: [{ name: "a" }],
                al: { name: "专辑", picUrl: "https://x/y.jpg" },
                dt: 200000,
              },
            ],
          },
        };
      }
      return { status: 200, body: { code: 200, data: {} } };
    },
  },
};

const sandbox = {
  splayer,
  console,
  JSON,
  Math,
  Date,
  Promise,
  Buffer,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  queueMicrotask,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "netease-listen-together.js", timeout: 5000 });

// 1) 能力声明正确
const reg = registered[0];
assert.ok(reg, "应调用 register");
assert.deepEqual(
  [...reg.events].sort(),
  ["lineChange", "playStateChange", "trackChange"].sort(),
  "应订阅播放事件",
);
assert.equal(reg.controls, true, "应声明反向控制");
assert.equal(reg.menus.length, 6, "应有 6 个菜单项");
assert.equal(reg.settings.length, 3, "应有 3 个设置项");
assert.ok(
  reg.menus.some((m) => m.id === "together-push"),
  "应包含推歌菜单",
);

// 2) menuClick 已注册
const menuClick = handlers.get("menuClick");
assert.equal(typeof menuClick, "function", "应注册 menuClick 处理器");

// 3) 未配置房间链接时点击「加入」→ 返回提示而非抛错
const joinRes = await menuClick({ menuId: "together-join", track: null });
assert.equal(joinRes.toast, "请先在插件设置里填写一起听房间链接");

// 4) 配置房间链接后点击「加入」→ 触发 netease accept 调用
settings.roomLink =
  "https://st.music.163.com/listen-together/share/?songId=1&roomId=999&inviterId=888";
// 用假响应让 accept 成功；加入流程内部会继续调用 user_account / sync_playlist_get
const joinRes2 = await menuClick({ menuId: "together-join", track: null });
const acceptCall = neteaseCalls.find((c) => c.name === "listentogether_accept");
assert.ok(acceptCall, "应调用 listentogether_accept");
assert.equal(acceptCall.params.refer, "third_party_invite");
assert.equal(acceptCall.params.roomId, "999");
assert.equal(acceptCall.params.inviterId, "888");
assert.equal(joinRes2.toast, "已加入一起听");

// 4b) 加入后应拉取房间状态，并把房间当前歌曲交给宿主播放
await new Promise((r) => setTimeout(r, 30));
assert.ok(
  neteaseCalls.some((c) => c.name === "listentogether_sync_playlist_get"),
  "加入后应拉取房间状态",
);
const playTrackCall = playerCalls.find((c) => c[0] === "playTrack");
assert.ok(playTrackCall, "应把房间当前歌曲交给宿主 playTrack");
assert.equal(playTrackCall[1].id, "123");
assert.equal(playTrackCall[1].source, "netease");

// 5) 推歌：非网易云曲目应被拒绝
const pushRes = await menuClick({
  menuId: "together-push",
  track: { id: "1", source: "local", title: "x" },
});
assert.equal(pushRes.toast, "仅支持推网易云在线歌曲");

// 6) 推歌：网易云曲目 → 调用 sync_list_command
await menuClick({
  menuId: "together-push",
  track: { id: "456", source: "netease", title: "歌", artists: [{ name: "a" }] },
});
assert.ok(
  neteaseCalls.some((c) => c.name === "listentogether_sync_list_command"),
  "推歌应调用 sync_list_command",
);

// 7) 已在房间列表中的歌曲推歌应为幂等空操作
const before = neteaseCalls.filter((c) => c.name === "listentogether_sync_list_command").length;
await menuClick({
  menuId: "together-push",
  track: { id: "123", source: "netease", title: "已在列表", artists: [{ name: "a" }] },
});
const after = neteaseCalls.filter((c) => c.name === "listentogether_sync_list_command").length;
assert.equal(after, before, "重复推歌不应再次上报");

console.log("SMOKE OK");
console.log("  netease calls:", neteaseCalls.map((c) => c.name).join(", "));
console.log("  player calls:", JSON.stringify(playerCalls));

// 同步引擎会常驻轮询/心跳定时器，验证完成后主动退出
process.exit(0);
