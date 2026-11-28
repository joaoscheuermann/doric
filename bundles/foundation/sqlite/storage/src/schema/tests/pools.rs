//! S77a3a: `Pools`, the cache of decoded descriptor pools (P1–P4).

use std::cell::Cell;

use doric_bundle::ContractError;
use prost_reflect::DescriptorPool;

use crate::schema::{POOLS, Pools};

/// `pools.get_or_build(hash, …)` with a build that counts its runs in `built`.
fn get(pools: &Pools, hash: &str, built: &Cell<usize>) {
    pools
        .get_or_build(hash, || {
            built.set(built.get() + 1);
            Ok(DescriptorPool::new())
        })
        .expect("the pool is built or cached");
}

/// Whether `get_or_build(hash, …)` runs its build now.
fn builds(pools: &Pools, hash: &str) -> bool {
    let built = Cell::new(0);
    get(pools, hash, &built);
    built.get() == 1
}

fn hash(n: usize) -> String {
    format!("{n:064x}")
}

#[test]
fn the_second_get_of_a_hash_does_not_build() {
    let pools = Pools::default();
    let built = Cell::new(0);

    get(&pools, &hash(0), &built);
    get(&pools, &hash(0), &built);

    assert_eq!(built.get(), 1);
}

#[test]
fn a_failing_build_answers_its_error_and_is_not_cached() {
    let pools = Pools::default();
    let refusal = ContractError::new("internal", "A stored schema does not decode.");

    let error = pools
        .get_or_build(&hash(0), || Err(refusal.clone()))
        .expect_err("the build fails");

    assert_eq!(error, refusal);
    assert!(builds(&pools, &hash(0)), "the next call builds again");
}

#[test]
fn a_full_cache_evicts_the_least_recently_used_pool() {
    let pools = Pools::default();
    let built = Cell::new(0);

    for n in 0..=POOLS {
        get(&pools, &hash(n), &built);
    }

    assert_eq!(built.get(), POOLS + 1);
    assert!(builds(&pools, &hash(0)), "the first hash was evicted");
}

#[test]
fn a_recently_used_pool_is_not_evicted() {
    let pools = Pools::default();
    let built = Cell::new(0);
    for n in 0..POOLS {
        get(&pools, &hash(n), &built);
    }

    get(&pools, &hash(0), &built);
    get(&pools, &hash(POOLS), &built);

    assert_eq!(built.get(), POOLS + 1);
    assert!(!builds(&pools, &hash(0)), "the hash used last stays");
    assert!(
        builds(&pools, &hash(1)),
        "the least recently used was evicted"
    );
}

#[test]
fn clones_share_the_cache() {
    let pools = Pools::default();
    let clone = pools.clone();

    assert!(builds(&pools, &hash(0)));
    assert!(!builds(&clone, &hash(0)));
}
