#include "CKOled128x64.h"
#include <Arduino.h>
#include <Wire.h>

namespace CKOled128x64 {
namespace {
uint8_t addr;
bool online;
// The AVR Wire TX buffer has 32 bytes including the command/data prefix.
bool commands(const uint8_t *cmd, uint8_t count) {
  Wire.beginTransmission(addr);
  Wire.write(uint8_t(0x00));
  Wire.write(cmd, count);
  return Wire.endTransmission() == 0;
}
bool fillPage(uint8_t page, uint8_t litColumns) {
  const uint8_t window[] = {0x21, 0, 127, 0x22, page, page};
  if (!commands(window, sizeof(window))) return false;
  for (int x = 0; x < 128; x += 16) {
    Wire.beginTransmission(addr);
    Wire.write(uint8_t(0x40));
    for (int i = 0; i < 16; ++i) Wire.write(uint8_t(x+i < litColumns ? 0xff : 0));
    if (Wire.endTransmission() != 0) return false;
  }
  return true;
}
}
void begin(uint8_t address) {
  addr = address;
  online = false;
  if (addr != 0x3c && addr != 0x3d) return;
  Wire.begin();
  const uint8_t init[] = {0xae, 0xd5,0x80, 0xa8,63, 0xd3,0, 0x40, 0x8d,0x14,
    0x20,0x00, 0xa1,0xc8, 0xda,0x12, 0x81,0x7f, 0xd9,0xf1, 0xdb,0x40, 0xa4,0xa6,0x2e};
  if (!commands(init, sizeof(init))) return;
  for (uint8_t p=0; p<8; ++p) if (!fillPage(p, 0)) return;
  const uint8_t on = 0xaf;
  online = commands(&on, 1);
}
bool ready() { return online; }
void bar(double percent) {
  if (!online || !isfinite(percent)) return;
  percent = constrain(percent, 0.0, 100.0);
  online = fillPage(3, uint8_t(percent * 1.28 + 0.5));
}
void invert(bool enabled) {
  const uint8_t cmd = enabled ? 0xa7 : 0xa6;
  if (online) online = commands(&cmd, 1);
}
}
