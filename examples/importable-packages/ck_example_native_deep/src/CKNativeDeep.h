#ifndef CK_NATIVE_DEEP_H
#define CK_NATIVE_DEEP_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

int32_t ck_native_add(int32_t left, int32_t right);
uint8_t ck_native_checksum(const uint8_t *data, uint32_t length);

#ifdef __cplusplus
}
#endif

#endif
