# FLFE ESP32 Library Edit Qualification (2026-08-23)

> **历史证据快照。**本报告绑定旧 production EXE `f47acdd2…`，只说明当时的 C6 compile-only 结果，不能授权当前 EXE。当前库编辑资格必须按当前 EXE、Core、工具链和证据重新认证。

This note records the first qualified ESP32 library-aware FLFE result after
the v4 evidence and path/runtime optimizations. It is a bounded qualification,
not a claim that every ESP32 Core, board menu, or library topology is fast.

## Bound identity

- Production executable: `target/release/appsdesktop.exe`
- Executable SHA-256: `f47acdd2a3f4133f2efc04335218a14216fe30bb3096dfaa0ba3d8d98a48816b`
- Target FQBN: `esp32:esp32:esp32c6`
- ESP32 Core: `3.3.6`
- Measurement mode: compile-only; no upload, serial access, or physical flash
- Formal report: `artifacts/benchmarks/ck-esp32-library-edit-c6-v11-parallel-evidence-formal.json`

## Five-trial result

The candidate wrapper ran five sequential trials with a fresh graph-establishing
stage and then compared the same-graph edit against native Arduino CLI. Source,
Flash/RAM summaries, required ESP32 artifact roles, CCDB source/object binding,
native link evidence v4, and fixture cleanup passed in every trial.

| Eligible stage | CK median | Native median | Median speedup | Result |
| --- | ---: | ---: | ---: | --- |
| Third-party library same-graph edit | 14.703 s | 19.602 s | 24.99% | Qualified |
| Core SPI library same-graph edit | 15.184 s | 19.653 s | 22.74% | Qualified |

The policy for this first version is at least 20% median speedup and at least
500 ms median absolute gain. Both eligible stages pass both conditions. Cold
graph-establishing stages remain recorded for visibility and are explicitly
excluded from the speed claim; they are still slower than native CLI.

## What changed

- Static `bootloader.bin` and `partitions.bin` are reused only inside an
  authenticated ESP32 library NativeRelink build root when they are ordinary,
  non-empty files. The application, merged image, and `flash_args` are rebuilt
  and validated on every edit.
- Native link process launch uses the validated ordinary Windows executable
  spelling while evidence continues to use canonical identities. A mismatch
  between the two identities fails closed.
- Final Core dependency and captured-file evidence revalidation uses a bounded
  maximum of eight read-only workers. Any missing, changed, escaped, or reparse
  backed file still rejects the fast route and falls back to Arduino CLI.
- The regression runner policy and tests now use the first-version 20% target.

## Scope and fallback

This certificate applies only to the bound FQBN, Core/toolchain identity,
production executable hash, and the tested library shapes. It does not certify
ESP32-P4, other Core versions, arbitrary board menu combinations, archives,
precompiled libraries, custom linker semantics, or complex conditional include
graphs. Unsupported or changed evidence remains fail-closed and uses the native
Arduino CLI path; correctness is never traded for the speed target.

## Ordinary product Fast route

The same production executable also passed the five-trial, library-free
`simple -> complex -> medium -> simple-return` NativeRelink qualification for
`esp32:esp32:esp32c6` / Core `3.3.6`:

| Eligible edit | CK median | Native median | Median speedup |
| --- | ---: | ---: | ---: |
| `complex` | 12.571 s | 19.901 s | 36.83% |
| `medium` | 12.281 s | 20.168 s | 39.11% |
| `simple-return` | 12.455 s | 20.018 s | 37.78% |

The cold `simple` stage is recorded only (CK median 43--62 s in this run) and
is not advertised as accelerated. The product certificate is stored under
`state/qualifications/dbd04b1ea56ecb61d158069c1a606a5cc7e3c25a110096d3cb7a93ed3dc44b49`;
the raw report is
`artifacts/benchmarks/flfe-esp32c6-native-relink-formal-20260823.json`.

## Reproduction

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts/Run-CKEsp32LibraryEditCandidate.ps1 `
  -ExecutablePath target/release/appsdesktop.exe `
  -ExpectedExecutableSha256 f47acdd2a3f4133f2efc04335218a14216fe30bb3096dfaa0ba3d8d98a48816b `
  -Fqbn esp32:esp32:esp32c6 -Trials 5 -MinFreeGiB 8 -DebugPort 9241 `
  -Output artifacts/benchmarks/ck-esp32-library-edit-c6-v11-parallel-evidence-formal.json
```
