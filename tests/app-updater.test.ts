import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_RELEASES_BASE_URL,
  GITHUB_LATEST_RELEASE_URL,
  fetchLatestRelease,
  getReleasesBaseUrl,
  pickCompatibleAsset,
  type UpdateDownloadAsset
} from '../src/main/services/app-update-source'

function githubRelease(version: string, assets: unknown[] = []): Record<string, unknown> {
  return {
    tag_name: `v${version}`,
    name: `ArtiSVN ${version}`,
    published_at: '2026-07-15T12:00:00Z',
    body: 'Notas',
    html_url: `https://github.com/JavierValdez/ArtiSVN/releases/tag/v${version}`,
    assets
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function yamlResponse(version: string, fileName: string): Response {
  return new Response(
    `version: ${version}\nreleaseDate: '2026-07-15T12:00:00Z'\nfiles:\n  - url: ${fileName}\n    size: 1234\n`,
    { status: 200, headers: { 'content-type': 'text/yaml' } }
  )
}

test('uses GitHub API and never contacts GCS when a compatible update exists', async () => {
  const calls: Array<{ url: string; userAgent: string | null }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      userAgent: new Headers(init?.headers).get('user-agent')
    })
    return jsonResponse(githubRelease('3.0.0', [{
      name: 'ArtiSVN-Mac-3.0.0-Installer.dmg',
      browser_download_url: 'https://github.com/download/ArtiSVN.dmg',
      size: 456,
      digest: `sha256:${'a'.repeat(64)}`
    }]))
  }

  const release = await fetchLatestRelease({
    currentVersion: '2.1.6',
    platform: 'darwin',
    fetchImpl
  })

  assert.equal(release.source, 'github')
  assert.equal(release.downloadAsset?.name, 'ArtiSVN-Mac-3.0.0-Installer.dmg')
  assert.equal(release.downloadAsset?.sha256, 'a'.repeat(64))
  assert.deepEqual(calls, [{ url: GITHUB_LATEST_RELEASE_URL, userAgent: 'ArtiSVN' }])
})

test('falls back to GCS (sha512 metadata) when the GitHub installer has no digest', async () => {
  const calls: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input)
    calls.push(url)
    if (url === GITHUB_LATEST_RELEASE_URL) {
      return jsonResponse(githubRelease('3.0.0', [{
        name: 'ArtiSVN-Mac-3.0.0-Installer.dmg',
        browser_download_url: 'https://github.com/download/ArtiSVN.dmg',
        size: 456
      }]))
    }
    return new Response(
      'version: 3.0.0\nfiles:\n  - url: v3.0.0/ArtiSVN-Mac-3.0.0-Installer.dmg\n    sha512: c2hhNTEyLWZpeHR1cmU=\n    size: 456\npath: v3.0.0/ArtiSVN-Mac-3.0.0-Installer.dmg\nsha512: c2hhNTEyLWZpeHR1cmU=\n',
      { status: 200 }
    )
  }
  const release = await fetchLatestRelease({ currentVersion: '2.2.1', platform: 'darwin', fetchImpl, env: {} })
  assert.equal(release.source, 'gcs')
  assert.equal(release.downloadAsset?.sha512, 'c2hhNTEyLWZpeHR1cmU=')
  assert.equal(release.downloadAsset?.size, 456)
  assert.equal(calls.length, 2)
})

test('GitHub assets with http download URLs are ignored', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) === GITHUB_LATEST_RELEASE_URL) {
      return jsonResponse(githubRelease('3.0.0', [{
        name: 'ArtiSVN-Mac-3.0.0-Installer.dmg',
        browser_download_url: 'http://github.com/download/ArtiSVN.dmg',
        digest: `sha256:${'b'.repeat(64)}`
      }]))
    }
    return new Response('', { status: 503 })
  }
  await assert.rejects(fetchLatestRelease({ currentVersion: '2.2.1', platform: 'darwin', fetchImpl, env: {} }), /503/)
})

test('treats a valid GitHub no-update response as authoritative without GCS', async () => {
  const calls: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(String(input))
    return jsonResponse(githubRelease('2.1.6'))
  }

  const release = await fetchLatestRelease({
    currentVersion: '2.1.6',
    platform: 'darwin',
    fetchImpl
  })

  assert.equal(release.source, 'github')
  assert.equal(release.downloadAsset, null)
  assert.deepEqual(calls, [GITHUB_LATEST_RELEASE_URL])
})

test('falls back to GCS when a newer GitHub release lacks a compatible installer', async () => {
  const calls: string[] = []
  const baseUrl = 'https://fallback.example/artisvn/releases'
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input)
    calls.push(url)
    if (url === GITHUB_LATEST_RELEASE_URL) {
      return jsonResponse(githubRelease('3.0.0', [{
        name: 'ArtiSVN-3.0.0.AppImage',
        browser_download_url: 'https://github.com/download/ArtiSVN.AppImage'
      }]))
    }
    return yamlResponse('3.0.0', 'ArtiSVN-Mac-3.0.0-Installer.dmg')
  }

  const release = await fetchLatestRelease({
    currentVersion: '2.1.6',
    platform: 'darwin',
    fetchImpl,
    env: {
      ARTISVN_RELEASES_BASE_URL: baseUrl,
      JAVISVN_RELEASES_BASE_URL: 'https://legacy.example/releases'
    }
  })

  assert.equal(release.source, 'gcs')
  assert.equal(release.downloadAsset?.url, `${baseUrl}/ArtiSVN-Mac-3.0.0-Installer.dmg`)
  assert.deepEqual(calls, [GITHUB_LATEST_RELEASE_URL, `${baseUrl}/latest-mac.yml`])
})

test('falls back to GCS for GitHub errors and invalid responses', async (t) => {
  for (const scenario of [
    { name: 'transport error', first: () => { throw new Error('offline') } },
    { name: 'HTTP error', first: () => new Response('', { status: 503 }) },
    { name: 'invalid payload', first: () => jsonResponse({ assets: [] }) },
    { name: 'invalid version', first: () => jsonResponse(githubRelease('not-semver', [])) }
  ]) {
    await t.test(scenario.name, async () => {
      let call = 0
      const fetchImpl: typeof fetch = async () => {
        call += 1
        if (call === 1) return scenario.first()
        return yamlResponse('3.1.0', 'ArtiSVN-Windows-3.1.0-Setup.exe')
      }

      const release = await fetchLatestRelease({
        currentVersion: '2.1.6',
        platform: 'win32',
            fetchImpl,
        env: {}
      })

      assert.equal(release.source, 'gcs')
      assert.equal(release.downloadAsset?.name, 'ArtiSVN-Windows-3.1.0-Setup.exe')
      assert.equal(call, 2)
    })
  }
})

test('release URL aliases prefer ARTISVN over JAVISVN and retain the new default', () => {
  assert.equal(getReleasesBaseUrl({
    ARTISVN_RELEASES_BASE_URL: 'https://new.example/releases/',
    JAVISVN_RELEASES_BASE_URL: 'https://old.example/releases/'
  }), 'https://new.example/releases')
  assert.equal(getReleasesBaseUrl({
    JAVISVN_RELEASES_BASE_URL: 'https://old.example/releases/'
  }), 'https://old.example/releases')
  assert.equal(getReleasesBaseUrl({}), DEFAULT_RELEASES_BASE_URL)
})

test('picker only returns installers compatible with the requested platform', () => {
  const assets: UpdateDownloadAsset[] = [
    { name: 'ArtiSVN.AppImage', url: 'https://example/AppImage', size: null },
    { name: 'ArtiSVN.exe', url: 'https://example/exe', size: null },
    { name: 'ArtiSVN.dmg', url: 'https://example/dmg', size: null }
  ]

  assert.equal(pickCompatibleAsset(assets, 'darwin')?.name, 'ArtiSVN.dmg')
  assert.equal(pickCompatibleAsset(assets, 'win32')?.name, 'ArtiSVN.exe')
  assert.equal(pickCompatibleAsset([
    { name: 'ArtiSVN-Mac.zip', url: 'https://example/mac.zip', size: null }
  ], 'win32'), null)
  assert.equal(pickCompatibleAsset(assets, 'linux'), null)
})

test('falls back to GCS when the GitHub request times out', async () => {
  let call = 0
  const fetchImpl: typeof fetch = async (_input, init) => {
    call += 1
    if (call === 1) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    }
    return yamlResponse('3.2.0', 'ArtiSVN-Mac-3.2.0-Installer.dmg')
  }

  const release = await fetchLatestRelease({
    currentVersion: '2.1.6',
    platform: 'darwin',
    fetchImpl,
    env: {},
    timeoutMs: 5
  })

  assert.equal(release.source, 'gcs')
  assert.equal(release.downloadAsset?.name, 'ArtiSVN-Mac-3.2.0-Installer.dmg')
  assert.equal(call, 2)
})
