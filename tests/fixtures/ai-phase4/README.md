# Cross-language task checkpoint fixture

This JSON was captured from the actual alpha.41 desktop failure-injection test on 2026-11-12. Its candidate deliberately used threshold 800 against a locked 650 requirement, so the firmware compiled but the independent GPIO assertion failed. The draft is not authority to apply, install, compile or reuse artifacts. It contains no API key or firmware.

Both the renderer checkpoint validator and the native encrypted-store test consume this exact fixture. It guards the protocol addition for `lastFailure`; the first desktop run exposed a native allowlist mismatch, which was fixed before delivery. The native test also rejects an injected executable token and an invalid retry budget.

`large-acceptance.json` is the model-produced 13-requirement plan from the default-32k serial task that encountered context overflow after failed behavior feedback. It is used only as a large real data shape in the synthetic runtime test; that test deliberately injects failure then success to verify bookkeeping, not physical behavior or plan quality. The actual failed desktop sample remains in the audit.
