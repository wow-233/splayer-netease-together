/** 官方“多人一起听”HTTP 协议封装。 */

import type {
  MultiHeartbeatData,
  MultiRoomAckData,
  MultiRoomMessageHistory,
  MultiSongOperate,
  MultiSongOperateData,
  NeteaseResult,
  SongDetail,
  SplayerContext,
} from "./types";

export const NET = {
  create: "listentogether_multi_room_create",
  join: "listentogether_multi_match_ack",
  heartbeat: "listentogether_multi_heartbeat",
  leave: "listentogether_multi_match_exit",
  songOperate: "listentogether_multi_song_operate",
  status: "listentogether_multi_match_status_get",
  history: "listentogether_multi_match_msg_history",
  token: "listentogether_security_token",
  songDetail: "song_detail",
} as const;

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

export const isRateLimited = (err: unknown): boolean => {
  if (!(err instanceof NeteaseApiError)) return false;
  return (
    err.status === 429 ||
    err.status === 400 ||
    err.status === 403 ||
    err.status >= 500 ||
    err.code === "-460" ||
    err.code === "460"
  );
};

export const createNeteaseApi = (ctx: SplayerContext) => {
  const call = async <T>(
    name: string,
    params: Record<string, unknown> = {},
  ): Promise<T> => {
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

    const body = res.body as
      | { code?: number | string; message?: string; msg?: string }
      | T;
    const code = (body as { code?: number | string })?.code;
    if (res.status !== 200 || (code !== undefined && Number(code) !== 200)) {
      const message =
        (body as { message?: string; msg?: string })?.message ??
        (body as { msg?: string })?.msg ??
        "";
      throw new NeteaseApiError(
        message || `网易云接口返回 ${code ?? res.status}`,
        String(code ?? res.status),
        res.status,
      );
    }
    return res.body as T;
  };

  return {
    async securityToken(): Promise<string> {
      const body = await call<{ code: number; token?: string }>(NET.token);
      if (!body.token) throw new Error("无法获取网易云房间校验 token，请稍后重试");
      return body.token;
    },
    async createRoom(args: {
      songId: string;
      playedTime: number;
      nextSongIds?: string[];
    }): Promise<MultiRoomAckData> {
      const securityToken = await this.securityToken();
      const body = await call<{ code: number; data?: MultiRoomAckData }>(
        NET.create,
        {
          type: 1,
          songId: args.songId,
          groupIds: [],
          inviteUids: [],
          from: "CREATE",
          playedTime: Math.max(0, Math.round(args.playedTime)),
          nextSongIds: args.nextSongIds ?? [],
          securityToken,
        },
      );
      return body.data ?? {};
    },

    async joinRoom(
      roomId: string,
      inviterUid: string,
    ): Promise<MultiRoomAckData> {
      const securityToken = await this.securityToken();
      const body = await call<{ code: number; data?: MultiRoomAckData }>(
        NET.join,
        {
          roomId,
          inviterUid,
          agree: true,
          securityToken,
        },
      );
      return body.data ?? {};
    },

    async heartbeat(roomId: string): Promise<MultiHeartbeatData> {
      const body = await call<{ code: number; data?: MultiHeartbeatData }>(
        NET.heartbeat,
        { roomId },
      );
      return body.data ?? {};
    },

    async roomStatus(): Promise<MultiRoomAckData> {
      const body = await call<{ code: number; data?: MultiRoomAckData }>(NET.status);
      return body.data ?? {};
    },

    async roomHistory(roomId: string): Promise<MultiRoomMessageHistory> {
      const body = await call<{ code: number; data?: MultiRoomMessageHistory; records?: MultiRoomMessageHistory["records"] }>(
        NET.history,
        { roomId },
      );
      return body.data ?? { records: body.records };
    },

    async operateSong(
      roomId: string,
      songId: string,
      bizId: string,
      operate: MultiSongOperate,
    ): Promise<MultiSongOperateData> {
      const securityToken = await this.securityToken();
      const body = await call<{ code: number; data?: MultiSongOperateData }>(
        NET.songOperate,
        { roomId, songId, bizId, operate, securityToken },
      );
      const data = body.data ?? {};
      if (data.failedCode || data.failedMsg) {
        throw new Error(data.failedMsg || `歌曲操作失败（${data.failedCode}）`);
      }
      return data;
    },

    async leaveRoom(roomId: string): Promise<void> {
      await call(NET.leave, { roomId, exitType: "NORMAL" });
    },

    async songDetail(ids: string[]): Promise<SongDetail[]> {
      const body = await call<{ songs?: SongDetail[] }>(NET.songDetail, {
        ids: ids.join(","),
      });
      return body.songs ?? [];
    },
  };
};

export type NeteaseApi = ReturnType<typeof createNeteaseApi>;

export const toTogetherTrack = (
  song: SongDetail,
): import("./types").TogetherTrack => {
  const artists = song.ar ?? song.artists ?? [];
  const album = song.al ?? song.album;
  return {
    id: String(song.id),
    source: "netease",
    title: song.name,
    artists: artists.map((artist) => ({
      id: artist.id !== undefined ? String(artist.id) : undefined,
      name: artist.name,
    })),
    album: album
      ? {
          id: album.id !== undefined ? String(album.id) : undefined,
          name: album.name,
          cover: album.picUrl,
        }
      : undefined,
    duration: Number(song.dt ?? song.duration ?? 0),
    cover: album?.picUrl,
  };
};
