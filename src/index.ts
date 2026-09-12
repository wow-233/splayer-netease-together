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

import { TogetherSyncEngine } from "./sync";
import { parseRoomLink } from "./sync";
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
    call<T = unknown>(name: string, params?: Record<string, unknown>): Promise<{ status: number; body: T }>;
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
    on: (kind, handler) => host.player.on(kind, handler as (data: unknown) => void),
  },
  register: (args) => host.register(args),
  on: (action, handler) => host.on(action, handler as (req: unknown) => Promise<unknown>),
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
  join: "together-join",
  leave: "together-leave",
  push: "together-push",
  pin: "together-pin",
  goto: "together-goto",
} as const;

/** 判断曲目是否为可推入一起听的网易云在线曲目 */
const isNeteaseTrack = (track: TogetherTrack | null | undefined): boolean =>
  !!track && track.source === "netease" && !!track.id;

ctx.register({
  events: ["trackChange", "playStateChange", "lineChange"],
  controls: true,
  settings: [
    {
      key: SETTING_ROOM_LINK,
      type: "text",
      label: "一起听房间链接",
      description: "粘贴网易云一起听分享链接（含 roomId 与 inviterId），或直接填 roomId",
      default: "",
      placeholder: "https://st.music.163.com/listen-together/share/?songId=..&roomId=..&inviterId=..",
    },
    {
      key: SETTING_AUTO_JOIN,
      type: "switch",
      label: "启动后自动加入",
      description: "插件启用时，若已配置房间链接则自动加入",
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
    { id: MENU.create, label: "创建一起听房间（复制链接）" },
    { id: MENU.join, label: "加入一起听" },
    { id: MENU.leave, label: "退出一起听" },
    { id: MENU.push, label: "推歌到一起听" },
    { id: MENU.pin, label: "置顶到一起听" },
    { id: MENU.goto, label: "立即播放（一起听）" },
  ],
});

/** 读取配置并加入房间 */
const joinFromSetting = async (): Promise<string> => {
  const link = String(ctx.getSetting(SETTING_ROOM_LINK) ?? "").trim();
  if (!link) throw new Error("请先在插件设置里填写一起听房间链接");
  await engine.join(link);
  return engine.inRoom ? "已加入一起听" : "加入失败";
};

/* ---------- 播放事件转发 ---------- */

ctx.player.on("playStateChange", (data) => {
  const payload = data as PlaybackEventData["playStateChange"];
  engine.onLocalEvent("playStateChange", { state: payload.state, position: payload.position });
});

ctx.player.on("lineChange", (data) => {
  const payload = data as PlaybackEventData["lineChange"];
  engine.onLocalEvent("lineChange", { position: payload.position });
});

// 曲目就绪后落地云端定位（避免从 0 开始播放）
ctx.player.on("trackChange", (data) => {
  const payload = data as PlaybackEventData["trackChange"];
  if (!payload.track) return;
  const position = engine.consumePendingSeek(String(payload.track.id));
  if (position !== null && position > 0) ctx.player.seek(Math.max(0, Math.round(position)));
});

/* ---------- 设置变更 ---------- */

ctx.onSettingChange(SETTING_ROOM_LINK, (value) => {
  if (!engine.inRoom) return;
  const parsed = parseRoomLink(String(value ?? ""));
  if (parsed.roomId) ctx.log.info(`[一起听] 房间链接已更新：${parsed.roomId}`);
});

/* ---------- 菜单点击 ---------- */

ctx.on("menuClick", async ({ menuId, track }) => {
  switch (menuId) {
    case MENU.create: {
      if (engine.inRoom) return { toast: "已在房间中，请先退出一起听" };
      try {
        const { roomId, creatorId } = await engine.create();
        const link =
          "https://st.music.163.com/listen-together/share/?roomId=" +
          encodeURIComponent(roomId) +
          "&inviterId=" +
          encodeURIComponent(creatorId);
        return { toast: "已创建一起听房间，分享链接已复制", copyText: link };
      } catch (err) {
        return { toast: err instanceof Error ? err.message : String(err) };
      }
    }
    case MENU.join: {
      if (engine.inRoom) return { toast: "已在一起听房间中" };
      if (joining) return { toast: "正在加入…" };
      joining = true;
      try {
        const message = await joinFromSetting();
        return { toast: message };
      } catch (err) {
        return { toast: err instanceof Error ? err.message : String(err) };
      } finally {
        joining = false;
      }
    }
    case MENU.leave: {
      if (!engine.inRoom) return { toast: "当前未在房间中" };
      await engine.leave();
      return { toast: "已退出一听" };
    }
    case MENU.push: {
      if (!engine.inRoom) return { toast: "请先加入一起听" };
      if (!isNeteaseTrack(track)) return { toast: "仅支持推网易云在线歌曲" };
      try {
        await engine.pushSong(String(track.id));
        if (ctx.getSetting(SETTING_PIN_AFTER_PUSH)) await engine.pinSong(String(track.id));
        return { toast: `已推歌：${track.title}` };
      } catch (err) {
        return { toast: err instanceof Error ? err.message : String(err) };
      }
    }
    case MENU.pin: {
      if (!engine.inRoom) return { toast: "请先加入一起听" };
      if (!isNeteaseTrack(track)) return { toast: "仅支持置顶网易云在线歌曲" };
      try {
        await engine.pinSong(String(track.id));
        return { toast: `已置顶：${track.title}` };
      } catch (err) {
        return { toast: err instanceof Error ? err.message : String(err) };
      }
    }
    case MENU.goto: {
      if (!engine.inRoom) return { toast: "请先加入一起听" };
      if (!isNeteaseTrack(track)) return { toast: "仅支持播放网易云在线歌曲" };
      try {
        await engine.goto(String(track.id));
        return { toast: `已切歌：${track.title}` };
      } catch (err) {
        return { toast: err instanceof Error ? err.message : String(err) };
      }
    }
    default:
      return;
  }
});

/* ---------- 自动加入 ---------- */

if (ctx.getSetting(SETTING_AUTO_JOIN)) {
  void joinFromSetting().catch((err) => {
    ctx.log.warn("[一起听] 自动加入失败：", err instanceof Error ? err.message : err);
  });
}

ctx.log.info("[一起听] 插件已就绪");
