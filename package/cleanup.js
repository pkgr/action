const core = require('@actions/core');
const exec = require('@actions/exec');

async function run() {
  const sessionId = core.getState('BUILDCURL_SESSION');
  if (!sessionId) return;

  let containerIds = '';
  await exec.exec('docker', [
    'ps', '-aq',
    '--filter', `label=io.pkgr.buildcurl.session=${sessionId}`
  ], {
    silent: true,
    listeners: {
      stdout: (data) => { containerIds += data.toString(); }
    }
  });

  const ids = containerIds.trim().split(/\s+/).filter(Boolean);
  if (ids.length > 0) await exec.exec('docker', ['rm', '-f', ...ids]);
}

run().catch((error) => core.warning(`Unable to clean compiler containers: ${error.message}`));
