#include <WiFi.h>

void setup() {
  Serial.begin(115200);
  WiFi.begin("MyWiFi", "12345678");
  WiFi.mode(WIFI_STA);
}

void loop() {
  // Wi-Fi connection initiated in setup
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi Connected!");
}
