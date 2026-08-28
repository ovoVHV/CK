# FLFE ESP32 NativeRelink Phase 1 — Design (esp32:esp32:esp32c6 first)

Status: implementation in progress (2026-07-26). Investigation evidence:
session task output `w3i1x574w` (4 deep-dive reports). Measured feasibility:
direct replay of the C6 edit command set = link 1.9s + elf2image 1.7s +
gen_esp32part 0.8s + merge-bin 1.6s + flash_args 0.1s ≈ 6.4s (+ sketch TU
compile ~2s) vs native edit ~25s → ~60% faster, comfortably above the
25%/500ms qualification bar (same shape as AVR: 2.3s vs 5.5s).

## Strategy: phase 1 reuses the shipped ESP32 fast-relink replay

Unlike AVR/SAMD (dedicated transaction engines), ck already ships an ESP32
relink replay used by Quick/Shared fast profiles: `try_fast_relink_quick`
(demo.rs ~18227) + `ESP32_FAST_RELINK_REQUIRED_RECIPES` (~13113:
prebuild.4 bootloader, objcopy.partitions.bin, objcopy.bin,
postobjcopy.4 flash_args) + `prepare_esp32_fast_relink_artifacts` (~13283) +
`validate_esp32_fast_relink_artifacts` (~13375) +
`resolve_relink_props_direct(..., CompileProfile::Release)` (~12145) — the
artifact recipes are ALREADY resolved from Release (untrimmed) properties.

Phase 1 = route **authorized** (QualificationProbe/Certified) ESP32
Release+CompileOnly+Managed edit compiles through this replay with **pure
Release compile flags** (no -O1 fast contract, no ccache shim for the sketch
TU) and emit the `[CK_BUILD_MODE] native-relink-compile-only` marker
(demo.rs:9757). The A/B harness is the equivalence prover; the certificate
only ever issues from passing evidence, so an imperfect replay fails closed
at qualification, never in the field. Production-certified use rides the same
dependency-signature + identity-lease + artifact-validation machinery that
already guards the shipped Quick/Shared fast path.

## Artifact policy: `esp32-app-bin-witness-bootloader-partitions-exact-v1`

Cross-lane facts (from r5–r9 portable-fast evidence):
- `application-bin` differs across lanes ONLY in the embedded ELF-SHA-256
  window (0xb0..0xd0) + validated 33-byte footer (ELF embeds lane-local build
  paths → different ELF sha → different embedded digest). Byte-exact required
  roles are impossible for it. The adapter therefore uses the EXISTING ESP
  payload witness (`payloadEquivalenceWitness`, kind
  `esp-application-bin-elf-sha256-offset-v1`) — same-length primary image,
  immutable segments byte-equal, footers valid, recipe proof pinned to
  `--elf-sha256-offset 0xb0`.
- `bootloader-bin`, `partitions-bin`: sketch-independent, byte-exact across
  lanes → required-exact roles.
- `flash-arguments`: embeds lane-local project names → NOT compared by the
  adapter (lane-local metadata), but the CK replay must still produce it
  byte-identically to what native tooling would produce **in its own lane**
  (cmd echo chain with trailing spaces; replay the exact recipe command, do
  NOT use `materialize_flash_args_from_echo_chain` which trims).
- `merged-firmware-bin`: contains application-bin → inherits the sha-window
  difference → not compared (still produced by replaying postobjcopy.3).
- `application-elf` (path-derived), `upload-manifest` (CK-only provenance):
  not compared.

Descriptor (all three registries, field-for-field identical):
- id: `esp32-esp32c6-native-relink-v1`
- fqbn_matcher: ExactBase(`esp32:esp32:esp32c6`)
- core_architecture: `esp32`
- engine_contract_id: `ck-native-relink-esp32-release-compile-only-phase1-v1`
- artifact_policy_id: `esp32-app-bin-witness-bootloader-partitions-exact-v1`
- required_artifact_roles: [`bootloader-bin`, `partitions-bin`]
- witness_artifact_roles: [`application-bin`]  ← NEW descriptor field (empty
  for AVR/SAMD); validators use the ESP payload witness for these roles.
- optional_artifact_roles: []
- forbidden_all_stage_artifact_roles: []
- forbidden_ck_edit_artifact_roles: []

## Implementation checklist (dependency order)

1. **ck_core contract + gates** (new small module
   `crates/ck_core/src/builder/demo/esp32_native_relink.rs`):
   - `ESP32_NATIVE_RELINK_ENGINE_CONTRACT` const.
   - `esp32_native_relink_baseline_capture_candidate(...)` gate: Release +
     Managed + CompileOnly + fqbn base == esp32:esp32:esp32c6 + the existing
     ESP32 relink eligibility (validate_esp32_fast_relink_upload_properties,
     no sketch-local bootloader.bin/partitions.csv/build_opt.h).
   - STM32 precedent (stm32_native_relink.rs is unregistered) shows engine
     code can land before registration.
2. **demo.rs wiring**:
   - `native_relink_target_binding` (~1706): 3-way dispatch — add
     `fqbn.starts_with("esp32:esp32:")` → ESP32 contract (**mandatory**, else
     access keys silently hash the AVR contract).
   - Route: authorized ESP32 edit (NativeRelinkAccess Probe/Certified +
     Release + CompileOnly + Managed + valid BuildMeta with matching
     dependency signature + only-sketch-changed) → Release-flags relink
     replay: sketch TU compile with native Release argv (from the sealed CCDB
     entry with ccache shim path replaced by the real compiler — byte-native,
     no -O1 contract), then link + prebuild.4 + objcopy.partitions +
     objcopy.bin + postobjcopy.3 merge-bin + postobjcopy.4 flash_args (exact
     cmd chain execution), then size. Emit
     `[CK_BUILD_MODE] native-relink-compile-only` marker + evidence lines.
   - Force-rebuild/invalidation dispatch (~20623 samd-vs-avr if/else → 3-way).
   - `native_release_props_cache_adapter_supported` (~10698): add esp32.
3. **ck_forge.rs**: descriptor const + registry row + `witness_artifact_roles`
   field (empty slices for AVR/SAMD); extend `recompute_native_relink_qualification`
   role loop: witness roles validated via the existing
   `esp_application_bin_immutable_segment_hashes` path (both lanes' witnesses
   layout-equal + immutable segments equal), not `artifact_role_matches`.
   Registration side effect (accepted): CompileOnly esp32c6 compiles force
   CompileProfile::Release (lib.rs:6025) — this IS the intended baseline.
4. **JS mirrors ×2** (Run-CKForgeNativeAB.cjs, Evaluate-CKForgePerformanceGate.cjs):
   descriptor + registry row + `witnessArtifactRoles` in
   `compareNativeRelinkAdapterArtifactEquivalence` and the evaluator's role
   loop (reuse `validEspApplicationBinPayloadEquivalenceWitness` + fixed
   projection + immutable-segment compare). The runner must pass the ESP
   payload recipe proof for relink runs on esp32 so witnesses are computed
   (espApplicationPayloadRecipeProofForCore — currently portable-fast only).
   Evaluator's `nativeRelinkAdapterFor` requires identity.coreArchitecture
   === 'esp32' exactly.
5. **Cross-language binding parity**: `nativeRelinkQualificationBinding` (JS)
   and `native_relink_qualification_key_for_adapter` (Rust) must stay
   byte-identical; add an ESP32 fixture to the parity test
   (apps/desktop/src-tauri/src/ck_forge.rs ~4937).
6. **Tests**: registry-is-explicit pins (ck_forge.rs ~4833), runner
   Run-CKForgeNativeAB.test.mjs adapter tests (witness-role case),
   evaluator tests, demo.rs gate tests.
7. **Qualify**: rebuild EXE → `Run-CKForgeNativeABCandidate`-style relink run:
   `node scripts/Run-CKForgeNativeAB.cjs --execute --allow-cache-reset
   --fqbn esp32:esp32:esp32c6 --sequence portable-edit --trials 5
   --require-ck-mode native-relink-compile-only ...` then
   `Evaluate-CKForgePerformanceGate.cjs --certify-native-relink`.
   Then extend board coverage (c3/s3/esp32/s2...) by adding ExactBase rows +
   per-board A/B runs (same batch pattern as AVR's 38 targets).

## Known hazards
- flash_args trailing spaces: replay the exact `cmd /c echo ... && ...`
  recipe command; never trim.
- file_opts must exist and be EMPTY for sketch TU compiles (core.postbuild.1
  truncates it); create-if-missing guard already exists (~2805).
- sdkconfig copy (prebuild.8) is dead weight for edit compiles — safely
  skippable (nothing reads the build-dir copy during compile/link).
- The sketch CCDB entry runs the ccache shim; the byte-native replay must
  substitute the real compiler path (nocache override pattern ~1609) while
  keeping every other token identical.
- Eligibility revalidation cost: identity lease + dependency signature are
  already optimized (guard walk); avoid adding per-edit rehash of the ~50
  SDK archives — they are covered by the toolchain identity guard.
- AVR full-matrix rerun required after the EXE changes (certificates bind
  production EXE sha) — rerun the AVR batch after ESP32 lands.
