const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');
const { BuildcurlServer } = require('../buildcurl-server');

const execFileAsync = promisify(execFile);

async function requestArchive(server, cacheRoot, request, expectedStatus) {
  const query = new URLSearchParams(request);
  const archivePath = path.join(cacheRoot, `${request.recipe}-${request.version}-${expectedStatus}.tgz`);
  const result = await new Promise((resolve, reject) => {
    const clientRequest = http.get(`${server.url}?${query}`, async (response) => {
      try {
        if (response.statusCode !== 200) {
          let body = '';
          for await (const chunk of response) body += chunk;
          throw new Error(`${request.recipe} failed: ${body.trim()}`);
        }
        await pipeline(response, fs.createWriteStream(archivePath, { flags: 'wx' }));
        resolve(response.headers);
      } catch (error) {
        reject(error);
      }
    });
    clientRequest.once('error', reject);
  });
  assert.equal(result['x-pkgr-cache'], expectedStatus, request.recipe);
  await execFileAsync('tar', ['-tzf', archivePath, './compile.log']);
  return archivePath;
}

async function assertArchiveContains(archivePath, pattern) {
  const { stdout } = await execFileAsync('tar', ['-tzf', archivePath]);
  assert.match(stdout, pattern);
}

async function runArchives(image, archives, command) {
  const args = ['run', '--rm', '--platform', 'linux/amd64'];
  const setup = [];
  const initializedPrefixes = new Set();
  for (const [index, archive] of archives.entries()) {
    const mount = `/archives/${index}.tgz`;
    args.push('-v', `${path.resolve(archive.path)}:${mount}:ro`);
    if (!initializedPrefixes.has(archive.prefix)) {
      setup.push(`rm -rf '${archive.prefix}'`, `mkdir -p '${archive.prefix}'`);
      initializedPrefixes.add(archive.prefix);
    }
    setup.push(`tar xzf '${mount}' -C '${archive.prefix}'`);
  }
  args.push('--entrypoint', '/bin/bash', image, '-lc', `${setup.join(' && ')} && ${command}`);
  return execFileAsync('docker', args);
}

async function assertBinary(image, archivePath, prefix, binary, expectedVersion) {
  const { stdout, stderr } = await runArchives(
    image,
    [{ path: archivePath, prefix }],
    `'${prefix}/bin/${binary}' --version`
  );
  assert.match(`${stdout}${stderr}`, new RegExp(expectedVersion.replaceAll('.', '\\.')));
}

async function assertGemBinary(image, rubyArchive, gemArchive, binary, expectedOutput) {
  const { stdout, stderr } = await runArchives(
    image,
    [
      { path: rubyArchive, prefix: '/app/vendor/ruby' },
      { path: gemArchive, prefix: '/usr/local' }
    ],
    `env PATH=/usr/local/bin:/app/vendor/ruby/bin:$PATH GEM_HOME=/usr/local GEM_PATH=/usr/local /usr/local/bin/${binary} --version`
  );
  assert.match(`${stdout}${stderr}`, expectedOutput);
}

async function run() {
  const target = (process.env.TARGET || 'ubuntu:24.04').replace('/', ':');
  const pkgrVersion = process.env.PKGR_VERSION || 'master';
  const recipeFilter = process.env.E2E_RECIPE || '';
  const pkgrRevision = process.env.PKGR_REVISION;
  if ((!recipeFilter || ['rubygem-pkgr', 'pkgr'].includes(recipeFilter)) &&
      (!pkgrRevision || !/^[0-9a-f]{40}$/.test(pkgrRevision))) {
    throw new Error('PKGR_REVISION must be a full Git commit SHA');
  }

  const image = process.env.PKGR_IMAGE || `ghcr.io/pkgr/pkgr/${target}-${pkgrVersion}`;
  if (!process.env.PKGR_IMAGE) {
    await execFileAsync('docker', ['pull', '--platform', 'linux/amd64', image]);
  }
  const { stdout } = await execFileAsync('docker', [
    'image', 'inspect', '--format', '{{.Id}}|{{.Architecture}}', image
  ]);
  const [imageId, architecture] = stdout.trim().split('|');
  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pkgr-recipe-e2e-'));
  const legacyRuby = new Set(['el:8', 'sles:12']).has(target);
  const rubyVersion = legacyRuby ? '2.7.7' : '3.3.10';
  const nodeVersion = target === 'sles:12' ? '16.18.1' : '24.13.0';
  const bundlerVersion = legacyRuby ? '2.4.22' : '2.7.2';
  const pkgrRubyVersion = legacyRuby ? '2.7.7' : '3.4.9';

  const server = new BuildcurlServer({
    image, imageId, architecture, target,
    cachePrefix: 'e2e', cacheRoot,
    core: {
      info: (message) => console.log(message),
      warning: (message) => console.warn(message),
      error: (message) => console.error(message)
    }
  });
  await server.start();

  try {
    const recipes = [
      { recipe: 'ruby', version: rubyVersion, target, prefix: '/usr/local' },
      { recipe: 'rubygem-bundler', version: bundlerVersion, target, prefix: '/usr/local' },
      { recipe: 'rubygem-pkgr', version: pkgrRevision, target, prefix: '/usr/local' },
      { recipe: 'node', version: nodeVersion, target, prefix: '/usr/local' },
      { recipe: 'python', version: '3.10.8', target, prefix: '/usr/local' },
      { recipe: 'pkgr', version: pkgrRevision, target, prefix: '/usr/local' }
    ].filter(({ recipe }) => !recipeFilter || recipe === recipeFilter);

    if (recipes.length === 0) throw new Error(`Unknown E2E_RECIPE: ${recipeFilter}`);

    const archives = new Map();
    for (const recipe of recipes) {
      const cold = await requestArchive(server, cacheRoot, recipe, 'miss');
      await requestArchive(server, cacheRoot, recipe, 'hit');
      archives.set(recipe.recipe, cold);
    }

    for (const dependency of [
      { recipe: 'libyaml', version: '0.2.5', target, prefix: '/usr/local' },
      { recipe: 'libffi', version: '3.2.1', target, prefix: '/usr/local' },
      { recipe: 'sqlite', version: '3.7.9', target, prefix: '/usr/local' }
    ].filter(({ recipe }) => {
      if (!recipeFilter) return true;
      if (recipeFilter === 'ruby') return recipe !== 'sqlite';
      if (recipeFilter === 'python') return recipe === 'sqlite';
      return false;
    })) {
      await requestArchive(server, cacheRoot, dependency, 'hit');
    }

    if (archives.has('ruby')) await assertBinary(image, archives.get('ruby'), '/usr/local', 'ruby', rubyVersion);
    if (archives.has('node')) await assertBinary(image, archives.get('node'), '/usr/local', 'node', nodeVersion);
    if (archives.has('python')) await assertBinary(image, archives.get('python'), '/usr/local', 'python', '3.10.8');
    if (archives.has('rubygem-bundler')) {
      const bundlerRuby = await requestArchive(server, cacheRoot, {
        recipe: 'ruby', version: rubyVersion, target, prefix: '/app/vendor/ruby'
      }, 'hit');
      await assertGemBinary(image, bundlerRuby, archives.get('rubygem-bundler'), 'bundle', new RegExp(`Bundler version ${bundlerVersion.replaceAll('.', '\\.')}`));
      await assertArchiveContains(archives.get('rubygem-bundler'), /\.\/bin\/bundle\n/);
    }
    if (archives.has('rubygem-pkgr')) {
      const pkgrRuby = await requestArchive(server, cacheRoot, {
        recipe: 'ruby', version: pkgrRubyVersion, target, prefix: '/app/vendor/ruby'
      }, 'hit');
      await assertGemBinary(image, pkgrRuby, archives.get('rubygem-pkgr'), 'pkgr', /pkgr/i);
      await assertArchiveContains(archives.get('rubygem-pkgr'), /\.\/bin\/pkgr\n/);
    }
    if (archives.has('pkgr')) {
      await runArchives(image, [{ path: archives.get('pkgr'), prefix: '/usr/local' }], '/usr/local/bin/pkgr --version');
      await assertArchiveContains(archives.get('pkgr'), /\.\/bin\/pkgr\n/);
    }
  } finally {
    await server.close();
    await fs.promises.rm(cacheRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
