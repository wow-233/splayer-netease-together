import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(
  resolve(here, "..", "dist", "netease-listen-together.js"),
  "utf8",
);
for (const forbidden of ["require(", "module.exports", "exports."]) {
  assert.ok(!code.includes(forbidden), `打包产物不应包含 ${forbidden}`);
}

const header = code.match(/^\s*\/\*[\s\S]*?\*\//)?.[0] ?? "";
for (const field of [
  "@name",
  "@id",
  "@version",
  "@type",
  "@apiLevel",
  "@grant",
]) {
  assert.ok(header.includes(field), `产物头部应包含 ${field}`);
}
const { version } = JSON.parse(readFileSync(resolve(here, "..", "package.json"), "utf8"));
assert.ok(header.includes(`@version     ${version}`));
assert.ok(header.includes("netease"));

const registered = [];
const handlers = new Map();
const settings = { roomLink: "", autoJoin: false, pinAfterPush: false };
const neteaseCalls = [];
const playerCalls = [];

const splayer = {
  pluginId: "splayer.netease-together",
  locale: "zh-CN",
  appVersion: "1.2.0",
  register: (args) => registered.push(args),
  on: (action, handler) => handlers.set(action, handler),
  getSetting: (key) => settings[key],
  onSettingChange() {},
  log: { debug() {}, info() {}, warn() {}, error() {} },
  player: {
    play: () => playerCalls.push(["play"]),
    pause: () => playerCalls.push(["pause"]),
    next() {},
    prev() {},
    seek: (ms) => playerCalls.push(["seek", ms]),
    setVolume() {},
    getPosition: async () => 1000,
    playTrack: (track) => playerCalls.push(["playTrack", track]),
    on() {},
  },
  netease: {
    call: async (name, params) => {
      neteaseCalls.push({ name, params });
      if (name === "user_account") {
        return { status: 200, body: { code: 200, profile: { userId: 88 } } };
      }
      if (name === "listentogether_security_token") {
        return { status: 200, body: { code: 200, token: "test-token" } };
      }
      if (name === "listentogether_multi_match_msg_history") {
        return { status: 200, body: { code: 200, data: { records: [] } } };
      }
      if (name === "listentogether_multi_match_ack") {
        return {
          status: 200,
          body: {
            code: 200,
            data: {
              success: true,
              multiLtRoomSnapshot: {
                roomId: "room_1",
                multiRoomInfoDTO: { roomId: "room_1" },
                multiLtRoomUserAgg: { onlineNums: 3 },
                roomPlaySongInfo: {
                  playSong: { songId: 123, songBizId: 9001 },
                  nextSongs: [],
                  playedTime: 5000,
                  songDuration: 200000,
                  version: 1,
                },
              },
            },
          },
        };
      }
      if (name === "listentogether_multi_heartbeat") {
        return {
          status: 200,
          body: {
            code: 200,
            data: {
              heartBeatDuration: 20,
              roomPlaySongInfo: {
                playSong: { songId: 123, songBizId: 9001 },
                nextSongs: [],
                playedTime: 5000,
                songDuration: 200000,
                version: 1,
              },
            },
          },
        };
      }
      if (name === "listentogether_multi_song_operate") {
        return {
          status: 200,
          body: {
            code: 200,
            data: {
              operateSongId: params.songId,
              operateSongBizId: 9002,
              roomSongInfo: {
                playSong: { songId: 123, songBizId: 9001 },
                nextSongs: [{ songId: params.songId, songBizId: 9002 }],
                playedTime: 5000,
                songDuration: 200000,
                version: 2,
              },
            },
          },
        };
      }
      if (name === "song_detail") {
        return {
          status: 200,
          body: {
            code: 200,
            songs: [
              {
                id: 123,
                name: "测试歌曲",
                ar: [{ name: "歌手" }],
                al: { name: "专辑", picUrl: "https://example.test/cover.jpg" },
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

vm.runInNewContext(code, {
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
});

const registration = registered[0];
assert.ok(registration);
assert.equal(registration.controls, true);
assert.equal(registration.menus.length, 3);
assert.equal(registration.settings.length, 3);
const menuClick = handlers.get("menuClick");
assert.equal(typeof menuClick, "function");

const emptyJoin = await menuClick({ menuId: "together-join", track: null });
assert.equal(emptyJoin.error, "请先在插件设置里填写多人一起听链接");

const twoPersonJoin = await menuClick({
  menuId: "together-join",
  data: {
    roomLink:
      "https://st.music.163.com/listen-together/share/index.html?roomId=room_1&inviterId=88",
  },
});
assert.match(twoPersonJoin.error, /不是多人一起听链接/);

const roomLink =
  "https://st.music.163.com/listen-together/multishare/index.html?roomId=room_1&inviterUid=77";
const joined = await menuClick({
  menuId: "together-join",
  data: { roomLink },
});
assert.equal(joined.toast, "已加入多人一起听");
assert.equal(joined.data.mode, "multi");
assert.equal(joined.data.memberCount, 3);
assert.ok(
  neteaseCalls.some((call) => call.name === "listentogether_multi_match_ack"),
);
assert.ok(
  neteaseCalls.some((call) => call.name === "listentogether_multi_heartbeat"),
);
assert.ok(playerCalls.some((call) => call[0] === "playTrack"));

const playTrackCountBeforePush = playerCalls.filter(
  (call) => call[0] === "playTrack",
).length;
await menuClick({
  menuId: "together-push",
  track: {
    id: "456",
    source: "netease",
    title: "推送歌曲",
    artists: [{ name: "歌手" }],
  },
});
const songOperation = neteaseCalls.find(
  (call) => call.name === "listentogether_multi_song_operate",
);
assert.ok(songOperation);
assert.equal(songOperation.params.operate, 1);
assert.equal(songOperation.params.songId, "456");
assert.equal(
  playerCalls.filter((call) => call[0] === "playTrack").length,
  playTrackCountBeforePush,
  "只推歌不应重新加载当前歌曲",
);

await menuClick({ menuId: "together-leave" });
assert.ok(
  neteaseCalls.some((call) => call.name === "listentogether_multi_match_exit"),
);

console.log("SMOKE OK — official multi-room flow");
