/**
 * build.mjs — 打包插件为单个 IIFE 脚本，并保留 JSDoc manifest 头部。
 *
 * 宿主从脚本第一个块注释解析 @name/@id/@type/@grant/@apiLevel，
 * 因此头部必须原样出现在产物最前面（用 esbuild banner 注入）。
 * 产物必须是 IIFE：沙箱 node:vm 里没有 require/module/exports。
 */

import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const banner = readFileSync(resolve(root, "src", "header.js"), "utf-8");

await build({
  entryPoints: [resolve(root, "src", "index.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  banner: { js: banner },
  outfile: resolve(root, "dist", "netease-listen-together.js"),
  logLevel: "info",
});
