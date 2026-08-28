#include "internal/CKExampleSensorCodec.h"

float ck_example_sensor_raw_to_celsius(int16_t raw) {
  return (float)raw / 256.0f;
}
