/**
 * sync.test.ts — 同步引擎纯决策函数单测
 *
 * 覆盖：版本递增、云端指令仲裁、期望位置外推（含半 RTT）、漂移阈值、
 * 自适应退避延迟、房间链接解析、展示列表归一化。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  bumpVersion,
  computeExpectedPosition,
  displaySongIds,
  needsSeek,
  nextPollDelay,
  parseRoomLink,
  shouldApplyCloud,
} from "./sync";

test("bumpVersion：递增发送方自己的版本号", () => {
  const next = bumpVersion([{ userId: "1", version: 3 }, { userId: "2", version: 5 }], "1");
  assert.deepEqual(next, [{ userId: "1", version: 4 }, { userId: "2", version: 5 }]);
});

test("bumpVersion：首次参与新增 version=1，且不修改入参", () => {
  const input = [{ userId: "2", version: 5 }];
  const next = bumpVersion(input, "9");
  assert.deepEqual(next, [{ userId: "2", version: 5 }, { userId: "9", version: 1 }]);
  assert.deepEqual(input, [{ userId: "2", version: 5 }], "入参不应被修改");
});

test("shouldApplyCloud：更大的 clientSeq 胜出", () => {
  assert.equal(
    shouldApplyCloud({ cloudSeq: 10, lastAppliedSeq: 9, now: 1000, overrideUntil: 0 }),
    true,
  );
});

test("shouldApplyCloud：本地乐观覆盖窗口内，未前进的云端指令被忽略", () => {
  assert.equal(
    shouldApplyCloud({ cloudSeq: 9, lastAppliedSeq: 9, now: 1000, overrideUntil: 2000 }),
    false,
  );
});

test("shouldApplyCloud：窗口外且 seq 未前进则不应用", () => {
  assert.equal(
    shouldApplyCloud({ cloudSeq: 9, lastAppliedSeq: 9, now: 3000, overrideUntil: 2000 }),
    false,
  );
});

test("computeExpectedPosition：播放中外推并叠加半 RTT", () => {
  const pos = computeExpectedPosition({
    command: { progress: 1000, playStatus: "PLAY" },
    appliedAt: 1000,
    now: 3000,
    halfRttMs: 200,
  });
  assert.equal(pos, 1000 + 2000 + 200);
});

test("computeExpectedPosition：暂停时不外推", () => {
  const pos = computeExpectedPosition({
    command: { progress: 1000, playStatus: "PAUSE" },
    appliedAt: 1000,
    now: 3000,
    halfRttMs: 200,
  });
  assert.equal(pos, 1000);
});

test("needsSeek：超过 2s 阈值才需要定位", () => {
  assert.equal(needsSeek(1000, 3000), false, "差值等于阈值不 seek");
  assert.equal(needsSeek(1000, 3001), true);
});

test("nextPollDelay：播放中基础 1.5s，暂停 5s，未在房间 10s", () => {
  assert.equal(nextPollDelay({ inRoom: true, paused: false, backoff: 1, jitter: 1 }), 1500);
  assert.equal(nextPollDelay({ inRoom: true, paused: true, backoff: 1, jitter: 1 }), 5000);
  assert.equal(nextPollDelay({ inRoom: false, paused: false, backoff: 1, jitter: 1 }), 10000);
});

test("nextPollDelay：退避放大且封顶 30s", () => {
  assert.equal(nextPollDelay({ inRoom: true, paused: false, backoff: 4, jitter: 1 }), 6000);
  assert.equal(nextPollDelay({ inRoom: true, paused: false, backoff: 100, jitter: 1 }), 30000);
});

test("parseRoomLink：从分享链接解析 roomId / inviterId / songId", () => {
  const parsed = parseRoomLink(
    "https://st.music.163.com/listen-together/share/?songId=123&roomId=456&inviterId=789",
  );
  assert.deepEqual(parsed, { roomId: "456", inviterId: "789", songId: "123" });
});

test("parseRoomLink：非法/空输入返回空对象", () => {
  assert.deepEqual(parseRoomLink(""), {});
  assert.deepEqual(parseRoomLink("not-a-link"), {});
});

test("parseRoomLink：兼容 multishare 链接的 inviterUid", () => {
  const parsed = parseRoomLink(
    "https://st.music.163.com/listen-together/multishare/index.html?roomId=261457dc16edd2d823ce56e6965d7f70_1789174659929&inviterUid=17932835450",
  );
  assert.deepEqual(parsed, {
    roomId: "261457dc16edd2d823ce56e6965d7f70_1789174659929",
    inviterId: "17932835450",
  });
});

test("displaySongIds：兼容对象与原始值两种展示项", () => {
  const ids = displaySongIds({
    playlist: { displayList: { result: [{ songId: 1 }, 2, { songId: "3" }] } },
  });
  assert.deepEqual(ids, ["1", "2", "3"]);
});
