/**
 * @name        网易云一起听
 * @id          splayer.netease-together
 * @version     1.0.0
 * @description 加入网易云一起听房间，与手机/电脑用户同步播放，支持推歌与置顶
 * @author      Sisyphus
 * @type        control
 * @apiLevel    4
 * @grant       network control ui netease
 */

"use strict";
(() => {
  // src/neteaseApi.ts
  var NET = {
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
    search: "search"
  };
  var NeteaseApiError = class extends Error {
    code;
    status;
    constructor(message, code, status) {
      super(message);
      this.name = "NeteaseApiError";
      this.code = code;
      this.status = status;
    }
  };
  var isRateLimited = (err) => {
    if (err instanceof NeteaseApiError) {
      if (err.status === 429 || err.status >= 500) return true;
      if (err.status === 400 || err.status === 403) return true;
      return err.code === "-460" || err.code === "460";
    }
    return false;
  };
  var createNeteaseApi = (ctx2) => {
    const call = async (name, params = {}) => {
      let res;
      try {
        res = await ctx2.callNetease(name, params);
      } catch (err) {
        throw new NeteaseApiError(
          err instanceof Error ? err.message : String(err),
          "NETEASE_BRIDGE_ERROR",
          -1
        );
      }
      const body = res.body;
      const code = body?.code;
      if (res.status !== 200 || code !== void 0 && Number(code) !== 200) {
        const msg = body?.message ?? body?.msg ?? "";
        throw new NeteaseApiError(
          msg ? `netease ${code ?? res.status}: ${msg}` : `netease ${code ?? res.status}`,
          String(code ?? res.status),
          res.status
        );
      }
      return res.body;
    };
    return {
      /** 接受邀请加入房间（访客侧） */
      async accept(roomId, inviterId) {
        await call(NET.accept, { refer: "inbox_invite", roomId, inviterId });
      },
      /** 查询当前一起听状态（是否已在房间） */
      async status() {
        return call(NET.status, {});
      },
      /** 拉取房间播放状态与列表（同步核心数据源） */
      async getPlaylist(roomId) {
        const body = await call(NET.playlistGet, { roomId });
        return body.data;
      },
      /** 上报列表变更（推歌 / 置顶 / 替换 / 播放模式） */
      async reportList(roomId, param) {
        await call(NET.listCommand, {
          roomId,
          commandType: param.commandType,
          version: JSON.stringify(param.version),
          anchorSongId: param.anchorSongId ?? "",
          anchorPosition: param.anchorPosition ?? -1,
          randomList: (param.randomList ?? []).join(","),
          displayList: (param.displayList ?? []).join(",")
        });
      },
      /** 上报播放指令（切歌 / 播放 / 暂停） */
      async reportPlay(roomId, command) {
        await call(NET.playCommand, {
          roomId,
          commandType: command.commandType,
          progress: command.progress ?? 0,
          playStatus: command.playStatus ?? "",
          formerSongId: command.formerSongId ?? "",
          targetSongId: command.targetSongId ?? "",
          clientSeq: command.clientSeq ?? 0
        });
      },
      /** 心跳：每首歌开始/保活时上报当前播放进度 */
      async heartbeat(roomId, songId, playStatus, progress) {
        await call(NET.heartbeat, { roomId, songId, playStatus, progress });
      },
      /** 歌曲详情：把 songId 变成可交给宿主播放的 Track */
      async songDetail(ids) {
        const body = await call(NET.songDetail, { ids: ids.join(",") });
        return body.songs ?? [];
      },
      /** 搜索歌曲（推歌选曲用） */
      async search(keywords, limit = 20) {
        const body = await call(NET.search, {
          keywords,
          type: 1,
          limit
        });
        return body.result?.songs ?? [];
      },
      /** 尽力而为地创建房间（第三方客户端能力受限，可能失败） */
      async roomCreate() {
        const body = await call(
          NET.roomCreate,
          {}
        );
        return body.data?.roomInfo ?? {};
      },
      /** 检查房间是否可加入 */
      async roomCheck(roomId) {
        const body = await call(NET.roomCheck, {
          roomId
        });
        return body.data ?? {};
      },
      /** 结束/离开房间 */
      async end(roomId) {
        await call(NET.end, { roomId, shareInfo: "{}" });
      }
    };
  };
  var toTogetherTrack = (song) => {
    const artists = song.ar ?? song.artists ?? [];
    const album = song.al ?? song.album;
    return {
      id: String(song.id),
      source: "netease",
      title: song.name,
      artists: artists.map((a) => ({ id: a.id !== void 0 ? String(a.id) : void 0, name: a.name })),
      album: album ? { id: album.id !== void 0 ? String(album.id) : void 0, name: album.name, cover: album.picUrl } : void 0,
      duration: Number(song.dt ?? song.duration ?? 0),
      cover: album?.picUrl
    };
  };

  // src/sync.ts
  var POLL_PLAYING_MS = 1500;
  var POLL_PAUSED_MS = 5e3;
  var POLL_IDLE_MS = 1e4;
  var POLL_MAX_MS = 3e4;
  var SEEK_THRESHOLD_MS = 2e3;
  var ECHO_SUPPRESS_MS = 1200;
  var LOCAL_OVERRIDE_MS = 1500;
  var LOCAL_DEBOUNCE_MS = 400;
  var LOCAL_SAMPLE_MS = 3e3;
  var HEARTBEAT_PLAYING_MS = 3e4;
  var HEARTBEAT_PAUSED_MS = 12e4;
  var BACKOFF_FACTOR = 1.7;
  var bumpVersion = (versions, selfUserId) => {
    const out = versions.map((v) => ({ ...v }));
    const mine = out.find((v) => String(v.userId) === String(selfUserId));
    if (mine) mine.version = Number(mine.version) + 1;
    else out.push({ userId: String(selfUserId), version: 1 });
    return out;
  };
  var shouldApplyCloud = (args) => {
    if (args.cloudSeq > args.lastAppliedSeq) return true;
    if (args.now < args.overrideUntil && args.cloudSeq <= args.lastAppliedSeq) return false;
    return false;
  };
  var computeExpectedPosition = (args) => {
    const base = Number(args.command.progress ?? 0);
    const playing = args.command.playStatus === "PLAY";
    const elapsed = Math.max(0, args.now - args.appliedAt) + Math.max(0, args.halfRttMs);
    return playing ? base + elapsed : base;
  };
  var needsSeek = (localPos, expectedPos) => Math.abs(localPos - expectedPos) > SEEK_THRESHOLD_MS;
  var nextPollDelay = (args) => {
    const base = !args.inRoom ? POLL_IDLE_MS : args.paused ? POLL_PAUSED_MS : POLL_PLAYING_MS;
    const capped = Math.min(base * Math.max(1, args.backoff), POLL_MAX_MS);
    return Math.round(capped * args.jitter);
  };
  var parseRoomLink = (input) => {
    const text = String(input ?? "").trim();
    if (!text) return {};
    const match = text.match(/[?&]roomId=([^&]+)/i);
    const inviter = text.match(/[?&]inviterId=([^&]+)/i);
    const song = text.match(/[?&]songId=([^&]+)/i);
    const pick = (m) => m ? decodeURIComponent(m[1] ?? "") : void 0;
    const out = {};
    const roomId = pick(match);
    const inviterId = pick(inviter);
    const songId = pick(song);
    if (roomId) out.roomId = roomId;
    if (inviterId) out.inviterId = inviterId;
    if (songId) out.songId = songId;
    return out;
  };
  var displaySongIds = (state) => {
    const result = state.playlist?.displayList?.result ?? [];
    return result.map((item) => typeof item === "object" && item !== null ? item.songId : item).filter((v) => v !== void 0 && v !== null).map((v) => String(v));
  };
  var TogetherSyncEngine = class {
    api;
    ctx;
    timers;
    roomId = null;
    inviterId = null;
    selfUserId = "";
    lastAppliedSeq = -1;
    currentSongId = null;
    lastApplied = null;
    echoUntil = 0;
    overrideUntil = 0;
    paused = false;
    backoff = 1;
    pollHandle = null;
    heartbeatHandle = null;
    sampleHandle = null;
    reportHandle = null;
    pendingReport = null;
    lastSample = { pos: 0, at: 0, playing: false };
    pendingSeek = null;
    running = false;
    versions = [];
    playlist = [];
    constructor(opts) {
      this.ctx = opts.ctx;
      this.api = createNeteaseApi(opts.ctx);
      this.timers = opts.timers ?? {
        setTimeout: (cb, ms) => setTimeout(cb, ms),
        clearTimeout: (h) => clearTimeout(h),
        now: () => Date.now()
      };
    }
    /* ---------- 生命周期 ---------- */
    /** 解析房间链接并加入；成功后启动同步循环 */
    async join(roomLinkOrRoomId, inviterIdArg) {
      const parsed = parseRoomLink(roomLinkOrRoomId);
      const roomId = parsed.roomId ?? roomLinkOrRoomId.trim();
      const inviterId = inviterIdArg ?? parsed.inviterId;
      if (!roomId || !inviterId) throw new Error("\u623F\u95F4\u94FE\u63A5\u7F3A\u5C11 roomId \u6216 inviterId");
      await this.api.accept(roomId, inviterId);
      this.roomId = roomId;
      this.inviterId = inviterId;
      this.selfUserId = await this.resolveSelfUserId();
      this.running = true;
      this.backoff = 1;
      this.lastAppliedSeq = -1;
      this.ctx.log.info(`[\u4E00\u8D77\u542C] \u5DF2\u52A0\u5165\u623F\u95F4 ${roomId}`);
      await this.reconcile(true);
      this.schedulePoll();
      this.scheduleHeartbeat();
      this.scheduleSample();
    }
    /** 离开房间并停止所有计时器 */
    async leave() {
      this.running = false;
      this.clearTimers();
      if (this.roomId) {
        try {
          await this.api.end(this.roomId);
        } catch (err) {
          this.ctx.log.warn("[\u4E00\u8D77\u542C] \u79BB\u5F00\u623F\u95F4\u5931\u8D25\uFF1A", err instanceof Error ? err.message : err);
        }
      }
      this.roomId = null;
      this.currentSongId = null;
      this.lastAppliedSeq = -1;
      this.lastApplied = null;
    }
    get inRoom() {
      return this.running && this.roomId !== null;
    }
    /* ---------- 主循环 ---------- */
    schedulePoll() {
      if (!this.running) return;
      const delay = nextPollDelay({
        inRoom: this.roomId !== null,
        paused: this.paused,
        backoff: this.backoff,
        jitter: 0.8 + Math.random() * 0.4
      });
      this.pollHandle = this.timers.setTimeout(() => void this.tick(), delay);
    }
    async tick() {
      try {
        await this.reconcile(false);
        this.backoff = 1;
      } catch (err) {
        if (isRateLimited(err)) {
          this.backoff = Math.min(this.backoff * BACKOFF_FACTOR, POLL_MAX_MS / POLL_PLAYING_MS);
          this.ctx.log.warn("[\u4E00\u8D77\u542C] \u7591\u4F3C\u98CE\u63A7\uFF0C\u9000\u907F\u81F3 x" + this.backoff.toFixed(2));
        } else {
          this.ctx.log.warn("[\u4E00\u8D77\u542C] \u8F6E\u8BE2\u5931\u8D25\uFF1A", err instanceof Error ? err.message : err);
        }
      } finally {
        this.schedulePoll();
      }
    }
    /** 拉取房间状态并应用/纠偏（reconnect 时强制全量重算） */
    async reconcile(force) {
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
      if (String(cmd.targetSongId) === this.currentSongId && this.lastApplied) {
        await this.correctDrift(cmd, t1);
      }
    }
    /** 应用云端播放指令：切歌 / 定位 / 播放暂停 */
    applyCloudCommand(cmd, halfRtt, now) {
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
    async loadTrack(songId, playing) {
      try {
        const songs = await this.api.songDetail([songId]);
        const song = songs[0];
        if (!song) throw new Error("song_detail \u65E0\u7ED3\u679C");
        const track = toTogetherTrack(song);
        this.ctx.player.playTrack(track);
        if (playing) this.ctx.player.play();
        else this.ctx.player.pause();
      } catch (err) {
        this.ctx.log.error("[\u4E00\u8D77\u542C] \u52A0\u8F7D\u6B4C\u66F2\u5931\u8D25\uFF1A", err instanceof Error ? err.message : err);
      }
    }
    /** 定位本地播放器到目标位置并对齐播放态 */
    async alignLocal(expected, playing) {
      const pos = await this.ctx.player.getPosition();
      if (needsSeek(pos, expected)) {
        this.echoUntil = this.timers.now() + ECHO_SUPPRESS_MS;
        this.ctx.player.seek(Math.max(0, Math.round(expected)));
      }
      if (playing) this.ctx.player.play();
      else this.ctx.player.pause();
    }
    /** 同一首歌的漂移校正：以本地外推的期望位置为准，超过阈值才 seek */
    async correctDrift(cmd, now) {
      if (!this.lastApplied) return;
      const playing = cmd.playStatus === "PLAY" || this.lastApplied.playing;
      const expected = computeExpectedPosition({
        command: { progress: this.lastApplied.progress, playStatus: playing ? "PLAY" : "PAUSE" },
        appliedAt: this.lastApplied.at,
        now,
        halfRttMs: 0
      });
      const pos = await this.ctx.player.getPosition();
      if (needsSeek(pos, expected)) {
        this.echoUntil = now + ECHO_SUPPRESS_MS;
        this.ctx.player.seek(Math.max(0, Math.round(expected)));
      }
    }
    /* ---------- 本地事件 → 上报（防抖 + 回声抑制 + 乐观覆盖） ---------- */
    /** 由 index.ts 转发宿主播放事件 */
    onLocalEvent(kind, data) {
      if (!this.running || !this.roomId) return;
      const now = this.timers.now();
      if (kind === "playStateChange" && data.state) {
        this.paused = data.state !== "playing";
        if (now < this.echoUntil) return;
        if (data.state === "playing") this.scheduleReport({ commandType: "PLAY", progress: data.position });
        else if (data.state === "paused") this.scheduleReport({ commandType: "PAUSE", progress: data.position });
        return;
      }
      if (kind === "lineChange") {
        this.observeLocalPosition(data.position, now);
      }
    }
    /** 采样本地位置，检测用户拖动进度条并即时上报 */
    observeLocalPosition(pos, now) {
      const wasPlaying = this.lastSample.playing;
      const expected = this.lastSample.pos + (wasPlaying ? now - this.lastSample.at : 0);
      const jumped = this.lastSample.at > 0 && Math.abs(pos - expected) > SEEK_THRESHOLD_MS;
      this.lastSample = { pos, at: now, playing: !this.paused };
      if (now < this.echoUntil) return;
      if (jumped) {
        this.scheduleReport({
          commandType: "GOTO",
          progress: Math.max(0, Math.round(pos))
        });
      }
    }
    scheduleReport(report) {
      this.pendingReport = report;
      if (this.reportHandle) this.timers.clearTimeout(this.reportHandle);
      this.reportHandle = this.timers.setTimeout(() => void this.flushReport(), LOCAL_DEBOUNCE_MS);
    }
    /** 去抖后上报本地操作；上报后进入乐观覆盖窗口，本地状态暂时优先 */
    async flushReport() {
      const report = this.pendingReport;
      this.pendingReport = null;
      if (!report || !this.roomId) return;
      const now = this.timers.now();
      this.overrideUntil = now + LOCAL_OVERRIDE_MS;
      this.lastAppliedSeq = Math.max(this.lastAppliedSeq + 1, this.lastAppliedSeq);
      this.lastApplied = {
        progress: report.progress,
        playing: report.commandType !== "PAUSE",
        at: now
      };
      try {
        await this.api.reportPlay(this.roomId, {
          commandType: report.commandType,
          progress: Math.round(report.progress),
          playStatus: report.commandType === "PAUSE" ? "PAUSE" : "PLAY",
          formerSongId: this.currentSongId ?? "",
          targetSongId: this.currentSongId ?? "",
          clientSeq: this.lastAppliedSeq
        });
      } catch (err) {
        this.ctx.log.warn("[\u4E00\u8D77\u542C] \u4E0A\u62A5\u64AD\u653E\u72B6\u6001\u5931\u8D25\uFF1A", err instanceof Error ? err.message : err);
      }
    }
    /* ---------- 心跳 ---------- */
    scheduleHeartbeat() {
      if (!this.running) return;
      const delay = this.paused ? HEARTBEAT_PAUSED_MS : HEARTBEAT_PLAYING_MS;
      this.heartbeatHandle = this.timers.setTimeout(() => void this.beat(), delay);
    }
    async beat() {
      try {
        if (this.roomId && this.currentSongId) {
          const pos = await this.ctx.player.getPosition();
          await this.api.heartbeat(
            this.roomId,
            this.currentSongId,
            this.paused ? "PAUSE" : "PLAY",
            Math.max(0, Math.round(pos))
          );
        }
      } catch (err) {
        this.ctx.log.warn("[\u4E00\u8D77\u542C] \u5FC3\u8DF3\u5931\u8D25\uFF1A", err instanceof Error ? err.message : err);
      } finally {
        this.scheduleHeartbeat();
      }
    }
    /* ---------- 本地采样（检测用户拖动） ---------- */
    scheduleSample() {
      if (!this.running) return;
      this.sampleHandle = this.timers.setTimeout(() => void this.sample(), LOCAL_SAMPLE_MS);
    }
    async sample() {
      try {
        if (this.roomId && this.currentSongId) {
          const pos = await this.ctx.player.getPosition();
          this.observeLocalPosition(pos, this.timers.now());
        }
      } catch {
      } finally {
        this.scheduleSample();
      }
    }
    /* ---------- 队列：推歌 / 置顶 ---------- */
    /** 推歌：把歌曲加入房间展示列表（已存在则忽略） */
    async pushSong(songId) {
      if (!this.roomId) throw new Error("\u5C1A\u672A\u52A0\u5165\u623F\u95F4");
      const id = String(songId);
      if (this.playlist.includes(id)) return;
      const version = bumpVersion(this.versions, this.selfUserId);
      await this.api.reportList(this.roomId, {
        commandType: "ADD",
        version,
        anchorSongId: this.currentSongId ?? "",
        anchorPosition: this.playlist.length,
        randomList: [id],
        displayList: [id]
      });
      this.ctx.log.info(`[\u4E00\u8D77\u542C] \u5DF2\u63A8\u6B4C ${id}`);
    }
    /** 置顶：把歌曲移到展示列表最前（以 REPLACE 重排；需真机验证网易云是否接受） */
    async pinSong(songId) {
      if (!this.roomId) throw new Error("\u5C1A\u672A\u52A0\u5165\u623F\u95F4");
      const id = String(songId);
      const reordered = [id, ...this.playlist.filter((s) => s !== id)];
      const version = bumpVersion(this.versions, this.selfUserId);
      await this.api.reportList(this.roomId, {
        commandType: "REPLACE",
        version,
        anchorSongId: id,
        anchorPosition: 0,
        randomList: reordered,
        displayList: reordered
      });
      this.ctx.log.info(`[\u4E00\u8D77\u542C] \u5DF2\u7F6E\u9876 ${id}`);
    }
    /** 切到指定歌曲（本地立即播放 + 上报 GOTO） */
    async goto(songId) {
      if (!this.roomId) throw new Error("\u5C1A\u672A\u52A0\u5165\u623F\u95F4");
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
        clientSeq: this.lastAppliedSeq
      });
    }
    /* ---------- 工具 ---------- */
    async resolveSelfUserId() {
      try {
        const body = await this.ctx.callNetease("user_account", {});
        return String(body.body?.profile?.userId ?? "");
      } catch {
        return "";
      }
    }
    clearTimers() {
      for (const handle of [this.pollHandle, this.heartbeatHandle, this.sampleHandle, this.reportHandle]) {
        if (handle) this.timers.clearTimeout(handle);
      }
      this.pollHandle = this.heartbeatHandle = this.sampleHandle = this.reportHandle = null;
    }
    /** 应用待处理的定位（供 index.ts 在曲目就绪后调用） */
    consumePendingSeek(songId) {
      if (this.pendingSeek && this.pendingSeek.songId === songId) {
        const position = this.pendingSeek.position;
        this.pendingSeek = null;
        return position;
      }
      return null;
    }
  };

  // src/index.ts
  var createSplayerContext = (host) => ({
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
      on: (kind, handler) => host.player.on(kind, handler)
    },
    register: (args) => host.register(args),
    on: (action, handler) => host.on(action, handler),
    getSetting: (key) => host.getSetting(key),
    onSettingChange: (key, handler) => host.onSettingChange(key, handler),
    log: host.log
  });
  var SETTING_ROOM_LINK = "roomLink";
  var SETTING_AUTO_JOIN = "autoJoin";
  var SETTING_PIN_AFTER_PUSH = "pinAfterPush";
  var ctx = createSplayerContext(splayer);
  var engine = new TogetherSyncEngine({ ctx });
  var joining = false;
  var MENU = {
    join: "together-join",
    leave: "together-leave",
    push: "together-push",
    pin: "together-pin",
    goto: "together-goto"
  };
  var isNeteaseTrack = (track) => !!track && track.source === "netease" && !!track.id;
  ctx.register({
    events: ["trackChange", "playStateChange", "lineChange"],
    controls: true,
    settings: [
      {
        key: SETTING_ROOM_LINK,
        type: "text",
        label: "\u4E00\u8D77\u542C\u623F\u95F4\u94FE\u63A5",
        description: "\u7C98\u8D34\u7F51\u6613\u4E91\u4E00\u8D77\u542C\u5206\u4EAB\u94FE\u63A5\uFF08\u542B roomId \u4E0E inviterId\uFF09\uFF0C\u6216\u76F4\u63A5\u586B roomId",
        default: "",
        placeholder: "https://st.music.163.com/listen-together/share/?songId=..&roomId=..&inviterId=.."
      },
      {
        key: SETTING_AUTO_JOIN,
        type: "switch",
        label: "\u542F\u52A8\u540E\u81EA\u52A8\u52A0\u5165",
        description: "\u63D2\u4EF6\u542F\u7528\u65F6\uFF0C\u82E5\u5DF2\u914D\u7F6E\u623F\u95F4\u94FE\u63A5\u5219\u81EA\u52A8\u52A0\u5165",
        default: false
      },
      {
        key: SETTING_PIN_AFTER_PUSH,
        type: "switch",
        label: "\u63A8\u6B4C\u540E\u81EA\u52A8\u7F6E\u9876",
        description: "\u63A8\u6B4C\u6210\u529F\u540E\u7ACB\u5373\u628A\u8BE5\u6B4C\u66F2\u79FB\u5230\u623F\u95F4\u5217\u8868\u6700\u524D",
        default: false
      }
    ],
    menus: [
      { id: MENU.join, label: "\u52A0\u5165\u4E00\u8D77\u542C" },
      { id: MENU.leave, label: "\u9000\u51FA\u4E00\u8D77\u542C" },
      { id: MENU.push, label: "\u63A8\u6B4C\u5230\u4E00\u8D77\u542C" },
      { id: MENU.pin, label: "\u7F6E\u9876\u5230\u4E00\u8D77\u542C" },
      { id: MENU.goto, label: "\u7ACB\u5373\u64AD\u653E\uFF08\u4E00\u8D77\u542C\uFF09" }
    ]
  });
  var joinFromSetting = async () => {
    const link = String(ctx.getSetting(SETTING_ROOM_LINK) ?? "").trim();
    if (!link) throw new Error("\u8BF7\u5148\u5728\u63D2\u4EF6\u8BBE\u7F6E\u91CC\u586B\u5199\u4E00\u8D77\u542C\u623F\u95F4\u94FE\u63A5");
    await engine.join(link);
    return engine.inRoom ? "\u5DF2\u52A0\u5165\u4E00\u8D77\u542C" : "\u52A0\u5165\u5931\u8D25";
  };
  ctx.player.on("playStateChange", (data) => {
    const payload = data;
    engine.onLocalEvent("playStateChange", { state: payload.state, position: payload.position });
  });
  ctx.player.on("lineChange", (data) => {
    const payload = data;
    engine.onLocalEvent("lineChange", { position: payload.position });
  });
  ctx.player.on("trackChange", (data) => {
    const payload = data;
    if (!payload.track) return;
    const position = engine.consumePendingSeek(String(payload.track.id));
    if (position !== null && position > 0) ctx.player.seek(Math.max(0, Math.round(position)));
  });
  ctx.onSettingChange(SETTING_ROOM_LINK, (value) => {
    if (!engine.inRoom) return;
    const parsed = parseRoomLink(String(value ?? ""));
    if (parsed.roomId) ctx.log.info(`[\u4E00\u8D77\u542C] \u623F\u95F4\u94FE\u63A5\u5DF2\u66F4\u65B0\uFF1A${parsed.roomId}`);
  });
  ctx.on("menuClick", async ({ menuId, track }) => {
    switch (menuId) {
      case MENU.join: {
        if (engine.inRoom) return { toast: "\u5DF2\u5728\u4E00\u8D77\u542C\u623F\u95F4\u4E2D" };
        if (joining) return { toast: "\u6B63\u5728\u52A0\u5165\u2026" };
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
        if (!engine.inRoom) return { toast: "\u5F53\u524D\u672A\u5728\u623F\u95F4\u4E2D" };
        await engine.leave();
        return { toast: "\u5DF2\u9000\u51FA\u4E00\u542C" };
      }
      case MENU.push: {
        if (!engine.inRoom) return { toast: "\u8BF7\u5148\u52A0\u5165\u4E00\u8D77\u542C" };
        if (!isNeteaseTrack(track)) return { toast: "\u4EC5\u652F\u6301\u63A8\u7F51\u6613\u4E91\u5728\u7EBF\u6B4C\u66F2" };
        try {
          await engine.pushSong(String(track.id));
          if (ctx.getSetting(SETTING_PIN_AFTER_PUSH)) await engine.pinSong(String(track.id));
          return { toast: `\u5DF2\u63A8\u6B4C\uFF1A${track.title}` };
        } catch (err) {
          return { toast: err instanceof Error ? err.message : String(err) };
        }
      }
      case MENU.pin: {
        if (!engine.inRoom) return { toast: "\u8BF7\u5148\u52A0\u5165\u4E00\u8D77\u542C" };
        if (!isNeteaseTrack(track)) return { toast: "\u4EC5\u652F\u6301\u7F6E\u9876\u7F51\u6613\u4E91\u5728\u7EBF\u6B4C\u66F2" };
        try {
          await engine.pinSong(String(track.id));
          return { toast: `\u5DF2\u7F6E\u9876\uFF1A${track.title}` };
        } catch (err) {
          return { toast: err instanceof Error ? err.message : String(err) };
        }
      }
      case MENU.goto: {
        if (!engine.inRoom) return { toast: "\u8BF7\u5148\u52A0\u5165\u4E00\u8D77\u542C" };
        if (!isNeteaseTrack(track)) return { toast: "\u4EC5\u652F\u6301\u64AD\u653E\u7F51\u6613\u4E91\u5728\u7EBF\u6B4C\u66F2" };
        try {
          await engine.goto(String(track.id));
          return { toast: `\u5DF2\u5207\u6B4C\uFF1A${track.title}` };
        } catch (err) {
          return { toast: err instanceof Error ? err.message : String(err) };
        }
      }
      default:
        return;
    }
  });
  if (ctx.getSetting(SETTING_AUTO_JOIN)) {
    void joinFromSetting().catch((err) => {
      ctx.log.warn("[\u4E00\u8D77\u542C] \u81EA\u52A8\u52A0\u5165\u5931\u8D25\uFF1A", err instanceof Error ? err.message : err);
    });
  }
  ctx.log.info("[\u4E00\u8D77\u542C] \u63D2\u4EF6\u5DF2\u5C31\u7EEA");
})();
