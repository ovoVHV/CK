#include "CKDht22.h"
#include <DHT.h>
#include <new>

namespace CKDht22 {
namespace {
struct Channel {
  alignas(DHT) unsigned char storage[sizeof(DHT)];
  DHT* sensor;
  float temperature;
  float humidity;
  bool valid;
};
Channel channels[2] = {};
}

namespace detail {
void begin(unsigned char slot, double pin) {
  auto& c = channels[slot];
  if (c.sensor) c.sensor->~DHT();
  c.sensor = nullptr;
  c.valid = false;
  if (!(pin >= 0 && pin < NUM_DIGITAL_PINS) || pin != static_cast<unsigned char>(pin)) return;
  c.sensor = new (c.storage) DHT(static_cast<unsigned char>(pin), DHT22);
  c.sensor->begin();
}
void sample(unsigned char slot) {
  auto& c = channels[slot];
  c.valid = false;
  if (c.sensor && c.sensor->read()) {
    c.temperature = c.sensor->readTemperature();
    c.humidity = c.sensor->readHumidity();
    c.valid = !isnan(c.temperature) && !isnan(c.humidity);
  }
}
bool valid(unsigned char slot) { return channels[slot].valid; }
float temperature(unsigned char slot) { return valid(slot) ? channels[slot].temperature : NAN; }
float humidity(unsigned char slot) { return valid(slot) ? channels[slot].humidity : NAN; }
}
}
