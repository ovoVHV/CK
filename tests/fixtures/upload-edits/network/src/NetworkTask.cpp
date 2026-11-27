#include "../NetworkTask.h"
#include <WiFi.h>

void startNetwork(const char *name, int channel) {
  WiFi.softAP(name, nullptr, channel);
}
