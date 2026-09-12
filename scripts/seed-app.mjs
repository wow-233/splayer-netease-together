// seed-app.mjs — 把构建产物安装到 SPlayer-Next 的插件目录（等价于应用内「本地导入」）
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

const pluginSrc = process.argv[2];
const pluginsDir = path.join(os.homedir(), "AppData", "Roaming", "SPlayer-Next", "app-data", "plugins");
const scriptsDir = path.join(pluginsDir, "scripts");
fs.mkdirSync(scriptsDir, { recursive: true });

const fileName = "splayer.netease-together.js";
const dst = path.join(scriptsDir, fileName);
fs.copyFileSync(pluginSrc, dst);

const source = fs.readFileSync(dst, "utf8");
const hash = crypto.createHash("sha1").update(source).digest("hex");
const id = "splayer.netease-together";

const manifest = {
  version: 1,
  plugins: {
    [id]: {
      id,
      name: "网易云一起听",
      version: "1.0.1",
      description: "加入网易云一起听房间，与手机/电脑用户同步播放，支持推歌与置顶",
      author: "Sisyphus",
      homepage: "",
      grant: ["network", "control", "ui", "netease"],
      type: "control",
      apiLevel: 4,
      hash,
      installedAt: Date.now(),
      fileName,
    },
  },
};

fs.writeFileSync(path.join(pluginsDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
console.log("seeded:", id, "hash:", hash, "->", dst);
