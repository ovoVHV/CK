# F-001：Fast/build contract v8/v9 收口记录

状态：已完成（最小兼容性 bugfix）  
日期：2026-08-25

本记录只处理 F-001。Compatibility Epoch、Evidence Envelope、Canonical Model、V2 Block Package 重构及 F-002～F-006 均保持 Deferred；本轮没有创建 v10，也没有放宽任何 Fast、证书、FQBN、Core、toolchain、artifact 或 hash 门禁。

## 根因

Rust builder 已经把当前构建签名推进到：

`ck-fast-build-contract-v9:command-scoped-ccache-native-file-paths-O1-final-g0-no-lto-expanded-ccdb-core-deps-portable-response-guard`

但 Forge 仍残留独立的 v8 常量，bundled qualification manifest 也写着 v8。于是同一份资格输入在 builder、Forge parser、Compile Doctor、board-lock 和 Specification 之间出现两个身份。这个分裂会让证据跨层不可用，或把本应回退的路径解释成可授权路径。

## 实际数据流

```text
Rust builder marker
  -> build/cache/property/signature evidence
  -> qualification runner / report / certificate installer
  -> current Forge loader（重新计算 Core、CLI、toolchain、FQBN、EXE、artifact、hash）
  -> Fast 仅在全部门禁匹配时授权，否则 native Arduino CLI Release
```

- builder：`crates/ck_core/src/builder/demo.rs` 产生唯一当前 marker，并将其纳入构建签名及相关证据。
- 持久化证据：qualification report、local certificate、NativeRelink binding、board passport/`ck.lock` 保存合同 ID，同时保存目标、Core、CLI、工具链、生产 EXE 和产物身份。
- loader/installer：`apps/desktop/src-tauri/src/ck_forge.rs` 的当前 loader 使用 `current_forge_contract_id()`，并重新验证所有身份和性能/产物门禁；仅字符串匹配不能单独授权 Fast。
- Compile Doctor：`apps/desktop/src/services/compile_doctor.ts` 只把当前 marker 的诊断显示为当前 Forge 证据，历史或错误合同显示回退/待资格状态。
- board-lock/passport：`apps/desktop/src-tauri/src/board_passport.rs` 直接引用 builder marker；它记录护照证据，不替代本机性能证书。
- bundled manifest：`apps/desktop/src-tauri/src/ck_forge_qualified_targets.v1.json` 现在使用当前 marker，但仍是 candidate-only；所有目标没有 `performance_ab`，因此不能直接授予 Fast。

## v8 与 v9 的真实差异

v9 增加了 native file/path identity 约束，并强化了命令、缓存和路径证据的绑定。现有审计没有证明这是对外可见的 breaking behavior contract；它更接近实现/证据身份强化。因此：

1. 不能把 v8 无条件 alias 成 v9。
2. v8 manifest、report、certificate、passport 或 binding 不得冒充当前 v9。
3. 旧证据必须重新资格化；无法证明完整当前身份时，继续 `force-platform` 并使用原生 Release。

## 最终权威来源

运行时权威是 Rust builder 的 `FAST_BUILD_CONTRACT_SIGNATURE_MARKER`。Forge 的 `current_forge_contract_id()` 直接返回该 marker；Compile Doctor、board-lock、Specification 和 bundled manifest 只做镜像/一致性约束。后续若实现变化但公共语义不变，应更新 producer/identity digest 并使证据重新验证，不创建新的合同版本。

## 已失效的历史证据

明确带有历史 v8 合同的 manifest、candidate、report、local certificate、NativeRelink binding、board passport 和 Compile Doctor 诊断，不得用于当前 Fast authorization。它们可以保留作审计资料，但只能走拒绝/回退或重新资格化路径。旧证据不是通过改字符串获得有效性。

## 回归覆盖

- `scripts/Validate-FastBuildContractConsistency.test.mjs`：16/16，检查 builder、Forge、Compile Doctor、board-lock、Specification 和 manifest 的统一权威值，并确认 manifest 没有伪造 `performance_ab`。
- `apps/desktop/src/services/compile_doctor_storage.test.mjs`：包含历史 v8 诊断拒绝当前 Fast 的回归。
- `cargo test -p appsdesktop --test ck_forge`：49/49，通过当前 loader、bundled manifest、历史 v8、错误合同、证书身份和原生回退测试。
- 额外覆盖：当前 builder 产出的合同可被当前 loader 识别；错误合同/历史 v8 不能授权；board-lock、Compile Doctor、Forge 使用同一语义。

Exact、普通 Release、上传安全和 V2 Block Package 未改动；bundled manifest 的候选性质也未改变。

## F-001 是否曾经实际阻止 Fast

是。v8/v9 分裂使任何依赖 bundled v8 性能证据的当前授权路径无法通过当前 v9 loader；由于 shipped manifest 本身没有 `performance_ab`，它没有把一个本来有效的 Fast 证书错误升级或降级，而是使该内置路径保持不可授权/回退。当前修复只消除了跨层身份矛盾，未替历史证据背书。

