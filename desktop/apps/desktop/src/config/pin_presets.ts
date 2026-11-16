
export interface PinConfig {
    label: string;
    value: string;
}

export const PIN_PRESETS: Record<string, PinConfig[]> = {
    'stm32': [
        // Digital / Analog pins common on BluePill/STM32F103
        { label: "PA0 (ADC0)", value: "PA0" },
        { label: "PA1 (ADC1)", value: "PA1" },
        { label: "PA2 (ADC2/TX2)", value: "PA2" },
        { label: "PA3 (ADC3/RX2)", value: "PA3" },
        { label: "PA4 (ADC4/SS1)", value: "PA4" },
        { label: "PA5 (ADC5/SCK1)", value: "PA5" },
        { label: "PA6 (ADC6/MISO1)", value: "PA6" },
        { label: "PA7 (ADC7/MOSI1)", value: "PA7" },
        { label: "PA8 (PWM)", value: "PA8" },
        { label: "PA9 (TX1)", value: "PA9" },
        { label: "PA10 (RX1)", value: "PA10" },
        { label: "PA11 (USB-)", value: "PA11" },
        { label: "PA12 (USB+)", value: "PA12" },
        { label: "PA15 (SS2)", value: "PA15" },

        { label: "PB0 (ADC8)", value: "PB0" },
        { label: "PB1 (ADC9)", value: "PB1" },
        { label: "PB3", value: "PB3" },
        { label: "PB4", value: "PB4" },
        { label: "PB5", value: "PB5" },
        { label: "PB6 (I2C1 SCL)", value: "PB6" },
        { label: "PB7 (I2C1 SDA)", value: "PB7" },
        { label: "PB8 (I2C2 SCL)", value: "PB8" },
        { label: "PB9 (I2C2 SDA)", value: "PB9" },
        { label: "PB10 (TX3/I2C2 SCL)", value: "PB10" },
        { label: "PB11 (RX3/I2C2 SDA)", value: "PB11" },
        { label: "PB12 (SS2)", value: "PB12" },
        { label: "PB13 (SCK2)", value: "PB13" },
        { label: "PB14 (MISO2)", value: "PB14" },
        { label: "PB15 (MOSI2)", value: "PB15" },

        { label: "PC13 (LED)", value: "PC13" },
        { label: "PC14 (OSC32)", value: "PC14" },
        { label: "PC15 (OSC32)", value: "PC15" }
    ]
};
