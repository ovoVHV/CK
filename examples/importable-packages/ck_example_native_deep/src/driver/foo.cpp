#include "CKNativeDriver.h"

#include <Wire.h>

int32_t CKNativeDriver::scale(int32_t value, int32_t factor) {
    return value * factor;
}

void CKNativeDriver::beginWire() {
    Wire.begin();
}
