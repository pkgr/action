.PHONY: build build-package build-publish

build: build-package build-publish

build-package:
	cd package && npm run build

build-publish:
	cd publish && npm run build
