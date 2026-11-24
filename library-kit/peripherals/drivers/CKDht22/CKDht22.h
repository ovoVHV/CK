#pragma once

namespace CKDht22 {
namespace detail {
void begin(unsigned char slot, double pin);
void sample(unsigned char slot);
bool valid(unsigned char slot);
float temperature(unsigned char slot);
float humidity(unsigned char slot);
template<unsigned int Channel> constexpr unsigned char slot() {
  static_assert(Channel == 1 || Channel == 2, "CK_DHT22_CHANNEL: use channel 1 or 2");
  return Channel - 1;
}
}

template<unsigned int Channel> void begin(double pin) { detail::begin(detail::slot<Channel>(), pin); }
template<unsigned int Channel> void sample() { detail::sample(detail::slot<Channel>()); }
template<unsigned int Channel> bool valid() { return detail::valid(detail::slot<Channel>()); }
template<unsigned int Channel> float temperature() { return detail::temperature(detail::slot<Channel>()); }
template<unsigned int Channel> float humidity() { return detail::humidity(detail::slot<Channel>()); }
}
