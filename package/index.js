const core = require('@actions/core');
const exec = require('@actions/exec');
const cache = require('@actions/cache');
const fs = require('fs');
const path = require('path');

async function run() {
  try {
    // Get inputs
    let target = core.getInput('target', { required: true });
    // Normalize target: ubuntu-20, ubuntu:20, ubuntu/20 -> ubuntu/20
    target = target.replace('-', '/').replace(':', '/');

    const name = core.getInput('name', { required: true });
    const appPath = core.getInput('path', { required: true });
    const version = core.getInput('version', { required: true });
    const pkgrVersion = core.getInput('pkgr_version', { required: true });
    const cachePrefix = core.getInput('cache_prefix', { required: true });
    const env = core.getInput('env', { required: false }) || '';
    const debug = core.getInput('debug', { required: false }) || 'false';

    // Setup workspace
    const workspace = '/tmp/pkgr';

    core.info(`Setting up workspace at ${workspace}`);
    await exec.exec('rm', ['-rf', workspace]);
    await exec.exec('mkdir', ['-p', `${workspace}/cache`, `${workspace}/output`]);

    core.setOutput('workspace', workspace);

    // Calculate iteration
    let iteration = Math.floor(Date.now() / 1000).toString();

    // Get git commit hash if available
    let gitHash = '';
    try {
      await exec.exec('git', ['rev-parse', 'HEAD'], {
        cwd: appPath,
        silent: true,
        listeners: {
          stdout: (data) => {
            gitHash = data.toString().trim().substring(0, 7);
          }
        }
      });
    } catch (error) {
      core.debug('Could not get git hash');
    }

    if (gitHash) {
      iteration = `${iteration}.${gitHash}`;
    }

    // Add codename to iteration
    let codename = target.replace(':', '').replace(/\..*/g, '');
    iteration = `${iteration}.${codename}`;

    core.info(`Iteration: ${iteration}`);

    // Restore cache
    const cacheKey = `pkgr-${cachePrefix}-${target}-${pkgrVersion}-${process.env.GITHUB_SHA}`;
    const restoreKeys = [
      `pkgr-${cachePrefix}-${target}-${pkgrVersion}-`
    ];

    core.info(`Restoring cache with key: ${cacheKey}`);
    await cache.restoreCache([`${workspace}/cache`], cacheKey, restoreKeys);

    // Package
    core.info(`Packaging ${name} version ${version} for ${target}`);

    const dockerImage = `ghcr.io/pkgr/pkgr/${target}-${pkgrVersion}`;
    const dockerArgs = [
      'run',
      '--rm',
      '-v', `${path.resolve(appPath)}:/pkgr/app`,
      '-v', `${workspace}/cache:/pkgr/cache`,
      '-v', `${workspace}/output:/pkgr/output`,
      '--net=host',
      dockerImage,
      '--name', name,
      '--version', version,
      '--iteration', iteration,
      '--env', env,
      `--debug=${debug}`
    ];

    await exec.exec('docker', dockerArgs);

    // Find package file
    const outputDir = `${workspace}/output`;
    const files = fs.readdirSync(outputDir);

    let packagePath = '';
    let packageType = '';
    let packageName = '';

    for (const file of files) {
      if (file.endsWith('.deb') || file.endsWith('.rpm')) {
        packagePath = path.join(outputDir, file);
        packageType = path.extname(file).substring(1);
        packageName = file;
        break;
      }
    }

    if (!packagePath) {
      throw new Error('No package file found in output directory');
    }

    core.info(`Package created: ${packageName} (${packageType})`);
    core.setOutput('package_path', packagePath);
    core.setOutput('package_type', packageType);
    core.setOutput('package_name', packageName);

    // Save cache
    core.info(`Saving cache with key: ${cacheKey}`);
    await cache.saveCache([`${workspace}/cache`], cacheKey);

  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
