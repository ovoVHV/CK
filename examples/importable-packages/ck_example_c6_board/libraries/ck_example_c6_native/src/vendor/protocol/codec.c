#include "codec.h"

uint32_t ck_example_c6_codec_fold(const char *text) {
  uint32_t value = 2166136261u;
  while (*text != '\0') {
    value ^= (uint8_t)*text++;
    value *= 16777619u;
  }
  return value;
}
