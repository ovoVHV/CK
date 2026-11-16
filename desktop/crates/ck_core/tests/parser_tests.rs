use anyhow::Result;
use ck_core::registry::platform::Platform;
use ck_core::registry::properties::Properties;

#[tokio::test]
async fn test_variable_expansion() {
    let mut props = Properties::new();
    props.insert("build.mcu", "esp32");
    props.insert("runtime.ide.path", "/opt/arduino");
    props.insert("build.core.path", "{runtime.ide.path}/hardware/esp32");

    // Recursive expansion test
    assert_eq!(
        props.expand("{build.core.path}/cores/esp32"),
        "/opt/arduino/hardware/esp32/cores/esp32"
    );
}

#[tokio::test]
async fn test_platform_parsing() -> Result<()> {
    // Requires a mock file, skipping real file test for unit test logic
    // Or we create a temp file
    use std::io::Write;
    let mut temp = tempfile::NamedTempFile::new()?;
    writeln!(temp, "name=ESP32 Arduino")?;
    writeln!(temp, "version=3.3.1")?;
    writeln!(temp, "compiler.path=/tools/xtensa")?;
    writeln!(temp, "compiler.c.cmd=gcc")?;
    writeln!(
        temp,
        "recipe.c.o.pattern={{compiler.path}}/{{compiler.c.cmd}} -c options"
    )?;

    let platform = Platform::from_file(temp.path()).await?;
    assert_eq!(platform.name, "ESP32 Arduino");
    assert_eq!(platform.version, "3.3.1");
    // Note: double curly braces in writeln for rust formatting
    // But actual file has single braces.
    // Let's assume the temp file writing is correct.

    let cmd_pattern = platform.properties.get("recipe.c.o.pattern").unwrap();
    // expand it
    let expanded = platform.properties.expand(cmd_pattern);
    assert_eq!(expanded, "/tools/xtensa/gcc -c options");

    Ok(())
}
