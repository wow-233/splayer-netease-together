import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildMultiShareLink,
  expectedMultiPosition,
  needsSeek,
  nextHeartbeatDelay,
  parseRoomLink,
  roomSongIds,
  TogetherSyncEngine,
} from "./sync";
import type { SplayerContext, TogetherTrack } from "./types";

test("解析官方多人邀请链接", () => {
  assert.deepEqual(
    parseRoomLink(
      "https://st.music.163.com/listen-together/multishare/index.html?roomId=room_1&inviterUid=88&songId=123",
    ),
    { roomId: "room_1", inviterId: "88", songId: "123", isMultiRoom: true },
  );
});

test("解析手机分享的完整文案和转义链接", () => {
  const text =
    "大家围坐听歌，就等你啦！快点开看看 [https://st.music.163.com/listen-together/multishare/index.html?roomId=abc\\_123&inviterUid=88](https://st.music.163.com/listen-together/multishare/index.html?roomId=abc_123\\&inviterUid=88) (@网易云音乐)";
  assert.deepEqual(parseRoomLink(text), {
    roomId: "abc_123",
    inviterId: "88",
    isMultiRoom: true,
  });
});

test("创建时优先恢复账号已有的官方房间", async () => {
  const calls: string[] = [];
  const roomSong = {
    playSong: { songId: "123", songBizId: "9001" },
    nextSongs: [],
    playedTime: 1000,
    version: 1,
  };
  const ctx = {
    callNetease: async (name: string) => {
      calls.push(name);
      if (name === "user_account")
        return { status: 200, body: { profile: { userId: 88 } } };
      if (name === "listentogether_multi_match_status_get")
        return {
          status: 200,
          body: {
            code: 200,
            data: {
              multiLtRoomSnapshot: {
                roomId: "existing",
                roomPlaySongInfo: roomSong,
              },
            },
          },
        };
      if (name === "listentogether_multi_heartbeat")
        return {
          status: 200,
          body: {
            code: 200,
            data: { roomPlaySongInfo: roomSong, heartBeatDuration: 20 },
          },
        };
      if (name === "song_detail")
        return {
          status: 200,
          body: {
            code: 200,
            songs: [
              {
                id: 123,
                name: "原房间歌曲",
                ar: [{ name: "歌手" }],
                dt: 180000,
              },
            ],
          },
        };
      if (name === "listentogether_multi_match_msg_history")
        return { status: 200, body: { code: 200, data: { records: [] } } };
      throw new Error(`unexpected API: ${name}`);
    },
    player: {
      getPosition: async () => 1000,
      playTrack: () => {},
      seek: () => {},
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as SplayerContext;
  const engine = new TogetherSyncEngine({
    ctx,
    timers: { setTimeout: () => 1, clearTimeout: () => {}, now: () => 1000 },
  });
  const result = await engine.create();
  assert.deepEqual(result, {
    roomId: "existing",
    creatorId: "88",
    resumed: true,
  });
  assert.equal(engine.snapshot.currentSongId, "123");
  assert.ok(!calls.includes("listentogether_multi_room_create"));
  assert.ok(!calls.includes("listentogether_security_token"));
});

test("手机房间加入携带校验 token 并刷新实时成员", async () => {
  const joined: Record<string, unknown>[] = [];
  const roomSong = {
    playSong: { songId: "1", songBizId: "a" },
    playedTime: 5_000,
    nextSongs: [{ songId: "2", songBizId: "b" }],
    version: 1,
  };
  const ctx = {
    callNetease: async (name: string, params: Record<string, unknown> = {}) => {
      if (name === "user_account")
        return { status: 200, body: { profile: { userId: 9 } } };
      if (name === "listentogether_security_token")
        return { status: 200, body: { code: 200, token: "test-token" } };
      if (name === "listentogether_multi_match_ack") {
        joined.push(params);
        return {
          status: 200,
          body: {
            code: 200,
            data: {
              success: true,
              multiLtRoomSnapshot: {
                roomId: "abc_123",
                roomPlaySongInfo: roomSong,
              },
            },
          },
        };
      }
      if (name === "listentogether_multi_heartbeat")
        return {
          status: 200,
          body: {
            code: 200,
            data: { roomPlaySongInfo: roomSong, heartBeatDuration: 20 },
          },
        };
      if (name === "listentogether_multi_match_status_get")
        return {
          status: 200,
          body: {
            code: 200,
            data: {
              multiLtRoomSnapshot: {
                roomId: "abc_123",
                multiLtRoomUserAgg: {
                  onlineNums: 2,
                  onlineUserInfos: [
                    { uid: 9, nickname: "我", avatar: "me.png" },
                    { uid: 88, nickname: "好友", avatar: "friend.png" },
                  ],
                },
              },
            },
          },
        };
      if (name === "listentogether_multi_match_msg_history")
        return {
          status: 200,
          body: {
            code: 200,
            data: {
              records: [
                { sendTime: 1, resourceInfo: { bizId: "b", upCnt: 3 } },
              ],
            },
          },
        };
      if (name === "song_detail")
        return {
          status: 200,
          body: {
            code: 200,
            songs: [
              { id: "1", name: "歌曲", ar: [{ name: "歌手" }], dt: 180000 },
            ],
          },
        };
      throw new Error(`unexpected API: ${name}`);
    },
    player: {
      getPosition: async () => 5_000,
      playTrack: () => {},
      seek: () => {},
      play: () => {},
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as SplayerContext;
  const engine = new TogetherSyncEngine({
    ctx,
    timers: { setTimeout: () => 1, clearTimeout: () => {}, now: () => 1000 },
  });
  await engine.join(
    "大家围坐听歌 [https://st.music.163.com/listen-together/multishare/index.html?roomId=abc_123&inviterUid=88]",
  );
  assert.equal(joined[0]?.securityToken, "test-token");
  assert.equal(engine.snapshot.memberCount, 2);
  assert.equal(engine.snapshot.members[1]?.nickname, "好友");
  assert.equal(engine.snapshot.members[1]?.avatarUrl, "friend.png");
  assert.equal(engine.snapshot.queue[1]?.pinCount, 3);
  assert.equal(engine.snapshot.queue[0]?.pinCount, undefined);
});

test("双人耳机分享链接不会被识别为多人房间", () => {
  const parsed = parseRoomLink(
    "https://st.music.163.com/listen-together/share/index.html?roomId=room_1&inviterId=88",
  );
  assert.equal(parsed.isMultiRoom, false);
  assert.equal(parsed.roomId, "room_1");
});

test("非法或空链接返回非多人房间", () => {
  assert.deepEqual(parseRoomLink(""), { isMultiRoom: false });
  assert.deepEqual(parseRoomLink("not-a-link"), { isMultiRoom: false });
});

test("生成手机端可打开的官方多人邀请链接", () => {
  assert.equal(
    buildMultiShareLink("room_1", "88", "123"),
    "https://st.music.163.com/listen-together/multishare/index.html?roomId=room_1&inviterUid=88&songId=123",
  );
});

test("服务端心跳秒数换算为毫秒并限制范围", () => {
  assert.equal(nextHeartbeatDelay(5), 5_000);
  assert.equal(nextHeartbeatDelay(0), 20_000);
  assert.equal(nextHeartbeatDelay(1), 2_000);
  assert.equal(nextHeartbeatDelay(20, 2), 30_000);
});

test("播放进度补偿半个请求往返时间", () => {
  assert.equal(expectedMultiPosition(12_000, 250), 12_250);
  assert.equal(expectedMultiPosition(undefined, -10), 0);
});

test("进度差超过两秒才定位", () => {
  assert.equal(needsSeek(1_000, 3_000), false);
  assert.equal(needsSeek(1_000, 3_001), true);
});

test("提取当前歌曲和后续队列", () => {
  assert.deepEqual(
    roomSongIds({
      playSong: { songId: 1, songBizId: "a" },
      nextSongs: [{ songId: "2" }, { songId: 3 }],
    }),
    ["1", "2", "3"],
  );
});

test("推歌和切歌响应仍是旧队列时，播放器和房间视图使用目标歌曲", async () => {
  const played: TogetherTrack[] = [];
  const operations: unknown[] = [];
  const currentSong = { songId: "1", songBizId: "a" };
  const ctx = {
    callNetease: async (name: string, params?: Record<string, unknown>) => {
      if (name === "user_account")
        return { status: 200, body: { profile: { userId: 9 } } };
      if (name === "listentogether_security_token")
        return { status: 200, body: { code: 200, token: "test-token" } };
      if (name === "listentogether_multi_room_create") {
        return {
          status: 200,
          body: {
            code: 200,
            data: {
              success: true,
              multiLtRoomSnapshot: {
                roomId: "room",
                roomPlaySongInfo: {
                  playSong: currentSong,
                  nextSongs: [],
                  version: 1,
                },
              },
            },
          },
        };
      }
      if (name === "listentogether_multi_song_operate") {
        assert.equal(params?.songId, "2");
        operations.push(params?.operate);
        return {
          status: 200,
          body: {
            code: 200,
            data: {
              operateSongId: "2",
              operateSongBizId: "b",
              roomSongInfo: {
                playSong: currentSong,
                nextSongs: [],
                version: 1,
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
            songs: String(params?.ids)
              .split(",")
              .map((id) => ({
                id,
                name: `歌曲 ${id}`,
                ar: [{ name: "歌手" }],
                dt: 180000,
              })),
          },
        };
      }
      throw new Error(`unexpected API: ${name}`);
    },
    player: {
      getPosition: async () => 0,
      playTrack: (track: TogetherTrack) => played.push(track),
      play: () => {},
      seek: () => {},
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as SplayerContext;
  const engine = new TogetherSyncEngine({
    ctx,
    timers: { setTimeout: () => 1, clearTimeout: () => {}, now: () => 1000 },
  });
  await engine.create({
    id: "1",
    source: "netease",
    title: "歌曲 1",
    artists: [],
    duration: 180000,
  });
  engine.onTrackEnded();
  assert.deepEqual(operations, [], "自然播完不能发官方切歌请求");
  await engine.goto("2");
  assert.equal(engine.snapshot.currentSongId, "2");
  assert.deepEqual(operations, [1, 4]);
  assert.deepEqual(
    engine.snapshot.queue.map((song) => song.songId),
    ["2", "1"],
  );
  assert.equal(engine.snapshot.played[0]?.songId, "1");
  assert.equal(played[0]?.id, "2");
  const detail = await engine.detailedSnapshot();
  assert.equal(detail.queue[0]?.track?.title, "歌曲 2");
});

test("置顶操作无需等待历史消息接口即可回显次数", async () => {
  let resolveHistory: ((value: unknown) => void) | undefined;
  const ctx = {
    callNetease: async (name: string) => {
      if (name === "user_account")
        return { status: 200, body: { profile: { userId: 9 } } };
      if (name === "listentogether_multi_match_status_get")
        return { status: 200, body: { code: 200, data: {} } };
      if (name === "listentogether_security_token")
        return { status: 200, body: { code: 200, token: "test-token" } };
      if (name === "listentogether_multi_room_create")
        return {
          status: 200,
          body: {
            code: 200,
            data: {
              success: true,
              multiLtRoomSnapshot: {
                roomId: "room",
                roomPlaySongInfo: {
                  playSong: { songId: "1", songBizId: "biz-1" },
                  nextSongs: [],
                  version: 1,
                },
              },
            },
          },
        };
      if (name === "listentogether_multi_song_operate")
        return { status: 200, body: { code: 200, data: {} } };
      if (name === "listentogether_multi_match_msg_history")
        return new Promise((resolve) => {
          resolveHistory = resolve;
        });
      if (name === "song_detail")
        return {
          status: 200,
          body: {
            code: 200,
            songs: [{ id: "1", name: "歌曲", ar: [], dt: 100000 }],
          },
        };
      throw new Error(`unexpected API: ${name}`);
    },
    player: {
      getPosition: async () => 0,
      playTrack: () => {},
      play: () => {},
      seek: () => {},
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as SplayerContext;
  const engine = new TogetherSyncEngine({
    ctx,
    timers: { setTimeout: () => 1, clearTimeout: () => {}, now: () => 1000 },
  });
  await engine.create({
    id: "1",
    source: "netease",
    title: "歌曲",
    artists: [],
    duration: 100000,
  });
  await Promise.race([
    engine.pinSong("1"),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("置顶被历史消息阻塞")), 100),
    ),
  ]);
  assert.equal(engine.snapshot.queue[0]?.pinCount, 1);
  const detail = await Promise.race([
    engine.detailedSnapshot(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("房间状态被历史消息阻塞")), 100),
    ),
  ]);
  assert.equal(detail.queue[0]?.pinCount, 1);
  resolveHistory?.({
    status: 200,
    body: {
      code: 200,
      data: { records: [{ resourceInfo: { bizId: "biz-1", upCnt: 0 } }] },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    engine.snapshot.queue[0]?.pinCount,
    1,
    "延迟的旧记录不能覆盖刚完成的置顶",
  );
});
