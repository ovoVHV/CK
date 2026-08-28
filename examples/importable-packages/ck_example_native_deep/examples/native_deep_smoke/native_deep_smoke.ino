#include <CKNativeDeep.h>
#include <driver/CKNativeDriver.h>

void setup() {
  Serial.begin(115200);
  CKNativeDriver::beginWire();
  const uint8_t payload[] = {1, 2, 3, 4};
  Serial.println(ck_native_add(20, 22));
  Serial.println(CKNativeDriver::scale(7, 6));
  Serial.println(ck_native_checksum(payload, sizeof(payload)));
}

void loop() {}
