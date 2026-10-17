import type { CreateExtension, ExtensionLifecycle, InstallationInput, InstallationResult, InstanceScope } from '@xcye/corio-plugin-sdk'
import { OpenAiMedia } from './media.js'

function installation(input: InstallationInput): InstallationResult {
  return { installationId: input.installationId, runtimeVersion: null, directory: null, command: null, ownership: 'external', metadata: { implementation: 'HTTP', nativeRuntimeRequired: false } }
}

/** 纯 API 扩展不伪造程序目录；安装/卸载不改变用户程序和认证。 */
const lifecycle: ExtensionLifecycle = {
  async inspect(input) {
    return { status: 'available', installation: installation(input) }
  },
  async install(input) {
    return installation(input)
  },
  async update(input) {
    return installation(input)
  },
  async uninstall() {},
  async doctor() {
    return { checks: [{ name: 'http-runtime', status: 'available' }] }
  }
}

/** 模块加载不请求模型，实例之间不共享连接、任务或员工上下文。 */
export const createExtension: CreateExtension = (host) => ({
  lifecycle,
  operations: Object.fromEntries(['image.generate', 'speech.synthesize', 'video.generate'].map((operation) => [operation, async (scope: InstanceScope) => new OpenAiMedia(host, scope, operation)])),
  async dispose() {}
})
