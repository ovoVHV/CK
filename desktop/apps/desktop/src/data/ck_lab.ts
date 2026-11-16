export const CK_LAB = 'https://ckswitch.site';

export const CK_DRIVER_SOURCES = [
    { id: 'ch340', chip: 'CH340 / CH341', vendor: 'WCH · 沁恒', url: `${CK_LAB}/downloads/drivers/CH341SER-4.0.ZIP`, official: false },
    { id: 'cp210x', chip: 'CP210x / CP2102 / CP2102N', vendor: 'Silicon Labs', url: 'https://www.silabs.com/documents/public/software/CP210x_Universal_Windows_Driver.zip', official: true },
    { id: 'ftdi', chip: 'FT232 / FT231X', vendor: 'FTDI', url: 'https://www.ftdichip.cn/Drivers/CDM/CDM-v2.12.36.20-WHQL-Certified.zip', official: true },
    { id: 'ch343', chip: 'CH343 / CH9102', vendor: 'WCH · 沁恒', url: `${CK_LAB}/downloads/drivers/CH343SER-2.2.ZIP`, official: false },
    { id: 'pl2303', chip: 'PL2303 / PL2323', vendor: 'Prolific · 旺玖', url: `${CK_LAB}/downloads/drivers/PL23XX-M-4.10.0.0.zip`, official: false },
] as const;
