#ifndef CK_MEDIAN5_FLOAT_H
#define CK_MEDIAN5_FLOAT_H

#include <Arduino.h>

// 5点窗口的 double 中值滤波，状态为本编译单元内的静态缓冲。
namespace ckMedian5Float {
static const uint8_t kWindowSize = 5;
static double samples[kWindowSize];
static uint8_t sampleCount = 0;  // 实际样本数，最多 kWindowSize
static uint8_t writeIndex = 0;   // 下一次写入位置
}

static inline void ckMedian5fReset() {
  for (uint8_t i = 0; i < ckMedian5Float::kWindowSize; i++) {
    ckMedian5Float::samples[i] = 0.0;
  }
  ckMedian5Float::sampleCount = 0;
  ckMedian5Float::writeIndex = 0;
}

static inline void ckMedian5fPush(double value) {
  ckMedian5Float::samples[ckMedian5Float::writeIndex] = value;
  ckMedian5Float::writeIndex =
      (uint8_t)((ckMedian5Float::writeIndex + 1) % ckMedian5Float::kWindowSize);
  if (ckMedian5Float::sampleCount < ckMedian5Float::kWindowSize) {
    ckMedian5Float::sampleCount++;
  }
}

static inline double ckMedian5fValue() {
  uint8_t n = ckMedian5Float::sampleCount;
  if (n == 0) {
    return 0.0;
  }
  double sorted[ckMedian5Float::kWindowSize];
  for (uint8_t i = 0; i < n; i++) {
    sorted[i] = ckMedian5Float::samples[i];
  }
  for (uint8_t i = 1; i < n; i++) {
    double key = sorted[i];
    int j = (int)i - 1;
    while (j >= 0 && sorted[j] > key) {
      sorted[j + 1] = sorted[j];
      j--;
    }
    sorted[j + 1] = key;
  }
  if ((n % 2) == 1) {
    return sorted[n / 2];
  }
  return (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0;
}

#endif  // CK_MEDIAN5_FLOAT_H
