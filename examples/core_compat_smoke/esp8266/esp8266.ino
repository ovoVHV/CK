#include <ESP8266WiFi.h>

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.begin("ck-smoke", "not-a-network");
}

void loop() {
  String ip = WiFi.localIP().toString();
  long rssi = WiFi.RSSI();
  int channel = WiFi.channel();
  Serial.printf("%s %ld %d\n", ip.c_str(), rssi, channel);
  delay(1000);
}
