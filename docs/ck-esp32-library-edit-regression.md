# CK ESP32 library-edit regression

更新时间：2026-08-25。

This runner is the compile-only A/B gate for the bounded ESP32 library-aware
FLFE NativeRelink route. It does not upload firmware or open a serial port.

## Current boundary

The historical first-version qualification below is an evidence snapshot, not
current authorization. Re-run the gate against the actual production EXE,
Core, toolchain and FQBN before using it for a release decision.

The historical first-version qualification was bound to an older production executable
SHA-256 `f47acdd2a3f4133f2efc04335218a14216FE30BB3096DFAA0BA3D8D98A48816B`,
FQBN `esp32:esp32:esp32c6`, and ESP32 Core `3.3.6`. The formal five-trial
report is
`artifacts/benchmarks/ck-esp32-library-edit-c6-v11-parallel-evidence-formal.json`.
The recorded same-graph workloads are historical evidence. Other FQBNs, Core
versions, or unsupported library semantics remain on the native Arduino CLI
path until independently qualified for the current EXE.

## Workloads

The four paired CK/native stages are:

1. Cold third-party graph: a temporary marker-owned ESP32 library with modern
   `src/`, C++, nested C, and C/C++ linkage. Recorded only.
2. Third-party same-graph sketch edit. Performance-gated.
3. ESP32 Core `SPI` library graph transition. Recorded only and allowed to use
   an explicit safe fallback.
4. Core-library same-graph sketch edit. Performance-gated.

Cold or graph-changing stages cannot make a speed claim. Each same-graph edit
must beat the native bundled Arduino CLI median by at least 20% and 500 ms for
the first-version policy. Five trials are required for formal review; one trial
is exploratory.

## Evidence gates

Every stage requires:

- identical source SHA-256 across CK and native lanes;
- exact Flash and RAM usage;
- byte-exact bootloader and partition images;
- ESP application payload equivalence through the resolved Core recipe proof;
- one application, bootloader, partition, and validated lane-local
  `flash_args` artifact; the merged image is retained as lane-local diagnostic
  evidence and is not treated as a cross-lane equality role;
- CCDB source/object one-to-one bindings for the active third-party or Core
  library and no stale translation units from the previous graph;
- stable library object identity across each same-graph pair;
- no Exact result, no unknown route, no upload, and no serial access.

ESP32 reproducibility is fixed to `SOURCE_DATE_EPOCH=1704067200` and `TZ=UTC`.
The PowerShell candidate launcher sets both values before starting the
production executable. It also generates a one-use 256-bit qualification token
and binds the desktop process and runner to that token. This permits measuring
an uninstalled phase-2 candidate before certification without exposing the
candidate route to an ordinary product compile.

## Commands

Read-only plan:

```powershell
node scripts/Run-CKEsp32LibraryEditRegression.cjs --plan `
  --fqbn esp32:esp32:esp32c6 --trials 5
```

Run against the production executable:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts/Run-CKEsp32LibraryEditCandidate.ps1 `
  -Fqbn esp32:esp32:esp32c6 `
  -Trials 5 `
  -Output artifacts/benchmarks/ck-esp32-library-edit-c6.json
```

Run an E-drive candidate without replacing the current production executable:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts/Run-CKEsp32LibraryEditCandidate.ps1 `
  -ExecutablePath E:\CK_FLFE_TARGET\release\appsdesktop.exe `
  -Fqbn esp32:esp32:esp32c6 `
  -Trials 5 `
  -Output artifacts/benchmarks/ck-esp32-library-edit-c6-candidate.json
```

The launcher refuses to overwrite evidence, checks the production EXE hash
when supplied, refuses an occupied debug port, restores environment variables,
and stops only the process tree it started. The runner rejects report paths
inside managed libraries, packages, CK build caches, or its own A/B work root,
then cleans its marker-owned fixture, board cache, and
`<TEMP>/CKAB/<run-token>` work directory in `finally`.

## Source files

- `scripts/Run-CKEsp32LibraryEditRegression.cjs`
- `scripts/Run-CKEsp32LibraryEditCandidate.ps1`
- `scripts/Run-CKEsp32LibraryEditRegression.test.mjs`
