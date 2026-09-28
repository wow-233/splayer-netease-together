/**
 * @name        网易云多人一起听
 * @id          splayer.netease-together
 * @version     1.3.3
 * @description 使用网易云官方多人房间，与手机端和其他 SPlayer 同步播放、推歌与置顶
 * @author      Sisyphus
 * @type        control
 * @apiLevel    4
 * @grant       network control ui netease
 */

"use strict";
(() => {
  // src/neteaseApi.ts
  var NET = {
    create: "listentogether_multi_room_create",
    join: "listentogether_multi_match_ack",
    heartbeat: "listentogether_multi_heartbeat",
    leave: "listentogether_multi_match_exit",
    songOperate: "listentogether_multi_song_operate",
    status: "listentogether_multi_match_status_get",
    history: "listentogether_multi_match_msg_history",
    token: "listentogether_security_token",
    songDetail: "song_detail"
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
    if (!(err instanceof NeteaseApiError)) return false;
    return err.status === 429 || err.status === 400 || err.status === 403 || err.status >= 500 || err.code === "-460" || err.code === "460";
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
        const message = body?.message ?? body?.msg ?? "";
        throw new NeteaseApiError(
          message || `\u7F51\u6613\u4E91\u63A5\u53E3\u8FD4\u56DE ${code ?? res.status}`,
          String(code ?? res.status),
          res.status
        );
      }
      return res.body;
    };
    return {
      async securityToken() {
        const body = await call(NET.token);
        if (!body.token) throw new Error("\u65E0\u6CD5\u83B7\u53D6\u7F51\u6613\u4E91\u623F\u95F4\u6821\u9A8C token\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
        return body.token;
      },
      async createRoom(args) {
        const securityToken = await this.securityToken();
        const body = await call(
          NET.create,
          {
            type: 1,
            songId: args.songId,
            groupIds: [],
            inviteUids: [],
            from: "CREATE",
            playedTime: Math.max(0, Math.round(args.playedTime)),
            nextSongIds: args.nextSongIds ?? [],
            securityToken
          }
        );
        return body.data ?? {};
      },
      async joinRoom(roomId, inviterUid) {
        const securityToken = await this.securityToken();
        const body = await call(
          NET.join,
          {
            roomId,
            inviterUid,
            agree: true,
            securityToken
          }
        );
        return body.data ?? {};
      },
      async heartbeat(roomId) {
        const body = await call(
          NET.heartbeat,
          { roomId }
        );
        return body.data ?? {};
      },
      async roomStatus() {
        const body = await call(NET.status);
        return body.data ?? {};
      },
      async roomHistory(roomId) {
        const body = await call(
          NET.history,
          { roomId }
        );
        return body.data ?? { records: body.records };
      },
      async operateSong(roomId, songId, bizId, operate) {
        const securityToken = await this.securityToken();
        const body = await call(
          NET.songOperate,
          { roomId, songId, bizId, operate, securityToken }
        );
        const data = body.data ?? {};
        if (data.failedCode || data.failedMsg) {
          throw new Error(data.failedMsg || `\u6B4C\u66F2\u64CD\u4F5C\u5931\u8D25\uFF08${data.failedCode}\uFF09`);
        }
        return data;
      },
      async leaveRoom(roomId) {
        await call(NET.leave, { roomId, exitType: "NORMAL" });
      },
      async songDetail(ids) {
        const body = await call(NET.songDetail, {
          ids: ids.join(",")
        });
        return body.songs ?? [];
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
      artists: artists.map((artist) => ({
        id: artist.id !== void 0 ? String(artist.id) : void 0,
        name: artist.name
      })),
      album: album ? {
        id: album.id !== void 0 ? String(album.id) : void 0,
        name: album.name,
        cover: album.picUrl
      } : void 0,
      duration: Number(song.dt ?? song.duration ?? 0),
      cover: album?.picUrl
    };
  };

  // src/sync.ts
  var DEFAULT_HEARTBEAT_MS = 2e4;
  var MIN_HEARTBEAT_MS = 2e3;
  var MAX_HEARTBEAT_MS = 3e4;
  var SEEK_THRESHOLD_MS = 2e3;
  var MAX_BACKOFF = 4;
  var parseRoomLink = (input) => {
    const text = String(input ?? "").trim();
    if (!text) return { isMultiRoom: false };
    try {
      const candidate = text.match(/https?:\/\/[^\s<>\])]+/i)?.[0] ?? text;
      const url = new URL(
        candidate.replace(/\\([_&?=])/g, "$1").replace(/[。，,;；]+$/, "")
      );
      const roomId = url.searchParams.get("roomId") || void 0;
      const inviterId = url.searchParams.get("inviterUid") || url.searchParams.get("inviterId") || void 0;
      const songId = url.searchParams.get("songId") || void 0;
      return {
        ...roomId ? { roomId } : {},
        ...inviterId ? { inviterId } : {},
        ...songId ? { songId } : {},
        isMultiRoom: /\/listen-together\/multishare(?:\/|$)/i.test(url.pathname)
      };
    } catch {
      return { isMultiRoom: false };
    }
  };
  var buildMultiShareLink = (roomId, inviterUid, songId) => {
    const params = new URLSearchParams({ roomId, inviterUid });
    if (songId) params.set("songId", songId);
    return `https://st.music.163.com/listen-together/multishare/index.html?${params.toString()}`;
  };
  var needsSeek = (localPos, expectedPos) => Math.abs(localPos - expectedPos) > SEEK_THRESHOLD_MS;
  var expectedMultiPosition = (playedTime, halfRttMs) => Math.max(0, Number(playedTime ?? 0) + Math.max(0, halfRttMs));
  var nextHeartbeatDelay = (serverSeconds, backoff = 1) => {
    const serverMs = Number(serverSeconds) * 1e3;
    const base = Number.isFinite(serverMs) && serverMs > 0 ? serverMs : DEFAULT_HEARTBEAT_MS;
    return Math.round(
      Math.min(
        MAX_HEARTBEAT_MS,
        Math.max(MIN_HEARTBEAT_MS, base * Math.max(1, backoff))
      )
    );
  };
  var TogetherSyncEngine = class {
    api;
    ctx;
    timers;
    roomId = null;
    inviterId = null;
    selfUserId = "";
    currentSongId = null;
    playlist = [];
    songCache = /* @__PURE__ */ new Map();
    pinCounts = /* @__PURE__ */ new Map();
    historyCheckedAt = Number.NEGATIVE_INFINITY;
    historyLoading = null;
    playedSongs = [];
    memberCount = 1;
    members = [];
    paused = false;
    running = false;
    version = -1;
    heartbeatMs = DEFAULT_HEARTBEAT_MS;
    backoff = 1;
    heartbeatHandle = null;
    endedSongId = null;
    endedFastPolls = 0;
    pendingPlayback = null;
    constructor(opts) {
      this.ctx = opts.ctx;
      this.api = createNeteaseApi(opts.ctx);
      this.timers = opts.timers ?? {
        setTimeout: (cb, ms) => setTimeout(cb, ms),
        clearTimeout: (handle) => clearTimeout(handle),
        now: () => Date.now()
      };
    }
    async create(initialTrack) {
      if (this.running) throw new Error("\u5DF2\u5728\u591A\u4EBA\u4E00\u8D77\u542C\u623F\u95F4\u4E2D\uFF0C\u8BF7\u5148\u9000\u51FA");
      const selfUserId = await this.resolveSelfUserId();
      if (await this.resumeExistingRoom(selfUserId)) {
        return { roomId: this.roomId, creatorId: selfUserId, resumed: true };
      }
      if (!initialTrack?.id) throw new Error("\u8BF7\u5148\u64AD\u653E\u4E00\u9996\u7F51\u6613\u4E91\u5728\u7EBF\u6B4C\u66F2");
      const playedTime = await this.ctx.player.getPosition();
      const data = await this.api.createRoom({
        songId: String(initialTrack.id),
        playedTime,
        nextSongIds: []
      });
      if (data.failedType === "MULTI_ACK_ALREADY_IN_ROOM" || data.existRoomId) {
        if (await this.resumeExistingRoom(selfUserId, data.existRoomId)) {
          return { roomId: this.roomId, creatorId: selfUserId, resumed: true };
        }
        throw new Error(
          "\u7F51\u6613\u4E91\u8D26\u53F7\u5DF2\u5728\u5176\u4ED6\u591A\u4EBA\u623F\u95F4\uFF0C\u8BF7\u5148\u5728\u624B\u673A\u7AEF\u9000\u51FA\u8BE5\u623F\u95F4\u540E\u518D\u521B\u5EFA"
        );
      }
      this.assertRoomAccepted(data, "\u521B\u5EFA");
      const snapshot = data.multiLtRoomSnapshot;
      const roomId = snapshot?.roomId ?? snapshot?.multiRoomInfoDTO?.roomId;
      if (!roomId) throw new Error("\u521B\u5EFA\u591A\u4EBA\u623F\u95F4\u5931\u8D25\uFF1A\u670D\u52A1\u7AEF\u672A\u8FD4\u56DE\u623F\u95F4\u53F7");
      this.startRoom(String(roomId), selfUserId, selfUserId, snapshot);
      this.currentSongId = String(initialTrack.id);
      if (!this.playlist.length) this.playlist = [{ songId: initialTrack.id }];
      if (snapshot?.roomPlaySongInfo) {
        await this.applyRoomSongInfo(snapshot.roomPlaySongInfo, 0, true);
      }
      if (this.currentSongId === String(initialTrack.id)) this.ctx.player.play();
      this.scheduleHeartbeat(0);
      this.ctx.log.info(`[\u591A\u4EBA\u4E00\u8D77\u542C] \u5DF2\u521B\u5EFA\u623F\u95F4 ${roomId}`);
      return { roomId: String(roomId), creatorId: selfUserId, resumed: false };
    }
    async resume() {
      if (this.inRoom) return true;
      return this.resumeExistingRoom(await this.resolveSelfUserId());
    }
    async join(roomLink, inviterIdArg) {
      if (this.running) throw new Error("\u5DF2\u5728\u591A\u4EBA\u4E00\u8D77\u542C\u623F\u95F4\u4E2D\uFF0C\u8BF7\u5148\u9000\u51FA");
      const parsed = parseRoomLink(roomLink);
      if (!parsed.isMultiRoom) {
        throw new Error(
          "\u8FD9\u4E0D\u662F\u591A\u4EBA\u4E00\u8D77\u542C\u94FE\u63A5\uFF0C\u8BF7\u4F7F\u7528\u5305\u542B multishare \u7684\u5B98\u65B9\u591A\u4EBA\u9080\u8BF7\u94FE\u63A5"
        );
      }
      const roomId = parsed.roomId;
      const inviterId = inviterIdArg ?? parsed.inviterId;
      if (!roomId || !inviterId)
        throw new Error("\u9080\u8BF7\u94FE\u63A5\u7F3A\u5C11 roomId \u6216 inviterUid");
      const selfUserId = await this.resolveSelfUserId();
      const data = await this.api.joinRoom(roomId, inviterId);
      if (data.failedType === "MULTI_ACK_ALREADY_IN_ROOM" || data.existRoomId) {
        if (data.existRoomId && String(data.existRoomId) !== String(roomId)) {
          throw new Error(
            "\u7F51\u6613\u4E91\u8D26\u53F7\u4ECD\u5728\u53E6\u4E00\u4E2A\u591A\u4EBA\u623F\u95F4\uFF0C\u8BF7\u5148\u9000\u51FA\u539F\u623F\u95F4\u540E\u518D\u52A0\u5165\u9080\u8BF7\u623F\u95F4"
          );
        }
        if (await this.resumeExistingRoom(selfUserId, roomId)) return;
        throw new Error("\u7F51\u6613\u4E91\u8D26\u53F7\u5DF2\u5728\u5176\u4ED6\u591A\u4EBA\u623F\u95F4\uFF0C\u8BF7\u5148\u5728\u624B\u673A\u7AEF\u9000\u51FA\u540E\u518D\u52A0\u5165");
      }
      this.assertRoomAccepted(data, "\u52A0\u5165");
      const snapshot = data.multiLtRoomSnapshot;
      const acceptedRoomId = snapshot?.roomId ?? snapshot?.multiRoomInfoDTO?.roomId ?? roomId;
      this.startRoom(String(acceptedRoomId), selfUserId, selfUserId, snapshot);
      if (snapshot?.roomPlaySongInfo) {
        await this.applyRoomSongInfo(snapshot.roomPlaySongInfo, 0, true);
      }
      await this.runHeartbeat();
      this.ctx.log.info(`[\u591A\u4EBA\u4E00\u8D77\u542C] \u5DF2\u52A0\u5165\u623F\u95F4 ${acceptedRoomId}`);
    }
    async leave() {
      const roomId = this.roomId;
      this.resetRoom();
      if (!roomId) return;
      try {
        await this.api.leaveRoom(roomId);
      } catch (error) {
        this.ctx.log.warn(
          "[\u591A\u4EBA\u4E00\u8D77\u542C] \u9000\u51FA\u623F\u95F4\u8BF7\u6C42\u5931\u8D25\uFF1A",
          error instanceof Error ? error.message : error
        );
      }
    }
    get inRoom() {
      return this.running && this.roomId !== null;
    }
    get snapshot() {
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
        queue: this.playlist.map((song) => ({
          songId: String(song.songId),
          track: this.songCache.get(String(song.songId)),
          recommendedBy: song.songRcmdUid ? String(song.songRcmdUid) : void 0,
          pinCount: song.songBizId === void 0 ? void 0 : this.pinCounts.get(String(song.songBizId))
        })),
        played: this.playedSongs.map((songId) => ({
          songId,
          track: this.songCache.get(songId)
        }))
      };
    }
    async detailedSnapshot() {
      if (this.inRoom) void this.refreshPinCounts();
      const ids = [
        ...this.playlist.map((song) => String(song.songId)),
        ...this.playedSongs
      ];
      const missing = [...new Set(ids)].filter((id) => !this.songCache.has(id)).slice(0, 50);
      if (missing.length) {
        try {
          for (const song of await this.api.songDetail(missing)) {
            this.songCache.set(String(song.id), toTogetherTrack(song));
          }
          while (this.songCache.size > 100) {
            const oldest = this.songCache.keys().next().value;
            if (oldest === void 0) break;
            this.songCache.delete(oldest);
          }
        } catch (error) {
          this.ctx.log.warn("[\u591A\u4EBA\u4E00\u8D77\u542C] \u8BFB\u53D6\u623F\u95F4\u6B4C\u66F2\u4FE1\u606F\u5931\u8D25\uFF1A", error);
        }
      }
      return this.snapshot;
    }
    cacheTrack(track) {
      if (track.source === "netease") this.songCache.set(String(track.id), track);
    }
    onLocalEvent(kind, data) {
      if (!this.running || kind !== "playStateChange" || !data.state) return;
      this.paused = data.state !== "playing";
    }
    async pushSong(songId) {
      const roomId = this.requireRoom();
      const id = String(songId);
      if (this.findSong(id)) return;
      const data = await this.api.operateSong(roomId, id, "0", 1);
      if (data.roomSongInfo) {
        this.updateRoomQueue(data.roomSongInfo, false);
      }
      if (!this.findSong(id)) {
        this.playlist.push({
          songId: data.operateSongId ?? id,
          songBizId: data.operateSongBizId
        });
      }
      this.ctx.log.info(`[\u591A\u4EBA\u4E00\u8D77\u542C] \u5DF2\u63A8\u6B4C ${id}`);
      this.scheduleHeartbeat(1500);
    }
    async pinSong(songId) {
      const roomId = this.requireRoom();
      const id = String(songId);
      let song = this.findSong(id);
      if (!song?.songBizId) {
        await this.runHeartbeat(false);
        song = this.findSong(id);
      }
      if (!song) throw new Error("\u8FD9\u9996\u6B4C\u5C1A\u672A\u52A0\u5165\u591A\u4EBA\u623F\u95F4");
      if (!song.songBizId)
        throw new Error("\u623F\u95F4\u5C1A\u672A\u8FD4\u56DE\u8FD9\u9996\u6B4C\u7684\u961F\u5217\u7F16\u53F7\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5");
      const data = await this.api.operateSong(
        roomId,
        id,
        String(song.songBizId),
        2
      );
      if (data.roomSongInfo) this.updateRoomQueue(data.roomSongInfo, false);
      const bizId = String(song.songBizId);
      this.pinCounts.set(bizId, (this.pinCounts.get(bizId) ?? 0) + 1);
      this.historyCheckedAt = Number.NEGATIVE_INFINITY;
      void this.refreshPinCounts();
    }
    async goto(songId, loadLocally = true) {
      const roomId = this.requireRoom();
      const id = String(songId);
      if (!this.findSong(id)) await this.pushSong(id);
      let song = this.findSong(id);
      if (!song?.songBizId) {
        await this.runHeartbeat(false);
        song = this.findSong(id);
      }
      if (!song?.songBizId)
        throw new Error("\u623F\u95F4\u5C1A\u672A\u8FD4\u56DE\u8FD9\u9996\u6B4C\u7684\u961F\u5217\u7F16\u53F7\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5");
      const data = await this.api.operateSong(
        roomId,
        id,
        String(song.songBizId),
        4
      );
      if (data.roomSongInfo) this.updateRoomQueue(data.roomSongInfo, false);
      this.recordPlayed(id);
      const selected = this.findSong(id) ?? song;
      if (selected)
        this.playlist = [
          selected,
          ...this.playlist.filter((song2) => String(song2.songId) !== id)
        ];
      this.currentSongId = id;
      this.paused = false;
      this.pendingPlayback = {
        songId: id,
        position: 0,
        playing: true,
        at: this.timers.now()
      };
      if (loadLocally) await this.loadTrack(id);
      this.scheduleHeartbeat(1500);
    }
    async next() {
      this.requireRoom();
      const previousId = this.currentSongId;
      await this.runHeartbeat(false);
      if (!this.inRoom || this.currentSongId !== previousId) return;
      const next = this.playlist.find(
        (song) => String(song.songId) !== this.currentSongId
      );
      if (!next) {
        this.ctx.player.pause();
        return;
      }
      await this.goto(String(next.songId));
    }
    /** 自然播完只等待服务端推进时间线，不替所有人发“切歌”操作。 */
    onTrackEnded() {
      if (!this.inRoom) return;
      this.endedSongId = this.currentSongId;
      this.endedFastPolls = 5;
      this.scheduleHeartbeat(0);
    }
    async onLocalTrackChange(songId) {
      const id = String(songId);
      if (!this.running || !this.roomId || this.currentSongId === id) return;
      try {
        await this.pushSong(id);
        await this.goto(id, false);
      } catch (error) {
        this.ctx.log.warn(
          "[\u591A\u4EBA\u4E00\u8D77\u542C] \u540C\u6B65\u672C\u5730\u5207\u6B4C\u5931\u8D25\uFF1A",
          error instanceof Error ? error.message : error
        );
      }
    }
    consumePendingPlayback(songId) {
      if (!this.pendingPlayback || this.pendingPlayback.songId !== String(songId))
        return null;
      const pending = this.pendingPlayback;
      this.pendingPlayback = null;
      return {
        position: pending.position + Math.max(0, this.timers.now() - pending.at),
        playing: pending.playing
      };
    }
    startRoom(roomId, inviterId, selfUserId, snapshot) {
      this.roomId = roomId;
      this.inviterId = inviterId;
      this.selfUserId = selfUserId;
      this.pinCounts.clear();
      this.historyCheckedAt = Number.NEGATIVE_INFINITY;
      this.memberCount = Math.max(
        1,
        Number(snapshot?.multiLtRoomUserAgg?.onlineNums ?? 1),
        snapshot?.multiLtRoomUserAgg?.onlineUserInfos?.length ?? 0
      );
      this.members = (snapshot?.multiLtRoomUserAgg?.onlineUserInfos ?? []).filter((user) => user.uid !== void 0 || user.userId !== void 0).map((user) => ({
        userId: String(user.uid ?? user.userId),
        nickname: user.nickname || `\u7528\u6237 ${user.uid ?? user.userId}`,
        avatarUrl: user.avatar ?? user.avatarUrl
      }));
      this.running = true;
      this.paused = false;
      this.version = -1;
      this.backoff = 1;
      this.heartbeatMs = DEFAULT_HEARTBEAT_MS;
      this.endedSongId = null;
      this.endedFastPolls = 0;
    }
    async resumeExistingRoom(selfUserId, expectedRoomId) {
      let snapshot;
      try {
        snapshot = (await this.api.roomStatus()).multiLtRoomSnapshot;
      } catch (error) {
        this.ctx.log.warn(
          "[\u591A\u4EBA\u4E00\u8D77\u542C] \u67E5\u8BE2\u5DF2\u6709\u623F\u95F4\u5931\u8D25\uFF1A",
          error instanceof Error ? error.message : error
        );
        return false;
      }
      const roomId = snapshot?.roomId ?? snapshot?.multiRoomInfoDTO?.roomId;
      if (!roomId || expectedRoomId && String(roomId) !== String(expectedRoomId))
        return false;
      this.startRoom(String(roomId), selfUserId, selfUserId, snapshot);
      if (snapshot?.roomPlaySongInfo) {
        await this.applyRoomSongInfo(snapshot.roomPlaySongInfo, 0, true);
      }
      await this.runHeartbeat();
      this.ctx.log.info(`[\u591A\u4EBA\u4E00\u8D77\u542C] \u5DF2\u6062\u590D\u623F\u95F4 ${roomId}`);
      return this.inRoom;
    }
    assertRoomAccepted(data, action) {
      if (data.success !== false && data.multiLtRoomSnapshot) return;
      const message = data.failedMessage || data.message || data.failedType;
      const existing = data.existRoomId ? `\uFF08\u5DF2\u6709\u623F\u95F4 ${data.existRoomId}\uFF09` : "";
      throw new Error(
        `${action}\u591A\u4EBA\u623F\u95F4\u5931\u8D25${message ? `\uFF1A${message}` : ""}${existing}`
      );
    }
    scheduleHeartbeat(delay = this.heartbeatMs) {
      if (!this.running) return;
      if (this.heartbeatHandle) this.timers.clearTimeout(this.heartbeatHandle);
      this.heartbeatHandle = this.timers.setTimeout(
        () => void this.runHeartbeat(),
        delay
      );
    }
    async runHeartbeat(reschedule = true) {
      if (!this.running || !this.roomId) return;
      const roomId = this.roomId;
      const startedAt = this.timers.now();
      try {
        const data = await this.api.heartbeat(roomId);
        if (!this.running || this.roomId !== roomId) return;
        const endedAt = this.timers.now();
        if (data.roomInfoDTO?.roomClosed) {
          this.resetRoom();
          this.ctx.log.warn("[\u591A\u4EBA\u4E00\u8D77\u542C] \u623F\u95F4\u5DF2\u7ED3\u675F");
          return;
        }
        this.heartbeatMs = nextHeartbeatDelay(data.heartBeatDuration);
        this.backoff = 1;
        if (data.roomPlaySongInfo) {
          await this.applyRoomSongInfo(
            data.roomPlaySongInfo,
            Math.max(0, (endedAt - startedAt) / 2),
            false
          );
        }
        await Promise.all([this.refreshMembers(roomId), this.refreshPinCounts()]);
      } catch (error) {
        if (error instanceof NeteaseApiError && error.code === "488") {
          this.resetRoom();
          this.ctx.log.warn("[\u591A\u4EBA\u4E00\u8D77\u542C] \u623F\u95F4\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u521B\u5EFA\u6216\u52A0\u5165");
          return;
        }
        this.backoff = isRateLimited(error) ? Math.min(MAX_BACKOFF, this.backoff * 1.7) : this.backoff;
        this.ctx.log.warn(
          "[\u591A\u4EBA\u4E00\u8D77\u542C] \u5FC3\u8DF3\u5931\u8D25\uFF0C\u5C06\u81EA\u52A8\u91CD\u8BD5\uFF1A",
          error instanceof Error ? error.message : error
        );
      } finally {
        if (reschedule && this.running) {
          if (this.endedSongId === this.currentSongId && this.endedFastPolls > 0) {
            this.endedFastPolls -= 1;
            this.scheduleHeartbeat(2e3);
          } else {
            this.scheduleHeartbeat(
              nextHeartbeatDelay(this.heartbeatMs / 1e3, this.backoff)
            );
          }
        }
      }
    }
    async refreshMembers(roomId) {
      try {
        const status = await this.api.roomStatus();
        if (!this.running || this.roomId !== roomId) return;
        const snapshot = status.multiLtRoomSnapshot;
        const statusRoomId = snapshot?.roomId ?? snapshot?.multiRoomInfoDTO?.roomId;
        if (!snapshot?.multiLtRoomUserAgg || statusRoomId && statusRoomId !== roomId)
          return;
        const users = snapshot.multiLtRoomUserAgg.onlineUserInfos ?? [];
        this.memberCount = Math.max(
          1,
          Number(snapshot.multiLtRoomUserAgg.onlineNums ?? users.length),
          users.length
        );
        this.members = users.filter((user) => user.uid !== void 0 || user.userId !== void 0).map((user) => ({
          userId: String(user.uid ?? user.userId),
          nickname: user.nickname || `\u7528\u6237 ${user.uid ?? user.userId}`,
          avatarUrl: user.avatar ?? user.avatarUrl
        }));
      } catch {
      }
    }
    async applyRoomSongInfo(info, halfRttMs, force) {
      if (!this.updateRoomQueue(info, force)) return;
      const playSong = info.playSong;
      if (playSong?.songId === void 0) return;
      const targetId = String(playSong.songId);
      const expected = expectedMultiPosition(info.playedTime, halfRttMs);
      if (targetId !== this.currentSongId) {
        this.endedSongId = null;
        this.endedFastPolls = 0;
        this.recordPlayed(targetId);
        this.currentSongId = targetId;
        this.paused = false;
        this.pendingPlayback = {
          songId: targetId,
          position: expected,
          playing: true,
          at: this.timers.now()
        };
        await this.loadTrack(targetId);
        return;
      }
      if (this.pendingPlayback?.songId === targetId) {
        this.pendingPlayback.position = expected;
        this.pendingPlayback.at = this.timers.now();
        return;
      }
      if (this.paused && !force) return;
      const localPosition = await this.ctx.player.getPosition();
      if (force || info.forceSync || needsSeek(localPosition, expected)) {
        this.ctx.player.seek(Math.round(expected));
      }
    }
    /** 推歌和置顶只更新队列，不能把操作响应误当成切歌指令。 */
    updateRoomQueue(info, force) {
      const incomingVersion = Number(info.version ?? this.version);
      if (!force && incomingVersion >= 0 && incomingVersion < this.version)
        return false;
      if (incomingVersion >= 0) this.version = incomingVersion;
      const songs = [info.playSong, ...info.nextSongs ?? []].filter(
        (song) => song?.songId !== void 0
      );
      if (songs.length) this.playlist = songs;
      return true;
    }
    async loadTrack(songId) {
      try {
        const [song] = await this.api.songDetail([songId]);
        if (!song) throw new Error("\u7F51\u6613\u4E91\u672A\u8FD4\u56DE\u6B4C\u66F2\u4FE1\u606F");
        if (!this.running || this.currentSongId !== songId) return;
        this.ctx.player.playTrack(toTogetherTrack(song));
      } catch (error) {
        this.ctx.log.error(
          "[\u591A\u4EBA\u4E00\u8D77\u542C] \u52A0\u8F7D\u6B4C\u66F2\u5931\u8D25\uFF1A",
          error instanceof Error ? error.message : error
        );
      }
    }
    /** 推荐消息以 songBizId 对应待播实例；同一首歌重复推荐也不会混淆次数。 */
    async refreshPinCounts() {
      if (!this.roomId || !this.running) return;
      if (this.historyLoading) return this.historyLoading;
      if (this.timers.now() - this.historyCheckedAt < 1e4) return;
      const roomId = this.roomId;
      this.historyCheckedAt = this.timers.now();
      this.historyLoading = (async () => {
        try {
          const history = await this.api.roomHistory(roomId);
          if (!this.running || this.roomId !== roomId) return;
          const records = [...history.records ?? []].sort(
            (a, b) => Number(a.sendTime ?? 0) - Number(b.sendTime ?? 0)
          );
          for (const record of records) {
            const resource = record.resourceInfo;
            if (resource?.bizId === void 0 || resource.upCnt === void 0)
              continue;
            const count = Number(resource.upCnt);
            if (Number.isSafeInteger(count) && count >= 0) {
              this.pinCounts.set(String(resource.bizId), count);
            }
          }
        } catch (error) {
          this.ctx.log.warn(
            "[\u591A\u4EBA\u4E00\u8D77\u542C] \u8BFB\u53D6\u7F6E\u9876\u6B21\u6570\u5931\u8D25\uFF1A",
            error instanceof Error ? error.message : error
          );
        } finally {
          this.historyLoading = null;
        }
      })();
      return this.historyLoading;
    }
    findSong(songId) {
      return this.playlist.find((song) => String(song.songId) === String(songId));
    }
    recordPlayed(nextSongId) {
      if (this.currentSongId && this.currentSongId !== nextSongId) {
        this.playedSongs.unshift(this.currentSongId);
        this.playedSongs = this.playedSongs.slice(0, 30);
      }
    }
    requireRoom() {
      if (!this.running || !this.roomId)
        throw new Error("\u8BF7\u5148\u52A0\u5165\u591A\u4EBA\u4E00\u8D77\u542C\u623F\u95F4");
      return this.roomId;
    }
    async resolveSelfUserId() {
      try {
        const response = await this.ctx.callNetease("user_account", {});
        const userId = response.body?.profile?.userId;
        if (response.status !== 200 || !userId) throw new Error("\u672A\u767B\u5F55");
        return String(userId);
      } catch {
        throw new Error("\u8BF7\u5148\u5728 SPlayer-Next \u767B\u5F55\u7F51\u6613\u4E91\u8D26\u53F7");
      }
    }
    resetRoom() {
      this.running = false;
      if (this.heartbeatHandle) this.timers.clearTimeout(this.heartbeatHandle);
      this.heartbeatHandle = null;
      this.roomId = null;
      this.inviterId = null;
      this.selfUserId = "";
      this.currentSongId = null;
      this.playlist = [];
      this.songCache.clear();
      this.pinCounts.clear();
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
    create: "together-create",
    resume: "together-resume",
    join: "together-join",
    leave: "together-leave",
    push: "together-push",
    pin: "together-pin",
    goto: "together-goto",
    next: "together-next",
    ended: "together-ended"
  };
  var isNeteaseTrack = (track) => !!track && track.source === "netease" && !!track.id;
  ctx.register({
    events: ["trackChange", "playStateChange", "lineChange"],
    controls: true,
    settings: [
      {
        key: SETTING_ROOM_LINK,
        type: "text",
        label: "\u591A\u4EBA\u4E00\u8D77\u542C\u623F\u95F4\u94FE\u63A5",
        description: "\u7C98\u8D34\u7F51\u6613\u4E91\u5B98\u65B9\u591A\u4EBA\u4E00\u8D77\u542C\u94FE\u63A5\uFF08\u5730\u5740\u4E2D\u5305\u542B multishare\uFF09",
        default: "",
        placeholder: "https://st.music.163.com/listen-together/multishare/index.html?roomId=..&inviterUid=.."
      },
      {
        key: SETTING_AUTO_JOIN,
        type: "switch",
        label: "\u542F\u52A8\u540E\u81EA\u52A8\u52A0\u5165",
        description: "\u63D2\u4EF6\u542F\u7528\u65F6\uFF0C\u82E5\u5DF2\u914D\u7F6E\u591A\u4EBA\u623F\u95F4\u94FE\u63A5\u5219\u81EA\u52A8\u52A0\u5165",
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
      { id: MENU.push, label: "\u63A8\u6B4C\u5230\u591A\u4EBA\u623F\u95F4" },
      { id: MENU.pin, label: "\u5728\u591A\u4EBA\u623F\u95F4\u7F6E\u9876" },
      { id: MENU.goto, label: "\u8BA9\u591A\u4EBA\u623F\u95F4\u64AD\u653E" }
    ]
  });
  var joinFromSetting = async () => {
    const link = String(ctx.getSetting(SETTING_ROOM_LINK) ?? "").trim();
    if (!link) throw new Error("\u8BF7\u5148\u5728\u63D2\u4EF6\u8BBE\u7F6E\u91CC\u586B\u5199\u591A\u4EBA\u4E00\u8D77\u542C\u94FE\u63A5");
    await engine.join(link);
    return engine.inRoom ? "\u5DF2\u52A0\u5165\u591A\u4EBA\u4E00\u8D77\u542C" : "\u52A0\u5165\u5931\u8D25";
  };
  var localTrackId = null;
  ctx.player.on("playStateChange", (data) => {
    const payload = data;
    if (payload.state === "playing" && localTrackId) {
      const pending = engine.consumePendingPlayback(localTrackId);
      if (pending) {
        if (pending.position > 0) ctx.player.seek(Math.round(pending.position));
        if (!pending.playing) ctx.player.pause();
      }
    }
    engine.onLocalEvent("playStateChange", {
      state: payload.state,
      position: payload.position
    });
  });
  ctx.player.on("lineChange", (data) => {
    const payload = data;
    engine.onLocalEvent("lineChange", { position: payload.position });
  });
  ctx.player.on("trackChange", (data) => {
    const payload = data;
    localTrackId = payload.track ? String(payload.track.id) : null;
    if (isNeteaseTrack(payload.track))
      void engine.onLocalTrackChange(localTrackId);
  });
  ctx.onSettingChange(SETTING_ROOM_LINK, (value) => {
    if (!engine.inRoom) return;
    const parsed = parseRoomLink(String(value ?? ""));
    if (parsed.roomId) ctx.log.info(`[\u4E00\u8D77\u542C] \u623F\u95F4\u94FE\u63A5\u5DF2\u66F4\u65B0\uFF1A${parsed.roomId}`);
  });
  ctx.on("menuClick", async ({ menuId, track, data }) => {
    switch (menuId) {
      case "together-status":
        return { data: await engine.detailedSnapshot() };
      case MENU.create: {
        if (engine.inRoom) return { error: "\u5DF2\u5728\u623F\u95F4\u4E2D\uFF0C\u8BF7\u5148\u9000\u51FA\u4E00\u8D77\u542C" };
        try {
          const initialTrack = isNeteaseTrack(track) ? track : void 0;
          const { roomId, creatorId, resumed } = await engine.create(initialTrack);
          const link = buildMultiShareLink(
            roomId,
            creatorId,
            initialTrack ? String(initialTrack.id) : void 0
          );
          return {
            toast: resumed ? "\u5DF2\u6062\u590D\u73B0\u6709\u591A\u4EBA\u623F\u95F4\uFF0C\u9080\u8BF7\u94FE\u63A5\u5DF2\u590D\u5236" : "\u5DF2\u521B\u5EFA\u591A\u4EBA\u4E00\u8D77\u542C\u623F\u95F4\uFF0C\u9080\u8BF7\u94FE\u63A5\u5DF2\u590D\u5236",
            copyText: link,
            data: engine.snapshot
          };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }
      case MENU.resume: {
        try {
          const found = await engine.resume();
          if (!found) return { error: "\u5F53\u524D\u7F51\u6613\u4E91\u8D26\u53F7\u6CA1\u6709\u6B63\u5728\u8FDB\u884C\u7684\u591A\u4EBA\u623F\u95F4" };
          return { toast: "\u5DF2\u6062\u590D\u73B0\u6709\u591A\u4EBA\u623F\u95F4", data: engine.snapshot };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }
      case MENU.join: {
        if (engine.inRoom) return { error: "\u5DF2\u5728\u4E00\u8D77\u542C\u623F\u95F4\u4E2D" };
        if (joining) return { error: "\u6B63\u5728\u52A0\u5165\u2026" };
        joining = true;
        try {
          const directLink = typeof data === "object" && data !== null && "roomLink" in data ? String(data.roomLink ?? "").trim() : "";
          if (directLink) await engine.join(directLink);
          else await joinFromSetting();
          return { toast: "\u5DF2\u52A0\u5165\u591A\u4EBA\u4E00\u8D77\u542C", data: engine.snapshot };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        } finally {
          joining = false;
        }
      }
      case MENU.leave: {
        if (!engine.inRoom) return { error: "\u5F53\u524D\u672A\u5728\u623F\u95F4\u4E2D" };
        await engine.leave();
        return { toast: "\u5DF2\u9000\u51FA\u591A\u4EBA\u4E00\u8D77\u542C", data: engine.snapshot };
      }
      case MENU.push: {
        if (!engine.inRoom) return { error: "\u8BF7\u5148\u52A0\u5165\u4E00\u8D77\u542C" };
        if (!isNeteaseTrack(track)) return { error: "\u4EC5\u652F\u6301\u63A8\u7F51\u6613\u4E91\u5728\u7EBF\u6B4C\u66F2" };
        try {
          engine.cacheTrack(track);
          await engine.pushSong(String(track.id));
          if (ctx.getSetting(SETTING_PIN_AFTER_PUSH))
            await engine.pinSong(String(track.id));
          return { toast: `\u5DF2\u63A8\u6B4C\uFF1A${track.title}`, data: engine.snapshot };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }
      case MENU.pin: {
        if (!engine.inRoom) return { error: "\u8BF7\u5148\u52A0\u5165\u4E00\u8D77\u542C" };
        if (!isNeteaseTrack(track)) return { error: "\u4EC5\u652F\u6301\u7F6E\u9876\u7F51\u6613\u4E91\u5728\u7EBF\u6B4C\u66F2" };
        try {
          await engine.pinSong(String(track.id));
          return { toast: `\u5DF2\u7F6E\u9876\uFF1A${track.title}`, data: engine.snapshot };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }
      case MENU.goto: {
        if (!engine.inRoom) return { error: "\u8BF7\u5148\u52A0\u5165\u4E00\u8D77\u542C" };
        if (!isNeteaseTrack(track)) return { error: "\u4EC5\u652F\u6301\u64AD\u653E\u7F51\u6613\u4E91\u5728\u7EBF\u6B4C\u66F2" };
        try {
          await engine.goto(String(track.id));
          return { toast: `\u5DF2\u5207\u6B4C\uFF1A${track.title}`, data: engine.snapshot };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }
      case MENU.next: {
        if (!engine.inRoom) return { error: "\u8BF7\u5148\u52A0\u5165\u4E00\u8D77\u542C" };
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
  if (ctx.getSetting(SETTING_AUTO_JOIN)) {
    void joinFromSetting().catch((err) => {
      ctx.log.warn(
        "[\u4E00\u8D77\u542C] \u81EA\u52A8\u52A0\u5165\u5931\u8D25\uFF1A",
        err instanceof Error ? err.message : err
      );
    });
  }
  ctx.log.info("[\u591A\u4EBA\u4E00\u8D77\u542C] \u63D2\u4EF6\u5DF2\u5C31\u7EEA");
})();
