# Retained real-model failure

`alpha41-failure.json` contains the two real candidate HEX files from alpha.41 sample `ai-phase4-candidate-1794450111356`, their content/source identities, the actual model proposals and its fixed plan, plus the pre-existing independent contract. No API key or captured chat transport is included.

The first candidate changes only the threshold and passes the independent contract. It fails the model's erroneous later-edge requirement. The second candidate adds sample counting, passes that self-test and fails the independent startup check. The phase5 test retains all four outcomes and checks that the attempted variable addition violates the fixed field repair scope. It does not silently change the test or the captured firmware.

These are AVR instruction-simulation regressions, not physical-board evidence.
