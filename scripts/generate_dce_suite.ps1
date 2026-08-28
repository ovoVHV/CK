param(
    [string]$Root = (Join-Path $PSScriptRoot ".."),
    [switch]$Clean
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$sysroot = (Resolve-Path $Root).Path
$tmpSketchRoot = Join-Path $sysroot "tmp_sketch"
$tmpRoot = Join-Path $sysroot "tmp"
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$null = New-Item -ItemType Directory -Force -Path $tmpSketchRoot
$null = New-Item -ItemType Directory -Force -Path $tmpRoot

function Write-Utf8NoBom {
    param(
        [string]$Path,
        [string]$Content
    )
    [System.IO.File]::WriteAllText($Path, $Content, $script:Utf8NoBom)
}

$unoLabels = @(
    "core_blink","serial_tick","analog_filter","time_slice","state_table",
    "eeprom_store","wire_probe","spi_frame","softserial_bridge","builtin_combo",
    "json_doc","json_queue","neopixel_wave","neopixel_anim","sensor_stub",
    "dht_monitor","config_router","display_stub","display_json","telemetry_panel",
    "module_mix","task_router","storage_bus","io_pipeline","ui_scheduler",
    "heavy_matrix","heavy_graph","heavy_console","heavy_dashboard","max_stress"
)

$esp32Labels = @(
    "core_blink","core_tasks","core_buffers","eeprom_cache","preferences_store",
    "wifi_boot","wifi_scan_stub","spiffs_cache","littlefs_index","sd_catalog",
    "json_status","json_pipeline","server_basic","server_routes","http_client",
    "secure_client","wire_spi_mix","ticker_jobs","storage_router","sensor_fusion",
    "neopixel_panel","neopixel_json","display_core","display_router","display_server",
    "dashboard_mix","service_graph","state_machine","ui_pipeline","max_stress"
)

function Join-Code {
    param(
        [string[]]$Lines,
        [int]$Indent = 0
    )
    if (-not $Lines -or $Lines.Count -eq 0) {
        return ""
    }
    $pad = " " * $Indent
    return (($Lines | ForEach-Object {
        if ($_ -eq "") { "" } else { $pad + $_ }
    }) -join "`r`n")
}

function Select-OrderedUnique {
    param([string[]]$Items)
    $seen = @{}
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($item in $Items) {
        if ([string]::IsNullOrWhiteSpace($item)) { continue }
        if (-not $seen.ContainsKey($item)) {
            $seen[$item] = $true
            $out.Add($item)
        }
    }
    return ,$out.ToArray()
}

function New-HelperBlock {
    param(
        [string]$Prefix,
        [int]$Count,
        [int]$Salt
    )
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("uint32_t ${Prefix}Mix(uint32_t seed) {")
    $lines.Add("  seed ^= (seed << 7);")
    $lines.Add("  seed ^= (seed >> 9);")
    $lines.Add("  seed += 0x9E3779B9UL + SUITE_LEVEL;")
    $lines.Add("  return seed;")
    $lines.Add("}")
    $lines.Add("")
    for ($i = 0; $i -lt $Count; $i++) {
        $shift = ($i % 5) + 1
        $bump = $Salt + 17 + ($i * 13)
        $lines.Add("uint32_t ${Prefix}Step${i}(uint32_t seed) {")
        $lines.Add("  seed = ${Prefix}Mix(seed + ${bump}UL);")
        $lines.Add("  seed ^= (seed >> ${shift});")
        $lines.Add("  seed += (uint32_t)(${i} + 3) * (SUITE_LEVEL + 1UL);")
        $lines.Add("  return seed;")
        $lines.Add("}")
        $lines.Add("")
    }
    $lines.Add("uint32_t ${Prefix}RunHelpers(uint32_t seed) {")
    for ($i = 0; $i -lt $Count; $i++) {
        $lines.Add("  seed = ${Prefix}Step${i}(seed);")
    }
    $lines.Add("  return seed;")
    $lines.Add("}")
    return ($lines -join "`r`n")
}

function New-ExtraLogicBlock {
    param(
        [string]$Prefix,
        [int]$Count
    )
    $lines = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $Count; $i++) {
        $mask = 31 + ($i * 7)
        $lines.Add("uint32_t ${Prefix}Logic${i}(uint32_t seed) {")
        $lines.Add("  seed ^= ((seed << 3) + ${mask}UL);")
        $lines.Add("  seed += (seed >> 2);")
        $lines.Add("  return seed ^ SUITE_LEVEL;")
        $lines.Add("}")
        $lines.Add("")
    }
    $lines.Add("uint32_t ${Prefix}ApplyLogic(uint32_t seed) {")
    for ($i = 0; $i -lt $Count; $i++) {
        $lines.Add("  seed = ${Prefix}Logic${i}(seed);")
    }
    $lines.Add("  return seed;")
    $lines.Add("}")
    return ($lines -join "`r`n")
}

function New-ExtraTableBlock {
    param(
        [string]$Prefix,
        [int]$Count,
        [int]$Salt
    )
    $values = for ($i = 0; $i -lt $Count; $i++) {
        (($Salt * 19) + ($i * 37) + 11) % 1024
    }
    $table = ($values -join ", ")
    return @"
const uint16_t ${Prefix}Table[$Count] = { $table };

uint32_t ${Prefix}FoldTable(uint32_t seed) {
  for (size_t i = 0; i < $Count; ++i) {
    seed ^= (${Prefix}Table[i] + (uint32_t)i + SUITE_LEVEL);
    seed = (seed << 1) | (seed >> 31);
  }
  return seed;
}
"@
}

function New-ExtraStateBlock {
    param([string]$Prefix)
    return @"
uint32_t ${Prefix}AdvanceState(uint32_t seed) {
  static uint8_t phase = 0;
  switch (phase) {
    case 0:
      seed += 17UL + SUITE_LEVEL;
      break;
    case 1:
      seed ^= 0x55AA55AAUL;
      break;
    case 2:
      seed = (seed << 5) | (seed >> 27);
      break;
    default:
      seed += (seed >> 3);
      break;
  }
  phase = (uint8_t)((phase + 1) & 0x03);
  return seed;
}
"@
}

function Get-UnoConfig {
    param([int]$Level)
    $includes = New-Object System.Collections.Generic.List[string]
    $globals = New-Object System.Collections.Generic.List[string]
    $setup = New-Object System.Collections.Generic.List[string]
    $loop = New-Object System.Collections.Generic.List[string]
    $features = New-Object System.Collections.Generic.List[string]

    $includes.Add("#include <Arduino.h>")

    if ($Level -ge 6) {
        $includes.Add("#include <EEPROM.h>")
        $features.Add("EEPROM")
        $setup.Add("int suiteEepromLen = EEPROM.length();")
        $setup.Add("suiteAccumulator ^= (uint32_t)suiteEepromLen;")
        $loop.Add("EEPROM.put(0, (uint8_t)(suiteAccumulator & 0xFFu));")
    }
    if ($Level -ge 7) {
        $includes.Add("#include <Wire.h>")
        $features.Add("Wire")
        $setup.Add("Wire.begin();")
        $loop.Add("Wire.beginTransmission(0x3C);")
        $loop.Add("Wire.write((uint8_t)(suiteAccumulator & 0x7Fu));")
        $loop.Add("Wire.endTransmission();")
    }
    if ($Level -ge 8) {
        $includes.Add("#include <SPI.h>")
        $features.Add("SPI")
        $setup.Add("SPI.begin();")
        $loop.Add("SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));")
        $loop.Add("suiteAccumulator ^= SPI.transfer((uint8_t)(suiteAccumulator & 0xFFu));")
        $loop.Add("SPI.endTransaction();")
    }
    if ($Level -ge 9) {
        $includes.Add("#include <SoftwareSerial.h>")
        $features.Add("SoftwareSerial")
        $globals.Add("SoftwareSerial suiteSoft(8, 9);")
        $setup.Add("suiteSoft.begin(9600);")
        $loop.Add("if ((suiteAccumulator & 7u) == 0u) { suiteSoft.write((uint8_t)('A' + (suiteAccumulator % 26u))); }")
    }
    if ($Level -ge 11) {
        $includes.Add("#include <ArduinoJson.h>")
        $features.Add("ArduinoJson")
        $loop.Add("JsonDocument suiteDoc;")
        $loop.Add("suiteDoc[`"lvl`"] = SUITE_LEVEL;")
        $loop.Add("suiteDoc[`"acc`"] = suiteAccumulator;")
        $loop.Add("char suiteJson[96];")
        $loop.Add("size_t suiteJsonLen = serializeJson(suiteDoc, suiteJson, sizeof(suiteJson));")
        $loop.Add("suiteAccumulator ^= (uint32_t)suiteJsonLen;")
    }
    if ($Level -ge 13) {
        $includes.Add("#include <Adafruit_NeoPixel.h>")
        $features.Add("Adafruit_NeoPixel")
        $globals.Add("Adafruit_NeoPixel suiteStrip(8, 6, NEO_GRB + NEO_KHZ800);")
        $setup.Add("suiteStrip.begin();")
        $setup.Add("suiteStrip.show();")
        $loop.Add("suiteStrip.setPixelColor((int)(suiteAccumulator % 8u), suiteStrip.Color(10, 30, 5));")
        $loop.Add("suiteStrip.show();")
    }
    if ($Level -ge 16) {
        $includes.Add("#include <DHT.h>")
        $features.Add("DHT")
        $globals.Add("#define SUITE_DHTPIN 2")
        $globals.Add("#define SUITE_DHTTYPE DHT22")
        $globals.Add("DHT suiteDht(SUITE_DHTPIN, SUITE_DHTTYPE);")
        $setup.Add("suiteDht.begin();")
        $loop.Add("float suiteTemp = suiteDht.readTemperature();")
        $loop.Add("if (suiteTemp == suiteTemp) { suiteAccumulator += (uint32_t)(suiteTemp * 4.0f); }")
    }
    if ($Level -ge 21) {
        $includes.Add("#include <Adafruit_GFX.h>")
        $includes.Add("#include <Adafruit_SSD1306.h>")
        $features.Add("Adafruit_SSD1306")
        if ($Level -lt 7) {
            $includes.Add("#include <Wire.h>")
            $setup.Add("Wire.begin();")
        }
        $globals.Add("Adafruit_SSD1306 suiteDisplay(128, 64, &Wire, -1);")
        $setup.Add("suiteDisplay.begin(SSD1306_SWITCHCAPVCC, 0x3C);")
        $setup.Add("suiteDisplay.clearDisplay();")
        $setup.Add("suiteDisplay.setTextSize(1);")
        $setup.Add("suiteDisplay.setTextColor(SSD1306_WHITE);")
        $loop.Add("suiteDisplay.clearDisplay();")
        $loop.Add("suiteDisplay.setCursor(0, 0);")
        $loop.Add("suiteDisplay.print(SUITE_NAME);")
        $loop.Add("suiteDisplay.setCursor(0, 10);")
        $loop.Add("suiteDisplay.print((unsigned long)suiteAccumulator);")
        $loop.Add("suiteDisplay.display();")
    }

    return [pscustomobject]@{
        Includes = (Select-OrderedUnique $includes)
        Globals = @($globals)
        Setup = @($setup)
        Loop = @($loop)
        Features = @($features)
    }
}

function Get-Esp32Config {
    param([int]$Level)
    $localLevel = $Level - 30
    $includes = New-Object System.Collections.Generic.List[string]
    $globals = New-Object System.Collections.Generic.List[string]
    $setup = New-Object System.Collections.Generic.List[string]
    $loop = New-Object System.Collections.Generic.List[string]
    $features = New-Object System.Collections.Generic.List[string]

    $includes.Add("#include <Arduino.h>")

    if ($localLevel -ge 2) {
        $includes.Add("#include <Wire.h>")
        $features.Add("Wire")
        $setup.Add("Wire.begin();")
        $loop.Add("Wire.beginTransmission(0x3C);")
        $loop.Add("Wire.write((uint8_t)(suiteAccumulator & 0x7Fu));")
        $loop.Add("Wire.endTransmission();")
    }
    if ($localLevel -ge 3) {
        $includes.Add("#include <SPI.h>")
        $features.Add("SPI")
        $setup.Add("SPI.begin();")
        $loop.Add("SPI.beginTransaction(SPISettings(2000000, MSBFIRST, SPI_MODE0));")
        $loop.Add("suiteAccumulator ^= SPI.transfer((uint8_t)(suiteAccumulator & 0xFFu));")
        $loop.Add("SPI.endTransaction();")
    }
    if ($localLevel -ge 4) {
        $includes.Add("#include <EEPROM.h>")
        $features.Add("EEPROM")
        $setup.Add("EEPROM.begin(128);")
        $setup.Add("EEPROM.write(0, (uint8_t)SUITE_LEVEL);")
        $setup.Add("EEPROM.commit();")
        $loop.Add("suiteAccumulator ^= EEPROM.read(0);")
    }
    if ($localLevel -ge 5) {
        $includes.Add("#include <Preferences.h>")
        $features.Add("Preferences")
        $globals.Add("Preferences suitePrefs;")
        $setup.Add("suitePrefs.begin(`"suite`", false);")
        $setup.Add("suitePrefs.putUInt(`"lvl`", SUITE_LEVEL);")
        $setup.Add("suitePrefs.end();")
    }
    if ($localLevel -ge 6) {
        $includes.Add("#include <WiFi.h>")
        $features.Add("WiFi")
        $setup.Add("WiFi.mode(WIFI_STA);")
        $setup.Add("WiFi.disconnect(true, true);")
        $loop.Add("suiteAccumulator ^= (uint32_t)WiFi.getMode();")
    }
    if ($localLevel -ge 8) {
        $includes.Add("#include <FS.h>")
        $includes.Add("#include <SPIFFS.h>")
        $features.Add("SPIFFS")
        $setup.Add("SPIFFS.begin(true);")
        $setup.Add("File suiteSpiffs = SPIFFS.open(`"/suite.txt`", FILE_WRITE);")
        $setup.Add("if (suiteSpiffs) { suiteSpiffs.print(SUITE_NAME); suiteSpiffs.close(); }")
    }
    if ($localLevel -ge 10) {
        $includes.Add("#include <LittleFS.h>")
        $features.Add("LittleFS")
        $setup.Add("LittleFS.begin(true);")
        $setup.Add("File suiteLittle = LittleFS.open(`"/suite.txt`", FILE_WRITE);")
        $setup.Add("if (suiteLittle) { suiteLittle.print(SUITE_LEVEL); suiteLittle.close(); }")
    }
    if ($localLevel -ge 12) {
        $includes.Add("#include <SD.h>")
        $features.Add("SD")
        if ($localLevel -lt 3) {
            $includes.Add("#include <SPI.h>")
            $setup.Add("SPI.begin();")
        }
        $setup.Add("SD.begin(5);")
    }
    if ($localLevel -ge 11) {
        $includes.Add("#include <ArduinoJson.h>")
        $features.Add("ArduinoJson")
        $loop.Add("JsonDocument suiteDoc;")
        $loop.Add("suiteDoc[`"lvl`"] = SUITE_LEVEL;")
        $loop.Add("suiteDoc[`"acc`"] = suiteAccumulator;")
        $loop.Add("suiteDoc[`"board`"] = `"esp32s3`";")
        $loop.Add("char suiteJson[160];")
        $loop.Add("size_t suiteJsonLen = serializeJson(suiteDoc, suiteJson, sizeof(suiteJson));")
        $loop.Add("suiteAccumulator ^= (uint32_t)suiteJsonLen;")
    }
    if ($localLevel -ge 13) {
        $includes.Add("#include <WebServer.h>")
        $features.Add("WebServer")
        $globals.Add("WebServer suiteServer(80);")
        $globals.Add("void suiteHandleRoot() { suiteServer.send(200, `"text/plain`", SUITE_NAME); }")
        $setup.Add("suiteServer.on(`"/`", HTTP_GET, suiteHandleRoot);")
        $setup.Add("suiteServer.begin();")
        $loop.Add("suiteServer.handleClient();")
    }
    if ($localLevel -ge 15) {
        $includes.Add("#include <HTTPClient.h>")
        $features.Add("HTTPClient")
        $loop.Add("HTTPClient suiteHttp;")
        $loop.Add("suiteHttp.setReuse(false);")
        $loop.Add("suiteHttp.setTimeout(50);")
        $loop.Add("suiteAccumulator ^= (uint32_t)(suiteHttp.getSize() + 1);")
    }
    if ($localLevel -ge 16) {
        $includes.Add("#include <NetworkClientSecure.h>")
        $features.Add("NetworkClientSecure")
        $globals.Add("NetworkClientSecure suiteSecure;")
        $setup.Add("suiteSecure.setInsecure();")
        $loop.Add("suiteAccumulator ^= (uint32_t)(suiteSecure.connected() ? 3 : 7);")
    }
    if ($localLevel -ge 18) {
        $includes.Add("#include <Ticker.h>")
        $features.Add("Ticker")
        $globals.Add("Ticker suiteTicker;")
        $globals.Add("volatile bool suiteTickerFlag = false;")
        $globals.Add("void suiteOnTicker() { suiteTickerFlag = true; }")
        $setup.Add("suiteTicker.attach_ms(250, suiteOnTicker);")
        $loop.Add("if (suiteTickerFlag) { suiteTickerFlag = false; suiteAccumulator ^= 0x55AAu; }")
    }
    if ($localLevel -ge 21) {
        $includes.Add("#include <Adafruit_NeoPixel.h>")
        $features.Add("Adafruit_NeoPixel")
        $globals.Add("Adafruit_NeoPixel suiteStrip(16, 26, NEO_GRB + NEO_KHZ800);")
        $setup.Add("suiteStrip.begin();")
        $setup.Add("suiteStrip.show();")
        $loop.Add("suiteStrip.setPixelColor((int)(suiteAccumulator % 16u), suiteStrip.Color(5, 25, 40));")
        $loop.Add("suiteStrip.show();")
    }
    if ($localLevel -ge 23) {
        $includes.Add("#include <TFT_eSPI.h>")
        $features.Add("TFT_eSPI")
        $globals.Add("TFT_eSPI suiteTft = TFT_eSPI();")
        $globals.Add("TFT_eSprite suiteCanvas = TFT_eSprite(&suiteTft);")
        $setup.Add("suiteTft.init();")
        $setup.Add("suiteTft.setRotation(0);")
        $setup.Add("suiteCanvas.createSprite(64, 32);")
        $loop.Add("suiteCanvas.fillSprite(TFT_BLACK);")
        $loop.Add("suiteCanvas.setTextColor(TFT_CYAN, TFT_BLACK);")
        $loop.Add("suiteCanvas.drawString(String((unsigned long)suiteAccumulator), 2, 2, 2);")
        $loop.Add("suiteCanvas.pushSprite(0, 0);")
    }

    return [pscustomobject]@{
        Includes = (Select-OrderedUnique $includes)
        Globals = @($globals)
        Setup = @($setup)
        Loop = @($loop)
        Features = @($features)
    }
}

function New-UnoSketchSpec {
    param([int]$Level)
    $name = "suite_{0:d2}_uno_{1}" -f $Level, $unoLabels[$Level - 1]
    $prefix = "suite{0:d2}u" -f $Level
    $config = Get-UnoConfig -Level $Level
    $helperCount = 5 + [int][Math]::Floor($Level * 1.4)
    $helperBlock = New-HelperBlock -Prefix $prefix -Count $helperCount -Salt ($Level * 7)

    $extraFiles = New-Object System.Collections.Generic.List[object]
    $extraCalls = New-Object System.Collections.Generic.List[string]
    if ($Level -ge 11) {
        $extraFiles.Add([pscustomobject]@{ Name = "logic.ino"; Content = (New-ExtraLogicBlock -Prefix $prefix -Count (3 + [int]($Level / 5))) })
        $extraCalls.Add("suiteAccumulator = ${prefix}ApplyLogic(suiteAccumulator);")
    }
    if ($Level -ge 18) {
        $extraFiles.Add([pscustomobject]@{ Name = "tables.ino"; Content = (New-ExtraTableBlock -Prefix $prefix -Count (12 + [int]($Level / 2)) -Salt $Level) })
        $extraCalls.Add("suiteAccumulator = ${prefix}FoldTable(suiteAccumulator);")
    }
    if ($Level -ge 24) {
        $extraFiles.Add([pscustomobject]@{ Name = "state.ino"; Content = (New-ExtraStateBlock -Prefix $prefix) })
        $extraCalls.Add("suiteAccumulator = ${prefix}AdvanceState(suiteAccumulator);")
    }

    $setupLines = @(
        "Serial.begin(115200);",
        "pinMode(LED_BUILTIN, OUTPUT);"
    ) + $config.Setup + @(
        "suiteAccumulator = ${prefix}RunHelpers(SUITE_LEVEL + 7UL);"
    )

    $loopLines = @(
        "suiteAccumulator = ${prefix}RunHelpers(suiteAccumulator + suiteLastTick + SUITE_LEVEL);"
    ) + $extraCalls + $config.Loop + @(
        "digitalWrite(LED_BUILTIN, (suiteAccumulator & 1u) ? HIGH : LOW);"
    )

    $main = @"
// Auto-generated DCE stress-suite sketch
// Level: $Level
// Board: arduino:avr:uno
$(Join-Code $config.Includes)

const uint32_t SUITE_LEVEL = ${Level}UL;
const char* SUITE_NAME = "$name";
volatile uint32_t suiteAccumulator = 0;
unsigned long suiteLastTick = 0;
$(Join-Code $config.Globals)

$helperBlock

void setup() {
$(Join-Code $setupLines 2)
}

void loop() {
  if (millis() - suiteLastTick >= 20UL) {
    suiteLastTick = millis();
$(Join-Code $loopLines 4)
  }
}
"@

    $featureArray = [string[]]@($config.Features)
    $extraFileArray = [object[]]$extraFiles.ToArray()
    return [pscustomobject]@{
        Level = $Level
        Name = $name
        Board = "uno"
        Fqbn = "arduino:avr:uno"
        Features = $featureArray
        ExtraFiles = $extraFileArray
        Main = $main
    }
}

function New-Esp32SketchSpec {
    param([int]$Level)
    $index = $Level - 31
    $name = "suite_{0:d2}_esp32_{1}" -f $Level, $esp32Labels[$index]
    $prefix = "suite{0:d2}e" -f $Level
    $config = Get-Esp32Config -Level $Level
    $helperCount = 8 + [int][Math]::Floor(($Level - 30) * 1.6)
    $helperBlock = New-HelperBlock -Prefix $prefix -Count $helperCount -Salt ($Level * 11)

    $extraFiles = New-Object System.Collections.Generic.List[object]
    $extraCalls = New-Object System.Collections.Generic.List[string]
    if ($Level -ge 36) {
        $extraFiles.Add([pscustomobject]@{ Name = "logic.ino"; Content = (New-ExtraLogicBlock -Prefix $prefix -Count (4 + [int](($Level - 30) / 4))) })
        $extraCalls.Add("suiteAccumulator = ${prefix}ApplyLogic(suiteAccumulator);")
    }
    if ($Level -ge 43) {
        $extraFiles.Add([pscustomobject]@{ Name = "tables.ino"; Content = (New-ExtraTableBlock -Prefix $prefix -Count (16 + [int](($Level - 30) / 2)) -Salt ($Level * 2)) })
        $extraCalls.Add("suiteAccumulator = ${prefix}FoldTable(suiteAccumulator);")
    }
    if ($Level -ge 52) {
        $extraFiles.Add([pscustomobject]@{ Name = "state.ino"; Content = (New-ExtraStateBlock -Prefix $prefix) })
        $extraCalls.Add("suiteAccumulator = ${prefix}AdvanceState(suiteAccumulator);")
    }

    $setupLines = @(
        "Serial.begin(115200);",
        "pinMode(LED_BUILTIN, OUTPUT);",
        "delay(10);"
    ) + $config.Setup + @(
        "suiteAccumulator = ${prefix}RunHelpers(SUITE_LEVEL + 19UL);"
    )

    $loopLines = @(
        "suiteAccumulator = ${prefix}RunHelpers(suiteAccumulator + suiteLastTick + SUITE_LEVEL);"
    ) + $extraCalls + $config.Loop + @(
        "digitalWrite(LED_BUILTIN, (suiteAccumulator & 1u) ? HIGH : LOW);"
    )

    $main = @"
// Auto-generated DCE stress-suite sketch
// Level: $Level
// Board: esp32:esp32:esp32s3:PartitionScheme=huge_app
$(Join-Code $config.Includes)

const uint32_t SUITE_LEVEL = ${Level}UL;
const char* SUITE_NAME = "$name";
volatile uint32_t suiteAccumulator = 0;
unsigned long suiteLastTick = 0;
$(Join-Code $config.Globals)

$helperBlock

void setup() {
$(Join-Code $setupLines 2)
}

void loop() {
  if (millis() - suiteLastTick >= 30UL) {
    suiteLastTick = millis();
$(Join-Code $loopLines 4)
  }
}
"@

    $featureArray = [string[]]@($config.Features)
    $extraFileArray = [object[]]$extraFiles.ToArray()
    return [pscustomobject]@{
        Level = $Level
        Name = $name
        Board = "esp32s3"
        Fqbn = "esp32:esp32:esp32s3:PartitionScheme=huge_app"
        Features = $featureArray
        ExtraFiles = $extraFileArray
        Main = $main
    }
}

if ($Clean) {
    Get-ChildItem -Path $tmpSketchRoot -Directory -Filter "suite_*" -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

$manifest = New-Object System.Collections.Generic.List[object]
for ($level = 1; $level -le 60; $level++) {
    $spec = if ($level -le 30) { New-UnoSketchSpec -Level $level } else { New-Esp32SketchSpec -Level $level }
    $dir = Join-Path $tmpSketchRoot $spec.Name
    $null = New-Item -ItemType Directory -Force -Path $dir

    Write-Utf8NoBom -Path (Join-Path $dir ("{0}.ino" -f $spec.Name)) -Content $spec.Main
    foreach ($extra in $spec.ExtraFiles) {
        Write-Utf8NoBom -Path (Join-Path $dir $extra.Name) -Content $extra.Content
    }

    $manifest.Add([pscustomobject]@{
        level = $spec.Level
        name = $spec.Name
        board = $spec.Board
        fqbn = $spec.Fqbn
        features = @($spec.Features)
        fileCount = 1 + $spec.ExtraFiles.Count
        evidence = "compile-only-stress"
        builtinBlockGeneratorCoverage = $false
        hardwareTested = $false
    })
}

$manifestPath = Join-Path $tmpRoot "dce_suite_manifest.json"
Write-Utf8NoBom -Path $manifestPath -Content ($manifest | ConvertTo-Json -Depth 6)
Write-Host ("Generated {0} sketches -> {1}" -f $manifest.Count, $manifestPath)
