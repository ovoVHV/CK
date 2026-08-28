# FLFE Library Topology Qualification (2026-07-27)

> **历史证据快照。**本报告绑定旧 production EXE `792c3ab2…`，不能作为当前 Fast 资格或客户机状态。需要当前结论时运行资格审计脚本并查看当前证书绑定的 EXE SHA-256。

This note records the current evidence for Arduino library-aware FLFE on the
production executable. It is an evidence note, not a claim that every Core or
every library topology is certified.

## Bound identity

- Production executable: `target/release/appsdesktop.exe`
- Executable SHA-256: `792c3ab24250b487bcbc8f3e423311ec45d8a760e5ca5bc18a6cd25638a6250a`
- Target: `arduino:avr:uno`
- Core/toolchain: the identity captured by the report; no identity is inferred
  from the board label.
- Physical flash and serial upload: not used. This is compile-only evidence.

## Generic topology matrix

Report:
`artifacts/benchmarks/ck-avr-generic-topology-uno-exe792c3ab2-20260727-t3-5trials.json`

Five trials passed all of the following in every trial:

- CK and native Arduino CLI source, Flash/RAM and AVR HEX/EEP equivalence;
- graph-transition and same-graph route gates;
- CCDB first-seen library order, per-library translation-unit membership and
  one-source/one-object binding;
- exact restoration of the full library graph;
- marker-owned fixture cleanup and unchanged production EXE.

Median CK versus native timings (milliseconds):

| Stage | CK | Native | Speedup |
| --- | ---: | ---: | ---: |
| Core cold baseline (recorded only) | 8452 | 6902 | -22.45% |
| Add topology | 3272 | 5661 | 42.20% |
| Same-graph edit | 2818 | 4700 | 40.03% |
| Include reorder | 3504 | 5438 | 35.57% |
| Partial remove | 3244 | 5336 | 39.20% |
| Restore | 3444 | 5380 | 35.97% |

The cold baseline is intentionally recorded only. It is not included in the
fast-performance claim. The later stages use a fail-closed gate of at least
25% median speedup and 500 ms median absolute gain.

## Covered shapes

The deterministic fixture includes a modern `src/` C++ library, mixed C/C++
translation units with `src/nested/`, a header-only transitive dependency, two
levels of `library.properties:depends`, two direct libraries, include-order
changes, removal and restoration. Fixture names are synthetic and carry no
production-library allow-list meaning.

## Separate dependency matrix

Report:
`artifacts/benchmarks/ck-avr-dependency-edit-uno-exe792c3ab2-20260727-t3-5trials.json`

The five-trial Uno matrix covering `MsTimer2` and `Wire/SPI/EEPROM` also passed
its independent verifier. All six post-cold stages cleared the same 25% gate;
the observed median speedups were 46.74%, 44.34%, 50.56%, 39.30%, 38.40% and
50.56%.

## Boundaries and next qualification work

This evidence does not yet certify:

- ESP32 library-aware NativeRelink (the current ESP32 phase-1 adapter still
  admits only an Arduino-only sketch graph and deliberately falls back when
  `extra_libs` are present);
- legacy root-level or `utility/` layouts in a real A/B run;
- same-name provider conflicts, assembly/`.cc` variants, precompiled/archive
  libraries or custom linker flags;
- arbitrary third-party Cores.

Those cases must either receive their own equivalent evidence or remain on the
native Arduino CLI path. No performance claim should be generalized beyond the
bound identity and topology above.

## Reproduction

Use the candidate wrapper so the production EXE hash, CDP ownership, cache
reset authority, no-clobber fixture install and cleanup are checked:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts/Run-CKAvrGenericLibraryTopologyCandidate.ps1 `
  -Output artifacts/benchmarks/ck-avr-generic-topology-uno-next.json `
  -ExpectedExecutableSha256 792c3ab24250b487bcbc8f3e423311ec45d8a760e5ca5bc18a6cd25638a6250a `
  -Target uno -Trials 5 -MinFreeGiB 8
```
