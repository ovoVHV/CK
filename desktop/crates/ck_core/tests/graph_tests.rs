use anyhow::Result;
use ck_core::builder::context::BuildContext;
use ck_core::builder::graph::DependencyGraph;
use std::fs;
use std::thread;
use std::time::Duration;

#[test]
fn test_dependency_tracking() -> Result<()> {
    // Setup temp dir
    let temp_dir = tempfile::tempdir()?;
    let root = temp_dir.path();

    // Create structure:
    // root/
    //   main.cpp
    //   include/
    //     mylib.h

    let include_dir = root.join("include");
    fs::create_dir(&include_dir)?;

    let main_cpp = root.join("main.cpp");
    let mylib_h = include_dir.join("mylib.h");

    fs::write(&main_cpp, "#include \"mylib.h\"")?;
    fs::write(&mylib_h, "// Header content")?;

    // Setup context
    let mut context = BuildContext::new();
    context.add_include_path(&include_dir);

    // Build Graph
    let mut graph = DependencyGraph::new();
    graph.scan(&main_cpp, &context)?;

    // Assert graph structure
    let node = graph.nodes.get(&main_cpp).expect("Node not found");
    assert_eq!(node.imports.len(), 1);
    assert_eq!(node.imports[0], mylib_h);

    // Test 1: Target missing -> Dirty
    let target_o = root.join("main.o");
    assert!(graph.is_dirty(&main_cpp, &target_o));

    // Test 2: Target exists and new -> Clean
    // Sleep to ensure mtime diff
    thread::sleep(Duration::from_millis(100));
    fs::write(&target_o, "compiled object")?;

    // We need to rebuild graph? No, mtime in memory is old.
    // Ideally we re-stat files or recreate graph for every build check.
    // For this test, valid. But wait, 'is_dirty' checks node.mtime (captured at scan time)
    // vs target mtime (captured at check time).
    // So if we just created target_o NOW, it should be newer than node.mtime.
    assert!(!graph.is_dirty(&main_cpp, &target_o));

    // Test 3: Modify header -> Dirty
    thread::sleep(Duration::from_millis(100));
    fs::write(&mylib_h, "// Modified content")?;

    // Re-scan to update graph mtimes
    let mut graph2 = DependencyGraph::new();
    graph2.scan(&main_cpp, &context)?;

    assert!(graph2.is_dirty(&main_cpp, &target_o));

    Ok(())
}
