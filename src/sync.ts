/** 官方网易云“多人一起听”房间同步引擎。 */

import {
  createNeteaseApi,
  isRateLimited,
  NeteaseApiError,
  toTogetherTrack,
  type NeteaseApi,
} from "./neteaseApi";
import type {
  MultiRoomSnapshot,
  MultiRoomSongInfo,
  MultiSongInfo,
  PlaybackEventData,
  SplayerContext,
  TogetherTrack,
} from "./types";

const DEFAULT_HEARTBEAT_MS = 20_000;
const MIN_HEARTBEAT_MS = 2_000;
const MAX_HEARTBEAT_MS = 30_000;
const SEEK_THRESHOLD_MS = 2_000;
const MAX_BACKOFF = 4;
const ROOM_REFRESH_MS = 1_800;

export interface ParsedRoomLink {
  roomId?: string;
  inviterId?: string;
  songId?: string;
  isMultiRoom: boolean;
}

export const parseRoomLink = (input: string): ParsedRoomLink => {
  const text = String(input ?? "").trim();
  if (!text) return { isMultiRoom: false };
  try {
    // 手机分享可能是整段文案、Markdown 链接，且转发时会转义 _ 和 &。
    const candidate = text.match(/https?:\/\/[^\s<>\])]+/i)?.[0] ?? text;
    const url = new URL(
      candidate.replace(/\\([_&?=])/g, "$1").replace(/[。，,;；]+$/, ""),
    );
    const roomId = url.searchParams.get("roomId") || undefined;
    const inviterId =
      url.searchParams.get("inviterUid") ||
      url.searchParams.get("inviterId") ||
      undefined;
    const songId = url.searchParams.get("songId") || undefined;
    return {
      ...(roomId ? { roomId } : {}),
      ...(inviterId ? { inviterId } : {}),
      ...(songId ? { songId } : {}),
      isMultiRoom: /\/listen-together\/multishare(?:\/|$)/i.test(url.pathname),
    };
  } catch {
    return { isMultiRoom: false };
  }
};

export const buildMultiShareLink = (
  roomId: string,
  inviterUid: string,
  songId?: string,
): string => {
  const params = new URLSearchParams({ roomId, inviterUid });
  if (songId) params.set("songId", songId);
  return `https://st.music.163.com/listen-together/multishare/index.html?${params.toString()}`;
};

export const needsSeek = (localPos: number, expectedPos: number): boolean =>
  Math.abs(localPos - expectedPos) > SEEK_THRESHOLD_MS;

export const expectedMultiPosition = (
  playedTime: number | undefined,
  halfRttMs: number,
): number => Math.max(0, Number(playedTime ?? 0) + Math.max(0, halfRttMs));

export const nextHeartbeatDelay = (
  serverSeconds: number | undefined,
  backoff = 1,
): number => {
  const serverMs = Number(serverSeconds) * 1000;
  const base =
    Number.isFinite(serverMs) && serverMs > 0 ? serverMs : DEFAULT_HEARTBEAT_MS;
  return Math.round(
    Math.min(
      MAX_HEARTBEAT_MS,
      Math.max(MIN_HEARTBEAT_MS, base * Math.max(1, backoff)),
    ),
  );
};

export const roomSongIds = (info?: MultiRoomSongInfo): string[] => {
  const songs = [info?.playSong, ...(info?.nextSongs ?? [])];
  return songs
    .filter((song): song is MultiSongInfo => song?.songId !== undefined)
    .map((song) => String(song.songId));
};

export interface SyncEngineOptions {
  ctx: SplayerContext;
  timers?: {
    setTimeout: (cb: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
    now: () => number;
  };
}

export class TogetherSyncEngine {
  private readonly api: NeteaseApi;
  private readonly ctx: SplayerContext;
  private readonly timers: NonNullable<SyncEngineOptions["timers"]>;
  private roomId: string | null = null;
  private inviterId: string | null = null;
  private selfUserId = "";
  private currentSongId: string | null = null;
  private currentSongBizId: string | null = null;
  private playlist: MultiSongInfo[] = [];
  private readonly songCache = new Map<string, TogetherTrack>();
  private readonly pinCounts = new Map<string, number>();
  private readonly pendingPinCounts = new Map<
    string,
    { count: number; until: number }
  >();
  private historyCheckedAt = Number.NEGATIVE_INFINITY;
  private historyLoading: Promise<void> | null = null;
  private session = 0;
  private mutationRevision = 0;
  private readonly pinned = new Set<string>();
  private readonly pinning = new Set<string>();
  private metadataLoading: Promise<void> | null = null;
  private metadataCheckedAt = Number.NEGATIVE_INFINITY;
  private heartbeatLoading: Promise<void> | null = null;
  private roomRefreshLoading: Promise<void> | null = null;
  private roomRefreshAt = 0;
  private roomRefreshBackoff = ROOM_REFRESH_MS;
  private readSequence = 0;
  private appliedReadSequence = 0;
  private loadingSong: string | null = null;
  private loadRetryAt = 0;
  private loadAttempts = 0;
  private syncError = "";
  private lastSyncedAt = 0;
  private playedSongs: string[] = [];
  private memberCount = 1;
  private members: Array<{
    userId: string;
    nickname: string;
    avatarUrl?: string;
  }> = [];
  private paused = false;
  private running = false;
  private version = -1;
  private heartbeatMs = DEFAULT_HEARTBEAT_MS;
  private backoff = 1;
  private heartbeatHandle: unknown = null;
  private endedSongId: string | null = null;
  private endedFastPolls = 0;
  private pendingPlayback: {
    songId: string;
    position: number;
    playing: boolean;
    at: number;
  } | null = null;

  constructor(opts: SyncEngineOptions) {
    this.ctx = opts.ctx;
    this.api = createNeteaseApi(opts.ctx);
    this.timers =
      opts.timers ??
      ({
        setTimeout: (cb, ms) => setTimeout(cb, ms),
        clearTimeout: (handle) =>
          clearTimeout(handle as ReturnType<typeof setTimeout>),
        now: () => Date.now(),
      } as NonNullable<SyncEngineOptions["timers"]>);
  }

  async create(
    initialTrack?: TogetherTrack,
  ): Promise<{ roomId: string; creatorId: string; resumed: boolean }> {
    if (this.running) throw new Error("已在多人一起听房间中，请先退出");
    const selfUserId = await this.resolveSelfUserId();
    // 桌面端重启后内存状态会丢失，但网易云账号仍可能在官方房间。
    if (await this.resumeExistingRoom(selfUserId)) {
      return { roomId: this.roomId!, creatorId: selfUserId, resumed: true };
    }
    if (!initialTrack?.id) throw new Error("请先播放一首网易云在线歌曲");
    const playedTime = await this.ctx.player.getPosition();
    const data = await this.api.createRoom({
      songId: String(initialTrack.id),
      playedTime,
      nextSongIds: [],
    });
    if (data.failedType === "MULTI_ACK_ALREADY_IN_ROOM" || data.existRoomId) {
      if (await this.resumeExistingRoom(selfUserId, data.existRoomId)) {
        return { roomId: this.roomId!, creatorId: selfUserId, resumed: true };
      }
      throw new Error(
        "网易云账号已在其他多人房间，请先在手机端退出该房间后再创建",
      );
    }
    this.assertRoomAccepted(data, "创建");
    const snapshot = data.multiLtRoomSnapshot;
    const roomId = snapshot?.roomId ?? snapshot?.multiRoomInfoDTO?.roomId;
    if (!roomId) throw new Error("创建多人房间失败：服务端未返回房间号");
    this.startRoom(String(roomId), selfUserId, selfUserId, snapshot);
    this.currentSongId = String(initialTrack.id);
    this.currentSongBizId =
      snapshot?.roomPlaySongInfo?.playSong?.songBizId === undefined
        ? null
        : String(snapshot.roomPlaySongInfo.playSong.songBizId);
    if (!this.playlist.length) this.playlist = [{ songId: initialTrack.id }];
    if (snapshot?.roomPlaySongInfo) {
      await this.applyRoomSongInfo(snapshot.roomPlaySongInfo, 0, true);
    }
    // 创建房间时原曲可能已经暂停；若服务端换了曲，则由 loadTrack 负责播放。
    if (this.currentSongId === String(initialTrack.id)) this.ctx.player.play();
    this.scheduleHeartbeat(0);
    this.ctx.log.info(`[多人一起听] 已创建房间 ${roomId}`);
    return { roomId: String(roomId), creatorId: selfUserId, resumed: false };
  }

  async resume(): Promise<boolean> {
    if (this.inRoom) return true;
    return this.resumeExistingRoom(await this.resolveSelfUserId());
  }

  async join(roomLink: string, inviterIdArg?: string): Promise<void> {
    if (this.running) throw new Error("已在多人一起听房间中，请先退出");
    const parsed = parseRoomLink(roomLink);
    if (!parsed.isMultiRoom) {
      throw new Error(
        "这不是多人一起听链接，请使用包含 multishare 的官方多人邀请链接",
      );
    }
    const roomId = parsed.roomId;
    const inviterId = inviterIdArg ?? parsed.inviterId;
    if (!roomId || !inviterId)
      throw new Error("邀请链接缺少 roomId 或 inviterUid");
    const selfUserId = await this.resolveSelfUserId();
    const data = await this.api.joinRoom(roomId, inviterId);
    if (data.failedType === "MULTI_ACK_ALREADY_IN_ROOM" || data.existRoomId) {
      if (data.existRoomId && String(data.existRoomId) !== String(roomId)) {
        throw new Error(
          "网易云账号仍在另一个多人房间，请先退出原房间后再加入邀请房间",
        );
      }
      if (await this.resumeExistingRoom(selfUserId, roomId)) return;
      throw new Error("网易云账号已在其他多人房间，请先在手机端退出后再加入");
    }
    this.assertRoomAccepted(data, "加入");
    const snapshot = data.multiLtRoomSnapshot;
    const acceptedRoomId =
      snapshot?.roomId ?? snapshot?.multiRoomInfoDTO?.roomId ?? roomId;
    this.startRoom(String(acceptedRoomId), selfUserId, selfUserId, snapshot);
    if (snapshot?.roomPlaySongInfo) {
      await this.applyRoomSongInfo(snapshot.roomPlaySongInfo, 0, true);
    }
    await this.runHeartbeat();
    this.ctx.log.info(`[多人一起听] 已加入房间 ${acceptedRoomId}`);
  }

  async leave(): Promise<void> {
    const roomId = this.roomId;
    this.resetRoom();
    if (!roomId) return;
    try {
      await this.api.leaveRoom(roomId);
    } catch (error) {
      this.ctx.log.warn(
        "[多人一起听] 退出房间请求失败：",
        error instanceof Error ? error.message : error,
      );
    }
  }

  get inRoom(): boolean {
    return this.running && this.roomId !== null;
  }

  get snapshot(): {
    inRoom: boolean;
    mode: "multi";
    roomId: string | null;
    inviterId: string | null;
    currentSongId: string | null;
    playlistLength: number;
    memberCount: number;
    members: Array<{ userId: string; nickname: string; avatarUrl?: string }>;
    paused: boolean;
    syncError: string;
    lastSyncedAt: number;
    queue: Array<{
      songId: string;
      songBizId?: string;
      pinned?: boolean;
      track?: TogetherTrack;
      recommendedBy?: string;
      pinCount?: number;
    }>;
    played: Array<{ songId: string; track?: TogetherTrack }>;
  } {
    return {
      inRoom: this.inRoom,
      mode: "multi",
      roomId: this.roomId,
      inviterId: this.inviterId,
      currentSongId: this.currentSongId,
      playlistLength: this.playlist.length,
      memberCount: this.memberCount,
      members: this.members,
      paused: this.paused,
      syncError: this.syncError,
      lastSyncedAt: this.lastSyncedAt,
      queue: this.playlist.map((song) => ({
        songId: String(song.songId),
        songBizId:
          song.songBizId === undefined ? undefined : String(song.songBizId),
        pinned:
          song.songBizId === undefined
            ? false
            : this.pinned.has(String(song.songBizId)),
        track: this.songCache.get(String(song.songId)),
        recommendedBy: song.songRcmdUid ? String(song.songRcmdUid) : undefined,
        pinCount:
          song.songBizId === undefined
            ? undefined
            : this.pinCounts.get(String(song.songBizId)),
      })),
      played: this.playedSongs.map((songId) => ({
        songId,
        track: this.songCache.get(songId),
      })),
    };
  }

  async detailedSnapshot() {
    // 页面每两秒查询一次真实房间；保活心跳仍遵循服务端间隔。
    await this.refreshRoomState();
    // 历史消息只用于补充置顶数，不应阻塞房间页面和每次操作的回显。
    if (this.inRoom) void this.refreshPinCounts();
    await this.refreshSongDetails();
    return this.snapshot;
  }

  private async refreshSongDetails(): Promise<void> {
    if (!this.inRoom) return;
    if (this.metadataLoading) return this.metadataLoading;
    if (this.timers.now() - this.metadataCheckedAt < 5_000) return;
    const session = this.session;
    const ids = [
      ...this.playlist.map((song) => String(song.songId)),
      ...this.playedSongs,
    ];
    const missing = [...new Set(ids)]
      .filter((id) => !this.songCache.has(id))
      .slice(0, 50);
    if (missing.length) {
      this.metadataCheckedAt = this.timers.now();
      const task = (async () => {
        try {
          const songs = await this.api.songDetail(missing);
          if (session !== this.session) return;
          for (const song of songs) this.cacheTrack(toTogetherTrack(song));
          if (missing.every((id) => this.songCache.has(id)))
            this.metadataCheckedAt = Number.NEGATIVE_INFINITY;
        } catch (error) {
          this.ctx.log.warn("[多人一起听] 读取房间歌曲信息失败：", error);
        }
      })();
      this.metadataLoading = task;
      try {
        await task;
      } finally {
        if (this.metadataLoading === task) this.metadataLoading = null;
      }
    }
  }

  cacheTrack(track: TogetherTrack): void {
    if (track.source === "netease") this.songCache.set(String(track.id), track);
    while (this.songCache.size > 100) {
      const oldest = this.songCache.keys().next().value;
      if (oldest === undefined) break;
      this.songCache.delete(oldest);
    }
  }

  onLocalEvent(
    kind: "playStateChange" | "lineChange",
    data: {
      state?: PlaybackEventData["playStateChange"]["state"];
      position: number;
    },
  ): void {
    if (!this.running || kind !== "playStateChange" || !data.state) return;
    const resuming = this.paused && data.state === "playing";
    this.paused = data.state !== "playing";
    if (resuming && !this.pendingPlayback) this.scheduleHeartbeat(0);
  }

  async pushSong(songId: string): Promise<void> {
    const roomId = this.requireRoom();
    const session = this.session;
    const id = String(songId);
    if (this.findSong(id)) return;
    const data = await this.api.operateSong(roomId, id, "0", 1);
    this.assertSession(session);
    this.mutationRevision += 1;
    if (data.roomSongInfo) {
      this.updateRoomQueue(data.roomSongInfo, false);
    }
    if (!this.findSong(id)) {
      this.playlist.push({
        songId: data.operateSongId ?? id,
        songBizId: data.operateSongBizId,
      });
    }
    this.ctx.log.info(`[多人一起听] 已推歌 ${id}`);
    this.scheduleHeartbeat(1_500);
  }

  async pinSong(songId: string, songBizId?: string): Promise<void> {
    const roomId = this.requireRoom();
    const session = this.session;
    const id = String(songId);
    let song = this.findSong(id, songBizId);
    if (!song?.songBizId) {
      await this.runHeartbeat();
      this.assertSession(session);
      song = this.findSong(id, songBizId);
    }
    if (!song) throw new Error("这首歌尚未加入多人房间");
    if (!song.songBizId)
      throw new Error("房间尚未返回这首歌的队列编号，请稍后再试");
    const bizId = String(song.songBizId);
    if (this.pinned.has(bizId) || this.pinning.has(bizId)) return;
    this.pinning.add(bizId);
    try {
      const data = await this.api.operateSong(
        roomId,
        id,
        String(song.songBizId),
        2,
      );
      this.assertSession(session);
      if (data.roomSongInfo) this.updateRoomQueue(data.roomSongInfo, false);
      this.mutationRevision += 1;
      this.pinned.add(bizId);
      const optimisticCount = (this.pinCounts.get(bizId) ?? 0) + 1;
      this.pinCounts.set(bizId, optimisticCount);
      this.pendingPinCounts.set(bizId, {
        count: optimisticCount,
        until: this.timers.now() + 10_000,
      });
      this.historyCheckedAt = Number.NEGATIVE_INFINITY;
      void this.refreshPinCounts();
      this.scheduleHeartbeat(1_500);
    } finally {
      if (session === this.session) this.pinning.delete(bizId);
    }
  }

  async goto(
    songId: string,
    loadLocally = true,
    songBizId?: string,
  ): Promise<void> {
    const roomId = this.requireRoom();
    const session = this.session;
    const id = String(songId);
    if (!this.findSong(id)) await this.pushSong(id);
    this.assertSession(session);
    let song = this.findSong(id, songBizId);
    if (!song?.songBizId) {
      await this.runHeartbeat();
      this.assertSession(session);
      song = this.findSong(id, songBizId);
    }
    if (!song?.songBizId)
      throw new Error("房间尚未返回这首歌的队列编号，请稍后再试");
    const data = await this.api.operateSong(
      roomId,
      id,
      String(song.songBizId),
      4,
    );
    this.assertSession(session);
    if (data.roomSongInfo) this.updateRoomQueue(data.roomSongInfo, false);
    this.mutationRevision += 1;
    // 歌曲操作成功后，以请求的歌曲为目标；操作响应可能仍是切换前的快照。
    this.recordPlayed(id);
    const selected = this.findSong(id, songBizId) ?? song;
    if (selected)
      this.playlist = [
        selected,
        ...this.playlist.filter(
          (entry) => String(entry.songBizId) !== String(selected.songBizId),
        ),
      ];
    this.currentSongId = id;
    this.currentSongBizId = String(selected.songBizId);
    this.paused = false;
    this.pendingPlayback = {
      songId: id,
      position: 0,
      playing: true,
      at: this.timers.now(),
    };
    if (loadLocally) await this.loadTrack(id);
    this.assertSession(session);
    this.scheduleHeartbeat(1500);
  }

  async next(): Promise<void> {
    this.requireRoom();
    const session = this.session;
    const previousId = this.currentSongId;
    await this.runHeartbeat();
    this.assertSession(session);
    if (!this.inRoom || this.currentSongId !== previousId) return;
    const next = this.playlist[1];
    if (!next) {
      this.ctx.player.pause();
      return;
    }
    await this.goto(
      String(next.songId),
      true,
      next.songBizId === undefined ? undefined : String(next.songBizId),
    );
  }

  /** 本机暂停后先追上官方进度，再恢复声音。 */
  async resumePlayback(): Promise<void> {
    this.requireRoom();
    const session = this.session;
    this.paused = false;
    await this.runHeartbeat();
    this.assertSession(session);
    if (this.syncError) throw new Error(this.syncError);
    if (!this.pendingPlayback) this.ctx.player.play();
  }

  /** 自然播完只等待服务端推进时间线，不替所有人发“切歌”操作。 */
  onTrackEnded(): void {
    if (!this.inRoom) return;
    this.endedSongId = this.currentSongId;
    this.endedFastPolls = 5;
    this.scheduleHeartbeat(0);
  }

  /** 本机音源不可用时重试当前房间歌曲，不触发全房间切歌。 */
  onPlaybackFailed(): void {
    if (!this.inRoom || !this.currentSongId) return;
    this.pendingPlayback ??= {
      songId: this.currentSongId,
      position: 0,
      playing: true,
      at: this.timers.now(),
    };
    this.syncError = "当前歌曲暂时无法播放，正在重试；房间队列继续保留";
    this.scheduleHeartbeat(2_000);
  }

  async onLocalTrackChange(songId: string): Promise<void> {
    const id = String(songId);
    if (!this.running || !this.roomId || this.currentSongId === id) return;
    const session = this.session;
    try {
      await this.pushSong(id);
      this.assertSession(session);
      await this.goto(id, false);
    } catch (error) {
      this.ctx.log.warn(
        "[多人一起听] 同步本地切歌失败：",
        error instanceof Error ? error.message : error,
      );
    }
  }

  consumePendingPlayback(
    songId: string,
  ): { position: number; playing: boolean } | null {
    if (!this.pendingPlayback || this.pendingPlayback.songId !== String(songId))
      return null;
    const pending = this.pendingPlayback;
    this.pendingPlayback = null;
    this.loadAttempts = 0;
    this.syncError = "";
    return {
      position: pending.position + Math.max(0, this.timers.now() - pending.at),
      playing: pending.playing,
    };
  }

  private startRoom(
    roomId: string,
    inviterId: string,
    selfUserId: string,
    snapshot?: MultiRoomSnapshot,
  ): void {
    this.resetRoom();
    this.roomId = roomId;
    this.inviterId = inviterId;
    this.selfUserId = selfUserId;
    this.pinCounts.clear();
    this.pendingPinCounts.clear();
    this.historyCheckedAt = Number.NEGATIVE_INFINITY;
    this.memberCount = Math.max(
      1,
      Number(snapshot?.multiLtRoomUserAgg?.onlineNums ?? 1),
      snapshot?.multiLtRoomUserAgg?.onlineUserInfos?.length ?? 0,
    );
    this.members = (snapshot?.multiLtRoomUserAgg?.onlineUserInfos ?? [])
      .filter((user) => user.uid !== undefined || user.userId !== undefined)
      .map((user) => ({
        userId: String(user.uid ?? user.userId),
        nickname: user.nickname || `用户 ${user.uid ?? user.userId}`,
        avatarUrl: user.avatar ?? user.avatarUrl,
      }));
    this.running = true;
    this.paused = false;
    this.version = -1;
    this.backoff = 1;
    this.heartbeatMs = DEFAULT_HEARTBEAT_MS;
    this.endedSongId = null;
    this.endedFastPolls = 0;
  }

  private async resumeExistingRoom(
    selfUserId: string,
    expectedRoomId?: string,
  ): Promise<boolean> {
    let snapshot: MultiRoomSnapshot | undefined;
    try {
      snapshot = (await this.api.roomStatus()).multiLtRoomSnapshot;
    } catch (error) {
      this.ctx.log.warn(
        "[多人一起听] 查询已有房间失败：",
        error instanceof Error ? error.message : error,
      );
      return false;
    }
    const roomId = snapshot?.roomId ?? snapshot?.multiRoomInfoDTO?.roomId;
    if (
      !roomId ||
      (expectedRoomId && String(roomId) !== String(expectedRoomId))
    )
      return false;
    this.startRoom(String(roomId), selfUserId, selfUserId, snapshot);
    if (snapshot?.roomPlaySongInfo) {
      await this.applyRoomSongInfo(snapshot.roomPlaySongInfo, 0, true);
    }
    await this.runHeartbeat();
    this.ctx.log.info(`[多人一起听] 已恢复房间 ${roomId}`);
    return this.inRoom;
  }

  private assertRoomAccepted(
    data: {
      success?: boolean;
      failedMessage?: string;
      message?: string;
      failedType?: string;
      existRoomId?: string;
      multiLtRoomSnapshot?: MultiRoomSnapshot;
    },
    action: string,
  ): void {
    if (data.success !== false && data.multiLtRoomSnapshot) return;
    const message = data.failedMessage || data.message || data.failedType;
    const existing = data.existRoomId ? `（已有房间 ${data.existRoomId}）` : "";
    throw new Error(
      `${action}多人房间失败${message ? `：${message}` : ""}${existing}`,
    );
  }

  private scheduleHeartbeat(delay = this.heartbeatMs): void {
    if (!this.running) return;
    if (this.heartbeatHandle) this.timers.clearTimeout(this.heartbeatHandle);
    this.heartbeatHandle = this.timers.setTimeout(
      () => void this.runHeartbeat(),
      delay,
    );
  }

  private async runHeartbeat(): Promise<void> {
    if (this.heartbeatLoading) return this.heartbeatLoading;
    const task = this.performHeartbeat(true);
    this.heartbeatLoading = task;
    try {
      await task;
    } finally {
      if (this.heartbeatLoading === task) this.heartbeatLoading = null;
    }
  }

  private async performHeartbeat(reschedule: boolean): Promise<void> {
    if (!this.running || !this.roomId) return;
    const roomId = this.roomId;
    const session = this.session;
    const revision = this.mutationRevision;
    const readSequence = ++this.readSequence;
    const startedAt = this.timers.now();
    try {
      const data = await this.api.heartbeat(roomId);
      if (!this.running || session !== this.session) return;
      const endedAt = this.timers.now();
      this.lastSyncedAt = endedAt;
      if (!this.pendingPlayback) this.syncError = "";
      if (data.roomInfoDTO?.roomClosed) {
        this.resetRoom();
        this.ctx.log.warn("[多人一起听] 房间已结束");
        return;
      }
      this.heartbeatMs = nextHeartbeatDelay(data.heartBeatDuration);
      this.backoff = 1;
      if (
        data.roomPlaySongInfo &&
        revision === this.mutationRevision &&
        readSequence > this.appliedReadSequence
      ) {
        this.appliedReadSequence = readSequence;
        await this.applyRoomSongInfo(
          data.roomPlaySongInfo,
          Math.max(0, (endedAt - startedAt) / 2),
          false,
        );
      }
      // 成员和置顶数是附加信息，并行读取，避免互相拖慢下一次房间同步。
      if (session !== this.session) return;
      void this.refreshRoomState();
      void this.refreshPinCounts();
    } catch (error) {
      if (session !== this.session) return;
      this.syncError = "房间连接暂时中断，正在重试";
      if (error instanceof NeteaseApiError && error.code === "488") {
        this.resetRoom();
        this.ctx.log.warn("[多人一起听] 房间已失效，请重新创建或加入");
        return;
      }
      this.backoff = isRateLimited(error)
        ? Math.min(MAX_BACKOFF, this.backoff * 1.7)
        : this.backoff;
      this.ctx.log.warn(
        "[多人一起听] 心跳失败，将自动重试：",
        error instanceof Error ? error.message : error,
      );
    } finally {
      if (reschedule && this.running && session === this.session) {
        if (
          this.pendingPlayback ||
          (this.endedSongId === this.currentSongId && this.endedFastPolls > 0)
        ) {
          this.endedFastPolls -= 1;
          this.scheduleHeartbeat(2_000);
        } else {
          this.scheduleHeartbeat(
            nextHeartbeatDelay(this.heartbeatMs / 1000, this.backoff),
          );
        }
      }
    }
  }

  private async refreshRoomState(): Promise<void> {
    if (!this.inRoom) return;
    if (this.roomRefreshLoading) return this.roomRefreshLoading;
    if (this.timers.now() < this.roomRefreshAt) return;
    const roomId = this.roomId;
    const session = this.session;
    const revision = this.mutationRevision;
    const readSequence = ++this.readSequence;
    const startedAt = this.timers.now();
    this.roomRefreshAt = startedAt + ROOM_REFRESH_MS;
    const task = (async () => {
      try {
        const status = await this.api.roomStatus();
        if (!this.running || session !== this.session) return;
        const snapshot = status.multiLtRoomSnapshot;
        const statusRoomId =
          snapshot?.roomId ?? snapshot?.multiRoomInfoDTO?.roomId;
        if (!snapshot || String(statusRoomId) !== roomId) return;
        this.roomRefreshBackoff = ROOM_REFRESH_MS;
        if (snapshot.multiRoomInfoDTO?.roomClosed) {
          this.resetRoom();
          return;
        }
        if (
          snapshot.roomPlaySongInfo &&
          revision === this.mutationRevision &&
          readSequence > this.appliedReadSequence
        ) {
          this.appliedReadSequence = readSequence;
          this.lastSyncedAt = this.timers.now();
          await this.applyRoomSongInfo(
            snapshot.roomPlaySongInfo,
            (this.timers.now() - startedAt) / 2,
            false,
          );
        }
        if (session !== this.session || !snapshot.multiLtRoomUserAgg) return;
        const users = snapshot.multiLtRoomUserAgg.onlineUserInfos ?? [];
        this.memberCount = Math.max(
          1,
          Number(snapshot.multiLtRoomUserAgg.onlineNums ?? users.length),
          users.length,
        );
        this.members = users
          .filter((user) => user.uid !== undefined || user.userId !== undefined)
          .map((user) => ({
            userId: String(user.uid ?? user.userId),
            nickname: user.nickname || `用户 ${user.uid ?? user.userId}`,
            avatarUrl: user.avatar ?? user.avatarUrl,
          }));
      } catch (error) {
        if (session !== this.session) return;
        this.roomRefreshBackoff = Math.min(30_000, this.roomRefreshBackoff * 2);
        this.roomRefreshAt = this.timers.now() + this.roomRefreshBackoff;
        this.ctx.log.warn("[多人一起听] 快速刷新失败，已延后重试：", error);
      }
    })();
    this.roomRefreshLoading = task;
    try {
      await task;
    } finally {
      if (this.roomRefreshLoading === task) this.roomRefreshLoading = null;
    }
  }

  private async applyRoomSongInfo(
    info: MultiRoomSongInfo,
    halfRttMs: number,
    force: boolean,
  ): Promise<void> {
    const session = this.session;
    if (!this.updateRoomQueue(info, force)) return;
    const playSong = info.playSong;
    if (playSong?.songId === undefined) return;
    const targetId = String(playSong.songId);
    const targetBizId =
      playSong.songBizId === undefined ? null : String(playSong.songBizId);
    const expected = expectedMultiPosition(info.playedTime, halfRttMs);
    if (
      targetId !== this.currentSongId ||
      (targetBizId !== null && targetBizId !== this.currentSongBizId)
    ) {
      this.endedSongId = null;
      this.endedFastPolls = 0;
      this.recordPlayed(targetId);
      this.currentSongId = targetId;
      this.currentSongBizId = targetBizId;
      this.paused = false;
      this.pendingPlayback = {
        songId: targetId,
        position: expected,
        playing: true,
        at: this.timers.now(),
      };
      await this.loadTrack(targetId);
      return;
    }
    if (this.pendingPlayback?.songId === targetId) {
      // 新曲仍在加载时，只更新待应用的服务端进度，避免 seek 到上一首。
      this.pendingPlayback.position = expected;
      this.pendingPlayback.at = this.timers.now();
      if (!this.loadingSong && this.timers.now() >= this.loadRetryAt) {
        await this.loadTrack(targetId);
      }
      return;
    }
    if (this.paused && !force) return;
    const localPosition = await this.ctx.player.getPosition();
    if (session !== this.session || targetId !== this.currentSongId) return;
    if (force || info.forceSync || needsSeek(localPosition, expected)) {
      this.ctx.player.seek(Math.round(expected));
    }
  }

  /** 推歌和置顶只更新队列，不能把操作响应误当成切歌指令。 */
  private updateRoomQueue(info: MultiRoomSongInfo, force: boolean): boolean {
    const incomingVersion = Number(info.version ?? this.version);
    if (!force && incomingVersion >= 0 && incomingVersion < this.version)
      return false;
    if (incomingVersion >= 0) this.version = incomingVersion;
    const songs = [info.playSong, ...(info.nextSongs ?? [])].filter(
      (song): song is MultiSongInfo => song?.songId !== undefined,
    );
    if (songs.length) this.playlist = songs;
    return true;
  }

  private async loadTrack(songId: string): Promise<void> {
    if (this.loadingSong === songId) return;
    const session = this.session;
    this.loadingSong = songId;
    try {
      let track = this.songCache.get(songId);
      if (!track) {
        const [song] = await this.api.songDetail([songId]);
        if (!song) throw new Error("网易云未返回歌曲信息");
        track = toTogetherTrack(song);
      }
      if (
        !this.running ||
        session !== this.session ||
        this.currentSongId !== songId
      )
        return;
      this.cacheTrack(track);
      this.loadAttempts += 1;
      this.loadRetryAt =
        this.timers.now() + Math.min(30_000, 5_000 * this.loadAttempts);
      this.ctx.player.playTrack(track);
    } catch (error) {
      if (session !== this.session || this.currentSongId !== songId) return;
      this.loadAttempts += 1;
      this.loadRetryAt =
        this.timers.now() + Math.min(30_000, 2_000 * this.loadAttempts);
      this.syncError = "当前歌曲加载失败，正在重新连接房间播放";
      this.ctx.log.error(
        "[多人一起听] 加载歌曲失败：",
        error instanceof Error ? error.message : error,
      );
    } finally {
      if (session === this.session && this.loadingSong === songId)
        this.loadingSong = null;
    }
  }

  /** 推荐消息以 songBizId 对应待播实例；同一首歌重复推荐也不会混淆次数。 */
  private async refreshPinCounts(): Promise<void> {
    if (!this.roomId || !this.running) return;
    if (this.historyLoading) return this.historyLoading;
    if (this.timers.now() - this.historyCheckedAt < 4_000) return;
    const roomId = this.roomId;
    const session = this.session;
    this.historyCheckedAt = this.timers.now();
    this.historyLoading = (async () => {
      try {
        const history = await this.api.roomHistory(roomId);
        if (!this.running || session !== this.session) return;
        const records = [...(history.records ?? [])].sort(
          (a, b) => Number(a.sendTime ?? 0) - Number(b.sendTime ?? 0),
        );
        for (const record of records) {
          const resource = record.resourceInfo;
          if (resource?.bizId === undefined || resource.upCnt === undefined)
            continue;
          const count = Number(resource.upCnt);
          if (Number.isSafeInteger(count) && count >= 0) {
            const bizId = String(resource.bizId);
            const pending = this.pendingPinCounts.get(bizId);
            if (
              pending &&
              (count < pending.count || resource.uped === false) &&
              this.timers.now() < pending.until
            )
              continue;
            this.pendingPinCounts.delete(bizId);
            this.pinCounts.set(bizId, count);
            if (resource.uped === true) this.pinned.add(bizId);
            else if (resource.uped === false) this.pinned.delete(bizId);
          }
        }
        const activeIds = new Set(
          this.playlist.map((song) => String(song.songBizId)),
        );
        for (const id of this.pinCounts.keys()) {
          if (!activeIds.has(id)) {
            this.pinCounts.delete(id);
            this.pinned.delete(id);
            this.pendingPinCounts.delete(id);
          }
        }
      } catch (error) {
        this.ctx.log.warn(
          "[多人一起听] 读取置顶次数失败：",
          error instanceof Error ? error.message : error,
        );
      } finally {
        if (session === this.session) this.historyLoading = null;
      }
    })();
    return this.historyLoading;
  }

  private findSong(
    songId: string,
    songBizId?: string,
  ): MultiSongInfo | undefined {
    return this.playlist.find(
      (song) =>
        String(song.songId) === String(songId) &&
        (songBizId === undefined || String(song.songBizId) === songBizId),
    );
  }

  private assertSession(session: number): void {
    if (!this.inRoom || session !== this.session)
      throw new Error("房间已切换，此次操作已结束");
  }

  private recordPlayed(nextSongId: string): void {
    if (this.currentSongId && this.currentSongId !== nextSongId) {
      this.playedSongs.unshift(this.currentSongId);
      this.playedSongs = this.playedSongs.slice(0, 30);
    }
  }

  private requireRoom(): string {
    if (!this.running || !this.roomId)
      throw new Error("请先加入多人一起听房间");
    return this.roomId;
  }

  private async resolveSelfUserId(): Promise<string> {
    try {
      const response = await this.ctx.callNetease<{
        profile?: { userId?: string | number };
      }>("user_account", {});
      const userId = response.body?.profile?.userId;
      if (response.status !== 200 || !userId) throw new Error("未登录");
      return String(userId);
    } catch {
      throw new Error("请先在 SPlayer-Next 登录网易云账号");
    }
  }

  private resetRoom(): void {
    this.session += 1;
    this.historyLoading = null;
    this.metadataLoading = null;
    this.metadataCheckedAt = Number.NEGATIVE_INFINITY;
    this.heartbeatLoading = null;
    this.roomRefreshLoading = null;
    this.roomRefreshAt = 0;
    this.roomRefreshBackoff = ROOM_REFRESH_MS;
    this.appliedReadSequence = 0;
    this.loadingSong = null;
    this.loadRetryAt = 0;
    this.loadAttempts = 0;
    this.syncError = "";
    this.lastSyncedAt = 0;
    this.pinned.clear();
    this.pinning.clear();
    this.running = false;
    if (this.heartbeatHandle) this.timers.clearTimeout(this.heartbeatHandle);
    this.heartbeatHandle = null;
    this.roomId = null;
    this.inviterId = null;
    this.selfUserId = "";
    this.currentSongId = null;
    this.currentSongBizId = null;
    this.playlist = [];
    this.songCache.clear();
    this.pinCounts.clear();
    this.pendingPinCounts.clear();
    this.historyCheckedAt = Number.NEGATIVE_INFINITY;
    this.playedSongs = [];
    this.memberCount = 1;
    this.members = [];
    this.paused = false;
    this.version = -1;
    this.pendingPlayback = null;
    this.endedSongId = null;
    this.endedFastPolls = 0;
  }
}
