const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ALLOWED_RECIPES = new Set([
  'ruby',
  'rubygem-bundler',
  'rubygem-pkgr',
  'node',
  'python',
  'pkgr',
  'libyaml',
  'libffi',
  'sqlite'
]);

const VERSION_PATTERN = /^[a-zA-Z0-9][+._a-zA-Z0-9-]*$/;
const TARGET_PATTERN = /^[a-z0-9][._a-z0-9-]*:[a-zA-Z0-9][._a-zA-Z0-9-]*$/;
const PREFIX_PATTERN = /^\/[+._/a-zA-Z0-9-]+$/;
const RECIPE_RESERVATIONS = new Map([
  ['node', 1],
  ['libyaml', 1],
  ['libffi', 1],
  ['sqlite', 1],
  ['ruby', 2],
  ['python', 2],
  ['rubygem-bundler', 3],
  ['rubygem-pkgr', 3],
  ['pkgr', 4]
]);

class WeightedSemaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  async acquire(weight) {
    if (weight === 0) return;
    if (this.active + weight <= this.limit && this.waiters.length === 0) {
      this.active += weight;
      return;
    }
    await new Promise((resolve) => this.waiters.push({ resolve, weight }));
  }

  release(weight) {
    if (weight === 0) return;
    this.active -= weight;
    while (this.waiters.length > 0) {
      const next = this.waiters[0];
      if (this.active + next.weight > this.limit) return;
      this.waiters.shift();
      this.active += next.weight;
      next.resolve();
    }
  }
}

function artifactIdentity({ cachePrefix, target, architecture, imageId, recipe, version, prefix }) {
  return JSON.stringify({
    schema: 1,
    cachePrefix,
    target,
    architecture,
    imageId,
    recipe,
    version,
    prefix
  });
}

function artifactDigest(request) {
  return crypto.createHash('sha256').update(artifactIdentity(request)).digest('hex');
}

function cacheKey(request) {
  const target = request.target.replace(/[^a-zA-Z0-9._-]/g, '-');
  return `pkgr-toolchain-${request.cachePrefix}-${target}-${request.recipe}-${artifactDigest(request)}`;
}

function validateRequest(requestUrl, expectedTarget) {
  const recipe = requestUrl.searchParams.get('recipe') || '';
  const version = requestUrl.searchParams.get('version') || '';
  const target = requestUrl.searchParams.get('target') || '';
  const prefix = requestUrl.searchParams.get('prefix') || '/usr/local';

  if (!ALLOWED_RECIPES.has(recipe)) throw new RequestError(404, `Unknown recipe: ${recipe || '(empty)'}`);
  if (!VERSION_PATTERN.test(version)) throw new RequestError(400, 'Invalid version');
  if (!TARGET_PATTERN.test(target)) throw new RequestError(400, 'Invalid target');
  if (target !== expectedTarget) throw new RequestError(400, `Target mismatch: expected ${expectedTarget}`);
  if (prefix === '/' || prefix.split('/').includes('..') || !PREFIX_PATTERN.test(prefix)) {
    throw new RequestError(400, 'Invalid prefix');
  }

  return { recipe, version, target, prefix };
}

class RequestError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function commandSucceeded(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
  });
}

async function validateArchive(archivePath) {
  if (!fs.existsSync(archivePath)) return false;
  if (!(await commandSucceeded('tar', ['-tzf', archivePath]))) return false;
  return commandSucceeded('tar', ['-tzf', archivePath, './compile.log']);
}

class BuildcurlServer {
  constructor(options) {
    this.image = options.image;
    this.imageId = options.imageId;
    this.architecture = options.architecture;
    this.target = options.target;
    this.cachePrefix = options.cachePrefix;
    this.cacheRoot = options.cacheRoot;
    this.cache = options.cache || null;
    this.core = options.core || { info() {}, warning() {}, error() {} };
    this.spawn = options.spawn || spawn;
    this.buildArtifactOverride = options.buildArtifact || null;
    this.validateArchive = options.validateArchive || validateArchive;
    this.timeoutMs = options.timeoutMs || 45 * 60 * 1000;
    this.sessionId = options.sessionId || crypto.randomBytes(10).toString('hex');
    this.nestedToken = options.nestedToken || crypto.randomBytes(20).toString('hex');
    this.server = null;
    this.url = null;
    this.inFlight = new Map();
    this.pendingSaves = new Map();
    this.activeContainers = new Set();
    const maxConcurrentBuilds = options.maxConcurrentBuilds || 8;
    this.admissionSemaphore = new WeightedSemaphore(maxConcurrentBuilds);
    this.containerSemaphore = new WeightedSemaphore(maxConcurrentBuilds);
  }

  async start() {
    await fs.promises.mkdir(this.cacheRoot, { recursive: true });
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        this.core.error(error.stack || error.message);
        const statusCode = error instanceof RequestError ? error.statusCode : 502;
        if (!response.headersSent) response.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
        const prefix = error instanceof RequestError ? '' : 'Toolchain build failed: ';
        response.end(`${prefix}${error.message}\n`);
      });
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });

    const address = this.server.address();
    this.url = `http://127.0.0.1:${address.port}/`;
    this.core.info(`Local buildcurl server listening at ${this.url}`);
    return this.url;
  }

  async handle(request, response) {
    if (request.method !== 'GET') throw new RequestError(405, 'Only GET is supported');

    let recipeRequest;
    try {
      recipeRequest = validateRequest(new URL(request.url, this.url), this.target);
      recipeRequest.nested = request.headers['x-pkgr-nested-token'] === this.nestedToken;
    } catch (error) {
      if (!(error instanceof RequestError)) throw error;
      response.writeHead(error.statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(`${error.message}\n`);
      return;
    }

    const result = await this.getArtifact(recipeRequest);
    const stat = await fs.promises.stat(result.archivePath);
    response.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Length': stat.size,
      'X-Pkgr-Cache': result.cacheStatus
    });
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(result.archivePath);
      stream.once('error', reject);
      response.once('error', reject);
      response.once('finish', resolve);
      stream.pipe(response);
    });
  }

  requestWithCacheFields(recipeRequest) {
    return {
      ...recipeRequest,
      cachePrefix: this.cachePrefix,
      architecture: this.architecture,
      imageId: this.imageId
    };
  }

  async getArtifact(recipeRequest) {
    const fullRequest = this.requestWithCacheFields(recipeRequest);
    const digest = artifactDigest(fullRequest);

    if (this.inFlight.has(digest)) {
      const result = await this.inFlight.get(digest);
      return { archivePath: result.archivePath, cacheStatus: 'hit' };
    }

    const promise = this.restoreOrBuild(fullRequest, digest);
    this.inFlight.set(digest, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(digest);
    }
  }

  async restoreOrBuild(fullRequest, digest) {
    const artifactDir = path.join(this.cacheRoot, digest);
    const archivePath = path.join(artifactDir, 'artifact.tgz');
    const key = cacheKey(fullRequest);
    await fs.promises.mkdir(artifactDir, { recursive: true });

    if (await this.validateArchive(archivePath)) {
      this.core.info(`Toolchain cache hit: ${fullRequest.recipe} ${fullRequest.version}`);
      return { archivePath, cacheStatus: 'hit' };
    }

    let saveKey = key;
    if (this.cache) {
      try {
        const restoredKey = await this.cache.restoreCache([artifactDir], key);
        if (restoredKey && await this.validateArchive(archivePath)) {
          this.core.info(`Toolchain cache restored: ${fullRequest.recipe} ${fullRequest.version}`);
          return { archivePath, cacheStatus: 'hit' };
        }
        if (restoredKey) {
          this.core.warning(`Ignoring corrupt toolchain cache: ${restoredKey}`);
          await fs.promises.rm(artifactDir, { recursive: true, force: true });
          await fs.promises.mkdir(artifactDir, { recursive: true });
        }

        const recoveryPrefix = `${key}-recovery-`;
        const recoveredKey = await this.cache.restoreCache(
          [artifactDir],
          `${key}-recovery`,
          [recoveryPrefix]
        );
        if (recoveredKey && await this.validateArchive(archivePath)) {
          this.core.info(`Toolchain cache restored: ${fullRequest.recipe} ${fullRequest.version}`);
          return { archivePath, cacheStatus: 'hit' };
        }
        if (recoveredKey) {
          this.core.warning(`Ignoring corrupt toolchain cache: ${recoveredKey}`);
          await fs.promises.rm(artifactDir, { recursive: true, force: true });
          await fs.promises.mkdir(artifactDir, { recursive: true });
        }
        if (restoredKey) {
          const runId = process.env.GITHUB_RUN_ID || this.sessionId;
          const attempt = process.env.GITHUB_RUN_ATTEMPT || '1';
          saveKey = `${recoveryPrefix}${runId}-${attempt}`;
        }
      } catch (error) {
        this.core.warning(`Unable to restore ${fullRequest.recipe} ${fullRequest.version}: ${error.message}`);
      }
    }

    await fs.promises.rm(archivePath, { force: true });
    this.core.info(`Toolchain cache miss: ${fullRequest.recipe} ${fullRequest.version}`);
    await this.buildArtifact(fullRequest, archivePath);
    if (!(await this.validateArchive(archivePath))) {
      await fs.promises.rm(archivePath, { force: true });
      throw new Error(`Recipe ${fullRequest.recipe} produced an invalid archive`);
    }

    this.pendingSaves.set(saveKey, artifactDir);
    return { archivePath, cacheStatus: 'miss' };
  }

  async buildArtifact(request, archivePath) {
    if (this.buildArtifactOverride) {
      await this.buildArtifactOverride(request, archivePath);
      return;
    }

    const reservation = request.nested ? 0 : RECIPE_RESERVATIONS.get(request.recipe);
    await this.admissionSemaphore.acquire(reservation);
    try {
      await this.containerSemaphore.acquire(1);
      try {
        await this.runCompilerContainer(request, archivePath);
      } finally {
        this.containerSemaphore.release(1);
      }
    } finally {
      this.admissionSemaphore.release(reservation);
    }
  }

  runCompilerContainer(request, archivePath) {
    const requestId = crypto.randomBytes(6).toString('hex');
    const containerName = `pkgr-buildcurl-${this.sessionId}-${requestId}`;
    const temporaryPath = `${archivePath}.tmp-${requestId}`;
    const args = [
      'run', '--rm',
      '--platform', 'linux/amd64',
      '--network', 'host',
      '--add-host', 'buildcurl.com:127.0.0.1',
      '--add-host', 'barebuild.com:127.0.0.1',
      '--name', containerName,
      '--label', `io.pkgr.buildcurl.session=${this.sessionId}`,
      '-e', `BUILDCURL_URL=${this.url}`,
      '-e', 'PKGR_BUILDCURL_NESTED=1',
      '-e', `PKGR_BUILDCURL_TOKEN=${this.nestedToken}`,
      '-e', `TARGET=${request.target}`,
      '-e', `VERSION=${request.version}`,
      '-e', `PREFIX=${request.prefix}`,
      '--entrypoint', '/opt/pkgr/buildcurl/compile',
      this.image,
      request.recipe,
      `--version=${request.version}`,
      `--target=${request.target}`,
      `--prefix=${request.prefix}`
    ];

    return new Promise((resolve, reject) => {
      let output;
      let child;
      try {
        output = fs.openSync(temporaryPath, 'wx');
        child = this.spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        if (output !== undefined) fs.closeSync(output);
        fs.rmSync(temporaryPath, { force: true });
        reject(error);
        return;
      }
      this.activeContainers.add(containerName);
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        this.forceRemoveContainer(containerName);
      }, this.timeoutMs);

      child.stdout.on('data', (data) => {
        try {
          fs.writeSync(output, data);
        } catch (error) {
          child.kill('SIGTERM');
          finish(error);
        }
      });
      child.stderr.on('data', (data) => {
        const message = data.toString().trimEnd();
        if (message) this.core.info(message);
      });

      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activeContainers.delete(containerName);
        fs.closeSync(output);
        const finalize = error
          ? fs.promises.rm(temporaryPath, { force: true }).then(() => { throw error; })
          : fs.promises.rename(temporaryPath, archivePath);
        finalize.then(resolve, reject);
      };

      child.once('error', (error) => finish(error));
      child.once('close', (code) => {
        if (timedOut) finish(new Error(`Recipe ${request.recipe} timed out after ${Math.ceil(this.timeoutMs / 60000)} minutes`));
        else if (code !== 0) finish(new Error(`Recipe ${request.recipe} failed with exit code ${code}`));
        else finish();
      });
    });
  }

  forceRemoveContainer(containerName) {
    const cleanup = this.spawn('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
    cleanup.on('error', () => {});
  }

  async saveCaches() {
    if (!this.cache) return;
    for (const [key, artifactDir] of this.pendingSaves) {
      try {
        const cacheId = await this.cache.saveCache([artifactDir], key);
        if (cacheId === -1) this.core.warning(`Toolchain cache was not saved: ${key}`);
        else this.core.info(`Saved toolchain cache: ${key}`);
      } catch (error) {
        this.core.warning(`Unable to save toolchain cache ${key}: ${error.message}`);
      }
    }
  }

  async close() {
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
    for (const containerName of this.activeContainers) this.forceRemoveContainer(containerName);
  }
}

module.exports = {
  ALLOWED_RECIPES,
  BuildcurlServer,
  RequestError,
  artifactDigest,
  artifactIdentity,
  cacheKey,
  validateArchive,
  validateRequest
};
