import assert from "node:assert/strict";
import test from "node:test";
import { TogetherSyncEngine } from "./sync";
import type { SplayerContext, TogetherTrack } from "./types";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const response = (data: unknown) => ({
  status: 200,
  body: { code: 200, data },
});

const harness = (
  override?: (name: string, params: Record<string, unknown>) => unknown,
) => {
  let now = 1_000;
  let serial = 0;
  const timers = new Map<number, { cb: () => void; ms: number }>();
  const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const played: TogetherTrack[] = [];
  const seeks: number[] = [];
  let plays = 0;
  const info = {
    playSong: { songId: "1", songBizId: "a" },
    nextSongs: [
      { songId: "2", songBizId: "b" },
      { songId: "2", songBizId: "c" },
    ],
    version: 1,
    playedTime: 12_000,
  };
  const ctx = {
    callNetease: async (name: string, params: Record<string, unknown> = {}) => {
      calls.push({ name, params });
      const result = override?.(name, params);
      if (result !== undefined) return result;
      if (name === "user_account")
        return { status: 200, body: { profile: { userId: 9 } } };
      if (name === "listentogether_security_token")
        return { status: 200, body: { code: 200, token: "test" } };
      if (name === "listentogether_multi_match_status_get") return response({});
      if (name === "listentogether_multi_room_create")
        return response({
          success: true,
          multiLtRoomSnapshot: { roomId: "room", roomPlaySongInfo: info },
        });
      if (name === "listentogether_multi_heartbeat")
        return response({ roomPlaySongInfo: info, heartBeatDuration: 20 });
      if (name === "song_detail")
        return {
          status: 200,
          body: {
            code: 200,
            songs: String(params.ids)
              .split(",")
              .map((id) => ({ id, name: `歌曲 ${id}`, ar: [], dt: 100_000 })),
          },
        };
      return response({});
    },
    player: {
      getPosition: async () => 0,
      playTrack: (track: TogetherTrack) => played.push(track),
      play: () => {
        plays += 1;
      },
      pause: () => {},
      seek: (pos: number) => seeks.push(pos),
    },
    log: { info() {}, warn() {}, error() {} },
  } as unknown as SplayerContext;
  const engine = new TogetherSyncEngine({
    ctx,
    timers: {
      setTimeout: (cb, ms) => {
        timers.set(++serial, { cb, ms });
        return serial;
      },
      clearTimeout: (id) => {
        timers.delete(id as number);
      },
      now: () => now,
    },
  });
  return {
    engine,
    calls,
    played,
    seeks,
    info,
    timers,
    get plays() {
      return plays;
    },
    advance: (ms: number) => {
      now += ms;
    },
    create: () =>
      engine.create({
        id: "1",
        source: "netease",
        title: "歌曲 1",
        artists: [],
        duration: 100_000,
      }),
    tick: async () => {
      const entry = [...timers.entries()][0];
      assert.ok(entry, "应继续安排同步");
      timers.delete(entry[0]);
      now += entry[1].ms;
      entry[1].cb();
      await flush();
    },
  };
};

test("歌曲详情加载失败后仍跟随房间重试，恢复时使用最新进度", async () => {
  let failures = 1;
  const h = harness((name) => {
    if (name === "song_detail" && failures-- > 0)
      return Promise.reject(new Error("offline"));
  });
  await h.create();
  h.info.playSong = { songId: "3", songBizId: "d" };
  await h.tick();
  assert.match(h.engine.snapshot.syncError, /加载失败/);
  h.info.playedTime = 14_000;
  await h.tick();
  assert.equal(h.played.at(-1)?.id, "3");
  assert.equal(h.engine.consumePendingPlayback("3")?.position, 14_000);
  assert.equal(h.engine.snapshot.syncError, "");
});

test("退出后重新加入同一房间，旧推歌响应不能写入新会话", async () => {
  const request = deferred<unknown>();
  const h = harness((name) =>
    name === "listentogether_multi_song_operate" ? request.promise : undefined,
  );
  await h.create();
  const pushing = h.engine.pushSong("8");
  const rejected = assert.rejects(pushing, /房间已切换/);
  await flush();
  await h.engine.leave();
  await h.create();
  request.resolve(response({ operateSongId: "8", operateSongBizId: "old" }));
  await rejected;
  assert.equal(
    h.engine.snapshot.queue.some((song) => song.songId === "8"),
    false,
  );
});

test("置顶按队列实例处理，同一人连续点击只提交一次", async () => {
  const h = harness();
  await h.create();
  await Promise.all([h.engine.pinSong("2", "c"), h.engine.pinSong("2", "c")]);
  await h.engine.pinSong("2", "c");
  const calls = h.calls.filter(
    (call) => call.name === "listentogether_multi_song_operate",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.params.bizId, "c");
  assert.equal(h.engine.snapshot.queue[2]?.pinned, true);
  assert.equal(h.engine.snapshot.queue[1]?.pinned, false);
});

test("历史消息长时间未返回仍安排下一次播放同步", async () => {
  const h = harness((name) =>
    name === "listentogether_multi_match_msg_history"
      ? new Promise(() => {})
      : undefined,
  );
  await h.create();
  await h.tick();
  assert.ok(h.timers.size > 0);
  const snapshot = await h.engine.detailedSnapshot();
  assert.equal(snapshot.inRoom, true);
});

test("本机恢复播放先校准官方进度，房间不会从旧进度继续", async () => {
  const h = harness();
  await h.create();
  h.engine.onLocalEvent("playStateChange", {
    state: "paused",
    position: 1_000,
  });
  h.info.playedTime = 55_000;
  await h.engine.resumePlayback();
  assert.equal(h.seeks.at(-1), 55_000);
  assert.equal(h.plays, 2);
});

test("旧房间歌曲详情返回后不会开始播放", async () => {
  const request = deferred<unknown>();
  const h = harness((name) =>
    name === "song_detail" ? request.promise : undefined,
  );
  await h.create();
  h.info.playSong = { songId: "3", songBizId: "d" };
  await h.tick();
  await h.engine.leave();
  request.resolve({
    status: 200,
    body: { code: 200, songs: [{ id: "3", name: "旧歌曲" }] },
  });
  await flush();
  assert.equal(h.played.length, 0);
  assert.equal(h.timers.size, 0);
});

test("同一首歌连续推荐时，下一条队列实例仍会重新加载播放", async () => {
  const h = harness();
  await h.create();
  h.engine.onTrackEnded();
  h.info.playSong = { songId: "1", songBizId: "second-copy" };
  h.info.playedTime = 0;
  await h.tick();
  assert.equal(h.played.at(-1)?.id, "1");
  assert.equal(
    h.calls.some((call) => call.name === "listentogether_multi_song_operate"),
    false,
  );
});

test("本机音源失败只恢复当前歌曲，不提交房间切歌操作", async () => {
  const h = harness();
  await h.create();
  h.engine.onPlaybackFailed();
  await h.tick();
  assert.equal(h.played.at(-1)?.id, "1");
  assert.equal(
    h.calls.some((call) => call.name === "listentogether_multi_song_operate"),
    false,
  );
});

test("两秒状态查询展示他人推歌及完整资料，不等待保活心跳", async () => {
  let remote = false;
  const h = harness((name) => {
    if (name === "listentogether_multi_match_status_get" && remote)
      return response({
        multiLtRoomSnapshot: {
          roomId: "room",
          roomPlaySongInfo: {
            ...h.info,
            version: 2,
            nextSongs: [{ songId: "3", songBizId: "remote" }],
          },
          multiLtRoomUserAgg: {
            onlineNums: 2,
            onlineUserInfos: [{ uid: 8, nickname: "好友" }],
          },
        },
      });
  });
  await h.create();
  await h.tick();
  const heartbeats = h.calls.filter(
    (c) => c.name === "listentogether_multi_heartbeat",
  ).length;
  remote = true;
  h.advance(2000);
  const snapshot = await h.engine.detailedSnapshot();
  assert.equal(snapshot.queue[1]?.songId, "3");
  assert.equal(snapshot.queue[1]?.track?.title, "歌曲 3");
  assert.equal(snapshot.memberCount, 2);
  assert.equal(
    h.calls.filter((c) => c.name === "listentogether_multi_heartbeat").length,
    heartbeats,
  );
  assert.ok(
    !h.calls.some((c) => c.name === "listentogether_multi_song_operate"),
  );
});

test("并发状态查询只请求一次，退出后迟到结果失效", async () => {
  const pending = deferred<unknown>();
  let wait = false;
  const h = harness((name) =>
    name === "listentogether_multi_match_status_get" && wait
      ? pending.promise
      : undefined,
  );
  await h.create();
  wait = true;
  const before = h.calls.filter(
    (c) => c.name === "listentogether_multi_match_status_get",
  ).length;
  const a = h.engine.detailedSnapshot();
  const b = h.engine.detailedSnapshot();
  assert.equal(
    h.calls.filter((c) => c.name === "listentogether_multi_match_status_get")
      .length,
    before + 1,
  );
  await h.engine.leave();
  pending.resolve(
    response({
      multiLtRoomSnapshot: { roomId: "room", roomPlaySongInfo: h.info },
    }),
  );
  await Promise.all([a, b]);
  assert.equal(h.engine.snapshot.inRoom, false);
  assert.deepEqual(h.engine.snapshot.queue, []);
});

test("快速查询限流后退避，不随每次界面刷新重复请求", async () => {
  let fail = false;
  const h = harness((name) =>
    name === "listentogether_multi_match_status_get" && fail
      ? { status: 429, body: { code: 429 } }
      : undefined,
  );
  await h.create();
  fail = true;
  await h.engine.detailedSnapshot();
  const count = h.calls.length;
  h.advance(2000);
  await h.engine.detailedSnapshot();
  assert.equal(h.calls.length, count);
  h.advance(2000);
  await h.engine.detailedSnapshot();
  assert.ok(h.calls.length > count);
});

test("较早发出的心跳不能覆盖快速查询得到的新队列", async () => {
  const old = deferred<unknown>();
  let wait = false;
  const h = harness((name) => {
    if (name === "listentogether_multi_heartbeat" && wait) return old.promise;
    if (name === "listentogether_multi_match_status_get" && wait)
      return response({
        multiLtRoomSnapshot: {
          roomId: "room",
          roomPlaySongInfo: {
            ...h.info,
            nextSongs: [{ songId: "4", songBizId: "new" }],
          },
        },
      });
  });
  await h.create();
  wait = true;
  await h.tick();
  await h.engine.detailedSnapshot();
  assert.equal(h.engine.snapshot.queue[1]?.songId, "4");
  old.resolve(response({ roomPlaySongInfo: h.info, heartBeatDuration: 20 }));
  await flush();
  assert.equal(h.engine.snapshot.queue[1]?.songId, "4");
});
