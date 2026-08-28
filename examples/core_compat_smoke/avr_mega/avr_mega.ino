void setup() {
  Serial.begin(115200);
#if defined(ARDUINO_ARCH_ESP32)
  Serial1.begin(115200, SERIAL_8N1, 19, 18);
#elif defined(HAVE_HWSERIAL1)
  Serial1.begin(115200);
#endif
}

void loop() {
#if defined(HAVE_HWSERIAL1)
  if (Serial1.available() > 0) {
    Serial.write(Serial1.read());
  }
#endif
}
