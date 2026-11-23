// SPDX-License-Identifier: Apache-2.0
#pragma once
#include <Arduino.h>

namespace CKButtonLatch {
void begin(uint8_t pin, uint16_t debounceMs);
void update();
bool pressed();
bool justPressed();
}
