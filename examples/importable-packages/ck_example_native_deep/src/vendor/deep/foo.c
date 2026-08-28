#include "codec.h"

uint8_t ck_native_deep_checksum(const uint8_t *data, uint32_t length) {
    uint8_t checksum = 0;
    uint32_t index;
    for (index = 0; index < length; index += 1) {
        checksum = (uint8_t)(checksum ^ data[index]);
    }
    return checksum;
}
