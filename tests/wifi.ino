#include <WiFi.h>
#include <Wire.h>
#include <SPI.h>

const char* ssid = "MyWiFi";
const char* password = "12345678";

void setup() {
  Serial.begin(115200);
  Wire.begin();
  SPI.begin();

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println(WiFi.localIP());
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();
  }
  delay(1000);
}
