#include <Arduino.h>
#include "AnalogReading.h"
uint16_t sampleInput(uint8_t pin) { return analogRead(pin); }
