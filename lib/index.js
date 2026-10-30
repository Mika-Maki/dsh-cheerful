/**
 * dsh-cheerful — Host 半边。
 *
 * 只做一件事：把一个全局可用的 `cheer` 工具注册进工具注册表。
 * 工具本身不产生任何界面副作用——浏览器端的礼炮由 Web 客户端插件
 * 通过 tool.call.toolview 观察到这次调用后播放（见 lib/client.js）。
 *
 * 可分发形态：插件参数全部走 Config，用户可在 profile patch 里覆盖：
 *
 *   - id: cheerful
 *     config:
 *       defaultSide: left
 *       defaultIntensity: 3
 *
 * @module dsh-cheerful
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

/** 插件名：与 cordis.patch.yml 里 insert 行的 id 保持一致。 */
export const name = 'cheerful'

/** 注册工具前必须就绪的服务。 */
export const inject = ['tools']

/** 允许的发射侧。 */
const SIDES = new Set(['both', 'left', 'right'])

/**
 * Host 侧配置：决定模型没给参数时的默认行为。
 * 浏览器侧的自动礼花参数在客户端设置里，见 lib/client.js。
 */
export const Config = Schema.object({
  defaultSide: Schema.union(['both', 'left', 'right']).default('both').description('模型未指定 side 时的默认发射侧。'),
  defaultIntensity: Schema.number().min(1).max(3).default(2).description('模型未指定 intensity 时的默认彩带密度。'),
})

/** 把任意 side 归一化成合法值。 */
function normalizeSide(value, fallback) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (SIDES.has(text)) return text
  const fallbackText = typeof fallback === 'string' ? fallback.trim().toLowerCase() : ''
  return SIDES.has(fallbackText) ? fallbackText : 'both'
}

/** 把任意 intensity 归一化成 1..3 的整数。 */
function normalizeIntensity(value, fallback) {
  const number = Number(value)
  if (Number.isFinite(number)) return Math.min(3, Math.max(1, Math.round(number)))
  const fallbackNumber = Number(fallback)
  if (Number.isFinite(fallbackNumber)) return Math.min(3, Math.max(1, Math.round(fallbackNumber)))
  return 2
}

/**
 * 插件入口：注册 `cheer` 工具。
 * @param ctx - Cordis 上下文。
 * @param config - profile patch 覆盖后的 Config。
 */
export function apply(ctx, config) {
  const settings = {
    defaultSide: normalizeSide(config?.defaultSide, 'both'),
    defaultIntensity: normalizeIntensity(config?.defaultIntensity, 2),
  }
  ctx.tools.register(
    defineTool({
      name: 'cheer',
      description:
        '在 Web 界面上庆祝：屏幕左右两侧的礼炮同时向中间喷出彩带，只有画面、不显示文字。' +
        '适用于任务完成、里程碑达成，或用户要求“庆祝一下 / 放个礼炮 / 撒花 / 放彩带”时。',
      parameters: {
        side: {
          type: 'string',
          description: '可选：从哪一侧发射礼炮——both（默认，左右同时）、left、right。',
        },
        intensity: {
          type: 'number',
          description: '可选：彩带密度，1 到 3 的整数，默认 2。',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const side = normalizeSide(args.side, settings.defaultSide)
        const intensity = normalizeIntensity(args.intensity, settings.defaultIntensity)
        const where = side === 'both' ? '左右两侧' : side === 'left' ? '左侧' : '右侧'
        return `🎉 礼炮已发射：${where}喷出彩带（强度 ${intensity}）`
      },
    }),
  )
}
