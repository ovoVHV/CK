#include "CKNativeDeep.h"
#include "vendor/deep/codec.h"

int32_t ck_native_add(int32_t left, int32_t right) {
    return left + right;
}

uint8_t ck_native_checksum(const uint8_t *data, uint32_t length) {
    return ck_native_deep_checksum(data, length);
}
