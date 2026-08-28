#include <Wire.h>
#include <CKExampleSensor.h>

CKExampleSensor sensor(0x48);

void setup() {
  Serial.begin(115200);
  Wire.begin();
  sensor.begin();
}

void loop() {
  Serial.println(sensor.readCelsius());
  delay(1000);
}
