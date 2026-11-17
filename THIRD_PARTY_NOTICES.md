# Third-party components

CK-owned source uses Apache-2.0. Existing file-level and subdirectory licenses take precedence for third-party material. This repository publishes source and assets, not bundled compiler/Core installations or downloaded driver archives.

## Separately downloaded Windows tools

`scripts/prepare-source.mjs` obtains the following fixed distributions and verifies SHA-256 before installing them into ignored local directories. `scripts/source-tools.json` records URLs, archive hashes, selected files, and executable hashes.

| Component | Version | Upstream / license |
| --- | --- | --- |
| Node.js | 24.13.0 | https://nodejs.org/ — MIT and bundled dependency terms; `licenses/Node-LICENSE.txt` |
| Ninja Python distribution | 1.13.2 (Kitware jobserver build) | https://pypi.org/project/ninja/1.13.2/ ; https://github.com/scikit-build/ninja-python-distributions — Apache-2.0; `licenses/LICENSE_Apache_20` |
| Arduino CLI | 1.4.1 | https://github.com/arduino/arduino-cli/tree/v1.4.1 — GPL-3.0; `desktop/apps/desktop/src-tauri/bin/GPL-3.0.txt` |
| ccache | 4.10.2 | https://github.com/ccache/ccache/tree/v4.10.2 — GPL-3.0-or-later and upstream dependency terms; the source-preparation script retains the distribution's license files |

Arduino board cores, GCC, GNU ld, upload tools and libraries are separate dependencies, obtained through the configured board/package sources. Their licenses are not replaced by CK's Apache-2.0 license. If distributing binaries, retain the applicable notices and fulfill the upstream source-distribution obligations.

## Application dependencies and examples

- Exact JavaScript dependencies: `desktop/apps/desktop/package-lock.json` (including Blockly, React, Tauri API, xterm, AJV, charts and avr8js).
- Exact Rust dependencies: `desktop/Cargo.lock`, `native/Cargo.lock`, `update-protocol/Cargo.lock`, `host-contract-tests/Cargo.lock`.
- avr8js 0.21.1: MIT; see `licenses/avr8js-MIT.txt`.
- CodeMirror 6 source editor, Lezer parsers and supporting packages: MIT; exact versions are pinned in the desktop lockfile, with notices in `licenses/CodeMirror-MIT.txt`.
- Blockly media and other checked-in assets retain their copyright notices. Examples and test libraries with a `LICENSE` retain that license.
- USB driver archives are not part of this source publication. The website catalog records upstream sources and checksums; CP210x and FTDI remain vendor-direct downloads.

Source publication does not certify every downstream redistribution. Review the actual dependency versions, licenses, trademarks and notices when distributing a modified product.
