#include "CKPositionServo.h"
#include <Arduino.h>
#if defined(ARDUINO_ARCH_AVR)
#include <Servo.h>
#elif !defined(ARDUINO_ARCH_ESP32) || ESP_ARDUINO_VERSION_MAJOR != 3
#error CKPositionServo requires Arduino AVR or Arduino ESP32 Core 3.x
#endif

namespace CKPositionServo {
namespace {
#if defined(ARDUINO_ARCH_AVR)
Servo servos[2];
#endif
unsigned char pins[2] = {};
int commands[2] = {-1, -1};
}
namespace detail {
void stop(unsigned char slot) {
  if (commands[slot] < 0) return;
#if defined(ARDUINO_ARCH_AVR)
  servos[slot].detach();
#else
  ledcDetach(pins[slot]);
#endif
  pinMode(pins[slot], OUTPUT);
  digitalWrite(pins[slot], LOW);
  commands[slot] = -1;
}
void write(unsigned char slot, double angle) {
  if (commands[slot] < 0 || !isfinite(angle)) return;
  const int target = static_cast<int>(angle < 0 ? 0 : angle > 180 ? 180 : angle);
#if defined(ARDUINO_ARCH_AVR)
  servos[slot].write(target);
#else
  // 50 Hz = 20000 us. A 1..2 ms pulse occupies 5..10% of a 14-bit cycle.
  const unsigned long us = 1000UL + (target * 1000UL + 90) / 180;
  if (!ledcWrite(pins[slot], (us * 16384UL + 10000) / 20000)) { stop(slot); return; }
#endif
  commands[slot] = target;
}
void begin(unsigned char slot, double pin) {
  stop(slot);
  if (!(pin >= 0 && pin < NUM_DIGITAL_PINS) || pin != static_cast<unsigned char>(pin)) return;
  const auto gpio = static_cast<unsigned char>(pin);
  if (commands[1 - slot] >= 0 && pins[1 - slot] == gpio) return;
#if defined(ARDUINO_ARCH_AVR)
  if (servos[slot].attach(gpio, 1000, 2000) == INVALID_SERVO) return;
#else
  if (!digitalPinCanOutput(digitalPinToGPIONumber(gpio)) || !ledcAttach(gpio, 50, 14)) return;
#endif
  pins[slot] = gpio;
  commands[slot] = 0;
  write(slot, 90);
}
int commanded(unsigned char slot) { return commands[slot]; }
}
}
