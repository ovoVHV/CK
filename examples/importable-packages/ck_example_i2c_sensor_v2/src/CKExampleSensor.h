#pragma once

#include <Arduino.h>
#include <Wire.h>

class CKExampleSensor {
 public:
  explicit CKExampleSensor(uint8_t address) : address_(address) {}
  void begin();
  float readCelsius();

 private:
  uint8_t address_;
  bool present_ = false;
};
