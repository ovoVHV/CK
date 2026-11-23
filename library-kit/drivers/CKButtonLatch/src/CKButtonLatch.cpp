// SPDX-License-Identifier: Apache-2.0
#include "CKButtonLatch.h"

namespace CKButtonLatch {
namespace {
uint8_t inputPin;
uint16_t interval;
uint32_t changedAt;
bool ready, rawDown, stableDown, pressEdge;
}
void begin(uint8_t pin, uint16_t debounceMs) {
    inputPin = pin;
    interval = debounceMs;
    pinMode(pin, INPUT_PULLUP);
    rawDown = stableDown = digitalRead(pin) == LOW;
    changedAt = millis();
    pressEdge = false;
    ready = true;
}
void update() {
    pressEdge = false;
    if (!ready) return;
    const bool down = digitalRead(inputPin) == LOW;
    const uint32_t now = millis();
    if (down != rawDown) {
        rawDown = down;
        changedAt = now;
    } else if (rawDown != stableDown && uint32_t(now - changedAt) >= interval) {
        stableDown = rawDown;
        pressEdge = stableDown;
    }
}
bool pressed() { return stableDown; }
bool justPressed() { return pressEdge; }
}
