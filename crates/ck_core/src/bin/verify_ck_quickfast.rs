use ck_core::builder::demo::{CompileProfile, compile_sketch_string};
use ck_core::sysroot::Sysroot;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

fn sketch(delay_ms: u32) -> String {
    format!(
        r#"
#include <Arduino.h>
#include <CK_AVR_Blink_Test.h>

void setup() {{
  ck_avr_pin_init(13);
}}

void loop() {{
  ck_avr_blink_once(13, {delay_ms});
}}
"#
    )
}

async fn run_compile(
    sysroot: &Arc<Sysroot>,
    code: &str,
    extra_libs: &[PathBuf],
    signature: &str,
    label: &str,
) -> Result<(u128, String), String> {
    let captured = Arc::new(Mutex::new(String::new()));
    let captured_cb = captured.clone();
    let start = std::time::Instant::now();
    let result = compile_sketch_string(
        sysroot,
        code,
        "arduino:avr:nano",
        extra_libs,
        8,
        signature,
        Some("verify_ck_quickfast"),
        CompileProfile::QuickFast,
        ck_core::builder::demo::CkExactReusePolicy::Allow,
        |_pct, _msg| {},
        move |line| {
            if let Ok(mut guard) = captured_cb.lock() {
                guard.push_str(&line);
            }
        },
    )
    .await;
    let elapsed_ms = start.elapsed().as_millis();
    let log = captured.lock().map(|g| g.clone()).unwrap_or_default();
    match result {
        Ok((_path, result_log)) => Ok((elapsed_ms, format!("{log}\n{result_log}"))),
        Err(err) => Err(format!(
            "{label} failed after {elapsed_ms} ms:\n{log}\n{err}"
        )),
    }
}

#[tokio::main]
async fn main() {
    let ck_root = dirs::document_dir()
        .expect("Documents directory")
        .join("CK");
    let sysroot = Arc::new(
        Sysroot::init(Some(ck_root.clone()), "CK")
            .await
            .expect("sysroot init"),
    );
    let lib = ck_root.join("libraries/arduino_avr_nano/ck_avr_blink_test");
    if !lib.exists() {
        eprintln!("Missing CK test library: {}", lib.display());
        std::process::exit(1);
    }
    let extra_libs = vec![lib];
    let signature = "verify_ck_quickfast_blink_v1";

    let code_a = sketch(7);
    let code_b = sketch(9);

    let first = match run_compile(&sysroot, &code_a, &extra_libs, signature, "first compile").await
    {
        Ok(ok) => ok,
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    };
    println!("first_compile_ms={}", first.0);

    let relink =
        match run_compile(&sysroot, &code_b, &extra_libs, signature, "relink compile").await {
            Ok(ok) => ok,
            Err(err) => {
                eprintln!("{err}");
                std::process::exit(1);
            }
        };
    let relink_hit =
        relink.1.contains("Fast Relink completed") || relink.1.contains("Fast Relink path");
    println!("relink_compile_ms={} fast_relink={}", relink.0, relink_hit);
    if !relink_hit {
        eprintln!("QuickFast relink did not trigger.");
        std::process::exit(1);
    }

    let exact = match run_compile(&sysroot, &code_b, &extra_libs, signature, "exact compile").await
    {
        Ok(ok) => ok,
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    };
    let exact_hit =
        exact.1.contains("Cached build (Exact Match)") || exact.1.contains("Code unchanged");
    println!("exact_compile_ms={} exact_hit={}", exact.0, exact_hit);
    if !exact_hit {
        eprintln!("Exact-match cache did not trigger.");
        std::process::exit(1);
    }
}
