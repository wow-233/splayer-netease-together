# splayer-netease-together

SPlayer-Next 的「网易云一起听」控制插件：让 Windows 桌面端加入**真实的一起听房间**，与手机 / 其它电脑用户同步听歌，支持**推歌**与**置顶**。

> 不是自建房间服务——房间是网易云官方的一起听房间，走官方分享链接加入，因此手机端与桌面端能在同一个房间里。

## 组成

| 部分                      | 位置                              | 说明                                                             |
| ------------------------- | --------------------------------- | ---------------------------------------------------------------- |
| 宿主扩展（Host Bridge）   | `SPlayer-Next/`（本仓库的补丁）   | 给插件系统加 `player.playTrack`、`netease.call` 与 `netease` 权限 |
| 插件（本目录）            | `splayer-netease-together/`       | 一起听协议 + 同步引擎 + 交互                                      |

## 宿主扩展清单（已应用）

- `shared/types/plugin.ts`：`PLUGIN_GRANTS` 增加 `netease`；`HostCallMethod` 增加 `player.playTrack`、`netease.call`；`PluginPlayerApi.playTrack`；`HostApi.netease.call`。
- `shared/defaults/plugin-api.ts`：`HOST_API_LEVEL` 提升到 `4`。
- `electron/main/plugins/host.ts`：`netease.call` 权限门控 + 分发到 `callNetease`；`player.playTrack` 分发到 `playerControl.playTrack`。
- `electron/main/plugins/host.worker.ts`：沙箱暴露 `splayer.netease.call` 与 `splayer.player.playTrack`。
- `electron/main/apis/netease/modules/listentogether_*.ts`：9 个一起听接口模块，并在 `modules/index.ts` 注册、在 `index.ts` 标记为非缓存。
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

1. 先应用上面的宿主扩展并重新构建 / 运行 SPlayer-Next。
2. 在 **设置 → 插件管理 → 本地导入** 选择 `dist/netease-listen-together.js`。
3. 在插件卡片上确认已授予 `网易云 / 控制 / 联网 / 界面` 权限。

## 使用

1. 手机端发起一起听，复制分享链接。
2. 在插件设置里把链接粘贴到「一起听房间链接」。
3. 右键任意歌曲 → 插件子菜单：
   - **加入一起听**：解析链接并加入房间（需要桌面端已登录网易云）。
   - **推歌到一起听**：把该歌曲加入房间列表。
   - **置顶到一起听**：把该歌曲移到房间列表最前。
   - **立即播放（一起听）**：立即切到该歌曲并同步给房间。
   - **退出一起听**：离开房间。
4. 加入后会自动同步房间当前歌曲与进度。

## 四个核心约束的实现

| 约束           | 方案                                                                                                                               | 位置                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 时钟同步/防抖  | 以云端 `clientSeq` 为准（更大者胜）；本地操作乐观覆盖（`overrideUntil`）；应用云端指令后进入回声抑制窗口（`echoUntil`）；漂移超 2s 才 seek | `sync.ts` `shouldApplyCloud` / `computeExpectedPosition` / `needsSeek` |
| 风控/频率限制  | 自适应退避轮询（播放 1.5s / 暂停 5s / 空闲 10s，命中风控 ×1.7 封顶 30s）；暂停时心跳降到 2 分钟；本地操作去抖 400ms 后一次性上报            | `sync.ts` `nextPollDelay` / `scheduleHeartbeat` / `scheduleReport` |
| 桥接权限边界   | 沙箱全局 `splayer`（非 `window`）→ `hostCall` → `dispatchHostCall` 权限门控 → `callNetease`（自动注入登录 Cookie）                    | `host.ts` / `host.worker.ts` / `apis/netease/index.ts`        |
| 断线重连补偿   | 重连后拉取 `playCommand`，按 `progress` + 半 RTT + 本地外推重算目标位置，直接 seek，而非从 0 播放                                    | `sync.ts` `reconcile` / `correctDrift` / `computeExpectedPosition` |

## 已知限制

- **第三方客户端只能作为「被邀请方」**。纯 HTTP 无法创建并维持一个可被加入的房主房间（需要官方客户端 CDP 或客户端内部 WS）。因此：手机建房 → 电脑用链接加入是可靠的；电脑主动建房为「尽力而为」，可能失败。
- **实时性来自轮询**（约 1.5s），不是官方客户端的长连接推送；进度偏差超过 2s 会被纠正。
- 置顶以 `REPLACE` 重排实现，具体是否被网易云接受需真机验证。
- 需要桌面端已登录网易云（插件通过宿主桥接复用登录态）。

## 许可

插件本体独立分发；宿主补丁遵循 SPlayer-Next 的 AGPL-3.0。
