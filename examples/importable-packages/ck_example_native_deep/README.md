# CK 深层原生 Arduino 库示例

这是一个没有 Blockly 脚本的纯原生 Arduino 库，可通过 CK 库管理器的“本地导入”导入 `ck_example_native_deep.zip`。导入质量报告应将其识别为 `arduino-library`，只声明 `import-gate` 与 `compile-resolver` 两个已验证消费者。

目录刻意覆盖 Arduino 1.5+ 标准的单一递归源码根：

- `src/foo.c`：根级 C 源码；
- `src/driver/foo.cpp`：嵌套 C++ 源码，并真实使用 `Wire` 依赖；
- `src/vendor/deep/foo.c`：更深层 C 源码，与根目录同名但必须生成不同对象；
- `src/CKNativeDeep.h` 与 `src/driver/CKNativeDriver.h`：分别以 `CKNativeDeep.h`、`driver/CKNativeDriver.h` 从唯一 `src/` include 根公开。

`library.json` 与 `library.properties` 的版本、架构、公开头、许可证和 `Wire` 依赖保持一致。`examples/native_deep_smoke` 会调用三个目录中的实现；如果导入、递归发现或链接拍平发生错误，示例会在编译或链接阶段失败。

本包不混入旧 Arduino 1.0 的根目录加 `utility/` 布局。该布局只保留为 `scripts/fixtures/importable-packages/legacy_utility_library` 的编译兼容测试夹具，不会打入面向用户的 ZIP。
