/**
 * Tests for scripts/install.mjs — the offline install route a stranger uses
 * after cloning the repository.
 *
 * Every case builds a throwaway `$DSH_HOME` with one or more fake profiles, so
 * nothing here touches the real DSH installation.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INSTALLER = join(ROOT, 'scripts', 'install.mjs')

/** A temporary DSH home holding the named profiles. */
function makeHome(profiles) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-model-avail-install-'))
  for (const name of profiles) {
    const dir = join(home, 'profiles', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: `profile-${name}`, private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2)}\n`,
      'utf8',
    )
  }
  return home
}

/** Run the installer with a clean environment pointing at `home`. */
function run(args, home) {
  const env = { ...process.env, DSH_HOME: home }
  delete env.DSH_PROFILE
  delete env.DSH_PROFILE_DIR
  return execFileSync(process.execPath, [INSTALLER, ...args], { env, encoding: 'utf8' })
}

/** Run the installer expecting a non-zero exit; returns stderr. */
function runFailing(args, home) {
  try {
    run(args, home)
  } catch (error) {
    return String(error.stderr ?? error.message)
  }
  throw new Error('installer unexpectedly succeeded')
}

/** The profile manifest of a fake profile. */
function manifestOf(home, name = 'desktop') {
  return JSON.parse(readFileSync(join(home, 'profiles', name, 'package.json'), 'utf8'))
}

test('installs the package and registers the bundle, idempotently', (t) => {
  const home = makeHome(['desktop'])
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const out = run([], home)
  assert.match(out, /restart DeepSeek Harness/)

  const target = join(home, 'profiles', 'desktop', 'node_modules', 'dsh-model-avail')
  for (const file of ['package.json', 'cordis.patch.yml', join('lib', 'index.js'), join('lib', 'client.js')]) {
    assert.ok(existsSync(join(target, file)), `${file} should be installed`)
  }
  assert.deepEqual(manifestOf(home).dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-model-avail'])

  // Second run: no duplicate entry, no failure.
  const again = run([], home)
  assert.match(again, /already up to date/)
  assert.deepEqual(manifestOf(home).dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-model-avail'])
})

test('--dry-run reports the plan without touching the profile', (t) => {
  const home = makeHome(['desktop'])
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const before = readFileSync(join(home, 'profiles', 'desktop', 'package.json'), 'utf8')
  const out = run(['--dry-run'], home)
  assert.match(out, /bundles change: yes/)
  assert.equal(readFileSync(join(home, 'profiles', 'desktop', 'package.json'), 'utf8'), before)
  assert.ok(!existsSync(join(home, 'profiles', 'desktop', 'node_modules', 'dsh-model-avail')))
})

test('--uninstall removes the files and the bundle entry', (t) => {
  const home = makeHome(['desktop'])
  t.after(() => rmSync(home, { recursive: true, force: true }))

  run([], home)
  const out = run(['--uninstall'], home)
  assert.match(out, /removed/)
  assert.ok(!existsSync(join(home, 'profiles', 'desktop', 'node_modules', 'dsh-model-avail')))
  assert.deepEqual(manifestOf(home).dsh.profile.bundles, ['@deepseek-ai/dsh-base'])
})

test('--profile wins over detection and rejects a directory without a manifest', (t) => {
  const home = makeHome(['desktop', 'work'])
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const work = join(home, 'profiles', 'work')
  run(['--profile', work], home)
  assert.deepEqual(manifestOf(home, 'work').dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-model-avail'])
  assert.deepEqual(manifestOf(home, 'desktop').dsh.profile.bundles, ['@deepseek-ai/dsh-base'])

  const empty = join(home, 'empty')
  mkdirSync(empty, { recursive: true })
  assert.match(runFailing(['--profile', empty], home), /no package.json/)
})

test('refuses to guess between several profiles and points at --profile', (t) => {
  const home = makeHome(['desktop', 'work'])
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const stderr = runFailing([], home)
  assert.match(stderr, /several DSH profiles/)
  assert.match(stderr, /--profile/)
})

test('--list prints every profile under the DSH home', (t) => {
  const home = makeHome(['desktop', 'work'])
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const out = run(['--list'], home)
  assert.match(out, /profiles[/\\]desktop/)
  assert.match(out, /profiles[/\\]work/)
})