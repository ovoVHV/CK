// Query the OS ANSI code page, not the console/OEM code page. Compiler output
// may use this encoding even though CK's own files are always UTF-8.
#[link(name = "kernel32")]
extern "system" { fn GetACP() -> u32; }
fn main() { println!("{}", unsafe { GetACP() }); }
