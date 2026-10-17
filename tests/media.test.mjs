import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = process.env.CORIO_MEDIA_TEST_ROOT ?? fileURLToPath(new URL('..', import.meta.url))
const { createExtension } = await import(pathToFileURL(join(packageRoot, 'dist/index.js')).href)

async function fixture(t, operation, respond) {
  const root = await mkdtemp(join(tmpdir(), 'corio-media-'))
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) {
      chunks.push(chunk)
    }
    const request = { method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }
    requests.push(request)
    respond(request, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/opaque/prefix'
  const scope = { agentId: '1', homeSpaceId: 'home', stateDirectory: root, workspacePath: root, pluginConnectionId: 'plugin', executionId: 'execution', threadId: 'thread', targetSpaceId: 'home' }
  const extension = await createExtension({})
  const adapter = await extension.operations[operation](scope)
  await adapter.configure({ type: 'connection', params: { baseUrl, apiKey: 'fixture-key', imageModel: 'model', speechModel: 'model', videoModel: 'model' }, revision: '1', scope })
  t.after(() => adapter.dispose())
  return { root, requests, adapter, scope, input: { operation, scope, callId: 'request', params: {}, signal: AbortSignal.timeout(5000) } }
}

test('image request keeps its opaque prefix, translates parameters and preserves real model usage and files', async (t) => {
  const f = await fixture(t, 'image.generate', (_req, res) => {
    res.setHeader('x-request-id', 'provider-request')
    res.end(JSON.stringify({ model: 'actual-model', output_format: 'webp', data: [{ b64_json: Buffer.from('image-bytes').toString('base64') }], usage: { input_tokens: 0, output_tokens: 12 } }))
  })
  const result = await f.adapter.execute({ ...f.input, prompt: 'A card', width: 1024, height: 1536, count: 1, format: 'webp', params: { quality: 'high' } })
  assert.equal(f.requests[0].path, '/opaque/prefix/images/generations')
  assert.equal(f.requests[0].headers.authorization, 'Bearer fixture-key')
  assert.deepEqual(JSON.parse(f.requests[0].body), { model: 'model', prompt: 'A card', size: '1024x1536', n: 1, output_format: 'webp', quality: 'high' })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.actualModel, 'actual-model')
  assert.equal(result.usage.complete, true)
  assert.equal(result.usage.modelUsages[0].inputTokens, '0')
  assert.equal(result.providerRequestId, 'provider-request')
  assert.equal(await readFile(result.artifacts[0].path, 'utf8'), 'image-bytes')
  assert.ok(relative(await realpath(f.root), result.artifacts[0].path).startsWith('artifacts' + sep + 'capabilities' + sep))
})

test('native parameters cannot replace identity or standard fields and unsupported streams make no request', async (t) => {
  const f = await fixture(t, 'image.generate', (_req, res) => res.end('{}'))
  for (const params of [{ prompt: 'override' }, { apiKey: 'other' }, { stream: true }]) {
    await assert.rejects(f.adapter.execute({ ...f.input, prompt: 'A card', params }))
  }
  await assert.rejects(f.adapter.execute({ ...f.input, prompt: 'A card', width: 1024 }), /together/)
  assert.equal(f.requests.length, 0)
})

test('an image URL is downloaded without forwarding the model credential', async (t) => {
  let downloadAuthorization
  const download = createServer((req, res) => {
    downloadAuthorization = req.headers.authorization
    res.end('downloaded-image')
  })
  await new Promise((resolve) => download.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => download.close(resolve)))
  const f = await fixture(t, 'image.generate', (_req, res) => res.end(JSON.stringify({ data: [{ url: 'http://127.0.0.1:' + download.address().port + '/image' }] })))
  const result = await f.adapter.execute({ ...f.input, prompt: 'A card' })
  assert.equal(downloadAuthorization, undefined)
  assert.equal(result.usage.complete, false)
  assert.equal(result.usage.modelUsages[0].images, '1')
  assert.equal(await readFile(result.artifacts[0].path, 'utf8'), 'downloaded-image')
})

test('speech returns a binary artifact and partial measured usage, without claiming provider billing', async (t) => {
  const f = await fixture(t, 'speech.synthesize', (_req, res) => res.end('speech-bytes'))
  const result = await f.adapter.execute({ ...f.input, text: 'Hi 😀', voice: 'alloy', format: 'wav', speed: 1.2, params: { instructions: 'Speak warmly' } })
  assert.equal(f.requests[0].path, '/opaque/prefix/audio/speech')
  assert.deepEqual(JSON.parse(f.requests[0].body), { model: 'model', input: 'Hi 😀', voice: 'alloy', response_format: 'wav', speed: 1.2, instructions: 'Speak warmly' })
  assert.equal(result.usage.complete, false)
  assert.equal(result.usage.modelUsages[0].characters, '4')
  assert.equal(await readFile(result.artifacts[0].path, 'utf8'), 'speech-bytes')
})

test('video submission is multipart; query downloads the completed job; cancellation never uses DELETE', async (t) => {
  const f = await fixture(t, 'video.generate', (req, res) => {
    if (req.path.endsWith('/content')) {
      res.end('video-bytes')
      return
    }
    res.end(JSON.stringify({ id: 'video_1', status: req.method === 'POST' ? 'queued' : 'completed', model: 'actual-video', seconds: '4', size: '720x1280' }))
  })
  const submitted = await f.adapter.execute({ ...f.input, prompt: 'A card moves', durationSeconds: 4, width: 720, height: 1280 })
  assert.equal(submitted.status, 'submitted')
  assert.equal(submitted.jobId, 'video_1')
  assert.match(f.requests[0].headers['content-type'], /multipart\/form-data/)
  assert.match(f.requests[0].body, /name="seconds"\r\n\r\n4/)
  const completed = await f.adapter.getJob({ scope: f.scope, jobId: submitted.jobId, signal: f.input.signal })
  assert.equal(completed.status, 'succeeded')
  assert.equal(completed.usage.modelUsages[0].videoSeconds, '4')
  assert.equal(await readFile(completed.artifacts[0].path, 'utf8'), 'video-bytes')
  const cancelled = await f.adapter.cancelJob({ scope: f.scope, jobId: submitted.jobId, signal: f.input.signal })
  assert.equal(cancelled.status, 'unknown')
  assert.equal(cancelled.error.code, 'CANCEL_UNSUPPORTED')
  assert.deepEqual(
    f.requests.map((item) => item.method),
    ['POST', 'GET', 'GET']
  )
})
