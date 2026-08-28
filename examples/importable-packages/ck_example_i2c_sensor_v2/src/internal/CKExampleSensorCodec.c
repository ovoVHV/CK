#include "CKExampleSensorCodec.h"

int16_t ck_example_sensor_decode_raw(uint8_t msb, uint8_t lsb) {
  const uint16_t combined = ((uint16_t)msb << 8) | (uint16_t)lsb;
  return (int16_t)combined;
}
