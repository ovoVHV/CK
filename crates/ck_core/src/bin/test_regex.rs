fn main() {
    let new_code = r#"#if defined(ARDUINO_ARCH_AVR)
#include <MsTimer2.h>
#define CK_MSTIMER2_RUN() ((void)0)
#else
class CKMsTimer2Compat {
public:
typedef void (*Callback)();
void set(unsigned long intervalMs, Callback cb) {
  intervalMs_ = intervalMs;
  callback_ = cb;
  lastTick_ = millis();
}
void start() {
  running_ = true;
  void stop() { running_ = false; }
  void run() {
    if (!running_ || callback_ == nullptr || intervalMs_ == 0) return;
    unsigned long now = millis();
    if ((now - lastTick_) >= intervalMs_) {
      lastTick_ += intervalMs_;
      callback_();
    private:
    unsigned long intervalMs_ = 0;
    unsigned long lastTick_ = 0;
    bool running_ = false;
    Callback callback_ = nullptr;
  };
  static CKMsTimer2Compat ck_ms_timer2;
  namespace MsTimer2 {
    inline void set(unsigned long ms, CKMsTimer2Compat::Callback cb) { ck_ms_timer2.set(ms, cb); }
    inline void start() { ck_ms_timer2.start(); }
    inline void stop() { ck_ms_timer2.stop(); }
    #define CK_MSTIMER2_RUN() ck_ms_timer2.run()
    #endif
    #include "CK_AVR_Blink_Test.h"
    #include <CK_DHT11_22_Universal.h>
    #include <CK_RGB_Strip_Pro.h>

    int arr1[3];
    void ck_mstimer2_callback() {
      ;
    }
    DHT* ck_dht_sensor_1 = nullptr;
    Adafruit_NeoPixel* ck_rgb_strip_1 = nullptr;
    uint16_t ck_rgb_strip_1_count = 0;
    static uint32_t ck_rgb_pack_color(int r, int g, int b) {
      return ((uint32_t)ck_rgb_u8(r) << 16) | ((uint32_t)ck_rgb_u8(g) << 8) | (uint32_t)ck_rgb_u8(b);
    }
    static uint8_t ck_rgb_u8(int v) {
      if (v < 0) return 0;
      if (v > 255) return 255;
      return (uint8_t)v;
    }
"#;

    let fqbn = "arduino:avr:nano";
    let is_avr = fqbn.contains("arduino:avr");
    let is_esp32 = fqbn.contains("esp32:esp32");

    let mut depths = vec![0; new_code.len()];
    let mut current_depth = 0;

    let mut active_stack = vec![true];
    let mut branch_taken = vec![true];

    let mut line_start = 0;
    let bytes = new_code.as_bytes();

    while line_start < new_code.len() {
        let mut line_end = line_start;
        while line_end < new_code.len() && bytes[line_end] != b'\n' {
            line_end += 1;
        }

        let line = &new_code[line_start..line_end];
        let trimmed = line.trim_start();

        if trimmed.starts_with("#if") {
            let condition = if trimmed.contains("ARDUINO_ARCH_AVR") {
                is_avr
            } else if trimmed.contains("ARDUINO_ARCH_ESP") {
                is_esp32
            } else {
                true
            }; // default unknown macros to active
            let parent_active = *active_stack.last().unwrap();
            let is_active = parent_active && condition;
            active_stack.push(is_active);
            branch_taken.push(condition);
        } else if trimmed.starts_with("#elif") {
            if active_stack.len() > 1 {
                let condition = if trimmed.contains("ARDUINO_ARCH_AVR") {
                    is_avr
                } else if trimmed.contains("ARDUINO_ARCH_ESP") {
                    is_esp32
                } else {
                    true
                };
                let parent_active = active_stack[active_stack.len() - 2];
                let taken = *branch_taken.last().unwrap();
                let is_active = parent_active && condition && !taken;
                *active_stack.last_mut().unwrap() = is_active;
                if is_active {
                    *branch_taken.last_mut().unwrap() = true;
                }
            }
        } else if trimmed.starts_with("#else") {
            if active_stack.len() > 1 {
                let parent_active = active_stack[active_stack.len() - 2];
                let taken = *branch_taken.last().unwrap();
                let is_active = parent_active && !taken;
                *active_stack.last_mut().unwrap() = is_active;
            }
        } else if trimmed.starts_with("#endif") {
            if active_stack.len() > 1 {
                active_stack.pop();
                branch_taken.pop();
            }
        }

        let currently_active = *active_stack.last().unwrap();

        for i in line_start..line_end {
            depths[i] = current_depth;
            if currently_active {
                if bytes[i] == b'{' {
                    current_depth += 1;
                } else if bytes[i] == b'}' {
                    if current_depth > 0 {
                        current_depth -= 1;
                    }
                }
            }
        }

        if line_end < new_code.len() {
            depths[line_end] = current_depth;
            line_start = line_end + 1;
        } else {
            break;
        }
    }

    let rx = regex::Regex::new(r"(?m)^[ \t]*(?:static\s+)?(?:volatile\s+)?(?:inline\s+)?(?:const\s+)?(?:[\w:\*&<>]+\s+)+[\w]+\s*\([^)]*\)\s*\{").unwrap();
    let mut protos = String::new();

    for cap in rx.captures_iter(new_code) {
        if let Some(m) = cap.get(0) {
            let start = m.start();
            if depths[start] > 0 {
                continue; // Skip deeply nested class methods
            }

            // Note: Since we don't compile `#else` blocks, should we even extract prototypes from inactive blocks?
            // Yes, active preprocessor lines could contain prototypes. Let's just trust the depth parser.
            // If the code is inactive, the regex might still match it, but the depth parser won't be completely wrong since it ignored it. Wait, if it ignored braces inside `#else`, they stay at depth 0!
            // This means we WOULD extract functions from `#else`!
            // BUT wait, if we extract `void set(...)` from the `#else` block, STILL THE BUG RETURN!

            println!(
                "Matched at byte {}, str: {:?}, depth: {}",
                start,
                m.as_str(),
                depths[start]
            );
        }
    }
}
