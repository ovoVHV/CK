#pragma once

namespace CKPositionServo {
namespace detail {
void begin(unsigned char slot, double pin);
void write(unsigned char slot, double angle);
int commanded(unsigned char slot);
void stop(unsigned char slot);
template<unsigned int Channel> constexpr unsigned char slot() {
  static_assert(Channel == 1 || Channel == 2, "CK_POSITION_SERVO_CHANNEL: use channel 1 or 2");
  return Channel - 1;
}
}
template<unsigned int Channel> void begin(double pin) { detail::begin(detail::slot<Channel>(), pin); }
template<unsigned int Channel> void write(double angle) { detail::write(detail::slot<Channel>(), angle); }
template<unsigned int Channel> int commanded() { return detail::commanded(detail::slot<Channel>()); }
template<unsigned int Channel> void stop() { detail::stop(detail::slot<Channel>()); }
}
