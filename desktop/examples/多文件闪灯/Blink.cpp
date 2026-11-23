#include <Arduino.h>
#include "Blink.h"
#include "src/Timing.h"

void initBlink() { pinMode(LED_BUILTIN, OUTPUT); }
void blinkOnce() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(blinkInterval());
  digitalWrite(LED_BUILTIN, LOW);
  delay(blinkInterval());
}
