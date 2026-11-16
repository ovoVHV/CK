#include <WiFi.h>

void setup() {
  WiFi.begin("MyWiFi", "12345678");
  WiFi.mode(WIFI_STA);
}

void loop() {
  // Wi-Fi connection initiated in setup
}
