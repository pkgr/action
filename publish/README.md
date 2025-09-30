# PackageHall Publish Action

GitHub Action for publishing RPM and DEB packages to PackageHall repository server.

## Features

- 🚀 Upload RPM and DEB packages via HTTP
- 🔐 Secure token-based authentication
- ⏱️ 10-minute upload timeout
- 📦 Automatic UUID output for downstream steps
- ✅ File format validation
- 🔒 Token masking in logs

## Usage

### Basic Example

```yaml
name: Publish Package

on:
  release:
    types: [published]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build package
        run: |
          # Your package build steps here
          # Creates my-package.deb or my-package.rpm

      - name: Publish to PackageHall
        uses: pkgr/action/publish@v1
        with:
          file: my-package.deb
          target: ubuntu/24.04
          repository: ${{ github.repository }}
          channel: stable
          token: ${{ secrets.PACKAGEHALL_TOKEN }}
          url: https://go.packager.io
```

### Multi-Distribution Publishing

```yaml
- name: Publish to multiple distributions
  strategy:
    matrix:
      target:
        - ubuntu/22.04
        - ubuntu/24.04
        - debian/12
  steps:
    - uses: pkgr/action/publish@v1
      with:
        file: my-package_${{ matrix.target }}.deb
        target: ${{ matrix.target }}
        channel: stable
        token: ${{ secrets.PACKAGEHALL_TOKEN }}
```

### Using Package UUID

```yaml
- name: Publish package
  id: publish
  uses: pkgr/action/publish@v1
  with:
    file: my-package.deb
    target: ubuntu/24.04
    token: ${{ secrets.PACKAGEHALL_TOKEN }}

- name: Use package UUID
  run: |
    echo "Package UUID: ${{ steps.publish.outputs.uuid }}"
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `file` | ✅ | - | Path to package file (.deb or .rpm) |
| `target` | ✅ | - | Distribution target (e.g., `ubuntu/24.04`, `el/9`) |
| `repository` | ✅ | `${{ github.repository }}` | Repository in `org/repo` format |
| `channel` | ✅ | `master` | Channel name (e.g., `stable`, `testing`, `main`) |
| `token` | ✅ | - | PackageHall authentication token |
| `url` | ❌ | `https://go.packager.io` | PackageHall server URL |

## Outputs

| Output | Description |
|--------|-------------|
| `uuid` | Unique identifier for the uploaded package |

## Authentication

Create a PackageHall token with `push` permissions:

```bash
# Using packagehall-ctl
./packagehall-ctl --admin=unix://packagehall-admin.sock \
  token create \
  --org=myorg \
  --repo=myrepo \
  --name="GitHub Actions" \
  --permissions=push
```

Add the token to your repository secrets as `PACKAGEHALL_TOKEN`.

## Supported Targets

Target format: `distribution/version`

### RPM Distributions
- `el/8` - Enterprise Linux 8 (RHEL, Rocky, Alma)
- `el/9` - Enterprise Linux 9
- `fedora/39`, `fedora/40` - Fedora

### DEB Distributions
- `ubuntu/20.04` - Ubuntu 20.04 (Focal)
- `ubuntu/22.04` - Ubuntu 22.04 (Jammy)
- `ubuntu/24.04` - Ubuntu 24.04 (Noble)
- `debian/11` - Debian 11 (Bullseye)
- `debian/12` - Debian 12 (Bookworm)

## Development

### Building

```bash
npm install
npm run build
```

The action must be rebuilt after changes to `index.js`:
- Compiled bundle: `dist/index.js`
- Source: `index.js`

### Testing Locally

```bash
# Set environment variables
export INPUT_FILE=./my-package.deb
export INPUT_TARGET=ubuntu/24.04
export INPUT_REPOSITORY=myorg/myrepo
export INPUT_CHANNEL=stable
export INPUT_TOKEN=your-token
export INPUT_URL=https://go.packager.io

# Run the action
node index.js
```

## Error Handling

The action validates:
- File exists
- File format (.deb or .rpm)
- Repository format (org/repo)
- Upload completes within 10 minutes

Common errors:
- `File not found` - Check file path
- `Invalid repository format` - Use `org/repo` format
- `Upload failed (403)` - Check token permissions
- `Upload failed (404)` - Verify org/repo/target exist
- `Upload timeout` - Package too large or slow network

## License

MIT
