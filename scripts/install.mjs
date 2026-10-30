/**
 * 按 bundle 常见的接法把本插件装进 DSH profile：把包复制到 profile 的
 * `node_modules`，并登记进 `dsh.profile.bundles`，这样下次启动时它的
 * bundle 补丁就会被应用。
 *
 * profile 清单里只动 `bundles` 数组 —— 不添加依赖条目，pnpm 的 lockfile
 * 因此保持有效，profile 也不会被重新向 registry 解析。这让本脚本成为离线
 * 路径；DSH 插件面板（npm / git / 本地目录）则是在线路径。
 *
 * 用法：
 *   node scripts/install.mjs                 # 自动识别唯一的 profile
 *   node scripts/install.mjs --list          # 列出找到的 profile
 *   node scripts/install.mjs --profile <dir> # 指定 profile 目录
 *   node scripts/install.mjs --dry-run       # 只报告，不改动
 *   node scripts/install.mjs --uninstall     # 再卸载掉
 *
 * 也可以从 `DSH_PROFILE_DIR` 取 profile，或从 `DSH_PROFILE`
 * （`$DSH_HOME/profiles` 下的 profile 名）取。
 *
 * @module dsh-model-avail/scripts/install
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE = 'dsh-model-avail'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FILES = ['lib', 'package.json', 'cordis.patch.yml', 'README.md', 'LICENSE']

/** 用一行可操作的提示终止。 */
function die(message) {
  console.error(`install: ${message}`)
  process.exit(1)
}

/** `$DSH_HOME`，默认 `~/.dsh`。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv !== undefined && fromEnv !== '' ? resolve(fromEnv) : join(homedir(), '.dsh')
}

/** profile 目录就是那个带有 `dsh.profile` 段落的 `package.json` 的目录。 */
function isProfile(dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return typeof manifest?.dsh?.profile === 'object' && manifest.dsh.profile !== null
  } catch {
    return false
  }
}

/** `$DSH_HOME/profiles` 下的所有 profile 目录，按名字排序。 */
function discoverProfiles() {
  const root = join(dshHome(), 'profiles')
  if (!existsSync(root)) return []
  return readdirSync(root)
    .map((name) => join(root, name))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory() && isProfile(dir)
      } catch {
        return false
      }
    })
    .sort()
}

/** 从命令行或环境变量读出 profile 目录。 */
function resolveProfile(argv) {
  const index = argv.indexOf('--profile')
  if (index >= 0) {
    const value = argv[index + 1]
    if (typeof value !== 'string' || value === '') die('--profile needs a directory')
    const dir = resolve(value)
    if (!existsSync(join(dir, 'package.json'))) die(`no package.json in ${dir}`)
    return dir
  }

  const fromEnvDir = process.env.DSH_PROFILE_DIR
  if (fromEnvDir !== undefined && fromEnvDir !== '') return resolve(fromEnvDir)

  const name = process.env.DSH_PROFILE
  if (name !== undefined && name !== '') {
    const dir = join(dshHome(), 'profiles', name)
    if (!existsSync(join(dir, 'package.json'))) die(`no profile named ${JSON.stringify(name)} under ${join(dshHome(), 'profiles')}`)
    return dir
  }

  const found = discoverProfiles()
  if (found.length === 1) return found[0]
  if (found.length === 0) die(`no DSH profile found under ${join(dshHome(), 'profiles')}; pass --profile <dir>`)
  die(`several DSH profiles found — pass --profile <dir>:\n  ${found.map((dir) => `${join(dir, 'package.json')}`).join('\n  ')}`)
}

/** 读取 profile 清单。 */
function readManifest(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    die(`cannot read ${file}: ${error.message}`)
  }
}

/** 以两空格缩进写回 profile 清单，和原始格式保持一致。 */
function writeManifest(file, manifest) {
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/** 确保 `name` 列在 `dsh.profile.bundles` 里，并保留既有顺序。 */
function registerBundle(manifest, name) {
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  if (bundles.includes(name)) return { manifest, changed: false }
  manifest.dsh.profile.bundles = [...bundles, name]
  return { manifest, changed: true }
}

/** 从 `dsh.profile.bundles` 里去掉 `name`。 */
function unregisterBundle(manifest, name) {
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.includes(name)) return { manifest, changed: false }
  manifest.dsh.profile.bundles = bundles.filter((entry) => entry !== name)
  return { manifest, changed: true }
}

/** 把包文件复制到 `<profile>/node_modules/<name>`。 */
function installFiles(profile) {
  const target = join(profile, 'node_modules', PACKAGE)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  for (const entry of FILES) {
    const from = join(ROOT, entry)
    if (!existsSync(from)) continue
    cpSync(from, join(target, entry), { recursive: true })
  }
  return target
}

function main() {
  const argv = process.argv.slice(2)

  if (argv.includes('--list')) {
    const found = discoverProfiles()
    console.log(`DSH home: ${dshHome()}`)
    if (found.length === 0) console.log('no profiles found')
    for (const dir of found) console.log(`  ${dir}`)
    return
  }

  const dryRun = argv.includes('--dry-run')
  const uninstall = argv.includes('--uninstall')
  const profile = resolveProfile(argv)
  const manifestFile = join(profile, 'package.json')
  const before = readManifest(manifestFile)
  const { manifest, changed } = uninstall
    ? unregisterBundle(before, PACKAGE)
    : registerBundle(before, PACKAGE)

  if (dryRun) {
    console.log(`profile: ${profile}`)
    console.log(`bundles change: ${changed ? 'yes' : 'no'}`)
    console.log(`files: ${uninstall ? 'would remove' : join('node_modules', PACKAGE)}`)
    return
  }

  if (!uninstall) {
    const target = installFiles(profile)
    for (const file of ['package.json', join('lib', 'index.js'), join('lib', 'client.js'), 'cordis.patch.yml']) {
      if (!existsSync(join(target, file))) die(`install incomplete: ${join(target, file)} is missing`)
    }
    console.log(`copied ${PACKAGE} -> ${target}`)
  } else {
    rmSync(join(profile, 'node_modules', PACKAGE), { recursive: true, force: true })
    console.log(`removed ${join(profile, 'node_modules', PACKAGE)}`)
  }

  if (changed) {
    writeManifest(manifestFile, manifest)
    console.log(`${uninstall ? 'unregistered from' : 'registered in'} dsh.profile.bundles`)
  } else {
    console.log('dsh.profile.bundles already up to date')
  }
  console.log(uninstall ? 'restart DeepSeek Harness to drop the plugin' : 'restart DeepSeek Harness to load the plugin')
}

main()