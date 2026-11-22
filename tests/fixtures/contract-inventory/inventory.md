# Fixture inventory

## A. Methods that are not plain data

Rows for the fixture contract `fixture/v1`.

| # | Contract | Method | Declared at | Today | Target |
| --- | --- | --- | --- | --- | --- |
| 1 | `fixture/v1` | `listed` | `packages/fixture/src/contracts.ts:24` | Stream | `fixture/v1.WatchListed`, server streaming. |
| 2 | `fixture/v1` | `list` | `packages/fixture/src/contracts.ts:12` | Synchronous getter | `fixture/v1.List`, asynchronous. |

## B. Something else

| Route | RPC |
| --- | --- |
| `GET /fixture` | `fixture/v1.watch` |
