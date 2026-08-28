void setup() {
  Serial.begin(115200);
  while (!Serial) {
    ; // wait for serial port to connect. Needed for native USB
  }
  Serial.println("\n\n--- CK Engine: Verification Start ---");
}

void loop() {
  Serial.println("Hello from CK Engine! [Serial Monitor Verified]");
  delay(1000);
}
