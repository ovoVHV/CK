#include "CKExampleSensor.h"
#include "internal/CKExampleSensorCodec.h"

void CKExampleSensor::begin() {
  Wire.beginTransmission(address_);
  present_ = Wire.endTransmission() == 0;
}

float CKExampleSensor::readCelsius() {
  if (!present_) return NAN;
  Wire.requestFrom(address_, static_cast<uint8_t>(2));
  if (Wire.available() < 2) return NAN;
  const uint8_t msb = static_cast<uint8_t>(Wire.read());
  const uint8_t lsb = static_cast<uint8_t>(Wire.read());
  const int16_t raw = ck_example_sensor_decode_raw(msb, lsb);
  return ck_example_sensor_raw_to_celsius(raw);
}
