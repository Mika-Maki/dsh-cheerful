import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** 假 React：只提供契约测试需要的几个 API。 */
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useRef: (value) => ({ current: value }),
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useState: (value) => [value, () => {}],
}

/** 假 localStorage：验证开关与轮次计数会被持久化。 */
const storage = new Map()
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)) },
  removeItem: (key) => { storage.delete(key) },
}

let loaded = null
const sandbox = {
  window: {
    __ModuleLoader__: { load: (definition) => { loaded = definition } },
    localStorage,
    addEventListener: () => {},
    removeEventListener: () => {},
  },
  document: { visibilityState: 'visible' },
  console,
  performance: { now: () => Date.now() },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  setTimeout,
  clearTimeout,
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

assert.ok(loaded, 'client.js must call window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-cheerful', 'module id must equal the package name')
assert.equal(typeof loaded.factory, 'function')

const exports_ = loaded.factory((request) => {
  assert.equal(request, 'react')
  return React
})

assert.equal(exports_.name, 'cheerful')
assert.deepEqual(Array.from(exports_.inject), ['slots'])
assert.equal(typeof exports_.apply, 'function')

/* ---- apply() 必须向四个 slot 各注册一个占位者 ---- */
const registrations = []
const ctx = {
  slots: {
    inject(slotName, register) {
      assert.equal(typeof slotName, 'string')
      return register()
    },
    register(options, Component) {
      registrations.push({ options, Component })
      return () => {}
    },
  },
  effect(fn) {
    return fn()
  },
}
exports_.apply(ctx)
assert.equal(registrations.length, 4, 'expected exactly four slot registrations')

const bySlot = (name) => registrations.find((row) => row.options.name === name)

const overlay = bySlot('shell.overlay')
assert.ok(overlay, 'must register into shell.overlay')
assert.equal(overlay.options.id, 'dsh-cheerful.layer')
assert.equal(typeof overlay.Component, 'function')

const toolview = bySlot('tool.call.toolview')
assert.ok(toolview, 'must register into tool.call.toolview')
assert.equal(toolview.options.key, 'cheer', 'toolview key must be the wire tool name')

const settingsRow = bySlot('settings.general.item')
assert.ok(settingsRow, 'must contribute the auto toggle to Settings')
assert.equal(settingsRow.options.id, 'dsh-cheerful.auto')
assert.equal(typeof settingsRow.Component, 'function')

const watcher = bySlot('conversation.session.header.actions')
assert.ok(watcher, 'must watch Session header for auto celebration')
assert.equal(watcher.options.id, 'dsh-cheerful.auto-celebrator')
assert.equal(typeof watcher.Component, 'function')

/* ---- 参数归一化 ---- */
const { normalizeRequest, readCallArgs } = exports_.__internals
const plain = (value) => JSON.parse(JSON.stringify(value))
assert.deepEqual(
  plain({
    side: normalizeRequest({ side: 'left', intensity: 9 }).side,
    intensity: normalizeRequest({ side: 'left', intensity: 9 }).intensity,
  }),
  { side: 'left', intensity: 3 },
)
assert.equal(normalizeRequest({ side: 'bogus' }).side, 'both')
assert.equal(normalizeRequest({ intensity: -4 }).intensity, 1)
assert.equal(normalizeRequest({ intensity: Number.NaN }).intensity, 2)

/* ---- 工具调用参数读取（跨 vm realm，先归一成主 realm 的普通对象） ---- */
assert.deepEqual(
  plain(readCallArgs({ phase: 'result', block: { call: { argsRaw: '{"side":"right","message":"ok"}' } } })),
  { side: 'right', message: 'ok' },
)
assert.deepEqual(plain(readCallArgs({ phase: 'start', block: { argsRaw: '{"intensity":3}' } })), { intensity: 3 })
assert.deepEqual(plain(readCallArgs({ phase: 'result', block: { call: { argsRaw: 'not-json' } } })), {})
assert.deepEqual(plain(readCallArgs({ phase: 'preparing', block: {} })), {})

/* ---- 可配置项：默认值 / 覆盖 / 夹紧 / 重置 ---- */
const api = exports_.__internals
const defaults = plain(api.getSettings())
assert.deepEqual(defaults, { auto: true, minSteps: 2, turnIntensity: 2, goalIntensity: 3, cooldownMs: 1000, settleMs: 400 })

const updated = api.setSettings({ auto: false, minSteps: 4, turnIntensity: 3 })
assert.equal(updated.auto, false)
assert.equal(updated.minSteps, 4)
assert.equal(updated.turnIntensity, 3)
assert.equal(api.getAuto(), false)
assert.ok(storage.get(api.SETTINGS_KEY), 'settings persist to localStorage')
assert.equal(storage.get(api.AUTO_KEY), undefined, 'legacy auto key is migrated away')

const clamped = plain(api.setSettings({ minSteps: 99, turnIntensity: 0, goalIntensity: 9, cooldownMs: -5, settleMs: 99999 }))
assert.equal(clamped.minSteps, 6, 'minSteps clamps to its upper bound')
assert.equal(clamped.turnIntensity, 1, 'turnIntensity clamps to 1')
assert.equal(clamped.goalIntensity, 3, 'goalIntensity clamps to 3')
assert.equal(clamped.cooldownMs, 0, 'cooldown clamps to 0')
assert.equal(clamped.settleMs, 5000, 'settleMs clamps to 5000')

const reset = plain(api.resetSettings())
assert.deepEqual(reset, plain(api.DEFAULT_SETTINGS))
assert.equal(api.getAuto(), true)

/* ---- 单轮步数判定：阈值可配 ---- */
assert.equal(api.shouldCelebrateSteps(1, 2), false, 'below threshold never celebrates')
assert.equal(api.shouldCelebrateSteps(2, 2), true, 'two steps qualify at default threshold')
assert.equal(api.shouldCelebrateSteps(3, 4), false, 'threshold is respected')
assert.equal(api.shouldCelebrateSteps(4, 4), true)
assert.equal(api.shouldCelebrateSteps(6, 99), true, 'out-of-range threshold clamps to 6')
assert.equal(api.shouldCelebrateSteps(5, 99), false)

/* ---- 冷却：同一会话立刻再触发必须被挡下 ---- */
assert.equal(api.autoFire('session-a', { side: 'both', intensity: 2 }), true)
assert.equal(api.autoFire('session-a', { side: 'both', intensity: 2 }), false, 'cooldown blocks immediate re-fire')
assert.equal(api.autoFire('session-b', { side: 'both', intensity: 2 }), true, 'cooldown is per Session')

/* 关闭开关后不再自动放。 */
api.setAuto(false)
assert.equal(api.autoFire('session-c', { side: 'both', intensity: 2 }), false)

const firedBefore = api.getFiredCount()
sandbox.window.__dshCheerful.fire({ side: 'left', intensity: 1 })
assert.equal(api.getFiredCount(), firedBefore + 1, 'manual fire still works and is never blocked')
assert.equal(typeof sandbox.window.__dshCheerful.setSettings, 'function', 'runtime settings API is exposed')

console.log('contract OK: 4 slots, ids/keys correct, args normalized, settings + steps + cooldown + per-turn quota verified')
