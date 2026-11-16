#include <EEPROM.h>
#include <SoftwareSerial.h>

SoftwareSerial secondarySerial(10, 11);
void setup() {
  secondarySerial.begin(9600);
  EEPROM.update(0, 42);
}
void loop() {
  secondarySerial.write(EEPROM.read(0));
  delay(500);
}
