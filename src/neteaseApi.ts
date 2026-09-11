/**
 * neteaseApi.ts — 一起听协议的类型化封装
 *
 * 唯一职责：把宿主桥接 `splayerContext.callNetease(name, params)` 包装成一组
 * 语义化方法，供同步引擎（sync.ts）与插件入口（index.ts）调用。
 * 不持有任何状态，不做重试/节流——那些属于同步引擎。
 *
 * 所有方法在 status !== 200 时抛出携带 code/status 的错误，交由上层退避与重连。
 */

import type {
  ListCommandType,
  NeteaseResult,
  PlayCommandType,
  PlayStatus,
  RoomState,
  SongDetail,
  SplayerContext,
  VersionEntry,
} from "./types";

/** 模块名与 electron/main/apis/netease/modules/ 下新增的模块一一对应 */
export const NET = {
  accept: "listentogether_accept",
  status: "listentogether_status",
  playlistGet: "listentogether_sync_playlist_get",
  listCommand: "listentogether_sync_list_command",
  playCommand: "listentogether_play_command",
  heartbeat: "listentogether_heatbeat",
  roomCreate: "listentogether_room_create",
  roomCheck: "listentogether_room_check",
  end: "listentogether_end",
  songDetail: "song_detail",
  search: "search",
} as const;

/** 接口错误：保留宿主返回的 code 与 status，供退避策略判定风控 */
export class NeteaseApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "NeteaseApiError";
    this.code = code;
    this.status = status;
  }
}

/** 是否疑似触发风控/频率限制：用于自适应退避放大间隔 */
export const isRateLimited = (err: unknown): boolean => {
  if (err instanceof NeteaseApiError) {
    // 网易云风控常见返回：-460（频率限制）/ 400 / 403 / 429 / 5xx
    if (err.status === 429 || err.status >= 500) return true;
    if (err.status === 400 || err.status === 403) return true;
    return err.code === "-460" || err.code === "460";
  }
  return false;
};

export const createNeteaseApi = (ctx: SplayerContext) => {
  /** 发起调用并解包：非 200 直接抛错 */
  const call = async <T>(name: string, params: Record<string, unknown> = {}): Promise<T> => {
    let res: NeteaseResult<T>;
    try {
      res = await ctx.callNetease<T>(name, params);
    } catch (err) {
      throw new NeteaseApiError(
        err instanceof Error ? err.message : String(err),
        "NETEASE_BRIDGE_ERROR",
        -1,
      );
    }
    const body = res.body as { code?: number | string; message?: string; msg?: string } | T;
    const code = (body as { code?: number | string })?.code;
    if (res.status !== 200 || (code !== undefined && Number(code) !== 200)) {
      const msg = (body as { message?: string; msg?: string })?.message ?? (body as { msg?: string })?.msg ?? "";
      throw new NeteaseApiError(
        msg ? `netease ${code ?? res.status}: ${msg}` : `netease ${code ?? res.status}`,
        String(code ?? res.status),
        res.status,
      );
    }
    return res.body as T;
  };

  return {
    /** 接受邀请加入房间（访客侧） */
    async accept(roomId: string, inviterId: string): Promise<void> {
      await call(NET.accept, { refer: "inbox_invite", roomId, inviterId });
    },

    /** 查询当前一起听状态（是否已在房间） */
    async status(): Promise<{ inRoom?: boolean; roomInfo?: { roomId?: string; creatorId?: string } }> {
      return call(NET.status, {});
    },

    /** 拉取房间播放状态与列表（同步核心数据源） */
    async getPlaylist(roomId: string): Promise<RoomState> {
      const body = await call<{ data: RoomState }>(NET.playlistGet, { roomId });
      return body.data;
    },

    /** 上报列表变更（推歌 / 置顶 / 替换 / 播放模式） */
    async reportList(
      roomId: string,
      param: {
        commandType: ListCommandType;
        version: VersionEntry[];
        anchorSongId?: string;
        anchorPosition?: number;
        randomList?: string[];
        displayList?: string[];
      },
    ): Promise<void> {
      await call(NET.listCommand, {
        roomId,
        commandType: param.commandType,
        version: JSON.stringify(param.version),
        anchorSongId: param.anchorSongId ?? "",
        anchorPosition: param.anchorPosition ?? -1,
        randomList: (param.randomList ?? []).join(","),
        displayList: (param.displayList ?? []).join(","),
      });
    },

    /** 上报播放指令（切歌 / 播放 / 暂停） */
    async reportPlay(
      roomId: string,
      command: {
        commandType: PlayCommandType;
        progress?: number;
        playStatus?: PlayStatus;
        formerSongId?: string;
        targetSongId?: string;
        clientSeq?: number;
      },
    ): Promise<void> {
      await call(NET.playCommand, {
        roomId,
        commandType: command.commandType,
        progress: command.progress ?? 0,
        playStatus: command.playStatus ?? "",
        formerSongId: command.formerSongId ?? "",
        targetSongId: command.targetSongId ?? "",
        clientSeq: command.clientSeq ?? 0,
      });
    },

    /** 心跳：每首歌开始/保活时上报当前播放进度 */
    async heartbeat(
      roomId: string,
      songId: string,
      playStatus: PlayStatus,
      progress: number,
    ): Promise<void> {
      await call(NET.heartbeat, { roomId, songId, playStatus, progress });
    },

    /** 歌曲详情：把 songId 变成可交给宿主播放的 Track */
    async songDetail(ids: string[]): Promise<SongDetail[]> {
      const body = await call<{ songs?: SongDetail[] }>(NET.songDetail, { ids: ids.join(",") });
      return body.songs ?? [];
    },

    /** 搜索歌曲（推歌选曲用） */
    async search(keywords: string, limit = 20): Promise<SongDetail[]> {
      const body = await call<{ result?: { songs?: SongDetail[] } }>(NET.search, {
        keywords,
        type: 1,
        limit,
      });
      return body.result?.songs ?? [];
    },

    /** 尽力而为地创建房间（第三方客户端能力受限，可能失败） */
    async roomCreate(): Promise<{ roomId?: string; creatorId?: string }> {
      const body = await call<{ data?: { roomInfo?: { roomId?: string; creatorId?: string } } }>(
        NET.roomCreate,
        {},
      );
      return body.data?.roomInfo ?? {};
    },

    /** 检查房间是否可加入 */
    async roomCheck(roomId: string): Promise<{ joinable?: boolean; status?: string }> {
      const body = await call<{ data?: { joinable?: boolean; status?: string } }>(NET.roomCheck, {
        roomId,
      });
      return body.data ?? {};
    },

    /** 结束/离开房间 */
    async end(roomId: string): Promise<void> {
      await call(NET.end, { roomId, shareInfo: "{}" });
    },
  };
};

export type NeteaseApi = ReturnType<typeof createNeteaseApi>;

/** 把网易云 SongDetail 归一化为宿主 Track */
export const toTogetherTrack = (song: SongDetail): import("./types").TogetherTrack => {
  const artists = song.ar ?? song.artists ?? [];
  const album = song.al ?? song.album;
  return {
    id: String(song.id),
    source: "netease",
    title: song.name,
    artists: artists.map((a) => ({ id: a.id !== undefined ? String(a.id) : undefined, name: a.name })),
    album: album ? { id: album.id !== undefined ? String(album.id) : undefined, name: album.name, cover: album.picUrl } : undefined,
    duration: Number(song.dt ?? song.duration ?? 0),
    cover: album?.picUrl,
  };
};
