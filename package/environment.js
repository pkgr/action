function withInternalBuildcurlUrl(userEnvironment, buildcurlUrl) {
  const values = (userEnvironment || '')
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  values.push(`BUILDCURL_URL=${buildcurlUrl}`);
  return values.join('\n');
}

module.exports = { withInternalBuildcurlUrl };
