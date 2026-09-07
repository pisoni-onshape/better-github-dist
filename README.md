# Better GitHub Distribution Dependencies

This repository hosts public distribution assets and dependencies for the [Better GitHub](https://github.com/onshape/onshape-dev-tools/tree/master/better-github) userscript.

Because Tampermonkey requires persistent raw URLs for `@require` and `@resource` directives, these dependency files are hosted here in a public repository without URL token rotation.

The primary source code and Chrome extension are maintained in the [onshape/onshape-dev-tools](https://github.com/onshape/onshape-dev-tools) repository under `better-github/`.

## Contents

- `src/utils.js`: DOM and browser utility helpers (`@require`)
- `src/userscript-config.js`: Configuration UI and storage manager (`@require`)
- `src/move-analysis.js`: Moved code analysis module (`@require`)
- `src/gm_polyfill.js`: Polyfill layer for WebExtension/Greasemonkey APIs
- `resources/`: Editor icons, GitHub icon, and configuration stylesheet (`@resource`)
