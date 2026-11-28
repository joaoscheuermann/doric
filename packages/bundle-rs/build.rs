//! Generates, from the exported protos (`dist/proto`, the root `proto-export`
//! target), the client of `doric.platform.v1.BundleHostService`, the
//! `google.rpc` messages, and the messages of `doric.conformance.v1`, which the
//! example `conformance` includes from `OUT_DIR`.

use std::path::PathBuf;

/// The conformance service is served by the example through the SDK, so only
/// its messages are generated.
const CONFORMANCE: &str = "doric/conformance/v1/conformance.proto";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../dist/proto");
    let files = [
        "doric/platform/v1/control.proto",
        "google/rpc/status.proto",
        "google/rpc/error_details.proto",
        CONFORMANCE,
    ]
    .map(|file| root.join(file));
    files
        .iter()
        .for_each(|file| println!("cargo:rerun-if-changed={}", file.display()));

    let mut descriptors = protox::compile(&files, [&root])?;
    descriptors
        .file
        .iter_mut()
        .filter(|file| file.name() == CONFORMANCE)
        .for_each(|file| file.service.clear());
    tonic_prost_build::configure()
        .build_server(false)
        .build_client(true)
        // The RPC `Connect` would clash with the generated `connect` constructor.
        .build_transport(false)
        .compile_fds(descriptors)?;
    Ok(())
}
