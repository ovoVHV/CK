# 安全反馈与预览版边界

CK alpha.46 是预览版，源码公开不等于生产安全认证。会话缓存的 T1 信任边界和 AI/板卡验证范围见 [PUBLICATION.md](docs/PUBLICATION.md)。

请勿在公开 Issue 中贴出 API 密钥、Wi-Fi 密码、服务器登录信息、用户聊天或私人工程。普通问题使用脱敏的最小复现；敏感漏洞可通过仓库 Security 页中的私密报告入口（可用时）提交。没有私密入口时，可以先提出联系请求，不公开利用细节或凭据。

2026-11-16 源码准备时，`npm audit --omit=dev` 对现有前端锁文件报告了 3 项依赖告警：ajv、fast-uri 为 moderate，ws 为 high。这是依赖数据库报告，不等同于已证明 CK 的具体利用链。本次保留 alpha.46 依赖基线，没有把依赖升级与源码公开混在一起；后续修复需做相应回归。开发依赖另有告警，可用 `npm audit --prefix desktop/apps/desktop` 复查当前结果。
