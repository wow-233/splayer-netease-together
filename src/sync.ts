/**
 * sync.ts — 一起听同步引擎
 *
 * 解决四类问题：
 * 1. 时钟同步与防抖动：以云端 clientSeq 为准（更大者胜），本地操作乐观覆盖；
 *    应用云端指令后进入「回声抑制窗口」，避免把云端刚下达的状态再报回去。
 * 2. 风控与频率限制：自适应退避轮询（非固定 3s），本地暂停时降低上报频率，
 *    心跳按需节流；命中风控时放大间隔。
 * 3. 权限边界：所有网易云调用经 splayerContext.callNetease（宿主桥接，自动带登录态）。
 * 4. 断线重连与状态补偿：重连后按 clientSeq/progress/playStatus 重算目标位置，
 *    半 RTT 补偿 + 本地外推，直接 seek 到目标而不是从 0 播放。
 *
 * 纯决策函数（bumpVersion / shouldApplyCloud / computeExpectedPosition /
 * nextPollDelay）不依赖计时器，可单测；计时循环见 TogetherSyncEngine。
 */

import { createNeteaseApi, isRateLimited, toTogetherTrack, type NeteaseApi } from "./neteaseApi";
import type {
  PlayCommand,
  PlayStatus,
  SplayerContext,
  TogetherTrack,
  VersionEntry,
} from "./types";

/* ================= 可调常量 ================= */

/** 播放中轮询间隔 */
const POLL_PLAYING_MS = 1500;
/** 本地暂停时轮询间隔（降低频率，规避风控） */
const POLL_PAUSED_MS = 5000;
/** 未在房间时轮询间隔 */
const POLL_IDLE_MS = 10000;
/** 轮询间隔上限（退避封顶） */
const POLL_MAX_MS = 30000;
/** 进度差超过该阈值才 seek，避免抖动 */
const SEEK_THRESHOLD_MS = 2000;
/** 应用云端指令后，此时长内的本地事件视为回声，不上报 */
const ECHO_SUPPRESS_MS = 1200;
/** 本地操作后的乐观覆盖窗口：期间忽略不更新的云端指令 */
const LOCAL_OVERRIDE_MS = 1500;
/** 本地上报去抖 */
const LOCAL_DEBOUNCE_MS = 400;
/** 本地位置采样间隔（检测用户拖动） */
const LOCAL_SAMPLE_MS = 3000;
/** 播放中心跳间隔 */
const HEARTBEAT_PLAYING_MS = 30000;
/** 暂停时心跳间隔（更长，降低频率） */
const HEARTBEAT_PAUSED_MS = 120000;
/** 风控退避放大系数 */
const BACKOFF_FACTOR = 1.7;

/* ================= 纯决策函数（可单测） ================= */

/**
 * 递增「发送方自己」的列表版本号；首次参与则新增一条 version=1。
 * 复用未递增的版本是两端列表不同步的最常见原因。
 */
export const bumpVersion = (versions: VersionEntry[], selfUserId: string): VersionEntry[] => {
  const out = versions.map((v) => ({ ...v }));
  const mine = out.find((v) => String(v.userId) === String(selfUserId));
  if (mine) mine.version = Number(mine.version) + 1;
  else out.push({ userId: String(selfUserId), version: 1 });
  return out;
};

/**
 * 是否应用云端指令：
 * - clientSeq 更大 → 应用（云端最新指令胜出）
 * - 本地乐观覆盖窗口内且 seq 未前进 → 暂不应用（本地操作平滑覆盖）
 * - 否则不应用
 */
export const shouldApplyCloud = (args: {
  cloudSeq: number;
  lastAppliedSeq: number;
  now: number;
  overrideUntil: number;
}): boolean => {
  if (args.cloudSeq > args.lastAppliedSeq) return true;
  if (args.now < args.overrideUntil && args.cloudSeq <= args.lastAppliedSeq) return false;
  return false;
};

/**
 * 计算云端指令对应的「当前应有位置」：
 * progress 是指令下达时刻的进度，需叠加指令到达后的播放时长；播放态才外推。
 * @param halfRttMs 请求往返的一半，用于抵消网络延迟
 */
export const computeExpectedPosition = (args: {
  command: Pick<PlayCommand, "progress" | "playStatus">;
  appliedAt: number;
  now: number;
  halfRttMs: number;
}): number => {
  const base = Number(args.command.progress ?? 0);
  const playing = args.command.playStatus === "PLAY";
  const elapsed = Math.max(0, args.now - args.appliedAt) + Math.max(0, args.halfRttMs);
  return playing ? base + elapsed : base;
};

/** 是否需要 seek：进度差超过阈值（避免频繁微调造成抖动） */
export const needsSeek = (localPos: number, expectedPos: number): boolean =>
  Math.abs(localPos - expectedPos) > SEEK_THRESHOLD_MS;

/** 计算下一次轮询延迟（含抖动），并在命中风控时退避放大 */
export const nextPollDelay = (args: {
  inRoom: boolean;
  paused: boolean;
  backoff: number;
  jitter: number;
}): number => {
  const base = !args.inRoom ? POLL_IDLE_MS : args.paused ? POLL_PAUSED_MS : POLL_PLAYING_MS;
  const capped = Math.min(base * Math.max(1, args.backoff), POLL_MAX_MS);
  return Math.round(capped * args.jitter);
};

/** 从分享链接解析 roomId / inviterId / songId */
export const parseRoomLink = (input: string): { roomId?: string; inviterId?: string; songId?: string } => {
  const text = String(input ?? "").trim();
  if (!text) return {};
  const match = text.match(/[?&]roomId=([^&]+)/i);
  const inviter = text.match(/[?&]inviterId=([^&]+)/i);
  const song = text.match(/[?&]songId=([^&]+)/i);
  const pick = (m: RegExpMatchArray | null): string | undefined =>
    m ? decodeURIComponent(m[1] ?? "") : undefined;
  const out: { roomId?: string; inviterId?: string; songId?: string } = {};
  const roomId = pick(match);
  const inviterId = pick(inviter);
  const songId = pick(song);
  if (roomId) out.roomId = roomId;
  if (inviterId) out.inviterId = inviterId;
  if (songId) out.songId = songId;
  return out;
};

/** 从播放列表取展示歌曲 id 数组 */
export const displaySongIds = (state: {
  playlist?: { displayList?: { result?: Array<{ songId: string | number } | string | number> } };
}): string[] => {
  const result = state.playlist?.displayList?.result ?? [];
  return result
    .map((item) => (typeof item === "object" && item !== null ? item.songId : item))
    .filter((v) => v !== undefined && v !== null)
    .map((v) => String(v));
};

/* ================= 同步引擎 ================= */

export interface SyncEngineOptions {
  ctx: SplayerContext;
  /** 轮询/心跳定时器（默认全局，测试可注入假实现） */
  timers?: {
    setTimeout: (cb: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
    now: () => number;
  };
}

interface PendingReport {
  commandType: "GOTO" | "PLAY" | "PAUSE";
  progress: number;
}

export class TogetherSyncEngine {
  private readonly api: NeteaseApi;
  private readonly ctx: SplayerContext;
  private readonly timers: NonNullable<SyncEngineOptions["timers"]>;

  private roomId: string | null = null;
  private inviterId: string | null = null;
  private selfUserId = "";

  private lastAppliedSeq = -1;
  private currentSongId: string | null = null;
  private lastApplied: { progress: number; playing: boolean; at: number } | null = null;

  private echoUntil = 0;
  private overrideUntil = 0;
  private paused = false;
  private backoff = 1;

  private pollHandle: unknown = null;
  private heartbeatHandle: unknown = null;
  private sampleHandle: unknown = null;
  private reportHandle: unknown = null;
  private pendingReport: PendingReport | null = null;

  private lastSample = { pos: 0, at: 0, playing: false };
  private pendingSeek: { songId: string; position: number } | null = null;

  private running = false;
  private versions: VersionEntry[] = [];
  private playlist: string[] = [];

  constructor(opts: SyncEngineOptions) {
    this.ctx = opts.ctx;
    this.api = createNeteaseApi(opts.ctx);
    this.timers =
      opts.timers ??
      ({
        setTimeout: (cb, ms) => setTimeout(cb, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        now: () => Date.now(),
      } as NonNullable<SyncEngineOptions["timers"]>);
  }

  /* ---------- 生命周期 ---------- */

  /** 解析房间链接并加入；成功后启动同步循环 */
  async join(roomLinkOrRoomId: string, inviterIdArg?: string): Promise<void> {
    const parsed = parseRoomLink(roomLinkOrRoomId);
    const roomId = parsed.roomId ?? roomLinkOrRoomId.trim();
    const inviterId = inviterIdArg ?? parsed.inviterId;
    if (!roomId || !inviterId) throw new Error("房间链接缺少 roomId 或 inviterId");

    await this.api.accept(roomId, inviterId);
    this.roomId = roomId;
    this.inviterId = inviterId;
    this.selfUserId = await this.resolveSelfUserId();
    this.running = true;
    this.backoff = 1;
    this.lastAppliedSeq = -1;
    this.ctx.log.info(`[一起听] 已加入房间 ${roomId}`);
    await this.reconcile(true);
    this.schedulePoll();
    this.scheduleHeartbeat();
    this.scheduleSample();
  }

  /** 离开房间并停止所有计时器 */
  async leave(): Promise<void> {
    this.running = false;
    this.clearTimers();
    if (this.roomId) {
      try {
        await this.api.end(this.roomId);
      } catch (err) {
        this.ctx.log.warn("[一起听] 离开房间失败：", err instanceof Error ? err.message : err);
      }
    }
    this.roomId = null;
    this.currentSongId = null;
    this.lastAppliedSeq = -1;
    this.lastApplied = null;
  }

  get inRoom(): boolean {
    return this.running && this.roomId !== null;
  }

  /* ---------- 主循环 ---------- */

  private schedulePoll(): void {
    if (!this.running) return;
    const delay = nextPollDelay({
      inRoom: this.roomId !== null,
      paused: this.paused,
      backoff: this.backoff,
      jitter: 0.8 + Math.random() * 0.4,
    });
    this.pollHandle = this.timers.setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    try {
      await this.reconcile(false);
      this.backoff = 1;
    } catch (err) {
      if (isRateLimited(err)) {
        this.backoff = Math.min(this.backoff * BACKOFF_FACTOR, POLL_MAX_MS / POLL_PLAYING_MS);
        this.ctx.log.warn("[一起听] 疑似风控，退避至 x" + this.backoff.toFixed(2));
      } else {
        this.ctx.log.warn("[一起听] 轮询失败：", err instanceof Error ? err.message : err);
      }
    } finally {
      this.schedulePoll();
    }
  }

  /** 拉取房间状态并应用/纠偏（reconnect 时强制全量重算） */
  async reconcile(force: boolean): Promise<void> {
    if (!this.roomId) return;
    const t0 = this.timers.now();
    const state = await this.api.getPlaylist(this.roomId);
    const t1 = this.timers.now();
    const halfRtt = Math.max(0, (t1 - t0) / 2);

    const cmd = state?.playCommand;
    if (!cmd) return;
    const cloudSeq = Number(cmd.clientSeq ?? 0);

    this.versions = state?.playlist?.version ?? [];
    this.playlist = displaySongIds(state ?? {});

    if (force || shouldApplyCloud({ cloudSeq, lastAppliedSeq: this.lastAppliedSeq, now: t1, overrideUntil: this.overrideUntil })) {
      this.lastAppliedSeq = cloudSeq;
      this.applyCloudCommand(cmd, halfRtt, t1);
      return;
    }

    // 同一首：仅做漂移校正（含重连后的补偿）
    if (String(cmd.targetSongId) === this.currentSongId && this.lastApplied) {
      await this.correctDrift(cmd, t1);
    }
  }

  /** 应用云端播放指令：切歌 / 定位 / 播放暂停 */
  private applyCloudCommand(cmd: PlayCommand, halfRtt: number, now: number): void {
    const targetId = String(cmd.targetSongId);
    const playing = cmd.playStatus === "PLAY";
    this.paused = !playing;
    this.echoUntil = now + ECHO_SUPPRESS_MS;

    if (targetId !== this.currentSongId) {
      this.currentSongId = targetId;
      this.lastApplied = { progress: Number(cmd.progress ?? 0), playing, at: now };
      this.pendingSeek = { songId: targetId, position: computeExpectedPosition({ command: cmd, appliedAt: now, now, halfRttMs: halfRtt }) };
      void this.loadTrack(targetId, playing);
    } else {
      this.lastApplied = { progress: Number(cmd.progress ?? 0), playing, at: now };
      void this.alignLocal(computeExpectedPosition({ command: cmd, appliedAt: now, now, halfRttMs: halfRtt }), playing);
    }
  }

  /** 加载歌曲并（尽量）定位到目标位置 */
  private async loadTrack(songId: string, playing: boolean): Promise<void> {
    try {
      const songs = await this.api.songDetail([songId]);
      const song = songs[0];
      if (!song) throw new Error("song_detail 无结果");
      const track: TogetherTrack = toTogetherTrack(song);
      this.ctx.player.playTrack(track);
      // 播放器加载是异步的；先乐观播放，位置交由 playStateChange/后续纠偏落地
      if (playing) this.ctx.player.play();
      else this.ctx.player.pause();
    } catch (err) {
      this.ctx.log.error("[一起听] 加载歌曲失败：", err instanceof Error ? err.message : err);
    }
  }

  /** 定位本地播放器到目标位置并对齐播放态 */
  private async alignLocal(expected: number, playing: boolean): Promise<void> {
    const pos = await this.ctx.player.getPosition();
    if (needsSeek(pos, expected)) {
      this.echoUntil = this.timers.now() + ECHO_SUPPRESS_MS;
      this.ctx.player.seek(Math.max(0, Math.round(expected)));
    }
    if (playing) this.ctx.player.play();
    else this.ctx.player.pause();
  }

  /** 同一首歌的漂移校正：以本地外推的期望位置为准，超过阈值才 seek */
  private async correctDrift(cmd: PlayCommand, now: number): Promise<void> {
    if (!this.lastApplied) return;
    const playing = cmd.playStatus === "PLAY" || this.lastApplied.playing;
    const expected = computeExpectedPosition({
      command: { progress: this.lastApplied.progress, playStatus: playing ? "PLAY" : "PAUSE" },
      appliedAt: this.lastApplied.at,
      now,
      halfRttMs: 0,
    });
    const pos = await this.ctx.player.getPosition();
    if (needsSeek(pos, expected)) {
      this.echoUntil = now + ECHO_SUPPRESS_MS;
      this.ctx.player.seek(Math.max(0, Math.round(expected)));
    }
  }

  /* ---------- 本地事件 → 上报（防抖 + 回声抑制 + 乐观覆盖） ---------- */

  /** 由 index.ts 转发宿主播放事件 */
  onLocalEvent(kind: "playStateChange" | "lineChange", data: { state?: string; position: number }): void {
    if (!this.running || !this.roomId) return;
    const now = this.timers.now();

    if (kind === "playStateChange" && data.state) {
      this.paused = data.state !== "playing";
      if (now < this.echoUntil) return; // 云端回声，不上报
      if (data.state === "playing") this.scheduleReport({ commandType: "PLAY", progress: data.position });
      else if (data.state === "paused") this.scheduleReport({ commandType: "PAUSE", progress: data.position });
      return;
    }

    if (kind === "lineChange") {
      this.observeLocalPosition(data.position, now);
    }
  }

  /** 采样本地位置，检测用户拖动进度条并即时上报 */
  private observeLocalPosition(pos: number, now: number): void {
    const wasPlaying = this.lastSample.playing;
    const expected = this.lastSample.pos + (wasPlaying ? now - this.lastSample.at : 0);
    const jumped = this.lastSample.at > 0 && Math.abs(pos - expected) > SEEK_THRESHOLD_MS;
    this.lastSample = { pos, at: now, playing: !this.paused };
    if (now < this.echoUntil) return;
    if (jumped) {
      this.scheduleReport({
        commandType: "GOTO",
        progress: Math.max(0, Math.round(pos)),
      });
    }
  }

  private scheduleReport(report: PendingReport): void {
    this.pendingReport = report;
    if (this.reportHandle) this.timers.clearTimeout(this.reportHandle);
    this.reportHandle = this.timers.setTimeout(() => void this.flushReport(), LOCAL_DEBOUNCE_MS);
  }

  /** 去抖后上报本地操作；上报后进入乐观覆盖窗口，本地状态暂时优先 */
  private async flushReport(): Promise<void> {
    const report = this.pendingReport;
    this.pendingReport = null;
    if (!report || !this.roomId) return;
    const now = this.timers.now();
    this.overrideUntil = now + LOCAL_OVERRIDE_MS;
    // 乐观推进本地序号，使云端回显的旧指令不覆盖本地
    this.lastAppliedSeq = Math.max(this.lastAppliedSeq + 1, this.lastAppliedSeq);
    this.lastApplied = {
      progress: report.progress,
      playing: report.commandType !== "PAUSE",
      at: now,
    };
    try {
      await this.api.reportPlay(this.roomId, {
        commandType: report.commandType,
        progress: Math.round(report.progress),
        playStatus: report.commandType === "PAUSE" ? "PAUSE" : "PLAY",
        formerSongId: this.currentSongId ?? "",
        targetSongId: this.currentSongId ?? "",
        clientSeq: this.lastAppliedSeq,
      });
    } catch (err) {
      this.ctx.log.warn("[一起听] 上报播放状态失败：", err instanceof Error ? err.message : err);
    }
  }

  /* ---------- 心跳 ---------- */

  private scheduleHeartbeat(): void {
    if (!this.running) return;
    const delay = this.paused ? HEARTBEAT_PAUSED_MS : HEARTBEAT_PLAYING_MS;
    this.heartbeatHandle = this.timers.setTimeout(() => void this.beat(), delay);
  }

  private async beat(): Promise<void> {
    try {
      if (this.roomId && this.currentSongId) {
        const pos = await this.ctx.player.getPosition();
        await this.api.heartbeat(
          this.roomId,
          this.currentSongId,
          this.paused ? "PAUSE" : "PLAY",
          Math.max(0, Math.round(pos)),
        );
      }
    } catch (err) {
      this.ctx.log.warn("[一起听] 心跳失败：", err instanceof Error ? err.message : err);
    } finally {
      this.scheduleHeartbeat();
    }
  }

  /* ---------- 本地采样（检测用户拖动） ---------- */

  private scheduleSample(): void {
    if (!this.running) return;
    this.sampleHandle = this.timers.setTimeout(() => void this.sample(), LOCAL_SAMPLE_MS);
  }

  private async sample(): Promise<void> {
    try {
      if (this.roomId && this.currentSongId) {
        const pos = await this.ctx.player.getPosition();
        this.observeLocalPosition(pos, this.timers.now());
      }
    } catch {
      /* 忽略采样失败 */
    } finally {
      this.scheduleSample();
    }
  }

  /* ---------- 队列：推歌 / 置顶 ---------- */

  /** 推歌：把歌曲加入房间展示列表（已存在则忽略） */
  async pushSong(songId: string): Promise<void> {
    if (!this.roomId) throw new Error("尚未加入房间");
    const id = String(songId);
    if (this.playlist.includes(id)) return;
    const version = bumpVersion(this.versions, this.selfUserId);
    await this.api.reportList(this.roomId, {
      commandType: "ADD",
      version,
      anchorSongId: this.currentSongId ?? "",
      anchorPosition: this.playlist.length,
      randomList: [id],
      displayList: [id],
    });
    this.ctx.log.info(`[一起听] 已推歌 ${id}`);
  }

  /** 置顶：把歌曲移到展示列表最前（以 REPLACE 重排；需真机验证网易云是否接受） */
  async pinSong(songId: string): Promise<void> {
    if (!this.roomId) throw new Error("尚未加入房间");
    const id = String(songId);
    const reordered = [id, ...this.playlist.filter((s) => s !== id)];
    const version = bumpVersion(this.versions, this.selfUserId);
    await this.api.reportList(this.roomId, {
      commandType: "REPLACE",
      version,
      anchorSongId: id,
      anchorPosition: 0,
      randomList: reordered,
      displayList: reordered,
    });
    this.ctx.log.info(`[一起听] 已置顶 ${id}`);
  }

  /** 切到指定歌曲（本地立即播放 + 上报 GOTO） */
  async goto(songId: string): Promise<void> {
    if (!this.roomId) throw new Error("尚未加入房间");
    const id = String(songId);
    const now = this.timers.now();
    this.currentSongId = id;
    this.overrideUntil = now + LOCAL_OVERRIDE_MS;
    this.lastAppliedSeq = this.lastAppliedSeq + 1;
    this.lastApplied = { progress: 0, playing: true, at: now };
    await this.loadTrack(id, true);
    await this.api.reportPlay(this.roomId, {
      commandType: "GOTO",
      progress: 0,
      playStatus: "PLAY",
      formerSongId: this.currentSongId,
      targetSongId: id,
      clientSeq: this.lastAppliedSeq,
    });
  }

  /* ---------- 工具 ---------- */

  private async resolveSelfUserId(): Promise<string> {
    try {
      const body = await this.ctx.callNetease<{ profile?: { userId?: number | string } }>("user_account", {});
      return String(body.body?.profile?.userId ?? "");
    } catch {
      return "";
    }
  }

  private clearTimers(): void {
    for (const handle of [this.pollHandle, this.heartbeatHandle, this.sampleHandle, this.reportHandle]) {
      if (handle) this.timers.clearTimeout(handle);
    }
    this.pollHandle = this.heartbeatHandle = this.sampleHandle = this.reportHandle = null;
  }

  /** 应用待处理的定位（供 index.ts 在曲目就绪后调用） */
  consumePendingSeek(songId: string): number | null {
    if (this.pendingSeek && this.pendingSeek.songId === songId) {
      const position = this.pendingSeek.position;
      this.pendingSeek = null;
      return position;
    }
    return null;
  }
}

export type { PlayStatus };
