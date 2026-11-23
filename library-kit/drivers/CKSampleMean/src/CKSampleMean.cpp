// SPDX-License-Identifier: Apache-2.0
#include "CKSampleMean.h"
#include <math.h>

namespace CKSampleMean {
namespace { float ring[16]; uint8_t width = 4, used, next; }
void reset(uint8_t size) {
    width = size < 1 ? 1 : size > 16 ? 16 : size;
    used = next = 0;
}
void push(float value) {
    if (!isfinite(value)) return;
    ring[next] = value;
    if (++next == width) next = 0;
    if (used < width) ++used;
}
float mean() {
    if (!used) return 0;
    // Bounded work, with no accumulated rounding error across windows.
    float total = 0;
    for (uint8_t i = 0; i < used; ++i) total += ring[i] / used;
    return total;
}
uint8_t count() { return used; }
}
