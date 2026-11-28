//! Generates, from the exported protos (`dist/proto`, the root `proto-export`
//! target), the messages of `doric.storage.kv.v1`, which `src/lib.rs`
//! includes from `OUT_DIR`.

use std::path::PathBuf;

/// The KV service is served through the SDK, so only its messages are
/// generated.
const KV: &str = "doric/storage/kv/v1/kv.proto";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../dist/proto");
    let file = root.join(KV);
    println!("cargo:rerun-if-changed={}", file.display());

    let mut descriptors = protox::compile([&file], [&root])?;
    // Its imports carry only options, which no generated message needs.
    descriptors.file.retain(|file| file.name() == KV);
    descriptors
        .file
        .iter_mut()
        .for_each(|file| file.service.clear());
    tonic_prost_build::configure()
        .build_server(false)
        .build_client(false)
        .compile_fds(descriptors)?;
    Ok(())
}
