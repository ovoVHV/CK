#ifndef CK_NATIVE_DRIVER_H
#define CK_NATIVE_DRIVER_H

#include <stdint.h>

class CKNativeDriver {
public:
    static int32_t scale(int32_t value, int32_t factor);
    static void beginWire();
};

#endif
