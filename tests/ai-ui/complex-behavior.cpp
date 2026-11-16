// The caller includes the exact generated sketch before this file.
// This is a host simulation of Arduino APIs, never a hardware qualification.
#include <cmath>
#include <regex>
static void check_samples(unsigned long interval,unsigned long end){
  ck_assert(ck_samples.size()==end/interval,"wrong number of analog samples");
  for(size_t i=0;i<ck_samples.size();++i)ck_assert(ck_samples[i]==(i+1)*interval,"sample cadence mismatch");
}
static void check_lines(unsigned long interval,unsigned long end){
  ck_assert(Serial.baud==115200,"Serial baud must be 115200");
  ck_assert(Serial.lines.size()==end/interval,"wrong telemetry count");
  for(size_t i=0;i<Serial.lines.size();++i)ck_assert(Serial.lines[i].at==(i+1)*interval,"telemetry is not independent");
}
static bool prints_value(const std::string& text,int value){
  const auto expected=std::to_string(value);
  if(text.size()<expected.size())return false;
  const auto offset=text.size()-expected.size();
  return text.compare(offset,expected.size(),expected)==0&&(offset==0||text[offset-1]<'0'||text[offset-1]>'9');
}
static bool prints_mean(const std::string& text,double value){
  // The requirement does not mandate integer or floating-point telemetry.
  // Accept a labeled numeric suffix and Arduino's normal decimal rounding,
  // as well as integer averaging. Do not require the model to change valid code.
  static const std::regex suffix(R"(([+-]?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)\s*$)");
  std::smatch match;
  if(!std::regex_search(text,match,suffix))return false;
  const double actual=std::stod(match[1].str());
  return std::abs(actual-value)<=0.011||actual==std::floor(value);
}
static void hysteresis(){
  ck_safety_pin=9;ck_safety_input=8;ck_fault_guard=true;ck_raw=650;setup();
  ck_assert(ck_modes[9]==OUTPUT&&ck_modes[8]==INPUT_PULLUP,"wrong output/button initialization");
  ck_assert(ck_pins[9]==LOW,"startup output must be off");
  bool expected=false;int latest=0;
  for(unsigned long t=0;t<=3200;++t){
    ck_now=t;
    if(t==150)ck_raw=750;if(t==250)ck_raw=650;if(t==450)ck_raw=600;if(t==550)ck_raw=700;
    if(t==650)ck_raw=1018;if(t==750)ck_raw=800;if(t==850)ck_raw=5;if(t==950)ck_raw=650;
    if(t==1050)ck_raw=750;if(t==1250)ck_raw=600;
    if(t==1350)ck_raw=750;if(t==1450)ck_raw=699;if(t==1550)ck_raw=601;if(t==1650)ck_raw=600;
    if(t==1750)ck_raw=601;if(t==1850)ck_raw=699;if(t==1950)ck_raw=700;
    if(t==2250)ck_raw=2;if(t==2450)ck_raw=1017;if(t==2650)ck_raw=1023;
    // Hold across a sample, release between samples. Immediate and no pulse both matter.
    ck_external[8]=(t>=1125&&t<1225)?LOW:HIGH;
    if(t&&t%100==0){latest=ck_raw;if(latest<=5||latest>=1018)expected=false;else if(latest>=700)expected=true;else if(latest<=600)expected=false;}
    if(ck_external[8]==LOW)expected=false;
    loop();ck_assert(ck_pins[9]==int(expected),"hysteresis, fault or immediate button priority mismatch");
    if(t&&t%1000==0)ck_assert(!Serial.lines.empty()&&prints_value(Serial.lines.back().text,latest),"telemetry value mismatch");
  }
  check_samples(100,3200);check_lines(1000,3200);
}
static int light(){
  ck_assert(ck_pins[8]+ck_pins[9]+ck_pins[10]==1,"exactly one traffic light must be active after loop");
  return ck_pins[8]?0:(ck_pins[10]?1:2);
}
static unsigned long duration(int state){return state==0?3000UL:state==1?4000UL:1000UL;}
static void traffic(bool wrap){
  if(wrap)ck_now=0xfffff000UL;
  setup();ck_assert(ck_modes[2]==INPUT_PULLUP,"emergency button must use pullup");ck_assert(light()==0,"startup must be red");
  int expected=0;unsigned long changed=0;bool wasHeld=false;int heart=ck_pins[13];unsigned long heartAt=0;
  const unsigned long start=ck_now;
  if(wrap){loop();expected=light();changed=start;heart=ck_pins[13];heartAt=start;}
  for(unsigned long elapsed=wrap?1:0;elapsed<=16000;++elapsed){
    ck_now=start+elapsed;
    const bool held=!wrap&&((elapsed>=1750&&elapsed<2250)||(elapsed>=6200&&elapsed<6800));
    ck_external[2]=held?LOW:HIGH;
    if(held){expected=0;changed=ck_now;}
    else if(wasHeld){expected=0;changed=ck_now;}
    else if(static_cast<unsigned long>(ck_now-changed)>=duration(expected)){expected=(expected+1)%3;changed=ck_now;}
    if(static_cast<unsigned long>(ck_now-heartAt)>=250){heart=!heart;heartAt=ck_now;}
    loop();ck_assert(light()==expected,"traffic phase / emergency release restart / rollover mismatch");
    ck_assert(ck_pins[13]==heart,"independent heartbeat mismatch");wasHeld=held;
  }
}
static void ring(){
  setup();ck_assert(ck_modes[13]==OUTPUT&&ck_pins[13]==LOW,"ring output startup");
  std::vector<int> readings;double mean=0;bool expected=false;
  for(unsigned long t=0;t<=4000;++t){
    ck_now=t;
    const unsigned long sample=t/20;
    ck_raw=sample<=3?800:(sample<=14?0:(sample<=25?1023:(sample<=35?500:(sample<=45?400:int((sample*137+53)%1024)))));
    if(t&&t%20==0){readings.push_back(ck_raw);if(readings.size()>8)readings.erase(readings.begin());int sum=0;for(auto v:readings)sum+=v;mean=double(sum)/readings.size();if(mean>=600)expected=true;else if(mean<=400)expected=false;}
    loop();ck_assert(ck_pins[13]==int(expected),"partial-fill, rolling mean or hysteresis mismatch");
    if(t&&t%200==0)ck_assert(!Serial.lines.empty()&&prints_mean(Serial.lines.back().text,mean),"mean telemetry mismatch");
  }
  check_samples(20,4000);check_lines(200,4000);
}
static void debounce(bool wrap){
  if(wrap)ck_now=0xfffff000UL;
  setup();ck_assert(Serial.baud==115200,"debounce serial baud");
  ck_assert(ck_modes[2]==INPUT_PULLUP&&ck_modes[9]==OUTPUT&&ck_modes[13]==OUTPUT,"debounce modes");
  ck_assert(ck_pins[9]==LOW&&ck_pins[13]==LOW,"debounce startup off");
  const auto start=ck_now;int last=HIGH,stable=HIGH,out=LOW,heart=LOW;unsigned long changed=start,heartAt=start,count=0;
  if(wrap){loop();heart=ck_pins[13];}
  for(unsigned long elapsed=wrap?1:0;elapsed<=7000;++elapsed){
    ck_now=start+elapsed;
    int raw=((elapsed>=100&&elapsed<104)||(elapsed>=108&&elapsed<112)||(elapsed>=120&&elapsed<700)||(elapsed>=900&&elapsed<930)||(elapsed>=3000&&elapsed<5000))?LOW:HIGH;
    ck_external[2]=raw;
    if(raw!=last){last=raw;changed=ck_now;}
    if(static_cast<unsigned long>(ck_now-changed)>=30&&raw!=stable){stable=raw;if(stable==LOW){out=!out;++count;}}
    if(static_cast<unsigned long>(ck_now-heartAt)>=250){heart=!heart;heartAt=ck_now;}
    loop();ck_assert(ck_pins[9]==out,"debounce press/release/hold mismatch");ck_assert(ck_pins[13]==heart,"debounce heartbeat mismatch");
    ck_assert(Serial.lines.size()==count,"debounce count must print once per accepted press");
  }
}
int main(int argc,char** argv){
  std::fill(std::begin(ck_external),std::end(ck_external),HIGH);
  try{
    const std::string mode=argc>1?argv[1]:"";
    if(mode=="hysteresis-safety")hysteresis();else if(mode=="traffic-emergency")traffic(false);else if(mode=="traffic-rollover")traffic(true);else if(mode=="ring-buffer-filter")ring();else if(mode=="uno-debounce")debounce(false);else if(mode=="debounce-rollover")debounce(true);else throw std::runtime_error("unknown scenario");
    std::cout<<"{\"status\":\"PASS\",\"checks\":"<<ck_checks<<",\"analogSamples\":"<<ck_samples.size()<<",\"digitalWrites\":"<<ck_writes<<",\"telemetryLines\":"<<Serial.lines.size()<<"}\n";
    return 0;
  }catch(const std::exception& e){std::cerr<<e.what()<<"\n";return 1;}
}

