/**
 * 按 bundle 常见的接法把本插件装进 DSH profile：把包复制到 profile 的
 * `node_modules`，并登记进 `dsh.profile.bundles`，这样下次启动时它的
 * bundle 补丁就会被应用。
 *
 * profile 由 pnpm 管理时（装了别的插件就会是），多写一笔
 * `dependencies["dsh-model-avail"] = "file:./vendor/dsh-model-avail"`：
 * pnpm 只保留依赖表里有的包，别的会被下一次 `pnpm install` 当垃圾清掉 ——
 * 插件面板装/升级别的插件正好会触发它。这条 `file:` 依赖指向 profile 内的
 * 副本，离线也能装回，所以本脚本仍是离线路径。
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
/** profile 里给本插件留的那份「pnpm 认得」的副本。 */
const VENDOR_DIR = 'vendor'
/** pnpm 依赖条目里写的 spec，形如 `file:./vendor/dsh-model-avail`。 */
const VENDOR_SPEC = `file:./${VENDOR_DIR}/${PACKAGE}`

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

/**
 * 这个 profile 是不是由 pnpm 管着（装了别的插件就会是）。
 *
 * 判据是 pnpm 自己留下的痕迹：lockfile 或 `node_modules/.modules.yaml`。
 * 一旦成立，`node_modules` 里所有「不在依赖表里」的目录下一次 `pnpm install`
 * 都会被清掉 —— 插件面板装/升级别的插件正是这么做的。
 */
function isPnpmManaged(profile) {
  return existsSync(join(profile, 'pnpm-lock.yaml'))
    || existsSync(join(profile, 'node_modules', '.modules.yaml'))
}

/** 往 `<profile>/vendor/<name>` 放一份副本，供 `file:` 依赖引用。 */
function installVendorCopy(profile) {
  const target = join(profile, VENDOR_DIR, PACKAGE)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  for (const entry of FILES) {
    const from = join(ROOT, entry)
    if (!existsSync(from)) continue
    cpSync(from, join(target, entry), { recursive: true })
  }
  return target
}

/** 登记 `dependencies[<name>] = file:./vendor/<name>`，免得被 pnpm 当垃圾清掉。 */
function registerDependency(manifest) {
  manifest.dependencies ??= {}
  if (manifest.dependencies[PACKAGE] === VENDOR_SPEC) return { manifest, changed: false }
  manifest.dependencies[PACKAGE] = VENDOR_SPEC
  return { manifest, changed: true }
}

/** 撤掉上面登记的那条依赖（只删自己写的那一条）。 */
function unregisterDependency(manifest) {
  const dependencies = manifest.dependencies
  if (typeof dependencies !== 'object' || dependencies === null) return { manifest, changed: false }
  const current = dependencies[PACKAGE]
  if (current === undefined) return { manifest, changed: false }
  delete dependencies[PACKAGE]
  if (Object.keys(dependencies).length === 0) delete manifest.dependencies
  return { manifest, changed: true }
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
  const pnpmManaged = isPnpmManaged(profile)
  const bundle = uninstall ? unregisterBundle(before, PACKAGE) : registerBundle(before, PACKAGE)
  // 只有 pnpm 管的 profile 才需要那条 file: 依赖；别的 profile 里写它反而指向一个不存在的目录。
  const dependency = pnpmManaged
    ? (uninstall ? unregisterDependency(bundle.manifest) : registerDependency(bundle.manifest))
    : { manifest: bundle.manifest, changed: false }
  const manifest = dependency.manifest
  const changed = bundle.changed || dependency.changed

  if (dryRun) {
    console.log(`profile: ${profile}`)
    console.log(`pnpm-managed profile: ${pnpmManaged ? 'yes' : 'no'}`)
    console.log(`bundles change: ${bundle.changed ? 'yes' : 'no'}`)
    console.log(`dependency change: ${pnpmManaged ? (dependency.changed ? 'yes' : 'no') : 'skipped (not pnpm-managed)'}`)
    if (!uninstall && pnpmManaged) console.log(`vendor copy: ${join(VENDOR_DIR, PACKAGE)}`)
    console.log(`files: ${uninstall ? 'would remove' : join('node_modules', PACKAGE)}`)
    return
  }

  if (!uninstall) {
    const target = installFiles(profile)
    for (const file of ['package.json', join('lib', 'index.js'), join('lib', 'client.js'), 'cordis.patch.yml']) {
      if (!existsSync(join(target, file))) die(`install incomplete: ${join(target, file)} is missing`)
    }
    console.log(`copied ${PACKAGE} -> ${target}`)
    if (pnpmManaged) {
      const vendor = installVendorCopy(profile)
      console.log(`copied ${PACKAGE} -> ${vendor} (file: dependency, survives pnpm install)`)
    }
  } else {
    rmSync(join(profile, 'node_modules', PACKAGE), { recursive: true, force: true })
    rmSync(join(profile, VENDOR_DIR, PACKAGE), { recursive: true, force: true })
    console.log(`removed ${join(profile, 'node_modules', PACKAGE)}`)
  }

  if (changed) {
    writeManifest(manifestFile, manifest)
    const parts = []
    if (bundle.changed) parts.push('dsh.profile.bundles')
    if (dependency.changed) parts.push(`dependencies["${PACKAGE}"]`)
    console.log(`${uninstall ? 'unregistered from' : 'registered in'} ${parts.join(' and ')}`)
  } else {
    console.log('dsh.profile.bundles already up to date')
  }
  if (!uninstall && pnpmManaged) {
    console.log('this profile is pnpm-managed: the file: dependency is what keeps the plugin across pnpm install;')
    console.log('run `pnpm install` in the profile if you want pnpm to own node_modules/dsh-model-avail right now')
  }
  console.log(uninstall ? 'restart DeepSeek Harness to drop the plugin' : 'restart DeepSeek Harness to load the plugin')
}

main()