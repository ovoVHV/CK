#include <WiFi.h>
#include <CKExampleC6Native.h>

volatile uint32_t ckExampleBoardLibrarySignature = 0;

void setup() {
  ckExampleBoardLibrarySignature = ck_example_c6_native_signature();
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true);
}

void loop() {}
