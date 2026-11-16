// Execute the unchanged generated sketch and library with simulated hardware.
#include <cmath>
#include <regex>
int main(int argc,char** argv){
 try {
  const bool wrap=argc>1&&std::string(argv[1])=="rollover";
  const unsigned long start=wrap?0xfffffe00UL:0UL;
  ck_now=start;std::fill(std::begin(ck_external),std::end(ck_external),HIGH);
  ck_safety_pin=9;ck_safety_input=2;setup();
  ck_assert(ck_modes[2]==INPUT_PULLUP&&ck_modes[9]==OUTPUT&&ck_modes[13]==OUTPUT,"pin modes");
  ck_assert(ck_pins[9]==LOW&&ck_pins[13]==LOW,"startup outputs must be off");
  ck_assert(Serial.baud==115200,"serial baud");
  std::vector<int> samples;double median=0;int expected=LOW,heart=LOW;
  unsigned long lastSample=0,lastHeart=0,lastPrint=0;bool sampled=false,heartbeat=false,printed=false;
  for(unsigned long elapsed=0;elapsed<=5000;++elapsed){
   ck_now=start+elapsed;
   // Deliberate extreme outliers, even partial fill, threshold boundaries,
   // stable hysteresis band, and a reproducible non-monotone stream.
   const int n=int(elapsed/20);
   ck_raw=n<2?(n?301:800):n<8?800:n<14?500:n<22?300:n<30?700:n<50?(n%5==0?0:900):int((n*173+121)%1024);
   const bool held=(elapsed>=357&&elapsed<427)||(elapsed>=1141&&elapsed<1327);
   ck_external[2]=held?LOW:HIGH;
   const auto oldSamples=ck_samples.size(),oldLines=Serial.lines.size();
   loop();
   ck_assert(ck_samples.size()<=oldSamples+1,"at most one analog sample per loop");
   if(ck_samples.size()>oldSamples){
    if(sampled)ck_assert(elapsed-lastSample==20,"independent 20ms sampling and rollover");
    else ck_assert(elapsed<=20,"first sample within 20ms");
    sampled=true;lastSample=elapsed;samples.push_back(ck_raw);if(samples.size()>5)samples.erase(samples.begin());
    auto sorted=samples;std::sort(sorted.begin(),sorted.end());const auto size=sorted.size();
    median=size%2?sorted[size/2]:(sorted[size/2-1]+sorted[size/2])/2.0;
    if(!held){if(median>=700)expected=HIGH;else if(median<=300)expected=LOW;}
   }
   if(held)expected=LOW;
   ck_assert(ck_pins[9]==expected,"median/hysteresis/immediate stop/resume on next sample");
   if(ck_pins[13]!=heart){
    if(heartbeat)ck_assert(elapsed-lastHeart==250,"independent 250ms heartbeat and rollover");
    else ck_assert(elapsed<=250,"first heartbeat within 250ms");
    heartbeat=true;lastHeart=elapsed;heart=ck_pins[13];
   }
   ck_assert(elapsed-lastHeart<=250,"heartbeat stalled");
   if(Serial.lines.size()>oldLines){
    ck_assert(Serial.lines.size()==oldLines+1,"one telemetry line per period");
    if(printed)ck_assert(elapsed-lastPrint==200,"independent 200ms telemetry and rollover");
    else ck_assert(elapsed<=200,"first telemetry within 200ms");
    printed=true;lastPrint=elapsed;
    std::smatch match;const std::string text=Serial.lines.back().text;
    ck_assert(std::regex_search(text,match,std::regex(R"(([+-]?[0-9]+(?:\.[0-9]+)?)\s*$)")),"telemetry contains median");
    ck_assert(std::abs(std::stod(match[1].str())-median)<0.011,"correct median telemetry");
   }
   ck_assert(elapsed-lastPrint<=200,"telemetry stalled");
  }
  ck_assert(sampled&&heartbeat&&printed,"all independent tasks ran");
  CK_TEST_MEDIAN_RESET();
  ck_assert(CK_TEST_MEDIAN_READ()==0,"empty reusable filter");
  std::vector<int> history;
  for(int i=0;i<256;++i){
   const int value=i==0?301:i==1?800:(i*233+17)%1024;
   CK_TEST_MEDIAN_PUSH(value);history.push_back(value);if(history.size()>5)history.erase(history.begin());
   auto sorted=history;std::sort(sorted.begin(),sorted.end());const auto n=sorted.size();
   const double expectedMedian=n%2?sorted[n/2]:(sorted[n/2-1]+sorted[n/2])/2.0;
   ck_assert(std::abs(CK_TEST_MEDIAN_READ()-expectedMedian)<0.011,"reusable library preserves exact even-count average and rolling median");
  }
  std::cout<<"{\"status\":\"PASS\",\"checks\":"<<ck_checks<<",\"samples\":"<<ck_samples.size()<<",\"lines\":"<<Serial.lines.size()<<"}\n";
  return 0;
 }catch(const std::exception& e){std::cerr<<e.what()<<"\n";return 1;}
}
