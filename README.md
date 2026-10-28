// actions.go contains the individual git operation implementations as methods
// on Runner. runner.go contains the Execute dispatcher, streaming helpers,
// and subprocess infrastructure. The split keeps each action self-contained
// and easy to test in isolation.


// WatchEvent is the payload pushed to all connected frontends when .git changes.
// Kept granular so the frontend only re-fetches what actually changed.
//
//   - added_shas  → call fetchNewCommits, prepend to graph
//   - removed_shas → drop those rows (force-push case)
//   - moved_refs  → patch branch label positions in-place, no full reload
//   - in_progress  → update command palette context immediately


30052026
rn to run,
in root dir: npx tauri dev
>> and in devtools in tauri build, backend should be running

to rebuild backend,
in root dir: ./scripts/build_backend.sh 

to rebuild tauri (?)
in src-tauri: 
cargo clean
cargo build