#pragma once
#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
using byte = unsigned char;
constexpr int LOW=0, HIGH=1, INPUT=0, OUTPUT=1, INPUT_PULLUP=2;
constexpr int A0=14,A1=15,A2=16,A3=17,A4=18,A5=19;
static_assert(sizeof(unsigned long)==4, "Arduino millis rollover requires a 32-bit unsigned long");
inline unsigned long ck_now=0;
inline int ck_raw=0, ck_pins[64]={}, ck_modes[64]={};
inline int ck_external[64];
inline int ck_safety_pin=-1, ck_safety_input=-1;
inline bool ck_fault_guard=false;
inline int ck_last_analog=0;
inline unsigned long ck_checks=0,ck_writes=0;
inline std::vector<unsigned long> ck_samples;
inline void ck_assert(bool ok,const std::string& reason){++ck_checks;if(!ok)throw std::runtime_error("t="+std::to_string(ck_now)+": "+reason);}
inline unsigned long millis(){return ck_now;}
inline void delay(unsigned long){throw std::runtime_error("Blocking delay was called");}
inline void delayMicroseconds(unsigned int){throw std::runtime_error("Blocking delayMicroseconds was called");}
inline void pinMode(int pin,int mode){ck_assert(pin>=0&&pin<64,"pinMode pin range");ck_modes[pin]=mode;}
inline int analogRead(int pin){ck_assert(pin==A0,"unexpected analog input");ck_samples.push_back(ck_now);ck_last_analog=ck_raw;return ck_raw;}
inline int digitalRead(int pin){ck_assert(pin>=0&&pin<64,"digitalRead pin range");return ck_external[pin];}
inline void digitalWrite(int pin,int value){ck_assert(pin>=0&&pin<64,"digitalWrite pin range");if(pin==ck_safety_pin&&value&&ck_safety_input>=0)ck_assert(ck_external[ck_safety_input]!=LOW,"output pulsed ON while emergency button held");if(pin==ck_safety_pin&&value&&ck_fault_guard)ck_assert(ck_last_analog>5&&ck_last_analog<1018,"output pulsed ON while a fault reading was active");ck_pins[pin]=value?HIGH:LOW;++ck_writes;}
struct CkSerialLine {unsigned long at;std::string text;};
struct CkSerial {
  unsigned long baud=0;std::ostringstream pending;std::vector<CkSerialLine> lines;
  void begin(unsigned long value){baud=value;}
  template<class T> void print(T value){pending<<value;}
  template<class T> void println(T value){print(value);println();}
  void println(){lines.push_back({ck_now,pending.str()});pending.str("");pending.clear();}
};
inline CkSerial Serial;

