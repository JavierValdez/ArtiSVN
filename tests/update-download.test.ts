import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import {
  DEFAULT_ALLOWED_UPDATE_HOSTS,
  fetchWithValidatedRedirects,
  isAllowedUpdateUrl,
  parseReleaseMetadata
} from '../src/main/services/app-update-source'
import { downloadVerifiedFile, verifyExistingDownload } from '../src/main/services/update-download'

const PAYLOAD = Buffer.from('instalador de prueba ArtiSVN '.repeat(100))
const OTHER = Buffer.alloc(PAYLOAD.length, 0x41) // same size, different content
const SHA512 = createHash('sha512').update(PAYLOAD).digest('base64')
const SHA256 = createHash('sha256').update(PAYLOAD).digest('hex')
const ASSET_URL = 'https://storage.googleapis.com/artictools-releases/artisvn/releases/v9.9.9/ArtiSVN.dmg'

const root = mkdtempSync(join(tmpdir(), 'artisvn-update-'))
after(() => rmSync(root, { recursive: true, force: true }))

function bodyResponse(buffer: Buffer, headers: Record<string, string> = {}): Response {
  return new Response(buffer, { status: 200, headers: { 'content-length': String(buffer.length), ...headers } })
}

describe('update metadata', () => {
  test('parses sha512 per file and top-level path checksum', () => {
    const metadata = parseReleaseMetadata(
      `version: 9.9.9\nfiles:\n  - url: v9.9.9/ArtiSVN.dmg\n    sha512: ${SHA512}\n    size: ${PAYLOAD.length}\n  - url: v9.9.9/ArtiSVN.zip\n    sha512: zzz\n    size: 10\npath: v9.9.9/ArtiSVN.dmg\nsha512: ${SHA512}\n`,
      'https://storage.googleapis.com/artictools-releases/artisvn/releases'
    )
    assert.equal(metadata.files[0].sha512, SHA512)
    assert.equal(metadata.files[0].size, PAYLOAD.length)
    assert.equal(metadata.files[1].sha512, 'zzz')
  })

  test('only HTTPS URLs on allowlisted hosts are accepted', () => {
    assert.equal(isAllowedUpdateUrl(ASSET_URL, DEFAULT_ALLOWED_UPDATE_HOSTS), true)
    assert.equal(isAllowedUpdateUrl(ASSET_URL.replace('https:', 'http:'), DEFAULT_ALLOWED_UPDATE_HOSTS), false)
    assert.equal(isAllowedUpdateUrl('https://evil.example/ArtiSVN.dmg', DEFAULT_ALLOWED_UPDATE_HOSTS), false)
    assert.equal(isAllowedUpdateUrl('https://storage.googleapis.com.evil.example/x', DEFAULT_ALLOWED_UPDATE_HOSTS), false)
    assert.equal(isAllowedUpdateUrl('https://user:pass@github.com/x', DEFAULT_ALLOWED_UPDATE_HOSTS), false)
  })

  test('redirects are followed only to allowlisted HTTPS hosts', async () => {
    const hops: string[] = []
    const okFetch: typeof fetch = async (input) => {
      hops.push(String(input))
      if (String(input).startsWith('https://github.com/')) {
        return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/a/b' } })
      }
      return bodyResponse(PAYLOAD)
    }
    const response = await fetchWithValidatedRedirects(okFetch, 'https://github.com/x/releases/download/v1/a.dmg', {}, DEFAULT_ALLOWED_UPDATE_HOSTS)
    assert.equal(response.status, 200)
    assert.deepEqual(hops, ['https://github.com/x/releases/download/v1/a.dmg', 'https://release-assets.githubusercontent.com/a/b'])

    const toHttp: typeof fetch = async () => new Response(null, { status: 302, headers: { location: 'http://github.com/a' } })
    await assert.rejects(fetchWithValidatedRedirects(toHttp, 'https://github.com/a', {}, DEFAULT_ALLOWED_UPDATE_HOSTS), /no permitida/)

    const toEvil: typeof fetch = async () => new Response(null, { status: 301, headers: { location: 'https://cdn.evil.example/a' } })
    await assert.rejects(fetchWithValidatedRedirects(toEvil, 'https://github.com/a', {}, DEFAULT_ALLOWED_UPDATE_HOSTS), /no permitida/)

    const loop: typeof fetch = async () => new Response(null, { status: 302, headers: { location: 'https://github.com/loop' } })
    await assert.rejects(fetchWithValidatedRedirects(loop, 'https://github.com/loop', {}, DEFAULT_ALLOWED_UPDATE_HOSTS), /Demasiadas/)
  })
})

describe('verified installer download', () => {
  test('downloads, verifies sha512 and size, then renames atomically', async () => {
    const target = join(root, 'ok.dmg')
    await downloadVerifiedFile({
      asset: { name: 'ok.dmg', url: ASSET_URL, size: PAYLOAD.length, sha512: SHA512 },
      targetPath: target,
      allowedHosts: DEFAULT_ALLOWED_UPDATE_HOSTS,
      fetchImpl: async () => bodyResponse(PAYLOAD)
    })
    assert.deepEqual(readFileSync(target), PAYLOAD)
    assert.equal(existsSync(`${target}.download`), false)
  })

  test('accepts a GitHub sha256 digest when no sha512 is available', async () => {
    const target = join(root, 'gh.dmg')
    await downloadVerifiedFile({
      asset: { name: 'gh.dmg', url: 'https://github.com/a/gh.dmg', size: PAYLOAD.length, sha256: SHA256 },
      targetPath: target,
      allowedHosts: DEFAULT_ALLOWED_UPDATE_HOSTS,
      fetchImpl: async () => bodyResponse(PAYLOAD)
    })
    assert.deepEqual(readFileSync(target), PAYLOAD)
  })

  test('rejects corrupted content of the same size and leaves no file behind', async () => {
    const target = join(root, 'corrupt.dmg')
    await assert.rejects(downloadVerifiedFile({
      asset: { name: 'corrupt.dmg', url: ASSET_URL, size: OTHER.length, sha512: SHA512 },
      targetPath: target,
      allowedHosts: DEFAULT_ALLOWED_UPDATE_HOSTS,
      fetchImpl: async () => bodyResponse(OTHER)
    }), /checksum/)
    assert.equal(existsSync(target), false)
    assert.equal(existsSync(`${target}.download`), false)
  })

  test('rejects truncated downloads and oversize bodies', async () => {
    const short = PAYLOAD.subarray(0, PAYLOAD.length - 10)
    await assert.rejects(downloadVerifiedFile({
      asset: { name: 't.dmg', url: ASSET_URL, size: PAYLOAD.length, sha512: SHA512 },
      targetPath: join(root, 't.dmg'),
      allowedHosts: DEFAULT_ALLOWED_UPDATE_HOSTS,
      fetchImpl: async () => new Response(short, { status: 200 })
    }), /incompleto/)
    await assert.rejects(downloadVerifiedFile({
      asset: { name: 'big.dmg', url: ASSET_URL, size: 10, sha512: SHA512 },
      targetPath: join(root, 'big.dmg'),
      allowedHosts: DEFAULT_ALLOWED_UPDATE_HOSTS,
      fetchImpl: async () => new Response(PAYLOAD, { status: 200 })
    }), /excede/)
  })

  test('rejects HTTP asset URLs, invalid redirects and assets without checksum', async () => {
    let fetched = false
    await assert.rejects(downloadVerifiedFile({
      asset: { name: 'h.dmg', url: ASSET_URL.replace('https:', 'http:'), size: PAYLOAD.length, sha512: SHA512 },
      targetPath: join(root, 'h.dmg'),
      allowedHosts: DEFAULT_ALLOWED_UPDATE_HOSTS,
      fetchImpl: async () => { fetched = true; return bodyResponse(PAYLOAD) }
    }), /no permitida/)
    assert.equal(fetched, false)

    await assert.rejects(downloadVerifiedFile({
      asset: { name: 'r.dmg', url: 'https://github.com/a/r.dmg', size: PAYLOAD.length, sha512: SHA512 },
      targetPath: join(root, 'r.dmg'),
      allowedHosts: DEFAULT_ALLOWED_UPDATE_HOSTS,
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/r.dmg' } })
    }), /no permitida/)

    await assert.rejects(downloadVerifiedFile({
      asset: { name: 'n.dmg', url: ASSET_URL, size: PAYLOAD.length },
      targetPath: join(root, 'n.dmg'),
      allowedHosts: DEFAULT_ALLOWED_UPDATE_HOSTS,
      fetchImpl: async () => bodyResponse(PAYLOAD)
    }), /checksum verificable/)
  })

  test('an existing download of the same name and size is re-hashed before reuse', async () => {
    const good = join(root, 'existing-good.dmg')
    const bad = join(root, 'existing-bad.dmg')
    writeFileSync(good, PAYLOAD)
    writeFileSync(bad, OTHER)
    const asset = { name: 'x.dmg', url: ASSET_URL, size: PAYLOAD.length, sha512: SHA512 }
    assert.equal(await verifyExistingDownload(good, asset), true)
    assert.equal(await verifyExistingDownload(bad, asset), false)
    assert.equal(await verifyExistingDownload(good, { ...asset, sha512: null }), false)
  })
})
