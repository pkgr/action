const core = require('@actions/core');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function uploadWithRetry(uploadFn, maxRetries = 3) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await uploadFn();
    } catch (error) {
      lastError = error;

      if (attempt < maxRetries) {
        const backoffMs = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
        core.warning(`Upload attempt ${attempt} failed: ${error.message}`);
        core.info(`Retrying in ${backoffMs / 1000}s... (${maxRetries - attempt} retries remaining)`);
        await sleep(backoffMs);
      }
    }
  }

  throw lastError;
}

async function run() {
  try {
    // Get inputs
    const file = core.getInput('file', { required: true });
    let target = core.getInput('target', { required: true });
    // Normalize target: ubuntu-20, ubuntu:20, ubuntu/20 -> ubuntu/20
    target = target.replace('-', '/').replace(':', '/');
    const repository = core.getInput('repository', { required: true });
    const channel = core.getInput('channel', { required: true });
    const token = core.getInput('token', { required: true });
    const serverUrl = core.getInput('url', { required: false }) || 'https://go.packager.io';

    // Mask token in logs
    core.setSecret(token);

    // Parse org/repo
    const [org, repo] = repository.split('/');
    if (!org || !repo) {
      throw new Error(`Invalid repository format: ${repository}. Expected format: org/repo`);
    }

    // Check if file exists
    if (!fs.existsSync(file)) {
      throw new Error(`File not found: ${file}`);
    }

    const fileStats = fs.statSync(file);
    const fileSize = fileStats.size;
    const fileName = path.basename(file);

    // Validate file format
    if (!fileName.endsWith('.deb') && !fileName.endsWith('.rpm')) {
      core.warning(`File ${fileName} doesn't appear to be a package file (.deb or .rpm)`);
    }

    core.info(`Uploading ${fileName} (${(fileSize / 1024 / 1024).toFixed(2)} MB) to ${serverUrl}/api/upload`);
    core.info(`Repository: ${org}/${repo}`);
    core.info(`Target: ${target}`);
    core.info(`Channel: ${channel}`);

    // Upload with retry logic
    const uploadUrl = `${serverUrl}/api/upload`;
    const url = new URL(uploadUrl);

    const response = await uploadWithRetry(async () => {
      // Create form data (must be recreated for each retry)
      const form = new FormData();
      form.append('org', org);
      form.append('repo', repo);
      form.append('target', target);
      form.append('channel', channel);
      // Make sure the file field is last
      form.append('file', fs.createReadStream(file), { filename: fileName });

      return await new Promise((resolve, reject) => {
        // Set timeout (10 minutes)
        const timeout = setTimeout(() => {
          reject(new Error('Upload timeout after 10 minutes'));
        }, 10 * 60 * 1000);

        form.submit({
          host: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname,
          protocol: url.protocol,
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        }, (err, res) => {
          clearTimeout(timeout);

          if (err) return reject(err);

          let data = '';

          res.on('data', (chunk) => {
            data += chunk;
          });

          res.on('end', () => {
            resolve({ statusCode: res.statusCode, body: data, headers: res.headers });
          });

          res.on('error', reject);
        });
      });
    });

    if (response.statusCode !== 201) {
      // Try to parse error message from response
      let errorMsg;
      try {
        const errBody = JSON.parse(response.body);
        errorMsg = errBody.message || errBody.error || response.body;
      } catch {
        errorMsg = response.body;
      }
      throw new Error(`Upload failed (${response.statusCode}): ${errorMsg}`);
    }

    // Parse response
    const result = JSON.parse(response.body);
    const uuid = result.package?.uuid;

    if (!uuid) {
      throw new Error('No UUID returned in response');
    }

    core.info(`✓ Package uploaded successfully`);
    core.info(`UUID: ${uuid}`);
    core.info(`Name: ${result.package.name}`);
    core.info(`Version: ${result.package.version}`);
    core.info(`Architecture: ${result.package.architecture}`);

    // Set output
    core.setOutput('uuid', uuid);

  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
