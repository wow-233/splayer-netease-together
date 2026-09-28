/**
 * index.ts — 一起听插件入口
 *
 * 职责（与 neteaseApi.ts / sync.ts 的分工）：
 * - 适配宿主沙箱全局 `splayer` → `splayerContext`（唯一直接接触宿主的地方）
 * - 声明能力（events / controls / settings / menus）并订阅播放事件
 * - 处理歌曲菜单点击：加入 / 退出 / 推歌 / 置顶 / 立即播放
 * - 把宿主播放事件转发给 TogetherSyncEngine，并在曲目就绪后落地定位
 *
 * neteaseApi.ts 只负责「怎么调网易云接口」，sync.ts 只负责「何时调、调完怎么同步」，
 * 本文件只负责「把两者和宿主粘起来」。
 */

import { buildMultiShareLink, parseRoomLink, TogetherSyncEngine } from "./sync";
import type { PlaybackEventData, SplayerContext, TogetherTrack } from "./types";

/* ================= 宿主沙箱全局 ================= */

/** 沙箱内由宿主注入的全局对象（无 DOM / 无 window） */
interface SandboxSplayer {
  pluginId: string;
  locale: string;
  appVersion: string;
  register(args: unknown): void;
  on(action: string, handler: (req: unknown) => Promise<unknown>): void;
  getSetting<T = unknown>(key: string): T | undefined;
  onSettingChange(key: string, handler: (value: unknown) => void): void;
  log: SplayerContext["log"];
  player: {
    play(): void;
    pause(): void;
    next(): void;
    prev(): void;
    seek(positionMs: number): void;
    setVolume(volume: number): void;
    getPosition(): Promise<number>;
    playTrack(track: TogetherTrack): void;
    on(kind: string, handler: (data: unknown) => void): void;
  };
  netease: {
    call<T = unknown>(
      name: string,
      params?: Record<string, unknown>,
    ): Promise<{ status: number; body: T }>;
  };
}

declare const splayer: SandboxSplayer;

/** 把沙箱全局适配为同步引擎依赖的 SplayerContext */
const createSplayerContext = (host: SandboxSplayer): SplayerContext => ({
  pluginId: host.pluginId,
  locale: host.locale,
  appVersion: host.appVersion,
  callNetease: (name, params) => host.netease.call(name, params),
  player: {
    play: () => host.player.play(),
    pause: () => host.player.pause(),
    next: () => host.player.next(),
    prev: () => host.player.prev(),
    seek: (ms) => host.player.seek(ms),
    setVolume: (v) => host.player.setVolume(v),
    getPosition: () => host.player.getPosition(),
    playTrack: (track) => host.player.playTrack(track),
    on: (kind, handler) =>
      host.player.on(kind, handler as (data: unknown) => void),
  },
  register: (args) => host.register(args),
  on: (action, handler) =>
    host.on(action, handler as (req: unknown) => Promise<unknown>),
  getSetting: (key) => host.getSetting(key),
  onSettingChange: (key, handler) => host.onSettingChange(key, handler),
  log: host.log,
});

/* ================= 插件主体 ================= */

const SETTING_ROOM_LINK = "roomLink";
const SETTING_AUTO_JOIN = "autoJoin";
const SETTING_PIN_AFTER_PUSH = "pinAfterPush";

const ctx = createSplayerContext(splayer);
const engine = new TogetherSyncEngine({ ctx });

let joining = false;

/** 菜单项 id 常量 */
const MENU = {
  create: "together-create",
  resume: "together-resume",
  join: "together-join",
  leave: "together-leave",
  push: "together-push",
  pin: "together-pin",
  goto: "together-goto",
  next: "together-next",
  ended: "together-ended",
} as const;

/** 判断曲目是否为可推入一起听的网易云在线曲目 */
const isNeteaseTrack = (
  track: TogetherTrack | null | undefined,
): track is TogetherTrack =>
  !!track && track.source === "netease" && !!track.id;

ctx.register({
  events: ["trackChange", "playStateChange", "lineChange"],
  controls: true,
  settings: [
    {
      key: SETTING_ROOM_LINK,
      type: "text",
      label: "多人一起听房间链接",
      description: "粘贴网易云官方多人一起听链接（地址中包含 multishare）",
      default: "",
      placeholder:
        "https://st.music.163.com/listen-together/multishare/index.html?roomId=..&inviterUid=..",
    },
    {
      key: SETTING_AUTO_JOIN,
      type: "switch",
      label: "启动后自动加入",
      description: "插件启用时，若已配置多人房间链接则自动加入",
      default: false,
    },
    {
      key: SETTING_PIN_AFTER_PUSH,
      type: "switch",
      label: "推歌后自动置顶",
      description: "推歌成功后立即把该歌曲移到房间列表最前",
      default: false,
    },
  ],
  menus: [
    { id: MENU.push, label: "推歌到多人房间" },
    { id: MENU.pin, label: "在多人房间置顶" },
    { id: MENU.goto, label: "让多人房间播放" },
  ],
});

/** 读取配置并加入房间 */
const joinFromSetting = async (): Promise<string> => {
  const link = String(ctx.getSetting(SETTING_ROOM_LINK) ?? "").trim();
  if (!link) throw new Error("请先在插件设置里填写多人一起听链接");
  await engine.join(link);
  return engine.inRoom ? "已加入多人一起听" : "加入失败";
};

/* ---------- 播放事件转发 ---------- */

let localTrackId: string | null = null;

ctx.player.on("playStateChange", (data) => {
  const payload = data as PlaybackEventData["playStateChange"];
  if (payload.state === "playing" && localTrackId) {
    const pending = engine.consumePendingPlayback(localTrackId);
    if (pending) {
      if (pending.position > 0) ctx.player.seek(Math.round(pending.position));
      if (!pending.playing) ctx.player.pause();
    }
  }
  engine.onLocalEvent("playStateChange", {
    state: payload.state,
    position: payload.position,
  });
});

ctx.player.on("lineChange", (data) => {
  const payload = data as PlaybackEventData["lineChange"];
  engine.onLocalEvent("lineChange", { position: payload.position });
});

ctx.player.on("trackChange", (data) => {
  const payload = data as PlaybackEventData["trackChange"];
  localTrackId = payload.track ? String(payload.track.id) : null;
  if (isNeteaseTrack(payload.track))
    void engine.onLocalTrackChange(localTrackId!);
});

/* ---------- 设置变更 ---------- */

ctx.onSettingChange(SETTING_ROOM_LINK, (value) => {
  if (!engine.inRoom) return;
  const parsed = parseRoomLink(String(value ?? ""));
  if (parsed.roomId) ctx.log.info(`[一起听] 房间链接已更新：${parsed.roomId}`);
});

/* ---------- 菜单点击 ---------- */

ctx.on("menuClick", async ({ menuId, track, data }) => {
  switch (menuId) {
    case "together-status":
      return { data: await engine.detailedSnapshot() };
    case MENU.create: {
      if (engine.inRoom) return { error: "已在房间中，请先退出一起听" };
      try {
        const initialTrack = isNeteaseTrack(track) ? track : undefined;
        const { roomId, creatorId, resumed } =
          await engine.create(initialTrack);
        const link = buildMultiShareLink(
          roomId,
          creatorId,
          initialTrack ? String(initialTrack.id) : undefined,
        );
        return {
          toast: resumed
            ? "已恢复现有多人房间，邀请链接已复制"
            : "已创建多人一起听房间，邀请链接已复制",
          copyText: link,
          data: engine.snapshot,
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }
    case MENU.resume: {
      try {
        const found = await engine.resume();
        if (!found) return { error: "当前网易云账号没有正在进行的多人房间" };
        return { toast: "已恢复现有多人房间", data: engine.snapshot };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }
    case MENU.join: {
      if (engine.inRoom) return { error: "已在一起听房间中" };
      if (joining) return { error: "正在加入…" };
      joining = true;
      try {
        const directLink =
          typeof data === "object" && data !== null && "roomLink" in data
            ? String((data as { roomLink?: unknown }).roomLink ?? "").trim()
            : "";
        if (directLink) await engine.join(directLink);
        else await joinFromSetting();
        return { toast: "已加入多人一起听", data: engine.snapshot };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      } finally {
        joining = false;
      }
    }
    case MENU.leave: {
      if (!engine.inRoom) return { error: "当前未在房间中" };
      await engine.leave();
      return { toast: "已退出多人一起听", data: engine.snapshot };
    }
    case MENU.push: {
      if (!engine.inRoom) return { error: "请先加入一起听" };
      if (!isNeteaseTrack(track)) return { error: "仅支持推网易云在线歌曲" };
      try {
        engine.cacheTrack(track);
        await engine.pushSong(String(track.id));
        if (ctx.getSetting(SETTING_PIN_AFTER_PUSH))
          await engine.pinSong(String(track.id));
        return { toast: `已推歌：${track.title}`, data: engine.snapshot };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }
    case MENU.pin: {
      if (!engine.inRoom) return { error: "请先加入一起听" };
      if (!isNeteaseTrack(track)) return { error: "仅支持置顶网易云在线歌曲" };
      try {
        await engine.pinSong(String(track.id));
        return { toast: `已置顶：${track.title}`, data: engine.snapshot };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }
    case MENU.goto: {
      if (!engine.inRoom) return { error: "请先加入一起听" };
      if (!isNeteaseTrack(track)) return { error: "仅支持播放网易云在线歌曲" };
      try {
        await engine.goto(String(track.id));
        return { toast: `已切歌：${track.title}`, data: engine.snapshot };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }
    case MENU.next: {
      if (!engine.inRoom) return { error: "请先加入一起听" };
      try {
        await engine.next();
        return { data: engine.snapshot };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }
    case MENU.ended: {
      engine.onTrackEnded();
      return { data: engine.snapshot };
    }
    default:
      return;
  }
});

/* ---------- 自动加入 ---------- */

if (ctx.getSetting(SETTING_AUTO_JOIN)) {
  void joinFromSetting().catch((err) => {
    ctx.log.warn(
      "[一起听] 自动加入失败：",
      err instanceof Error ? err.message : err,
    );
  });
}

ctx.log.info("[多人一起听] 插件已就绪");
