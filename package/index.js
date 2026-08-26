const core = require('@actions/core');
const exec = require('@actions/exec');
const cache = require('@actions/cache');
const fs = require('fs');
const path = require('path');
const { BuildcurlServer } = require('./buildcurl-server');
const { withInternalBuildcurlUrl } = require('./environment');

async function capture(command, args, options = {}) {
  let stdout = '';
  await exec.exec(command, args, {
    ...options,
    silent: true,
    listeners: {
      ...(options.listeners || {}),
      stdout: (data) => { stdout += data.toString(); }
    }
  });
  return stdout.trim();
}

async function saveApplicationCache(appCachePath, cacheKey) {
  if (!cacheKey || !fs.existsSync(appCachePath)) return;

  core.info('Fixing application cache permissions');
  try {
    await exec.exec('sudo', ['chown', '-R', `${process.env.USER}:${process.env.USER}`, appCachePath]);
  } catch (error) {
    core.warning(`Failed to fix application cache permissions: ${error.message}`);
  }

  core.info(`Saving application cache with key: ${cacheKey}`);
  try {
    const cacheId = await cache.saveCache([appCachePath], cacheKey);
    if (cacheId === -1) core.warning('Application cache was not saved');
    else core.info(`Application cache saved: ${cacheId}`);
  } catch (error) {
    core.warning(`Unable to save application cache: ${error.message}`);
  }
}

async function run() {
  const workspace = '/tmp/pkgr';
  const appCachePath = `${workspace}/cache/app`;
  const toolchainCachePath = `${workspace}/cache/toolchains`;
  let buildcurlServer;
  let applicationCacheKey;
  let packageSucceeded = false;

  try {
    let target = core.getInput('target', { required: true });
    target = target.replace('-', '/').replace(':', '/');

    const name = core.getInput('name', { required: true });
    const appPath = core.getInput('path', { required: true });
    const version = core.getInput('version', { required: true });
    const pkgrVersion = core.getInput('pkgr_version', { required: true });
    const cachePrefix = core.getInput('cache_prefix', { required: true });
    const userEnvironment = core.getInput('env', { required: false }) || '';
    const debug = core.getInput('debug', { required: false }) || 'false';

    core.info(`Setting up workspace at ${workspace}`);
    await exec.exec('rm', ['-rf', workspace]);
    await exec.exec('mkdir', ['-p', appCachePath, toolchainCachePath, `${workspace}/output`]);
    core.setOutput('workspace', workspace);

    let iteration = Math.floor(Date.now() / 1000).toString();
    try {
      const gitHash = (await capture('git', ['rev-parse', 'HEAD'], { cwd: appPath })).substring(0, 7);
      if (gitHash) iteration = `${iteration}.${gitHash}`;
    } catch (error) {
      core.debug('Could not get git hash');
    }

    const codename = target.replace('/', '').replace(/\..*/g, '');
    iteration = `${iteration}.${codename}`;
    core.info(`Iteration: ${iteration}`);

    const dockerTag = [target.replace('/', ':'), pkgrVersion].join('-');
    const dockerImage = `ghcr.io/pkgr/pkgr/${dockerTag}`;
    core.info(`Pulling packaging image ${dockerImage}`);
    await exec.exec('docker', ['pull', '--platform', 'linux/amd64', dockerImage]);

    const imageMetadata = await capture('docker', [
      'image', 'inspect',
      '--format', '{{.Id}}|{{.Architecture}}',
      dockerImage
    ]);
    const [imageId, architecture] = imageMetadata.split('|');
    if (!imageId || architecture !== 'amd64') {
      throw new Error(`Unsupported packaging image: expected linux/amd64, got ${imageMetadata}`);
    }

    const cacheRestorePrefix = `pkgr-${cachePrefix}-${codename}-${pkgrVersion}-`;
    applicationCacheKey = `${cacheRestorePrefix}${process.env.GITHUB_SHA}`;
    core.info(`Restoring application cache with key: ${applicationCacheKey}`);
    const applicationCacheHit = await cache.restoreCache(
      [appCachePath],
      applicationCacheKey,
      [cacheRestorePrefix]
    );
    core.info(applicationCacheHit ? `Application cache hit: ${applicationCacheHit}` : 'Application cache miss');

    buildcurlServer = new BuildcurlServer({
      image: imageId,
      imageId,
      architecture,
      target: target.replace('/', ':'),
      cachePrefix,
      cacheRoot: toolchainCachePath,
      cache,
      core
    });
    core.saveState('BUILDCURL_SESSION', buildcurlServer.sessionId);
    const buildcurlUrl = await buildcurlServer.start();
    const buildEnvironment = withInternalBuildcurlUrl(userEnvironment, buildcurlUrl);

    core.info(`Packaging ${name} version ${version} for ${target}`);
    const dockerArgs = [
      'run',
      '--rm',
      '--platform', 'linux/amd64',
      '--network', 'host',
      '--add-host', 'buildcurl.com:127.0.0.1',
      '--add-host', 'barebuild.com:127.0.0.1',
      '-v', `${path.resolve(appPath)}:/pkgr/app`,
      '-v', `${appCachePath}:/pkgr/cache`,
      '-v', `${workspace}/output:/pkgr/output`,
      imageId,
      '--name', name,
      '--version', version,
      '--iteration', iteration,
      '--env', buildEnvironment,
      `--debug=${debug}`
    ];

    await exec.exec('docker', dockerArgs);

    const outputDir = `${workspace}/output`;
    const packageName = fs.readdirSync(outputDir)
      .find((file) => file.endsWith('.deb') || file.endsWith('.rpm'));
    if (!packageName) throw new Error('No package file found in output directory');

    const packagePath = path.join(outputDir, packageName);
    const packageType = path.extname(packageName).substring(1);
    core.info(`Package created: ${packageName} (${packageType})`);
    core.setOutput('package_path', packagePath);
    core.setOutput('package_type', packageType);
    core.setOutput('package_name', packageName);
    packageSucceeded = true;
  } catch (error) {
    core.setFailed(error.message);
  } finally {
    if (buildcurlServer) {
      try {
        await buildcurlServer.close();
      } catch (error) {
        core.warning(`Unable to stop the local buildcurl server: ${error.message}`);
      }
      try {
        await buildcurlServer.saveCaches();
      } catch (error) {
        core.warning(`Unable to save toolchain caches: ${error.message}`);
      }
    }
    if (packageSucceeded) await saveApplicationCache(appCachePath, applicationCacheKey);
  }
}

run();

module.exports = { capture, saveApplicationCache };
