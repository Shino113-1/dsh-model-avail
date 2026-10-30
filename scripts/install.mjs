/**
 * Install this plugin into a DSH profile the way a bundle is normally wired:
 * copy the package into the profile's `node_modules` and register it in
 * `dsh.profile.bundles`, so its bundle patch is applied on the next boot.
 *
 * Only the `bundles` array is touched in the profile manifest — no dependency
 * entry is added, so pnpm's lockfile stays valid and the profile is never
 * re-resolved against a registry. That makes this script the offline route;
 * the DSH plugin panel (npm / git / local directory) is the online one.
 *
 * Usage:
 *   node scripts/install.mjs                 # detect the only profile
 *   node scripts/install.mjs --list          # show the profiles found
 *   node scripts/install.mjs --profile <dir> # explicit profile directory
 *   node scripts/install.mjs --dry-run       # report, change nothing
 *   node scripts/install.mjs --uninstall     # remove it again
 *
 * The profile is also taken from `DSH_PROFILE_DIR`, or from `DSH_PROFILE`
 * (a profile name under `$DSH_HOME/profiles`).
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

/** Fail with a one-line, actionable message. */
function die(message) {
  console.error(`install: ${message}`)
  process.exit(1)
}

/** `$DSH_HOME`, defaulting to `~/.dsh`. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv !== undefined && fromEnv !== '' ? resolve(fromEnv) : join(homedir(), '.dsh')
}

/** A profile directory is one holding a `package.json` with a `dsh.profile` block. */
function isProfile(dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return typeof manifest?.dsh?.profile === 'object' && manifest.dsh.profile !== null
  } catch {
    return false
  }
}

/** Every profile directory under `$DSH_HOME/profiles`, in name order. */
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

/** Read the profile directory from the CLI or the environment. */
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

/** Read the profile manifest. */
function readManifest(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    die(`cannot read ${file}: ${error.message}`)
  }
}

/** Write the profile manifest with two-space indentation, like the original. */
function writeManifest(file, manifest) {
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/** Ensure `name` is listed in `dsh.profile.bundles`, keeping existing order. */
function registerBundle(manifest, name) {
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  if (bundles.includes(name)) return { manifest, changed: false }
  manifest.dsh.profile.bundles = [...bundles, name]
  return { manifest, changed: true }
}

/** Drop `name` from `dsh.profile.bundles`. */
function unregisterBundle(manifest, name) {
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.includes(name)) return { manifest, changed: false }
  manifest.dsh.profile.bundles = bundles.filter((entry) => entry !== name)
  return { manifest, changed: true }
}

/** Copy the package files into `<profile>/node_modules/<name>`. */
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