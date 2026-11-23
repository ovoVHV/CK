{
  "format": "ck-project",
  "schema_version": 1,
  "migration_version": 1,
  "name": "多文件闪灯",
  "board": "arduino:avr:nano",
  "board_package_id": "arduino:avr:nano",
  "options": "{\"cpu\":\"atmega328\"}",
  "xml": "{\"blocks\":{\"languageVersion\":0,\"blocks\":[]},\"ckSource\":{\"version\":1,\"mode\":\"source\",\"generatedBase\":\"void setup() {\\n}\\n\\nvoid loop() {\\n}\",\"code\":\"#include \\\"Blink.h\\\"\\nvoid setup() { initBlink(); }\\nvoid loop() { blinkOnce(); }\\n\"}}",
  "code": "#include \"Blink.h\"\nvoid setup() { initBlink(); }\nvoid loop() { blinkOnce(); }\n"
}
