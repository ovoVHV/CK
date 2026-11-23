// SPDX-License-Identifier: Apache-2.0
#pragma once
#include <Arduino.h>

namespace CKSampleMean {
void reset(uint8_t width);
void push(float value);
float mean();
uint8_t count();
}
