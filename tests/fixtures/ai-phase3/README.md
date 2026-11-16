# AI phase 3 reproducibility fixture

This 97-block Uno project has median filtering, 20 ms sampling, hysteresis,
an emergency-stop input, an independent 250 ms heartbeat and 200 ms serial output.
The original upper threshold is 700; edit tests change it to 650.

Import the included `ck_ai_736b8b7dd8f8` library with CK's library manager before
running the desktop regression harnesses. Keep its LICENSE. This is a test
fixture, not an automatically installed product library. Install Arduino AVR
Core 1.8.8 and configure `Start-Preview.ps1` for the local tools and data root.

Run `desktop-ai-phase3.mjs` once, then once with `CK_AI_PHASE3_RESTART=1` to
exercise a real process restart. `desktop-ai-library-revision.mjs` checks
side-by-side revision and original-source compilation. Both use a deterministic
local model fixture with real native compilers. The live harness additionally
requires the user's own `CK_AI_LIVE_KEY` and preserves model/provider results.

`ai-phase3-cases.mjs` defines the independent nine-assertion suite. No physical
board is required or claimed. Original source maps and block IDs are retained
so edits and firmware can be traced to the same fixture.

`simulator.mjs` is the bundled offline firmware verifier built from the same acceptance and AVR simulation source as the alpha.41 desktop. It is supplied for independent regression checks; dependency license is in engine/licenses/avr8js-MIT.txt. It executes only bounded AVR HEX instructions, not model scripts.
