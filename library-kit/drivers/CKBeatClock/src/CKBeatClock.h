// SPDX-License-Identifier: Apache-2.0
#pragma once
#include <Arduino.h>

namespace CKBeatClock {
void start(uint32_t periodMs);
bool poll();
void stop();
}
