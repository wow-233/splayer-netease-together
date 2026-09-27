# splayer-netease-together

SPlayer-Next 的「网易云多人一起听」控制插件：让 Windows 桌面端创建或加入**官方多人房间**，与网易云手机端 / 其它 SPlayer 用户同步听歌，支持**推歌**、**置顶**和**全员切歌**。

房间使用网易云官方 `multi` 协议和 `multishare` 邀请链接，可以容纳多人。旧的“耳机分你一半”双人链接会被明确拒绝。

## 组成

| 部分                    | 位置                            | 说明                                                              |
| ----------------------- | ------------------------------- | ----------------------------------------------------------------- |
| 宿主扩展（Host Bridge） | [SPlayer-Next 一起听分支](https://github.com/wow-233/SPlayer-Next/tree/feat/netease-listen-together) | 给插件系统加 `player.playTrack`、`netease.call` 与 `netease` 权限 |
| 插件（本目录）          | `splayer-netease-together/`     | 一起听协议 + 同步引擎 + 交互                                      |

## 宿主扩展清单（已应用）

- `shared/types/plugin.ts`：`PLUGIN_GRANTS` 增加 `netease`；`HostCallMethod` 增加 `player.playTrack`、`netease.call`；`PluginPlayerApi.playTrack`；`HostApi.netease.call`。
- `shared/defaults/plugin-api.ts`：`HOST_API_LEVEL` 提升到 `4`。
- `electron/main/plugins/host.ts`：`netease.call` 权限门控 + 分发到 `callNetease`；`player.playTrack` 分发到 `playerControl.playTrack`。
- `electron/main/plugins/host.worker.ts`：沙箱暴露 `splayer.netease.call` 与 `splayer.player.playTrack`。
- `electron/main/apis/netease/modules/listentogether_*.ts`：多人建房、加入、心跳、成员状态、推荐记录、歌曲操作、退出及校验 token 接口，并在 `modules/index.ts` 注册、在 `index.ts` 标记为非缓存。
- `src/components/settings/custom/PluginDetailDialog.vue` + i18n：新增 `netease` 权限图标与文案。

## 构建

```bash
cd splayer-netease-together
npm install
npm run build      # 产出 dist/netease-listen-together.js
npm test           # 纯决策函数单测
npm run smoke      # 用 node:vm 模拟沙箱加载真实产物
```

## 安装

1. 先构建并运行已集成宿主扩展的 [SPlayer-Next 一起听分支](https://github.com/wow-233/SPlayer-Next/tree/feat/netease-listen-together)。
2. 在 **设置 → 插件管理 → 本地导入** 选择 `dist/netease-listen-together.js`。
3. 在插件卡片上确认已授予 `网易云 / 控制 / 联网 / 界面` 权限。

## 使用

1. 在 SPlayer 播放一首网易云在线歌曲，打开播放器工具栏或侧边栏的「多人一起听」页面。
2. 点击「创建或恢复房间」。若网易云账号已在官方房间，会先恢复；否则以当前歌曲建房并复制邀请链接。也可单独点击「恢复已有房间」。好友可用网易云手机端或装有本插件的 SPlayer 加入。
3. 加入好友房间时，可粘贴手机分享的完整文案或官方多人邀请链接。
4. 房间页显示当前歌曲、只读进度、歌词预览、实时成员、待播和本次会话的听过记录；输入歌名自动搜索，也可从普通歌曲列表直接推歌。待播歌曲显示官方推荐记录中的逐曲置顶次数。
5. 加入后插件按官方心跳持续同步当前歌曲、队列和播放进度；本地进度不可拖动。自然播完等待官方房间推进，手动切歌才发送房间操作。

## 四个核心约束的实现

| 约束          | 方案                                                                                                                                       | 位置                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 时钟同步/防抖 | 以多人心跳的 `roomPlaySongInfo.version` 防止旧状态覆盖，按 `playedTime + 半 RTT` 对齐，漂移超 2 秒才定位 | `sync.ts` `applyRoomSongInfo` / `expectedMultiPosition` / `needsSeek` |
| 风控/频率限制 | 使用服务端下发的 `heartBeatDuration`，失败时自适应退避，间隔限制在 2 到 30 秒 | `sync.ts` `nextHeartbeatDelay` / `runHeartbeat` |
| 桥接权限边界  | 沙箱全局 `splayer`（非 `window`）→ `hostCall` → `dispatchHostCall` 权限门控 → `callNetease`（自动注入登录 Cookie）                         | `host.ts` / `host.worker.ts` / `apis/netease/index.ts`                 |
| 断线重连补偿  | 心跳恢复后按房间当前歌曲、队列版本和服务端进度重新对齐 | `sync.ts` `runHeartbeat` / `applyRoomSongInfo` |

## 已知限制

- 桌面端通过 HTTP 心跳接收房间状态，没有接入网易云聊天室的即时消息通道；更新速度取决于服务端返回的心跳间隔。
- 在线人数及成员通过官方房间状态接口随心跳更新；暂时查询失败时保留上一份状态。
- 需要桌面端已登录网易云（插件通过宿主桥接复用登录态）。
- 官方手机端对自己推荐的待播歌曲提供删除。9.5.70 版 APK 将待播弹层交给在线加载的 `rn-tt-playlist` 页面，APK 内没有可确认的删除请求。桌面端暂不开放删除，避免只在本地隐藏、却仍由房间播放。
- 推荐记录缺失或请求失败时，置顶次数显示“—”；跨设备互通仍需两台已登录设备实际验证。
- 易盾校验 token 获取会对异常响应短暂重试。账号已有房间时先读取官方房间状态，避免重复建房报 `MULTI_ACK_ALREADY_IN_ROOM`。

## 许可

插件本体独立分发；宿主改动遵循 SPlayer-Next 的 AGPL-3.0。
