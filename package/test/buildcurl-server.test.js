const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { promisify } = require('node:util');

const {
  BuildcurlServer,
  artifactDigest,
  cacheKey,
  validateRequest
} = require('../buildcurl-server');
const { withInternalBuildcurlUrl } = require('../environment');

const execFileAsync = promisify(execFile);

async function createArchive(archivePath, contents = 'ok') {
  const source = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pkgr-archive-'));
  await fs.promises.writeFile(path.join(source, 'compile.log'), 'compiled\n');
  await fs.promises.writeFile(path.join(source, 'payload'), contents);
  await execFileAsync('tar', ['-czf', archivePath, '-C', source, '.']);
  await fs.promises.rm(source, { recursive: true, force: true });
}

function serverOptions(cacheRoot, overrides = {}) {
  return {
    image: 'pkgr:test',
    imageId: 'sha256:image',
    architecture: 'amd64',
    target: 'ubuntu:24.04',
    cachePrefix: 'v1',
    cacheRoot,
    ...overrides
  };
}

test('validates the local protocol and allow-list', () => {
  const valid = validateRequest(
    new URL('http://127.0.0.1/?recipe=ruby&version=3.3.10&target=ubuntu:24.04&prefix=/usr/local'),
    'ubuntu:24.04'
  );
  assert.deepEqual(valid, {
    recipe: 'ruby', version: '3.3.10', target: 'ubuntu:24.04', prefix: '/usr/local'
  });

  assert.throws(
    () => validateRequest(new URL('http://127.0.0.1/?recipe=custom&version=1&target=ubuntu:24.04'), 'ubuntu:24.04'),
    /Unknown recipe/
  );
  assert.throws(
    () => validateRequest(new URL('http://127.0.0.1/?recipe=ruby&version=1&target=el:9'), 'ubuntu:24.04'),
    /Target mismatch/
  );
  assert.throws(
    () => validateRequest(new URL('http://127.0.0.1/?recipe=ruby&version=1&target=ubuntu:24.04&prefix=/../etc'), 'ubuntu:24.04'),
    /Invalid prefix/
  );
});

test('cache identity includes every compatibility input', () => {
  const request = {
    cachePrefix: 'v1', target: 'ubuntu:24.04', architecture: 'amd64',
    imageId: 'sha256:a', recipe: 'ruby', version: '3.3.10', prefix: '/usr/local'
  };
  const original = artifactDigest(request);
  for (const [field, value] of [
    ['cachePrefix', 'v2'], ['target', 'el:9'], ['architecture', 'arm64'],
    ['imageId', 'sha256:b'], ['recipe', 'python'], ['version', '3.3.9'],
    ['prefix', '/app/vendor/ruby']
  ]) {
    assert.notEqual(artifactDigest({ ...request, [field]: value }), original, field);
  }
  assert.match(cacheKey(request), /^pkgr-toolchain-v1-ubuntu-24.04-ruby-/);
});

test('internal buildcurl URL follows user values and therefore takes precedence', () => {
  assert.equal(
    withInternalBuildcurlUrl('FOO=one\nBUILDCURL_URL=https://example.test\nBAR=two', 'http://127.0.0.1:1234/'),
    'FOO=one\nBUILDCURL_URL=https://example.test\nBAR=two\nBUILDCURL_URL=http://127.0.0.1:1234/'
  );
});

test('builds once, serves a warm hit, and coalesces concurrent requests', async (t) => {
  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pkgr-server-'));
  let builds = 0;
  let releaseBuild;
  const buildStarted = new Promise((resolve) => { releaseBuild = resolve; });
  let continueBuild;
  const buildBlocked = new Promise((resolve) => { continueBuild = resolve; });

  const server = new BuildcurlServer(serverOptions(cacheRoot, {
    buildArtifact: async (_request, archivePath) => {
      builds += 1;
      releaseBuild();
      await buildBlocked;
      await createArchive(archivePath);
    }
  }));
  await server.start();
  t.after(async () => {
    await server.close();
    await fs.promises.rm(cacheRoot, { recursive: true, force: true });
  });

  const url = `${server.url}?recipe=ruby&version=3.3.10&target=ubuntu:24.04`;
  const firstPromise = fetch(url);
  await buildStarted;
  const secondPromise = fetch(url);
  continueBuild();

  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  await Promise.all([first.arrayBuffer(), second.arrayBuffer()]);
  assert.equal(builds, 1);
  assert.deepEqual(
    [first.headers.get('x-pkgr-cache'), second.headers.get('x-pkgr-cache')].sort(),
    ['hit', 'miss']
  );

  const warm = await fetch(url);
  await warm.arrayBuffer();
  assert.equal(warm.headers.get('x-pkgr-cache'), 'hit');
  assert.equal(builds, 1);
});

test('rebuilds a corrupt local archive', async (t) => {
  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pkgr-server-'));
  const request = {
    cachePrefix: 'v1', target: 'ubuntu:24.04', architecture: 'amd64',
    imageId: 'sha256:image', recipe: 'node', version: '24.13.0', prefix: '/usr/local'
  };
  const artifactDir = path.join(cacheRoot, artifactDigest(request));
  await fs.promises.mkdir(artifactDir, { recursive: true });
  await fs.promises.writeFile(path.join(artifactDir, 'artifact.tgz'), 'corrupt');
  let builds = 0;

  const server = new BuildcurlServer(serverOptions(cacheRoot, {
    buildArtifact: async (_request, archivePath) => {
      builds += 1;
      await createArchive(archivePath);
    }
  }));
  await server.start();
  t.after(async () => {
    await server.close();
    await fs.promises.rm(cacheRoot, { recursive: true, force: true });
  });

  const response = await fetch(`${server.url}?recipe=node&version=24.13.0&target=ubuntu:24.04`);
  await response.arrayBuffer();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-pkgr-cache'), 'miss');
  assert.equal(builds, 1);
});

test('rejects a corrupt restored cache entry and replaces it', async (t) => {
  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pkgr-server-'));
  let builds = 0;
  const cache = {
    async restoreCache(paths, key) {
      await fs.promises.writeFile(path.join(paths[0], 'artifact.tgz'), 'not a tar archive');
      return key;
    },
    async saveCache() {}
  };
  const server = new BuildcurlServer(serverOptions(cacheRoot, {
    cache,
    buildArtifact: async (_request, archivePath) => {
      builds += 1;
      await createArchive(archivePath, 'replacement');
    }
  }));
  await server.start();
  t.after(async () => {
    await server.close();
    await fs.promises.rm(cacheRoot, { recursive: true, force: true });
  });

  const response = await fetch(`${server.url}?recipe=python&version=3.10.8&target=ubuntu:24.04`);
  await response.arrayBuffer();
  assert.equal(response.headers.get('x-pkgr-cache'), 'miss');
  assert.equal(builds, 1);
});

test('restores a recovery cache after an immutable exact entry is corrupt', async (t) => {
  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pkgr-server-'));
  let restores = 0;
  let builds = 0;
  const cache = {
    async restoreCache(paths, key) {
      restores += 1;
      const archivePath = path.join(paths[0], 'artifact.tgz');
      if (restores === 1) {
        await fs.promises.writeFile(archivePath, 'corrupt exact cache');
        return key;
      }
      await createArchive(archivePath, 'recovered');
      return `${key}-from-prefix`;
    },
    async saveCache() {}
  };
  const server = new BuildcurlServer(serverOptions(cacheRoot, {
    cache,
    buildArtifact: async () => { builds += 1; }
  }));
  await server.start();
  t.after(async () => {
    await server.close();
    await fs.promises.rm(cacheRoot, { recursive: true, force: true });
  });

  const response = await fetch(`${server.url}?recipe=python&version=3.10.8&target=ubuntu:24.04`);
  await response.arrayBuffer();
  assert.equal(response.headers.get('x-pkgr-cache'), 'hit');
  assert.equal(restores, 2);
  assert.equal(builds, 0);
});

test('returns a failed gateway response when a recipe fails', async (t) => {
  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pkgr-server-'));
  const server = new BuildcurlServer(serverOptions(cacheRoot, {
    buildArtifact: async () => { throw new Error('compiler exploded'); }
  }));
  await server.start();
  t.after(async () => {
    await server.close();
    await fs.promises.rm(cacheRoot, { recursive: true, force: true });
  });

  const response = await fetch(`${server.url}?recipe=python&version=3.10.8&target=ubuntu:24.04`);
  assert.equal(response.status, 502);
  assert.match(await response.text(), /compiler exploded/);
});

test('times out a compiler container and requests scoped cleanup', async () => {
  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pkgr-server-'));
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
    }
    kill() { this.emit('close', 143); }
  }

  const child = new FakeChild();
  const server = new BuildcurlServer(serverOptions(cacheRoot, {
    timeoutMs: 10,
    spawn: () => child
  }));
  server.url = 'http://127.0.0.1:1234/';
  let removed = false;
  server.forceRemoveContainer = () => { removed = true; };

  await assert.rejects(
    server.runCompilerContainer(
      { recipe: 'ruby', version: '3.3.10', target: 'ubuntu:24.04', prefix: '/usr/local' },
      path.join(cacheRoot, 'artifact.tgz')
    ),
    /timed out/
  );
  assert.equal(removed, true);
  await fs.promises.rm(cacheRoot, { recursive: true, force: true });
});

test('close removes every compiler container still owned by the session', async () => {
  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pkgr-server-'));
  const server = new BuildcurlServer(serverOptions(cacheRoot));
  server.activeContainers.add('pkgr-buildcurl-session-one');
  server.activeContainers.add('pkgr-buildcurl-session-two');
  const removed = [];
  server.forceRemoveContainer = (name) => removed.push(name);

  await server.close();

  assert.deepEqual(removed.sort(), [
    'pkgr-buildcurl-session-one',
    'pkgr-buildcurl-session-two'
  ]);
  await fs.promises.rm(cacheRoot, { recursive: true, force: true });
});

test('runs no more than eight nested compiler containers at once', async () => {
  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pkgr-server-'));
  const server = new BuildcurlServer(serverOptions(cacheRoot));
  let active = 0;
  let maximum = 0;
  server.runCompilerContainer = async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  };

  await Promise.all(Array.from({ length: 12 }, (_, index) => server.buildArtifact(
    { recipe: 'node', version: `24.13.${index}`, target: 'ubuntu:24.04', prefix: '/usr/local', nested: true },
    path.join(cacheRoot, `${index}.tgz`)
  )));

  assert.equal(maximum, 8);
  await fs.promises.rm(cacheRoot, { recursive: true, force: true });
});

test('reserves nested compiler capacity for composite recipes', async () => {
  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pkgr-server-'));
  const server = new BuildcurlServer(serverOptions(cacheRoot));
  let active = 0;
  let maximum = 0;
  server.runCompilerContainer = async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  };

  await Promise.all(Array.from({ length: 4 }, (_, index) => server.buildArtifact(
    { recipe: 'pkgr', version: `abcdef${index}`, target: 'ubuntu:24.04', prefix: '/usr/local' },
    path.join(cacheRoot, `${index}.tgz`)
  )));

  assert.equal(maximum, 2);
  await fs.promises.rm(cacheRoot, { recursive: true, force: true });
});
