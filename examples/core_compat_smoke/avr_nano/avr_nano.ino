#include <MsTimer2.h>

volatile bool ck_irq_flag = false;

void ck_irq_isr() {
  ck_irq_flag = true;
}

void ck_timer_callback() {
  ck_irq_flag = true;
}

void setup() {
  Serial.begin(115200);
  pinMode(2, INPUT_PULLUP);
  pinMode(13, OUTPUT);
  attachInterrupt(digitalPinToInterrupt(2), ck_irq_isr, FALLING);
  MsTimer2::set(500, ck_timer_callback);
  MsTimer2::start();
}

void loop() {
  unsigned long width = pulseInLong(2, HIGH, 1000UL);
  digitalWrite(13, width > 0 ? HIGH : LOW);
  if (ck_irq_flag) {
    ck_irq_flag = false;
    Serial.println(String("tick:") + String(millis()));
  }
}
