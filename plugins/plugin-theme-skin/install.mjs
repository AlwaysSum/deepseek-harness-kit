// Bootstrap installer for @dsh-kit/plugin-theme-skin into a dsh profile.
//
// Usage:
//   node install.mjs                    # install into ~/.dsh/profiles/web
//   node install.mjs --home <dir>       # install into <dir>/profiles/web (DSH_HOME)
//   node install.mjs --uninstall        # remove the plugin (disable)
//
// It links the package into the profile's node_modules as a junction (so edits
// under plugins/plugin-theme-skin apply on the next dsh restart) and records it
// in the profile manifest (dependencies + dsh.profile.bundles), which is what
// makes the bundle's cordis.patch.yml mount at boot. Pass --uninstall to remove
// both.

import {
  existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here);
const NAME = "@dsh-kit/plugin-theme-skin";

function arg(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const home = resolve(arg("--home") ?? process.env.DSH_HOME ?? join(homedir(), ".dsh"));
const profileName = arg("--profile") ?? "web";
const profileDir = join(home, "profiles", profileName);
const linkDir = join(profileDir, "node_modules", "@dsh-kit");
const linkPath = join(linkDir, "plugin-theme-skin");
const manifestPath = join(profileDir, "package.json");

let manifest;
try {
  const raw = readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "");
  manifest = JSON.parse(raw);
} catch {
  console.error(`找不到 profile manifest：${manifestPath}（先运行一次 dsh 以初始化 profile）`);
  process.exit(1);
}

const uninstall = process.argv.includes("--uninstall");

if (uninstall) {
  // remove dependency + bundle entry
  if (manifest.dependencies) delete manifest.dependencies[NAME];
  if (manifest.dsh?.profile?.bundles) {
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((b) => b !== NAME);
  }
  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink() || stat.isDirectory()) rmSync(linkPath, { recursive: true, force: true });
  } catch {
    /* not present */
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`✓ 已卸载 ${NAME}（需重启 dsh 服务生效）`);
  process.exit(0);
}

// 1. junction link
mkdirSync(linkDir, { recursive: true });
try {
  const stat = lstatSync(linkPath);
  if (stat.isSymbolicLink() || stat.isDirectory()) rmSync(linkPath, { recursive: true, force: true });
} catch {
  /* not present */
}
try {
  symlinkSync(pkgDir, linkPath, "junction");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
console.log(`✓ 链接：${linkPath} -> ${pkgDir}`);

// 2. manifest update
manifest.dependencies ??= {};
manifest.dependencies[NAME] = "0.1.0";
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
manifest.dsh.profile.bundles ??= [];
if (!manifest.dsh.profile.bundles.includes(NAME)) {
  manifest.dsh.profile.bundles.push(NAME);
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`✓ manifest 已更新：${manifestPath}`);
console.log(`   bundles = ${JSON.stringify(manifest.dsh.profile.bundles)}`);
console.log("重新启动 dsh 服务后，主题换肤生效（设置 → 主题换肤）。");
