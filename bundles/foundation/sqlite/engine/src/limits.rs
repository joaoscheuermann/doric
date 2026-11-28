//! The refusals of `storage.kv/v1` that need no connection: guarantee 6, the
//! limits, guarantee 8, the prefix ([`access::check`]), and the
//! `invalid_input` cases of the contract (A76). Every check runs before a
//! transaction opens, so a refused call reads and writes nothing.
//!
//! An answer over a limit is `limit_exceeded` with `details.limit`, the
//! limit's name: `keyBytes`, `valueBytes`, `getKeys`, `rangeLimit`,
//! `commitItems` or `commitBytes`.

use doric_bundle::ContractError;

use crate::{
    access,
    kv::{
        CommitRequest, Condition, GetRequest, KeyRange, PositionedPut, Put, RangeRequest,
        commit_request,
    },
};

/// The most bytes of one key (`keyBytes`).
pub(crate) const KEY_BYTES: usize = 4096;
/// The most bytes of one value (`valueBytes`).
pub(crate) const VALUE_BYTES: usize = 1_048_576;
/// The most keys of one `Get` (`getKeys`).
pub(crate) const GET_KEYS: usize = 1000;
/// The highest `limit` of one `Range` (`rangeLimit`).
pub(crate) const RANGE_LIMIT: u32 = 1000;
/// The most items, conditions included, of one commit (`commitItems`).
pub(crate) const COMMIT_ITEMS: usize = 200_000;
/// The most bytes of keys and values of one commit (`commitBytes`).
pub(crate) const COMMIT_BYTES: usize = 67_108_864;

/// Checks a `Get` from `caller`, in this order, and answers the first
/// refusal:
///
/// 1. no keys is `invalid_input`;
/// 2. more than [`GET_KEYS`] keys is `getKeys`;
/// 3. then, for each key in request order, its prefix ([`access::check`],
///    `not_owner`), then its size, over [`KEY_BYTES`] `keyBytes`.
///
/// # Errors
///
/// `invalid_input`, `limit_exceeded` with `details.limit`, or `not_owner` with
/// `details.key`.
pub fn get(caller: &str, request: &GetRequest) -> Result<(), ContractError> {
    if request.keys.is_empty() {
        return Err(invalid("A Get names no key."));
    }
    if request.keys.len() > GET_KEYS {
        return Err(exceeded(
            "getKeys",
            format!("A Get names more than {GET_KEYS} keys."),
        ));
    }

    request.keys.iter().try_for_each(|key| {
        access::check(caller, key)?;
        size(key.len())
    })
}

/// Checks a `Range` from `caller`, in this order, and answers the first
/// refusal:
///
/// 1. a `limit` of 0 is `invalid_input`;
/// 2. a `limit` above [`RANGE_LIMIT`] is `rangeLimit`;
/// 3. a `start` after `end`, bytewise, is `invalid_input`; `start == end` is
///    an empty range and passes;
/// 4. the prefix of `start`, then of `end` ([`access::check`], `not_owner`);
/// 5. `start`, then `end`, over [`KEY_BYTES`] is `keyBytes`.
///
/// # Errors
///
/// `invalid_input`, `limit_exceeded` with `details.limit`, or `not_owner` with
/// `details.key`.
pub fn range(caller: &str, request: &RangeRequest) -> Result<(), ContractError> {
    if request.limit == 0 {
        return Err(invalid("A Range has a limit of 0."));
    }
    if request.limit > RANGE_LIMIT {
        return Err(exceeded(
            "rangeLimit",
            format!("A Range has a limit above {RANGE_LIMIT}."),
        ));
    }
    if request.start > request.end {
        return Err(invalid("A Range starts after its end."));
    }

    access::check(caller, &request.start)?;
    access::check(caller, &request.end)?;
    size(request.start.len())?;
    size(request.end.len())
}

/// The items of one commit, checked as they arrive and held in memory until
/// the stream ends: at most [`COMMIT_ITEMS`] items and [`COMMIT_BYTES`] bytes.
#[derive(Debug, Default)]
pub struct Batch {
    /// The items taken so far, in arrival order.
    items: Vec<Item>,
    /// The bytes of keys and values of `items` (see [`Batch::push`]).
    bytes: usize,
}

impl Batch {
    /// Checks one commit item from `caller`, in this order, and takes it when
    /// it passes:
    ///
    /// 1. an item with no case set is `invalid_input`;
    /// 2. the prefix of every key it names ([`access::check`], `not_owner`):
    ///    a condition's, put's or delete's key, a clear range's `start` then
    ///    `end`, a positioned put's `key_prefix`;
    /// 3. each of those keys over [`KEY_BYTES`] is `keyBytes`, a positioned put
    ///    counting `key_prefix` plus the 8 bytes of the position;
    /// 4. the value of a put or a positioned put over [`VALUE_BYTES`] is
    ///    `valueBytes`;
    /// 5. a clear range whose `start` is after its `end` is `invalid_input`;
    /// 6. the running count, with this item, over [`COMMIT_ITEMS`] is
    ///    `commitItems`;
    /// 7. the running bytes, with this item's keys and values as counted in 3
    ///    and 4, over [`COMMIT_BYTES`] is `commitBytes`.
    ///
    /// # Errors
    ///
    /// `invalid_input`, `not_owner` with `details.key`, or `limit_exceeded`
    /// with `details.limit`. A refused item is not taken and the batch is left
    /// as it was; the caller ends the call and drops the batch.
    pub fn push(&mut self, caller: &str, request: CommitRequest) -> Result<(), ContractError> {
        let item = Item::try_from(request)?;
        let keys = item.keys();

        keys.iter()
            .try_for_each(|(key, _)| access::check(caller, key))?;
        keys.iter().try_for_each(|(_, bytes)| size(*bytes))?;
        let value = item.value().map_or(0, <[u8]>::len);
        if value > VALUE_BYTES {
            return Err(exceeded(
                "valueBytes",
                format!("A value is over {VALUE_BYTES} bytes."),
            ));
        }
        if let Item::ClearRange { start, end } = &item
            && start > end
        {
            return Err(invalid("A clear range starts after its end."));
        }
        if self.items.len() >= COMMIT_ITEMS {
            return Err(exceeded(
                "commitItems",
                format!("A commit has more than {COMMIT_ITEMS} items."),
            ));
        }
        let bytes = self.bytes + value + keys.iter().map(|(_, bytes)| bytes).sum::<usize>();
        if bytes > COMMIT_BYTES {
            return Err(exceeded(
                "commitBytes",
                format!("A commit has more than {COMMIT_BYTES} bytes of keys and values."),
            ));
        }

        self.items.push(item);
        self.bytes = bytes;
        Ok(())
    }

    /// Ends the batch when the stream has ended, and answers its items in
    /// arrival order.
    ///
    /// # Errors
    ///
    /// `invalid_input` when no item is a mutation: no item at all, or
    /// conditions only.
    pub fn finish(self) -> Result<Vec<Item>, ContractError> {
        self.items
            .iter()
            .any(|item| !matches!(item, Item::Condition { .. }))
            .then_some(self.items)
            .ok_or_else(|| invalid("A commit holds no mutation."))
    }
}

/// One checked commit item: a condition or a mutation.
#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    /// The key's version must be `version`; 0 means the key must be absent.
    Condition { key: Vec<u8>, version: f64 },
    /// Writes `value` under `key`.
    Put { key: Vec<u8>, value: Vec<u8> },
    /// Removes the key.
    Delete(Vec<u8>),
    /// Removes every key of `[start, end)`.
    ClearRange { start: Vec<u8>, end: Vec<u8> },
    /// Writes `value` under `key_prefix` followed by the commit's position as
    /// 8 bytes, big-endian.
    PositionedPut { key_prefix: Vec<u8>, value: Vec<u8> },
}

impl Item {
    /// The keys the item names, each with the bytes it counts: a positioned
    /// put's `key_prefix` counts the 8 bytes of the position too.
    fn keys(&self) -> Vec<(&[u8], usize)> {
        match self {
            Self::Condition { key, .. } | Self::Put { key, .. } | Self::Delete(key) => {
                vec![(key, key.len())]
            }
            Self::ClearRange { start, end } => vec![(start, start.len()), (end, end.len())],
            Self::PositionedPut { key_prefix, .. } => vec![(key_prefix, key_prefix.len() + 8)],
        }
    }

    /// The value the item writes, if it writes one.
    fn value(&self) -> Option<&[u8]> {
        match self {
            Self::Put { value, .. } | Self::PositionedPut { value, .. } => Some(value),
            _ => None,
        }
    }
}

impl TryFrom<CommitRequest> for Item {
    type Error = ContractError;

    /// The item of `request`.
    ///
    /// # Errors
    ///
    /// `invalid_input` when no case is set.
    fn try_from(request: CommitRequest) -> Result<Self, ContractError> {
        Ok(match request.item {
            None => return Err(invalid("A commit item has no case set.")),
            Some(commit_request::Item::Condition(Condition { key, version })) => {
                Self::Condition { key, version }
            }
            Some(commit_request::Item::Put(Put { key, value })) => Self::Put { key, value },
            Some(commit_request::Item::Delete(key)) => Self::Delete(key),
            Some(commit_request::Item::ClearRange(KeyRange { start, end })) => {
                Self::ClearRange { start, end }
            }
            Some(commit_request::Item::PositionedPut(PositionedPut { key_prefix, value })) => {
                Self::PositionedPut { key_prefix, value }
            }
        })
    }
}

/// Refuses a key of `bytes` over [`KEY_BYTES`].
fn size(bytes: usize) -> Result<(), ContractError> {
    if bytes > KEY_BYTES {
        return Err(exceeded(
            "keyBytes",
            format!("A key is over {KEY_BYTES} bytes."),
        ));
    }
    Ok(())
}

/// An `invalid_input` refusal.
fn invalid(message: &str) -> ContractError {
    ContractError::new("invalid_input", message)
}

/// A `limit_exceeded` refusal of the limit `name`.
fn exceeded(name: &str, message: String) -> ContractError {
    crate::refusal("limit_exceeded", message, "limit", name.into())
}

#[cfg(test)]
mod tests;
