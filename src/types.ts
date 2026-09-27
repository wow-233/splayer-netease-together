/**
 * 一起听协议与宿主上下文类型
 *
 * 该文件只定义类型，不产生运行时副作用，可被所有模块安全引用。
 * `splayerContext` 是插件对宿主注入能力的抽象；生产环境由沙箱全局 `splayer` 适配，
 * 单测中可注入假实现，因此同步引擎不直接依赖全局对象。
 */

/* ================= 宿主桥接（Host Bridge） ================= */

/** 宿主网络/网易云接口返回的统一结构，与主进程 callNetease 对齐 */
export interface NeteaseResult<T> {
  status: number;
  body: T;
}

/** 播放器控制面：与 SPlayer-Next PluginPlayerApi 对齐，新增 playTrack */
export interface SplayerPlayer {
  play(): void;
  pause(): void;
  next(): void;
  prev(): void;
  seek(positionMs: number): void;
  setVolume(volume: number): void;
  getPosition(): Promise<number>;
  /** 加载并播放指定曲目（宿主扩展能力） */
  playTrack(track: TogetherTrack): void;
  on<K extends PlaybackEventKind>(
    kind: K,
    handler: (data: PlaybackEventData[K]) => void,
  ): void;
}

export type PlaybackEventKind =
  | "trackChange"
  | "lyricChange"
  | "lineChange"
  | "playStateChange";

export interface PlaybackEventData {
  trackChange: { track: TogetherTrack | null };
  lyricChange: { lines: unknown[] };
  lineChange: { index: number; position: number };
  playStateChange: {
    state: "playing" | "paused" | "stopped";
    position: number;
  };
}

/** 插件声明的设置项（与宿主 PluginSettingItem 对齐的安全子集） */
export interface PluginSettingItem {
  key: string;
  type: "switch" | "number" | "text" | "select";
  label: string;
  description?: string;
  default: boolean | number | string;
  min?: number;
  max?: number;
  placeholder?: string;
  options?: { label: string; value: string }[];
}

/** 菜单项 */
export interface PluginMenuItem {
  id: string;
  label: string;
  sources?: string[];
}

/** 歌曲菜单点击入参 */
export interface MenuClickReq {
  menuId: string;
  track?: TogetherTrack;
  data?: unknown;
}

/** 菜单点击返回（宿主代为执行） */
export interface MenuClickRes {
  error?: string;
  toast?: string;
  openUrl?: string;
  copyText?: string;
  data?: unknown;
}

/**
 * 宿主注入能力的抽象。生产环境用 `createSplayerContext(splayer)` 适配沙箱全局。
 * 核心方法 `callNetease` 直连主进程 `callNetease(name, params)`（自动注入登录 Cookie）。
 */
export interface SplayerContext {
  readonly pluginId: string;
  readonly locale: string;
  readonly appVersion: string;

  /** 调用网易云接口（宿主桥接，自动带登录态 + 加密 + 系统代理） */
  callNetease<T = unknown>(
    name: string,
    params?: Record<string, unknown>,
  ): Promise<NeteaseResult<T>>;

  /** 播放器控制面 */
  player: SplayerPlayer;

  /** 声明能力 */
  register(args: {
    events?: PlaybackEventKind[];
    controls?: boolean;
    settings?: PluginSettingItem[];
    menus?: PluginMenuItem[];
  }): void;

  /** 注册动作处理器（menuClick） */
  on(
    action: "menuClick",
    handler: (req: MenuClickReq) => Promise<MenuClickRes | void>,
  ): void;

  /** 读取用户设置 */
  getSetting<T = unknown>(key: string): T | undefined;
  onSettingChange(key: string, handler: (value: unknown) => void): void;

  log: {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
}

/* ================= 曲目 ================= */

/** 插件构造并交给宿主加载的曲目（对齐 shared/types/player.ts 的 Track 关键字段） */
export interface TogetherTrack {
  id: string;
  source: "netease";
  title: string;
  artists: { id?: string; name: string }[];
  album?: { id?: string; name: string; cover?: string };
  duration: number;
  cover?: string;
  /** 标记来源，便于宿主/其它逻辑识别 */
  comment?: string;
}

/* ================= 一起听协议 ================= */

export type MultiSongOperate = 1 | 2 | 4;

/** 多人房间队列中的歌曲。songBizId 是置顶和切歌操作需要的队列实例 id。 */
export interface MultiSongInfo {
  songId: string | number;
  songBizId?: string | number;
  songRcmdUid?: string | number;
  rcmdType?: number;
  alg?: string;
}

/** multi 心跳返回的当前播放状态。多人房间由服务端时间线持续推进。 */
export interface MultiRoomSongInfo {
  playSong?: MultiSongInfo;
  nextSongs?: MultiSongInfo[];
  playedTime?: number;
  songDuration?: number;
  version?: number;
  forceSync?: boolean;
  waitSongCount?: number;
}

export interface MultiRoomUserList {
  onlineNums?: number;
  onlineUserInfos?: Array<{
    userId?: string | number;
    uid?: string | number;
    nickname?: string;
    avatarUrl?: string;
    avatar?: string;
  }>;
}

export interface MultiRoomInfoDto {
  roomId?: string;
  creatorId?: string | number;
  roomType?: string;
  roomBizType?: number;
  roomStatus?: number;
  roomClosed?: boolean;
}

/** multi/room/create 与 multi/match/ack 返回的官方房间快照。 */
export interface MultiRoomSnapshot {
  roomId?: string;
  multiRoomInfoDTO?: MultiRoomInfoDto;
  roomPlaySongInfo?: MultiRoomSongInfo;
  multiLtRoomUserAgg?: MultiRoomUserList;
}

export interface MultiRoomAckData {
  success?: boolean;
  failedType?: string;
  failedMessage?: string;
  message?: string;
  existRoomId?: string;
  multiLtRoomSnapshot?: MultiRoomSnapshot;
  nextAddSongDuration?: number;
}

export interface MultiHeartbeatData {
  roomPlaySongInfo?: MultiRoomSongInfo;
  roomInfoDTO?: MultiRoomInfoDto;
  heartBeatDuration?: number;
  nextAddSongDuration?: number;
  realOnlineTime?: number;
}

export interface MultiSongOperateData {
  failedMsg?: string;
  failedCode?: number;
  roomSongInfo?: MultiRoomSongInfo;
  operateSongId?: string | number;
  operateSongBizId?: string | number;
  nextAddSongDuration?: number;
}

/** 官方多人房间推荐消息内的歌曲置顶信息。 */
export interface MultiRoomMessageHistory {
  records?: Array<{
    sendTime?: number;
    resourceInfo?: {
      bizId?: string | number;
      resourceId?: string | number;
      upCnt?: number;
      uped?: boolean;
    };
  }>;
}

/** 网易云歌曲详情（song_detail 返回） */
export interface SongDetail {
  id: number | string;
  name: string;
  ar?: { id?: number | string; name: string }[];
  artists?: { id?: number | string; name: string }[];
  al?: { id?: number | string; name: string; picUrl?: string };
  album?: { id?: number | string; name: string; picUrl?: string };
  dt?: number;
  duration?: number;
}
