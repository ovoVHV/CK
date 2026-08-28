# FLFE 支持状态展示审计（2026-07-25）

## 结论

FLFE 是跨 Arduino Core 的统一资格与路由底座，不是只兼容两个目标。当前界面、文档或报告
只有在**所查 production EXE**的精确主机、CLI、Core、工具链、完整 FQBN、operation 和
构建合同通过 `simple -> complex -> medium -> simple-return` 四阶段 A/B，并持有可由现行
评估器复算的证书时，才可以显示 `Fast-qualified`。

当前规则下，候选清单、普通 compile-only 兼容通过、Exact 产物回放、旧 EXE 证书、历史
报告中的 `passed` 和真板上传成功均不进入 Fast 计数。旧 `7b45eccf...` 的 Yun/Uno 证书
缺少现行 lane-boundary/四阶段绑定，现行评估器会 fail-closed；它们只保留为历史过程，
不能继续显示为当前两个 Fast 目标。

## 状态词

| 状态 | 含义 | 是否计入 Fast |
| --- | --- | --- |
| `Fast 已认证` | 当前 EXE 的精确证书通过现行评估器复算 | 是 |
| `Fast 待验证` | 尚未取得当前 EXE 的四阶段证书；真实构建使用原生 Arduino CLI Release | 否 |
| `兼容回归通过` | 某次 compile-only、产物或资源门禁通过 | 否 |
| `Exact 命中` | 完整证据相同时回放已存在产物 | 否 |
| `历史证书/报告` | 绑定其他 EXE、旧合同或旧评估器 | 否 |
| `不兼容` | 命中确定性阻止条件；不能用来描述仅仅缺少 Fast 证书 | 否 |

## ESP32 资格工作表

同一报告入口会把 ESP32-C3、C5、C6、S3、H2、P4、Adafruit Feather ESP32-S3，以及
回归目录中的经典 ESP32、S2 和高风险菜单组合列为 `qualification-pending`。这些条目不是
逐板硬编码的加速实现，也不是不兼容清单；它们共享同一个四阶段 runner、评估器和证书
合同，只是每个完整身份必须独立给出证据。

只读查询：

```powershell
node scripts/Report-CKForgeFastQualifications.cjs `
  --exe target/release/appsdesktop.exe `
  --architecture esp32 `
  --format text
```

输出中的 `Fast-qualified targets` 只统计有效证书；`Qualification pending (not incompatible)`
单独统计待办，不会混入 Fast 数量。

## 已修展示面

- `Report-CKForgeFastQualifications.cjs` 现在同时输出持证目标和待验证工作表。
- `docs/specification/index.json` 不再把某个旧 EXE 哈希和两张证书写成动态“当前”状态。
- CK Forge、FLFE、性能门禁、功能清单和 AVR 历史矩阵统一把 `7b45eccf...` 标为历史快照。
- 旧证书在现行评估器下失效的事实已进入测试，不再用旧计数锁住文档。
- `compile_doctor.ts` 只有完整匹配当前 schema、v8 合同、FQBN/Core、CLI、工具链与构建
  签名的 `allow-fast` 才显示“CK Forge · 热构建”；旧日志和残缺声明显示待验证/证据不完整。
- `release_notes.ts` 已把 C6 历史正确性/真板证据与当前 FLFE Fast 资格分开。

## 后续命名收口

`ck_forge_qualified_targets.v1.json` 与 `BuiltinQualificationManifest` 的历史命名仍像 Fast
   白名单。兼容路径允许时应增加机器字段 `manifest_role=compatibility-candidate-registry`
   并逐步改名；在此之前所有 UI 必须称其为“候选身份清单”。
