#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

int16_t ck_example_sensor_decode_raw(uint8_t msb, uint8_t lsb);
float ck_example_sensor_raw_to_celsius(int16_t raw);

#ifdef __cplusplus
}
#endif
