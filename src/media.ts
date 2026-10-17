import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import type { Artifact, CapabilityAdapter, CapabilityInput, CapabilityResult, PluginConnectionInput, ConfigureResult, ExecutionScope, ExtensionHost, InstanceScope, JsonObject, UsageSnapshot } from '@xcye/corio-plugin-sdk'

const maxBytes = 96 * 1024 * 1024
interface MediaConnection {
  readonly baseUrl: string
  readonly apiKey: string
  readonly headers: Record<string, string>
  readonly modelId: string
}
const audioMime: Readonly<Record<string, string>> = { mp3: 'audio/mpeg', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', pcm: 'audio/L16' }

/** 标准参数翻译为原生 HTTP 请求；额外参数不允许覆盖模型、身份或已设置的标准字段。 */
export class OpenAiMedia implements CapabilityAdapter {
  private settings: JsonObject = {}

  constructor(
    private readonly host: ExtensionHost,
    private readonly scope: InstanceScope,
    private readonly operation: string
  ) {}

  async configure(input: PluginConnectionInput): Promise<ConfigureResult> {
    if (input.type !== 'connection') {
      return { status: 'unsupported', appliedRevision: null }
    }
    const endpoint = new URL(String(input.params.baseUrl ?? ''))
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
      throw new Error('Provide an HTTP or HTTPS base URL')
    }
    if (typeof input.params.apiKey !== 'string' || !input.params.apiKey) {
      throw new Error('Provide an API key for this plugin connection')
    }
    this.settings = { ...input.params }
    return { status: 'applied', appliedRevision: input.revision }
  }

  async execute(input: CapabilityInput): Promise<CapabilityResult> {
    if (input.operation !== this.operation) {
      throw new Error('This instance implements a different operation')
    }
    const text = 'text' in input ? input.text : 'prompt' in input ? input.prompt : undefined
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('Provide non-empty text or prompt for this operation')
    }
    const connection = this.connection(input.params)
    if (input.operation === 'image.generate') {
      return this.image(input as Extract<CapabilityInput, { operation: 'image.generate' }>, connection)
    }
    if (input.operation === 'speech.synthesize') {
      return this.speech(input as Extract<CapabilityInput, { operation: 'speech.synthesize' }>, connection)
    }
    if (input.operation === 'video.generate') {
      return this.video(input as Extract<CapabilityInput, { operation: 'video.generate' }>, connection)
    }
    throw new Error('This extension does not implement custom operations')
  }

  async getJob(input: { scope: ExecutionScope; jobId: string; signal: AbortSignal }): Promise<CapabilityResult> {
    if (this.operation !== 'video.generate') {
      throw new Error('This operation has no asynchronous jobs')
    }
    const connection = this.connection({})
    const response = await this.request(connection, 'videos/' + encodeURIComponent(input.jobId), { signal: input.signal })
    const body = object(JSON.parse((await bytes(response)).toString('utf8')))
    let result = this.videoResult(body, response.headers.get('x-request-id') ?? undefined)
    if (result.status === 'succeeded') {
      const content = await this.request(connection, 'videos/' + encodeURIComponent(input.jobId) + '/content', { signal: input.signal })
      const artifact = await this.artifact('video', 'video/mp4', 'mp4', input.jobId, await bytes(content))
      result = { ...result, artifacts: [artifact] }
    }
    return result
  }

  /** 删除视频不是取消生成；当前协议没有可确认的取消端点，不能把停止等待记成取消成功。 */
  async cancelJob(input: { scope: ExecutionScope; jobId: string; signal: AbortSignal }): Promise<CapabilityResult> {
    input.signal.throwIfAborted()
    return { status: 'unknown', jobId: input.jobId, artifacts: [], error: { code: 'CANCEL_UNSUPPORTED', message: 'This protocol does not expose confirmed video generation cancellation; the job may continue and incur cost.' } }
  }

  async dispose(): Promise<void> {
    this.settings = {}
  }

  private async image(input: Extract<CapabilityInput, { operation: 'image.generate' }>, connection: MediaConnection): Promise<CapabilityResult> {
    const body: Record<string, unknown> = { model: connection.modelId, prompt: input.prompt }
    dimensions(body, input.width, input.height)
    if (input.count !== undefined) {
      body.n = input.count
    }
    if (input.format !== undefined) {
      body.output_format = input.format
    }
    nativeParams(body, input.params)
    if (body.stream === true) {
      throw new Error('Image streaming is not implemented by this capability')
    }
    const response = await this.request(connection, 'images/generations', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, signal: input.signal })
    const payload = object(JSON.parse((await bytes(response)).toString('utf8')))
    if (!Array.isArray(payload.data) || !payload.data.length || payload.data.length > 100) {
      throw new Error('The image response has no valid artifacts')
    }
    const format = String(payload.output_format ?? input.format ?? 'png')
    if (!['png', 'jpeg', 'webp'].includes(format)) {
      throw new Error('The image response format is unsupported')
    }
    const artifacts: Artifact[] = []
    for (const [index, value] of payload.data.entries()) {
      const item = object(value)
      let data: Buffer
      if (typeof item.b64_json === 'string' && /^[a-zA-Z0-9+/]*={0,2}$/.test(item.b64_json)) {
        data = Buffer.from(item.b64_json, 'base64')
      } else if (typeof item.url === 'string') {
        const url = new URL(item.url)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
          throw new Error('The image download URL is invalid')
        }
        // 外部图像地址不能收到模型连接的 Authorization，也不自动跟随重定向。
        data = await bytes(await fetch(url, { signal: input.signal, redirect: 'error' }))
      } else {
        throw new Error('The image artifact has neither base64 content nor a URL')
      }
      artifacts.push(await this.artifact('image', 'image/' + format, format, input.callId + '-' + index, data))
    }
    const model = typeof payload.model === 'string' ? payload.model : connection.modelId
    const raw = payload.usage && typeof payload.usage === 'object' ? object(payload.usage) : undefined
    const inputTokens = integer(raw?.input_tokens)
    const outputTokens = integer(raw?.output_tokens)
    const usage: UsageSnapshot = {
      snapshotId: input.callId,
      revision: '1',
      scope: 'call',
      accounting: 'cumulative',
      complete: !!inputTokens && !!outputTokens,
      modelUsages: [{ model, capability: 'image_generation', pricingContext: { size: String(body.size ?? 'default'), quality: String(body.quality ?? 'default') }, ...(raw ? { inputTokens, outputTokens, raw } : { images: String(artifacts.length) }) }]
    }
    return { status: 'succeeded', artifacts, actualModel: model, usage, providerRequestId: response.headers.get('x-request-id') ?? undefined }
  }

  private async speech(input: Extract<CapabilityInput, { operation: 'speech.synthesize' }>, connection: MediaConnection): Promise<CapabilityResult> {
    const body: Record<string, unknown> = { model: connection.modelId, input: input.text }
    if (input.voice !== undefined) {
      body.voice = input.voice
    }
    if (input.format !== undefined) {
      body.response_format = input.format
    }
    if (input.speed !== undefined) {
      body.speed = input.speed
    }
    nativeParams(body, input.params)
    if (!body.voice) {
      throw new Error('Provide voice in the standard field or params')
    }
    if (body.stream_format !== undefined && body.stream_format !== 'audio') {
      throw new Error('This speech operation expects an audio response')
    }
    const format = String(body.response_format ?? 'mp3')
    if (!audioMime[format]) {
      throw new Error('Unsupported speech format')
    }
    const response = await this.request(connection, 'audio/speech', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, signal: input.signal })
    const artifact = await this.artifact('audio', audioMime[format]!, format, input.callId, await bytes(response))
    return {
      status: 'succeeded',
      artifacts: [artifact],
      actualModel: connection.modelId,
      providerRequestId: response.headers.get('x-request-id') ?? undefined,
      usage: {
        snapshotId: input.callId,
        revision: '1',
        scope: 'call',
        accounting: 'cumulative',
        complete: false,
        modelUsages: [{ model: connection.modelId, capability: 'speech_synthesis', characters: String([...input.text].length), raw: { measurement: 'submitted_input_codepoints', providerUsageUnavailable: true } }]
      }
    }
  }

  private async video(input: Extract<CapabilityInput, { operation: 'video.generate' }>, connection: MediaConnection): Promise<CapabilityResult> {
    const body: Record<string, unknown> = { model: connection.modelId, prompt: input.prompt }
    dimensions(body, input.width, input.height)
    if (input.durationSeconds !== undefined) {
      body.seconds = String(input.durationSeconds)
    }
    nativeParams(body, input.params)
    const form = new FormData()
    for (const [name, value] of Object.entries(body)) {
      if (!['string', 'number', 'boolean'].includes(typeof value)) {
        throw new Error('Video multipart params currently support scalar fields only')
      }
      form.append(name, String(value))
    }
    const response = await this.request(connection, 'videos', { method: 'POST', body: form, signal: input.signal })
    const result = this.videoResult(object(JSON.parse((await bytes(response)).toString('utf8'))), response.headers.get('x-request-id') ?? undefined)
    return result.status === 'succeeded' ? this.getJob({ scope: input.scope, jobId: result.jobId!, signal: input.signal }) : result
  }

  private videoResult(body: JsonObject, providerRequestId?: string): CapabilityResult {
    if (typeof body.id !== 'string' || !body.id) {
      throw new Error('The video response has no provider job ID')
    }
    const status = ({ queued: 'submitted', in_progress: 'running', completed: 'succeeded', failed: 'failed' } as const)[String(body.status) as 'queued' | 'in_progress' | 'completed' | 'failed'] ?? 'unknown'
    const model = typeof body.model === 'string' ? body.model : this.connection({}).modelId
    const seconds = typeof body.seconds === 'string' && /^\d+(?:\.\d+)?$/.test(body.seconds) ? body.seconds : undefined
    return {
      status,
      jobId: body.id,
      artifacts: [],
      actualModel: model,
      providerRequestId,
      ...(status === 'succeeded' && seconds
        ? { usage: { snapshotId: body.id, revision: '1', scope: 'call' as const, accounting: 'cumulative' as const, complete: false, modelUsages: [{ model, capability: 'video_generation', videoSeconds: seconds, pricingContext: { size: body.size ?? null } }] } }
        : {}),
      ...(status === 'failed' ? { error: { code: 'VIDEO_FAILED', message: 'The provider reported video generation failure.' } } : {})
    }
  }

  private connection(params: JsonObject): MediaConnection {
    const field = { 'image.generate': 'imageModel', 'speech.synthesize': 'speechModel', 'video.generate': 'videoModel' }[this.operation]
    const modelId = params.model ?? (field ? this.settings[field] : undefined)
    if (typeof modelId !== 'string' || !modelId) {
      throw new Error('Configure a model in this plugin connection or params.model')
    }
    return { baseUrl: String(this.settings.baseUrl), apiKey: String(this.settings.apiKey), modelId, headers: (this.settings.headers ?? {}) as Record<string, string> }
  }

  private request(connection: MediaConnection, path: string, init: RequestInit): Promise<Response> {
    // 保留已配置前缀，不按域名/末尾 v1 等猜测或重写基础地址。
    const headers = new Headers(connection.headers)
    new Headers(init.headers).forEach((value, key) => headers.set(key, value))
    headers.set('Authorization', 'Bearer ' + connection.apiKey)
    return fetch(connection.baseUrl.replace(/\/$/, '') + '/' + path, { ...init, headers, redirect: 'error' })
  }

  private async artifact(kind: Artifact['kind'], mimeType: string, format: string, identity: string, data: Buffer): Promise<Artifact> {
    if (!data.length || data.length > maxBytes) {
      throw new Error('The generated artifact is empty or exceeds 96 MiB')
    }
    const workspace = await realpath(this.scope.workspacePath)
    const directory = join(workspace, 'artifacts', 'capabilities')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const actual = await realpath(directory)
    const location = relative(workspace, actual)
    if (isAbsolute(location) || location === '..' || location.startsWith('..' + sep)) {
      throw new Error('The artifact directory escapes the employee workspace')
    }
    const name = createHash('sha256').update(identity).digest('hex') + '.' + format
    const path = join(actual, name)
    await writeFile(path, data, { mode: 0o600 })
    return { kind, mimeType, path, name, metadata: { bytes: String(data.length) } }
  }
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The provider response must be a JSON object')
  }
  return value as JsonObject
}

function nativeParams(body: Record<string, unknown>, params: JsonObject): void {
  for (const [name, value] of Object.entries(params)) {
    if (name === 'model') {
      continue
    }
    if (['model', 'provider', 'providerId', 'apiKey', 'credential', 'scope', 'callId', 'headers', 'baseUrl', '__proto__', 'constructor', 'prototype'].includes(name) || Object.hasOwn(body, name)) {
      throw new Error('Native params cannot override configured or standard fields: ' + name)
    }
    body[name] = value
  }
}

function dimensions(body: Record<string, unknown>, width?: number, height?: number): void {
  if ((width === undefined) !== (height === undefined)) {
    throw new Error('Provide width and height together')
  }
  if (width !== undefined) {
    if (![width, height].every((value) => Number.isInteger(value) && value! > 0)) {
      throw new Error('Dimensions must be positive integers')
    }
    body.size = width + 'x' + height
  }
}

function integer(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return value
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value)
  }
  return undefined
}

/** 有界读取；错误只保留 HTTP 状态，不把可能包含秘密的提供商响应原样写入日志。 */
async function bytes(response: Response): Promise<Buffer> {
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error('Capability request failed: HTTP ' + response.status)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) {
        break
      }
      total += part.value.length
      if (total > maxBytes) {
        throw new Error('The capability response exceeds 96 MiB')
      }
      chunks.push(part.value)
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}
