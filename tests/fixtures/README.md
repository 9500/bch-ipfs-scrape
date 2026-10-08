# Test Fixtures

Sample data used by the tests. Everything here is real blockchain data, reduced
to what the tests need, so the suite runs offline and deterministically.

## `chaingraph/`

Chaingraph GraphQL results (the shape `--query-chaingraph` writes).

- `sample-100-registries.json`, `sample-200-registries.json` - Real announcements. Used as row data by the fake Chaingraph in `tests/integration/cli-query-chaingraph.test.ts`; also an input for manual runs. `sample-200` contains identities whose auth UTXO was swept into busy wallets (chains of hundreds of hops), which take minutes to walk against a live Fulcrum.
- `short-chains-half.json`, `short-chains-full.json` - Announcements whose authchains are short and whose addresses have short histories, so the whole walk is covered by the recorded Fulcrum fixture below. The half file is a prefix of the full file (the cache tests rely on that).
- `short-chains-embedded.json` - A result file with Chaingraph's authchain resolution and input-0 outpoints embedded, as `--query-chaingraph` produces them. Resolves with no endpoints at all.
- `three-tx-chain.json` - Synthetic authchain `A -> B -> C` (three announcements of one identity, listed out of order), used by the unit tests with fake backends.
- `limit-1000-query.graphql` - A custom query file, used to test that custom queries are sent as-is.

## `fulcrum/`

- `short-chains.json` - Recorded Fulcrum answers (trimmed verbose transactions, `listunspent` with `include_tokens`, `get_history`) covering every hop of the announcements in `short-chains-{half,full}.json`. Served by `tests/helpers/fake-fulcrum.ts`.

## Fakes (`tests/helpers/`)

- `fake-fulcrum.ts` - Electrum protocol over WebSocket, answering from the recorded fixture; can drop sockets, ignore requests or return RPC errors on demand.
- `fake-chaingraph.ts` - GraphQL over HTTP serving `search_output_prefix` pages with the real server's 5000-row cap.
- `cli.ts` - Runs the built CLI in a scratch directory with explicit endpoints, so a developer's `.env` never leaks live servers into a test.

## Regenerating

`short-chains-*.json` and `fulcrum/short-chains.json` were produced together by
walking the announcements of `sample-200-registries.json` against a live
Fulcrum, keeping those whose every hop has a script history of at most 16
entries, and recording every answer. The live servers can be exercised with
`LIVE_TESTS=1 npx vitest run tests/integration/live-smoke.test.ts`.
