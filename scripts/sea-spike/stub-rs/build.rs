//! Generates the client of `doric.platform.v1.BundleHostService` from the
//! exported protos (`dist/proto`, the root `proto-export` target).

use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../dist/proto");
    let control = root.join("doric/platform/v1/control.proto");
    println!("cargo:rerun-if-changed={}", control.display());

    let descriptors = protox::compile([&control], [&root])?;
    tonic_prost_build::configure()
        .build_server(false)
        .build_client(true)
        // The RPC `Connect` would clash with the generated `connect` constructor.
        .build_transport(false)
        .compile_fds(descriptors)?;
    Ok(())
}
