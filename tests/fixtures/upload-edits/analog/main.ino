#include "AnalogReading.h"
#define INPUT_CHANNEL 2
const int baudRate = 9600;
uint16_t measure(uint8_t pin) {
  return sampleInput(pin);
}
void setup() {
  Serial.begin(baudRate);
}
void loop() {
  Serial.println(measure(INPUT_CHANNEL));
  Serial.flush();
}
