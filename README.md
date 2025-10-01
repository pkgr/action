# pkgr/action

GitHub Action for packaging apps as DEB or RPM. Should be used as a replacement for [Packager.io](https://packager.io) hosted service.

## Usage

### Building Packages

Build packages for multiple Linux distributions in parallel:

```yaml
name: Package
on: [push]

jobs:
  build:
    name: ${{ matrix.target }}
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        target:
          - debian:10
          - debian:11
          - debian:12
          - ubuntu:20.04
          - ubuntu:22.04
          - ubuntu:24.04
          - el:7
          - el:8
          - el:9
          - sles:12
          - sles:15
    steps:
      - uses: actions/checkout@v4

      - uses: pkgr/action/package@v1
        id: package
        with:
          target: ${{ matrix.target }}
          version: '1.0.0'

      - name: Upload
        uses: actions/upload-artifact@v4
        with:
          name: ${{ steps.package.outputs.package_name }}
          path: ${{ steps.package.outputs.package_path }}
```

### Building and Publishing Packages

To publish packages to a repository, add a separate publish step after building. Contact support@packager.io to obtain a publish token.

```yaml
name: Package and Publish
on: [push]

jobs:
  build:
    name: ${{ matrix.target }}
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        target:
          - debian:10
          - debian:11
          - debian:12
          - ubuntu:20.04
          - ubuntu:22.04
          - ubuntu:24.04
          - el:7
          - el:8
          - el:9
          - sles:12
          - sles:15
    steps:
      - uses: actions/checkout@v4

      - uses: pkgr/action/package@v1
        id: package
        with:
          target: ${{ matrix.target }}
          version: '1.0.0'

      - name: Upload
        uses: actions/upload-artifact@v4
        with:
          name: ${{ steps.package.outputs.package_name }}
          path: ${{ steps.package.outputs.package_path }}

      - name: Publish
        uses: pkgr/action/publish@v1
        with:
          target: ${{ matrix.target }}
          token: ${{ secrets.PACKAGER_PUBLISH_TOKEN }}
          repository: ${{ github.repository }}
          channel: ${{ github.ref_name }}
          file: ${{ steps.package.outputs.package_path }}
```

**Note:** Store your publish token as a GitHub secret named `PACKAGER_PUBLISH_TOKEN` in your repository settings.

<img width="1684" alt="Building packages across linux distributions" src="https://github.com/pkgr/action/assets/6114/72388c40-6e97-4481-899a-9a67b081e6fa">
