#!/usr/bin/env node
// Phase 0 of the split PaaS deployment (strategy/runbooks/scenario-split-paas-deployment.md):
// measure what the new proxy actually does before any config is written.
//
// The app this is written for lives on ONE origin: passkeys are bound to the hostname, the
// session cookie is __Host- prefixed, and the API never sends Allow-Credentials. So a split
// deployment (static web + API on another host) is only viable if a same-origin proxy passes
// bodies, headers, cookies and origins through untouched. None of that is documented by the
// platforms, which is why it is measured here instead of assumed.
//
//   node scripts/deploy/spike.mjs --base https://app.example.com
//   node scripts/deploy/spike.mjs --base https://app.example.com --cookie 'gymsid=…'
//   node scripts/deploy/spike.mjs --base https://app.example.com --token <api-token> --upload-mb 40
//
// Exit codes: 0 = every check measured and passed, 1 = a check failed, 2 = incomplete (a check
// could not run). A check that cannot run is never reported as a pass.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const CSP_HASH = 'G6hveK3W3qL6wotsg9mMbpCvPnzXurSHhi8Jb3TS2Vc='
const PASS = 'pass', FAIL = 'fail', SKIP = 'skip'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const base = String(arg('base', '')).replace(/\/+$/, '')
if (!base) {
  console.error('usage: node scripts/deploy/spike.mjs --base https://app.example.com [--cookie …] [--token …] [--upload-mb 40]')
  process.exit(2)
}
const cookie = arg('cookie', '')
const token = arg('token', '')
const uploadMb = Number(arg('upload-mb', '40'))
const results = []

const authHeaders = () => (cookie ? { cookie } : token ? { authorization: 'Bearer ' + token } : {})

async function request(path, init = {}) {
  const res = await fetch(base + path, { redirect: 'manual', ...init })
  const body = await res.text().catch(() => '')
  return { res, body }
}

function record(name, state, note, extra = {}) {
  results.push({ name, state, note, ...extra })
  const icon = state === PASS ? '✓' : state === FAIL ? '✗' : '–'
  console.log(`${icon} ${name}: ${note}`)
}

// The API answers its own 413 for oversized JSON; the proxy answers with a marker of its own.
// Telling them apart is the whole point — one means "lower the cap", the other means "this
// architecture cannot carry uploads".
function classifyBody(status, text) {
  if (status === 413) {
    const proxySaid = /FUNCTION_PAYLOAD_TOO_LARGE|REQUEST_ENTITY_TOO_LARGE|Payload Too Large/i.test(text)
    return proxySaid
      ? { state: FAIL, note: 'the proxy capped the body — uploads above this never reach the API' }
      : { state: SKIP, note: 'the API answered 413 (its own cap): raise the cap or lower --upload-mb' }
  }
  if (status === 201 || status === 200) return { state: PASS, note: `body crossed the proxy and was stored (${status})` }
  if (status === 401) return { state: SKIP, note: 'no credential: pass --cookie or --token to measure the real path' }
  return { state: SKIP, note: `answered ${status} — body handling not proven` }
}

async function checkHealth() {
  const { res, body } = await request('/api/health')
  const ok = res.status === 200 && /"ok"\s*:\s*true/.test(body)
  record('health', ok ? PASS : FAIL, ok ? '200 {"ok":true} through the proxy' : `got ${res.status}`, { status: res.status })
}

// The phone app preflights with its own origin. A proxy that answers the preflight itself
// (auth middleware, CORS header of its own) breaks pairing with nothing in the app's log.
async function checkPreflight() {
  const { res } = await request('/api/pair/redeem', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://localhost',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  })
  const allow = res.headers.get('access-control-allow-origin')
  const ok = (res.status === 204 || res.status === 200) && allow === 'https://localhost'
  record('preflight', ok ? PASS : FAIL, ok ? `${res.status} with allow-origin https://localhost` : `status ${res.status}, allow-origin ${allow || 'absent'}`, { status: res.status, allow })
}

// The API refuses a state-changing request from a foreign origin. If the proxy strips or
// rewrites Origin, that guard silently stops working — so prove it still fires. PUT /api/data is
// used because the pre-auth routes are deliberately exempt (their credential is in the body).
async function checkOriginRefusal() {
  const { res, body } = await request('/api/data', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: 'https://evil.invalid' },
    body: '{}',
  })
  const refused = res.status === 403 && /origin-mismatch|cross-origin/i.test(body)
  record('origin-refusal', refused ? PASS : FAIL, refused ? `${res.status} refused a foreign origin` : `got ${res.status}, body: ${body.slice(0, 80)}`, { status: res.status })
}

// Everything the old nginx sent must be sent by the new host, or the app loses its CSP (and the
// inline boot script stops running) without any visible error. Only the web host serves the
// shell; against a bare API these are skipped rather than failed.
let shellHost = null
async function checkHeaders() {
  const { res } = await request('/')
  shellHost = /text\/html/i.test(res.headers.get('content-type') || '')
  if (!shellHost) return record('headers', SKIP, 'this base serves no shell (bare API): run against the web host')
  const csp = res.headers.get('content-security-policy') || ''
  const missing = []
  if (!csp.includes(`'sha256-${CSP_HASH}'`)) missing.push('inline-script hash in CSP')
  if (res.headers.get('x-frame-options') !== 'DENY') missing.push('X-Frame-Options')
  if (res.headers.get('referrer-policy') !== 'same-origin') missing.push('Referrer-Policy')
  const sw = await request('/sw.js')
  if (!/no-cache/.test(sw.res.headers.get('cache-control') || '')) missing.push('no-cache on /sw.js')
  record('headers', missing.length ? FAIL : PASS, missing.length ? 'missing: ' + missing.join(', ') : 'CSP hash, frame, referrer and sw.js revalidation all present')
}

// 180 px media ships inside the image today; a static build has to stage it itself.
async function checkStaticMedia() {
  if (shellHost === false) return record('static-media', SKIP, 'this base serves no static build: run against the web host')
  const { res } = await request('/exercise-media/clip/0001.mp4', { method: 'HEAD' })
  const corp = res.headers.get('cross-origin-resource-policy')
  const ok = res.status === 200 && corp === 'same-origin'
  record('static-media', ok ? PASS : FAIL, ok ? '200 with Cross-Origin-Resource-Policy' : `status ${res.status}, CORP ${corp || 'absent'}`, { status: res.status })
}

// A random buffer is refused 415 before the body limit is ever exercised: the API sniffs the
// first 64 bytes and parses the MP4 boxes. So a real clip is padded with a `free` box (one the
// parser skips) up to the target size — a genuinely valid file that is genuinely that large,
// which is the only payload that measures the proxy rather than the type checker.
function paddedMp4(targetBytes) {
  const src = readFileSync(join(ROOT, 'catalogue/media/clip/0001.mp4'))
  if (src.length >= targetBytes) return src
  const ftypSize = src.readUInt32BE(0)
  const pad = Buffer.alloc(targetBytes - src.length)
  pad.writeUInt32BE(pad.length, 0)
  pad.write('free', 4, 'latin1')
  return Buffer.concat([src.subarray(0, ftypSize), pad, src.subarray(ftypSize)])
}

async function checkUpload() {
  const bytes = paddedMp4(uploadMb * 1024 * 1024)
  const hash = createHash('sha256').update(bytes).digest('hex')
  let out
  try {
    out = await request('/api/media/' + hash, {
      method: 'PUT',
      headers: { 'content-type': 'video/mp4', ...authHeaders() },
      body: bytes,
    })
  } catch (e) {
    record('upload-' + uploadMb + 'mb', FAIL, `connection failed mid-body (${e.cause?.code || e.message}) — the proxy cut the request`)
    return hash
  }
  const verdict = classifyBody(out.res.status, out.body)
  record('upload-' + uploadMb + 'mb', verdict.state, verdict.note, { status: out.res.status })
  return hash
}

async function checkDownload(hash) {
  if (!hash) return
  let res
  try {
    res = await fetch(base + '/api/media/' + hash, { headers: authHeaders() })
  } catch (e) {
    record('download-' + uploadMb + 'mb', FAIL, `failed mid-body (${e.cause?.code || e.message})`)
    return
  }
  if (res.status !== 200) {
    record('download-' + uploadMb + 'mb', SKIP, `status ${res.status} — nothing to download (upload did not store)`)
    return
  }
  const bytes = Buffer.from(await res.arrayBuffer())
  const expected = uploadMb * 1024 * 1024
  record('download-' + uploadMb + 'mb', bytes.length === expected ? PASS : FAIL, `${bytes.length} of ${expected} bytes returned${bytes.length === expected ? '' : ' — truncated by the proxy'}`)
}

async function checkSession() {
  const { res } = await request('/api/me', { headers: authHeaders() })
  if (res.status === 401) return record('session', SKIP, 'no credential: pass --cookie to prove the session survives the proxy')
  const ok = res.status === 200
  record('session', ok ? PASS : FAIL, ok ? 'session accepted through the proxy' : `got ${res.status}`, { status: res.status })
}

// The AI Coach holds a request for minutes. A proxy that times out at 30 s breaks it silently.
async function checkCoach() {
  const { body } = await request('/api/config')
  const on = /"coach"\s*:/.test(body)
  record('coach-latency', SKIP, on ? 'coach is on: run the slowest real request by hand and time it' : 'coach is off on this instance — not measurable, not a risk today')
}

console.log(`Measuring ${base} (upload ${uploadMb} MB)\n`)
try {
  await checkHealth()
  await checkPreflight()
  await checkOriginRefusal()
  await checkHeaders()
  await checkStaticMedia()
  const hash = await checkUpload()
  await checkDownload(hash)
  await checkSession()
  await checkCoach()
} catch (e) {
  // A typo'd hostname is the likeliest first run, and a stack trace is not an answer to it.
  console.error(`\ncould not reach ${base}: ${e.cause?.code || e.message}`)
  process.exit(2)
}

const failed = results.filter(r => r.state === FAIL)
const skipped = results.filter(r => r.state === SKIP)
const summary = { base, measuredAt: new Date().toISOString(), uploadMb, results }
const evidenceDir = join(ROOT, 'docs/evidence')
mkdirSync(evidenceDir, { recursive: true })
const evidenceFile = join(evidenceDir, `deploy-spike-${new Date().toISOString().slice(0, 10)}.json`)
writeFileSync(evidenceFile, JSON.stringify(summary, null, 2) + '\n')

console.log(`\n${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} not measured`)
console.log(`Evidence: ${evidenceFile}`)
console.log(failed.length ? 'VERDICT: the platform contract is not met — see the runbook Key Decisions table.' : skipped.length ? 'VERDICT: incomplete. A skipped check is not a pass.' : 'VERDICT: contract met. Proceed to Phase 1.')
process.exitCode = failed.length ? 1 : skipped.length ? 2 : 0
