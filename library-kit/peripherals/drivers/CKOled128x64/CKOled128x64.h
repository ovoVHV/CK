#pragma once
#include <stdint.h>

// One 128x64 SSD1306 on the default Wire bus. No RAM framebuffer.
namespace CKOled128x64 {
  void begin(uint8_t address);
  bool ready();
  void bar(double percent);
  void invert(bool enabled);
}
