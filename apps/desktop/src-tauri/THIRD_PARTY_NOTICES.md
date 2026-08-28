# CK 1.0 bundled tool notices

This file records the command-line tools that CK copies into its per-user data root. It is not a
complete legal opinion or a substitute for the license files shipped by each upstream project.

## Arduino CLI 1.4.1

- Project: <https://github.com/arduino/arduino-cli>
- License: GNU General Public License, version 3
- Bundled license text: `licenses/GPL-3.0.txt`

CK uses the single bundled Arduino CLI binary and the per-user `arduino-cli.yaml`; it does not
download or silently select a second CLI version from `PATH`.

## ccache 4.10.2

- Project: <https://github.com/ccache/ccache>
- License: GNU General Public License, version 3 or later
- Bundled license text: `licenses/GPL-3.0.txt`

CK may create hard links or byte-identical copies of the bundled ccache binary under compiler
names in the per-user data root. These shims are local build accelerators and are not separate
upstream programs.

## JavaScript and UI dependencies

The exact npm dependency graph and versions are recorded in `package-lock.json`. A broader
dependency and media provenance audit remains a separate release-compliance task; CK 1.0 does not
describe the local package quality gate as a legal compatibility certification.
