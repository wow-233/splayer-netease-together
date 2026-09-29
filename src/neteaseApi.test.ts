import assert from "node:assert/strict";
import test from "node:test";
import { createNeteaseApi } from "./neteaseApi";
import type { SplayerContext } from "./types";

const apiWithResult = (data: unknown) =>
  createNeteaseApi({
    callNetease: async (name: string) => ({
      status: 200,
      body:
        name === "listentogether_security_token"
          ? { code: 200, token: "test" }
          : { code: 200, data },
    }),
  } as unknown as SplayerContext);

test("官方成功码 0 携带提示文案时推歌、置顶仍成功", async () => {
  for (const operate of [1, 2] as const) {
    const data = {
      failedCode: 0,
      failedMsg: operate === 1 ? "推荐成功，加入播放列表" : "置顶成功",
      operateSongBizId: "new",
    };
    assert.deepEqual(
      await apiWithResult(data).operateSong("room", "1", "new", operate),
      data,
    );
  }
});

test("官方失败码不会因为提示中包含成功二字就被当作成功", async () => {
  await assert.rejects(
    apiWithResult({
      failedCode: 10007,
      failedMsg: "已经置顶成功，请勿重复",
    }).operateSong("room", "1", "new", 2),
    /请勿重复/,
  );
});
