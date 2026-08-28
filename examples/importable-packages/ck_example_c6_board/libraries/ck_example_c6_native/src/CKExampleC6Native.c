#include <CKExampleC6Native.h>

#include "vendor/protocol/codec.h"

uint32_t ck_example_c6_native_signature(void) {
  return ck_example_c6_codec_fold("CK-C6");
}
