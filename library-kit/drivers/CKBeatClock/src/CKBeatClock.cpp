// SPDX-License-Identifier: Apache-2.0
#include "CKBeatClock.h"

namespace CKBeatClock {
namespace { uint32_t anchor, period; }
void start(uint32_t periodMs) {
    anchor = millis();
    period = periodMs;
}
bool poll() {
    if (!period) return false;
    const uint32_t elapsed = uint32_t(millis()) - anchor;
    if (elapsed < period) return false;
    // Keep the original phase; deliver at most one event per poll.
    anchor += elapsed - elapsed % period;
    return true;
}
void stop() { period = 0; }
}
